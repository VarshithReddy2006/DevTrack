// Weekly leagues: cohort assignment, score increments, rollover transitions, idempotency and
// Redis rebuild. MongoDB is the in-memory server from the shared test setup; the Redis sorted
// sets are replaced by FakeScoreStore, so no Redis server is involved.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { LeagueStanding, UserSettings, User, XpTransaction } from '../../../db/models/index.js';
import type { LeagueDivision } from '../../../db/models/index.js';
import { cohortKey } from '../../../modules/leagues/leagues.constants.js';
import {
  getCurrentStandings,
  isParticipating,
  joinCurrentWeek,
  rebuildWeekFromLedger,
  recordXpAward,
  setParticipation,
} from '../../../modules/leagues/leagues.service.js';
import { computeCohortOutcomes, runWeeklyRollover, type WeekFinalizedPayload } from '../../../modules/leagues/rollover.js';
import { processLeagueScoreJob } from '../../../modules/leagues/workers/leagueScore.worker.js';
import { weekToFinalize } from '../../../modules/leagues/workers/weeklyRollover.worker.js';
import { FakeScoreStore } from './fakeScoreStore.js';

const PREVIOUS = '2026-11-08';
const WEEK = '2026-11-15';
const NEXT = '2026-11-22';
const MID_WEEK = new Date('2026-11-18T12:00:00.000Z');
const ROLLOVER_AT = new Date('2026-11-22T00:00:05.000Z');

let store: FakeScoreStore;
let counter = 0;

beforeEach(() => {
  store = new FakeScoreStore();
  counter = 0;
});

async function makeUsers(n: number, participate = true): Promise<string[]> {
  const ids = Array.from({ length: n }, () => new Types.ObjectId());
  await UserSettings.insertMany(ids.map(userId => ({ userId, leagues: { participate } })));
  return ids.map(id => id.toString());
}

/** Gives users a finalized earlier week that sends them to `division` this week. */
async function startIn(ids: string[], division: LeagueDivision) {
  await LeagueStanding.insertMany(ids.map(id => ({
    weekKey: PREVIOUS, userId: new Types.ObjectId(id), division, cohortId: 'c1', status: 'finalized',
    joinedAt: new Date('2026-11-08T00:00:00Z'), points: 1, rank: 1, cohortSize: 1, outcome: 'stayed',
    nextDivision: division, finalizedAt: new Date('2026-11-15T00:00:00Z'),
  })));
}

async function joinAll(ids: string[], at = MID_WEEK) {
  for (const id of ids) await joinCurrentWeek(id, at, store);
}

async function award(userId: string, xp: number, at = MID_WEEK, sourceId = `src-${++counter}`) {
  return recordXpAward({ userId, sourceType: 'dsa_accepted', sourceId, xpAwarded: xp, occurredAt: at }, store, at);
}

const row = (userId: string, weekKey: string) => LeagueStanding.findOne({ weekKey, userId: new Types.ObjectId(userId) }).lean();

async function snapshot(weekKey: string) {
  return (await LeagueStanding.find({ weekKey }).sort({ userId: 1 }).lean()).map(r => ({
    userId: r.userId.toString(), division: r.division, cohortId: r.cohortId, status: r.status,
    points: r.points, rank: r.rank, outcome: r.outcome, nextDivision: r.nextDivision,
  }));
}

describe('opt-in setting', () => {
  it('defaults leagues.participate to false', async () => {
    const userId = new Types.ObjectId();
    const settings = await UserSettings.create({ userId });
    expect(settings.leagues.participate).toBe(false);
    expect(await isParticipating(userId.toString())).toBe(false);
  });

  it('setParticipation creates the settings document and places the user in a cohort', async () => {
    const userId = new Types.ObjectId().toString();
    await setParticipation(userId, true, MID_WEEK, store);
    expect(await isParticipating(userId)).toBe(true);
    expect(await row(userId, WEEK)).toMatchObject({ division: 'bronze', cohortId: 'c1', status: 'active' });
    expect(store.score(cohortKey(WEEK, 'bronze', 'c1'), userId)).toBe(0);
  });

  it('opting out removes the live row and the Redis member but keeps history', async () => {
    const [userId] = await makeUsers(1);
    await startIn([userId], 'silver');
    await joinAll([userId]);
    await award(userId, 40);
    await setParticipation(userId, false, MID_WEEK, store);

    expect(await isParticipating(userId)).toBe(false);
    expect(await row(userId, WEEK)).toBeNull();
    expect(store.score(cohortKey(WEEK, 'silver', 'c1'), userId)).toBeUndefined();
    expect(await row(userId, PREVIOUS)).not.toBeNull();
  });
});

describe('cohort assignment', () => {
  it('starts new users in bronze and uses the division of their last finalized week otherwise', async () => {
    const [fresh, veteran] = await makeUsers(2);
    await startIn([veteran], 'diamond');
    await joinAll([fresh, veteran]);
    expect(await row(fresh, WEEK)).toMatchObject({ division: 'bronze' });
    expect(await row(veteran, WEEK)).toMatchObject({ division: 'diamond' });
  });

  it('is idempotent for the same user and week', async () => {
    const [userId] = await makeUsers(1);
    await joinAll([userId]);
    await joinAll([userId]);
    expect(await LeagueStanding.countDocuments({ weekKey: WEEK })).toBe(1);
  });

  it('fills a cohort to 30 and opens the next one for late joiners', async () => {
    const ids = await makeUsers(31);
    await joinAll(ids);
    const cohorts = await LeagueStanding.aggregate([{ $match: { weekKey: WEEK } }, { $group: { _id: '$cohortId', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
    expect(cohorts).toEqual([{ _id: 'c1', n: 30 }, { _id: 'c2', n: 1 }]);
  });

  it('settles concurrent joins of one user into a single row', async () => {
    const [userId] = await makeUsers(1);
    await Promise.all([joinCurrentWeek(userId, MID_WEEK, store), joinCurrentWeek(userId, MID_WEEK, store), joinCurrentWeek(userId, MID_WEEK, store)]);
    expect(await LeagueStanding.countDocuments({ weekKey: WEEK })).toBe(1);
  });
});

describe('score increments from XP awards', () => {
  it('adds the awarded XP to the user in the active cohort sorted set', async () => {
    const [a, b] = await makeUsers(2);
    await joinAll([a, b]);
    expect(await award(a, 10)).toMatchObject({ applied: true, weekKey: WEEK, score: 10 });
    expect(await award(a, 25)).toMatchObject({ applied: true, score: 35 });
    await award(b, 5);
    const key = cohortKey(WEEK, 'bronze', 'c1');
    expect(store.score(key, a)).toBe(35);
    expect(store.score(key, b)).toBe(5);
  });

  it('places an opted-in user without a row on their first award of the week', async () => {
    const [userId] = await makeUsers(1);
    expect(await award(userId, 20)).toMatchObject({ applied: true, score: 20 });
    expect(await row(userId, WEEK)).toMatchObject({ status: 'active' });
  });

  it('ignores users who did not opt in', async () => {
    const [userId] = await makeUsers(1, false);
    expect(await award(userId, 20)).toEqual({ applied: false, reason: 'not_participating' });
    expect(await LeagueStanding.countDocuments()).toBe(0);
  });

  it('adds 0 for awards without XP, e.g. a focus session that did not qualify', async () => {
    const [userId] = await makeUsers(1);
    await joinAll([userId]);
    expect(await award(userId, 0)).toEqual({ applied: false, reason: 'no_xp' });
    expect(await award(userId, -5)).toEqual({ applied: false, reason: 'no_xp' });
    expect(await award(userId, 2.5)).toEqual({ applied: false, reason: 'no_xp' });
    expect(store.score(cohortKey(WEEK, 'bronze', 'c1'), userId)).toBe(0);
  });

  it('counts a replayed award once', async () => {
    const [userId] = await makeUsers(1);
    await joinAll([userId]);
    expect(await award(userId, 15, MID_WEEK, 'same-source')).toMatchObject({ applied: true });
    expect(await award(userId, 15, MID_WEEK, 'same-source')).toEqual({ applied: false, reason: 'duplicate' });
    expect(store.score(cohortKey(WEEK, 'bronze', 'c1'), userId)).toBe(15);
  });

  it('drops XP earned before the user joined, and XP that arrives after the week was finalized', async () => {
    const [userId] = await makeUsers(1);
    await joinAll([userId]);
    expect(await award(userId, 10, new Date('2026-11-18T11:00:00Z'))).toEqual({ applied: false, reason: 'before_join' });

    await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify: vi.fn() });
    expect(await award(userId, 10, new Date('2026-11-21T23:59:00Z'))).toEqual({ applied: false, reason: 'week_closed' });
  });

  it('puts an award in the week of its ledger timestamp, not of the time the job ran', async () => {
    const [userId] = await makeUsers(1);
    await joinAll([userId], new Date('2026-11-15T00:00:00Z'));
    const result = await recordXpAward(
      { userId, sourceType: 'dsa_accepted', sourceId: 'late-job', xpAwarded: 30, occurredAt: new Date('2026-11-21T23:59:59Z') },
      store,
      new Date('2026-11-22T00:00:02Z'),
    );
    expect(result).toMatchObject({ applied: true, weekKey: WEEK, score: 30 });
  });

  it('the score worker handler validates its job and applies it', async () => {
    const [userId] = await makeUsers(1);
    await joinAll([userId]);
    const data = { userId, sourceType: 'dsa_accepted', sourceId: 'p-1', xpAwarded: 12, occurredAt: MID_WEEK.toISOString() };
    expect(await processLeagueScoreJob(data, store, MID_WEEK)).toMatchObject({ applied: true, score: 12 });
    await expect(processLeagueScoreJob({ ...data, occurredAt: 'not a date' }, store, MID_WEEK)).rejects.toThrow(/invalid occurredAt/);
  });

  it('credits late-joiner XP when async worker runs after occurredAt without dropping as before_join', async () => {
    const [userId] = await makeUsers(1);
    const occurredAt = new Date(MID_WEEK.getTime() - 15_000);
    const result = await recordXpAward(
      { userId, sourceType: 'dsa_accepted', sourceId: 'async-first-xp', xpAwarded: 40, occurredAt },
      store,
      MID_WEEK,
    );
    expect(result).toMatchObject({ applied: true, weekKey: WEEK, score: 40 });
    const standing = await row(userId, WEEK);
    expect(standing).not.toBeNull();
    expect(standing!.joinedAt.getTime()).toBe(occurredAt.getTime());
  });

  it('ensures store.seed runs on E11000 duplicate-key recovery in joinCurrentWeek', async () => {
    const [userId] = await makeUsers(1);
    const seedSpy = vi.spyOn(store, 'seed');

    // Pre-insert standing without seeding Redis, then simulate E11000 on create
    const existingRow = await LeagueStanding.create({
      weekKey: WEEK,
      userId: new Types.ObjectId(userId),
      division: 'bronze',
      cohortId: 'c1',
      status: 'active',
      joinedAt: MID_WEEK,
    });
    const findSpy = vi.spyOn(LeagueStanding, 'findOne');
    // Return null on pre-check and double-check so joinCurrentWeek attempts create, hits E11000, then recovers
    findSpy.mockReturnValueOnce({ lean: async () => null } as any);
    findSpy.mockReturnValueOnce({ lean: async () => null } as any);

    const joined = await joinCurrentWeek(userId, MID_WEEK, store);
    expect(joined.cohortId).toBe(existingRow.cohortId);
    expect(seedSpy).toHaveBeenCalledWith(cohortKey(WEEK, 'bronze', 'c1'), [userId]);
  });
});

describe('computeCohortOutcomes', () => {
  const board = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u${i + 1}`, points: (n - i) * 10 }));
  const outcomes = (division: LeagueDivision, n: number) => computeCohortOutcomes(division, board(n)).map(s => s.outcome);

  it('promotes the top 20% and demotes the bottom 20% of a cohort of 30', () => {
    const result = outcomes('gold', 30);
    expect(result.slice(0, 6)).toEqual(Array(6).fill('promoted'));
    expect(result.slice(6, 24)).toEqual(Array(18).fill('stayed'));
    expect(result.slice(24)).toEqual(Array(6).fill('demoted'));
  });

  it('rounds the 20% down, so small cohorts move fewer people', () => {
    expect(outcomes('gold', 4)).toEqual(['stayed', 'stayed', 'stayed', 'stayed']);
    expect(outcomes('gold', 9).filter(o => o === 'promoted')).toHaveLength(1);
    expect(outcomes('gold', 10).filter(o => o === 'demoted')).toHaveLength(2);
  });

  it('cannot demote out of bronze or promote out of grandmaster', () => {
    expect(outcomes('bronze', 10)).toEqual(['promoted', 'promoted', ...Array(8).fill('stayed')]);
    expect(outcomes('grandmaster', 10)).toEqual([...Array(8).fill('stayed'), 'demoted', 'demoted']);
  });

  it('moves exactly one division and reports rank, points and cohort size', () => {
    const [first, , , , , , , , , last] = computeCohortOutcomes('silver', board(10));
    expect(first).toEqual({ userId: 'u1', rank: 1, points: 100, cohortSize: 10, outcome: 'promoted', nextDivision: 'gold' });
    expect(last).toEqual({ userId: 'u10', rank: 10, points: 10, cohortSize: 10, outcome: 'demoted', nextDivision: 'bronze' });
  });
});

describe('weekly rollover', () => {
  /** 10 gold users; user i earns (i + 1) * 10 XP, so index 9 is rank 1. */
  async function goldCohort() {
    const ids = await makeUsers(10);
    await startIn(ids, 'gold');
    await joinAll(ids);
    for (const [i, id] of ids.entries()) await award(id, (i + 1) * 10);
    return ids;
  }

  it('finalizes ranks, promotes the top 20%, demotes the bottom 20% and persists the records', async () => {
    const ids = await goldCohort();
    const notify = vi.fn();
    const result = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify });

    expect(result).toMatchObject({ weekKey: WEEK, nextWeekKey: NEXT, finalized: 10, promoted: 2, demoted: 2, assigned: 10 });
    const rows = await Promise.all(ids.map(id => row(id, WEEK)));
    expect(rows.map(r => r!.rank)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(rows.map(r => r!.points)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(rows.map(r => r!.outcome)).toEqual([
      'demoted', 'demoted', 'stayed', 'stayed', 'stayed', 'stayed', 'stayed', 'stayed', 'promoted', 'promoted',
    ]);
    expect(rows.map(r => r!.nextDivision)).toEqual([
      'silver', 'silver', 'gold', 'gold', 'gold', 'gold', 'gold', 'gold', 'platinum', 'platinum',
    ]);
    for (const r of rows) expect(r).toMatchObject({ status: 'finalized', cohortSize: 10, finalizedAt: ROLLOVER_AT });
  });

  it('puts everyone in a fresh cohort of the new week in the division they moved to', async () => {
    const ids = await goldCohort();
    await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify: vi.fn() });

    const next = await Promise.all(ids.map(id => row(id, NEXT)));
    expect(next.map(r => r!.division)).toEqual([
      'silver', 'silver', 'gold', 'gold', 'gold', 'gold', 'gold', 'gold', 'platinum', 'platinum',
    ]);
    for (const r of next) expect(r).toMatchObject({ status: 'active', points: 0, rank: null, outcome: null });
    expect(new Set(next.map(r => r!.joinedAt.toISOString()))).toEqual(new Set(['2026-11-22T00:00:00.000Z']));
    // The Redis boards for the new week exist with everybody at 0, and the old week is set to expire.
    expect(store.score(cohortKey(NEXT, 'gold', 'c1'), ids[2])).toBe(0);
    expect(store.score(cohortKey(NEXT, 'platinum', 'c1'), ids[9])).toBe(0);
    expect(store.score(cohortKey(NEXT, 'silver', 'c1'), ids[0])).toBe(0);
    expect(store.ttls.get(cohortKey(WEEK, 'gold', 'c1'))).toBeGreaterThan(0);
  });

  it('notifies each finalized user once with league.week.finalized data', async () => {
    const ids = await goldCohort();
    const notify = vi.fn<(userId: string, payload: WeekFinalizedPayload) => Promise<void>>().mockResolvedValue(undefined);
    await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify });

    expect(notify).toHaveBeenCalledTimes(10);
    expect(notify).toHaveBeenCalledWith(ids[9], {
      weekKey: WEEK, division: 'gold', rank: 1, points: 100, cohortSize: 10, outcome: 'promoted', nextDivision: 'platinum',
    });
  });

  it('a failing notification does not fail the rollover', async () => {
    await goldCohort();
    const notify = vi.fn().mockRejectedValue(new Error('sse down'));
    await expect(runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify })).resolves.toMatchObject({ finalized: 10 });
  });

  it('running it again for the same week is a no-op: same rows, no double promotion, no new notifications', async () => {
    await goldCohort();
    const notify = vi.fn().mockResolvedValue(undefined);
    await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify });
    const weekRows = await snapshot(WEEK);
    const nextRows = await snapshot(NEXT);
    const redisBefore = JSON.stringify([...store.sets].map(([k, v]) => [k, [...v]]));

    const again = await runWeeklyRollover(WEEK, { store, now: new Date('2026-11-22T00:07:00Z'), notify });
    const thrice = await runWeeklyRollover(WEEK, { store, now: new Date('2026-11-22T01:00:00Z'), notify });

    expect(again).toMatchObject({ finalized: 0, promoted: 0, demoted: 0, assigned: 0 });
    expect(thrice).toMatchObject({ finalized: 0, assigned: 0 });
    expect(await snapshot(WEEK)).toEqual(weekRows);
    expect(await snapshot(NEXT)).toEqual(nextRows);
    expect(JSON.stringify([...store.sets].map(([k, v]) => [k, [...v]]))).toBe(redisBefore);
    expect(notify).toHaveBeenCalledTimes(10);
    // A promoted user is exactly one division up, not two.
    expect((await LeagueStanding.find({ weekKey: NEXT, division: 'platinum' })).length).toBe(2);
    expect((await LeagueStanding.find({ weekKey: NEXT, division: 'diamond' })).length).toBe(0);
  });

  it('does nothing when the week has no participants', async () => {
    const result = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify: vi.fn() });
    expect(result).toMatchObject({ finalized: 0, promoted: 0, demoted: 0, assigned: 0 });
    expect(await LeagueStanding.countDocuments()).toBe(0);
  });

  it('repairs a run that stopped after finalizing: finishes the new week without re-ranking or re-notifying', async () => {
    await goldCohort();
    const notify = vi.fn().mockResolvedValue(undefined);
    await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify });
    const weekRows = await snapshot(WEEK);
    const nextRows = await snapshot(NEXT);

    // Simulate a crash after phase 1: the new week and its Redis boards never got written.
    await LeagueStanding.deleteMany({ weekKey: NEXT });
    store.flush();
    const repaired = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify });

    expect(repaired).toMatchObject({ finalized: 0, promoted: 0, demoted: 0, assigned: 10 });
    expect(await snapshot(WEEK)).toEqual(weekRows);
    expect(await snapshot(NEXT)).toEqual(nextRows);
    expect(notify).toHaveBeenCalledTimes(10);
  });

  it('ranks a half-finalized cohort the same way, finalizing only the remaining rows', async () => {
    const ids = await goldCohort();
    // An earlier run finalized the current leader before dying.
    await LeagueStanding.updateOne(
      { weekKey: WEEK, userId: new Types.ObjectId(ids[9]) },
      { $set: { status: 'finalized', points: 100, rank: 1, cohortSize: 10, outcome: 'promoted', nextDivision: 'platinum', finalizedAt: ROLLOVER_AT } },
    );
    const result = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify: vi.fn() });

    expect(result).toMatchObject({ finalized: 9, promoted: 1, demoted: 2 });
    expect(await row(ids[8], WEEK)).toMatchObject({ rank: 2, outcome: 'promoted' });
    expect(await row(ids[0], WEEK)).toMatchObject({ rank: 10, outcome: 'demoted' });
  });

  it('does not carry users who opted out into the next week, but keeps their final record', async () => {
    const ids = await goldCohort();
    await UserSettings.updateOne({ userId: new Types.ObjectId(ids[9]) }, { $set: { 'leagues.participate': false } });
    await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify: vi.fn() });

    expect(await row(ids[9], WEEK)).toMatchObject({ status: 'finalized', rank: 1, outcome: 'promoted' });
    expect(await row(ids[9], NEXT)).toBeNull();
    expect(await LeagueStanding.countDocuments({ weekKey: NEXT })).toBe(9);
  });

  it('builds the new week in cohorts of ~30 and merges a leftover under 10 into the previous cohort', async () => {
    // Gold cohorts of 30, 20 and 10 this week: 18 + 12 + 6 = 36 users stay in gold, which is one
    // cohort of 30 plus a leftover of 6, so the leftover is merged instead of standing alone.
    const sizes = { c1: 30, c2: 20, c3: 10 };
    const ids = await makeUsers(60);
    let next = 0;
    for (const [cohortId, size] of Object.entries(sizes)) {
      await LeagueStanding.insertMany(ids.slice(next, next + size).map(id => ({
        weekKey: WEEK, userId: new Types.ObjectId(id), division: 'gold', cohortId, status: 'active',
        joinedAt: new Date('2026-11-15T00:00:00Z'),
      })));
      next += size;
    }
    await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify: vi.fn() });

    const grouped = await LeagueStanding.aggregate([
      { $match: { weekKey: NEXT } },
      { $group: { _id: { d: '$division', c: '$cohortId' }, n: { $sum: 1 } } },
    ]);
    const bySize = Object.fromEntries(grouped.map(g => [`${g._id.d}/${g._id.c}`, g.n]));
    expect(bySize).toEqual({ 'gold/c1': 36, 'platinum/c1': 12, 'silver/c1': 12 });
  });

  it('finalizes cohorts in several divisions in one run', async () => {
    const silver = await makeUsers(10);
    const master = await makeUsers(10);
    await startIn(silver, 'silver');
    await startIn(master, 'master');
    await joinAll([...silver, ...master]);
    for (const [i, id] of [...silver, ...master].entries()) await award(id, i + 1);
    await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify: vi.fn() });

    expect(await row(silver[9], NEXT)).toMatchObject({ division: 'gold' });
    expect(await row(silver[0], NEXT)).toMatchObject({ division: 'bronze' });
    expect(await row(master[9], NEXT)).toMatchObject({ division: 'grandmaster' });
    expect(await row(master[0], NEXT)).toMatchObject({ division: 'diamond' });
  });

  it('the repeatable job finalizes the week before the one it runs in, even when it runs late', () => {
    expect(weekToFinalize(new Date('2026-11-22T00:00:01Z'))).toBe(WEEK);
    expect(weekToFinalize(new Date('2026-11-23T09:30:00Z'))).toBe(WEEK); // worker was down at midnight
    expect(weekToFinalize(new Date('2026-11-22T00:00:01Z'), '2026-11-08')).toBe('2026-11-08');
    expect(() => weekToFinalize(new Date(), '2026-11-09')).toThrow(/Invalid league week key/);
  });
});

describe('rebuilding from the XpTransaction ledger after Redis is flushed', () => {
  async function ledger(userId: string, xp: number, createdAt: Date) {
    await XpTransaction.create({
      userId: new Types.ObjectId(userId), sourceType: 'dsa_accepted', sourceId: `ledger-${++counter}`,
      xpAwarded: xp, previousTotalXp: 0, newTotalXp: xp, levelBefore: 1, levelAfter: 1, createdAt,
    });
  }

  it('restores every cohort score from the ledger, counting only this week and only after the user joined', async () => {
    const [a, b, c] = await makeUsers(3);
    await joinAll([a, b], new Date('2026-11-15T08:00:00Z'));
    await joinAll([c], new Date('2026-11-19T00:00:00Z'));

    await ledger(a, 10, new Date('2026-11-16T10:00:00Z'));
    await ledger(a, 5, new Date('2026-11-20T10:00:00Z'));
    await ledger(b, 50, new Date('2026-11-14T23:00:00Z')); // previous week
    await ledger(b, 7, new Date('2026-11-22T00:00:00Z')); // next week
    await ledger(c, 30, new Date('2026-11-17T10:00:00Z')); // before c joined
    await ledger(c, 9, new Date('2026-11-20T10:00:00Z'));

    store.flush();
    expect(await rebuildWeekFromLedger(WEEK, store)).toBe(1);

    const key = cohortKey(WEEK, 'bronze', 'c1');
    expect(store.score(key, a)).toBe(15);
    expect(store.score(key, b)).toBe(0);
    expect(store.score(key, c)).toBe(9);
  });

  it('standings reads rebuild a missing cohort on demand', async () => {
    const [a, b] = await makeUsers(2);
    await joinAll([a, b], new Date('2026-11-15T00:00:00Z'));
    await ledger(a, 40, new Date('2026-11-16T10:00:00Z'));
    await ledger(b, 15, new Date('2026-11-17T10:00:00Z'));
    store.flush();

    const view = await getCurrentStandings(a, store, MID_WEEK);
    expect(view.standings.map(s => [s.userId, s.points])).toEqual([[a, 40], [b, 15]]);
    expect(view.me).toEqual({ rank: 1, points: 40 });
  });

  it('a rollover run after a flush ranks from the ledger instead of treating everybody as 0', async () => {
    const ids = await makeUsers(10);
    await startIn(ids, 'gold');
    await joinAll(ids, new Date('2026-11-15T00:00:00Z'));
    for (const [i, id] of ids.entries()) await ledger(id, (i + 1) * 10, new Date('2026-11-17T10:00:00Z'));
    store.flush();

    await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, notify: vi.fn() });
    expect(await row(ids[9], WEEK)).toMatchObject({ rank: 1, points: 100, outcome: 'promoted' });
    expect(await row(ids[0], WEEK)).toMatchObject({ rank: 10, points: 10, outcome: 'demoted' });
  });
});

describe('current standings view', () => {
  it('tells a non-participant to opt in and still reports the countdown', async () => {
    const [userId] = await makeUsers(1, false);
    const view = await getCurrentStandings(userId, store, MID_WEEK);
    expect(view).toMatchObject({
      participating: false, weekKey: WEEK, standings: [], me: null,
      weekStartsAt: '2026-11-15T00:00:00.000Z', resetsAt: '2026-11-22T00:00:00.000Z',
    });
    expect(view.secondsUntilReset).toBe(Math.ceil((Date.parse('2026-11-22T00:00:00Z') - MID_WEEK.getTime()) / 1000));
  });

  it('lists the cohort best first with rank, username, avatar and points', async () => {
    const [a, b, c] = await makeUsers(3);
    await User.insertMany([
      { _id: new Types.ObjectId(a), clerkId: 'c-a', email: 'a@example.com', username: 'alice', displayName: 'Alice', avatarUrl: 'https://img.example/a.png' },
      { _id: new Types.ObjectId(b), clerkId: 'c-b', email: 'b@example.com', username: 'bob', displayName: 'Bob', avatarUrl: null },
      { _id: new Types.ObjectId(c), clerkId: 'c-c', email: 'c@example.com', username: 'carol', displayName: 'Carol', avatarUrl: null },
    ]);
    await joinAll([a, b, c]);
    await award(a, 20);
    await award(b, 70);
    await award(c, 45);

    const view = await getCurrentStandings(a, store, MID_WEEK);
    expect(view).toMatchObject({ participating: true, division: 'bronze', cohortId: 'c1', cohortSize: 3, promotionSlots: 0, demotionSlots: 0 });
    expect(view.me).toEqual({ rank: 3, points: 20 });
    expect(view.standings).toEqual([
      { rank: 1, userId: b, username: 'bob', displayName: 'Bob', avatarUrl: null, points: 70, isMe: false },
      { rank: 2, userId: c, username: 'carol', displayName: 'Carol', avatarUrl: null, points: 45, isMe: false },
      { rank: 3, userId: a, username: 'alice', displayName: 'Alice', avatarUrl: 'https://img.example/a.png', points: 20, isMe: true },
    ]);
  });

  it('only shows members of the caller\'s own cohort', async () => {
    const ids = await makeUsers(31);
    await joinAll(ids);
    const view = await getCurrentStandings(ids[30], store, MID_WEEK);
    expect(view.cohortId).toBe('c2');
    expect(view.standings.map(s => s.userId)).toEqual([ids[30]]);
  });

  it('places a participant who has no row yet and reports the 20% zones of a full cohort', async () => {
    const ids = await makeUsers(30);
    await joinAll(ids.slice(0, 29));
    const view = await getCurrentStandings(ids[29], store, MID_WEEK);
    expect(view).toMatchObject({ cohortSize: 30, promotionSlots: 6, demotionSlots: 6 });
  });
});
