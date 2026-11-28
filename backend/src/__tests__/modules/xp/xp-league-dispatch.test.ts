// A committed XP award whose league enqueue failed must still reach the weekly board, once.
// The ledger is a small in-memory fake and league jobs are applied to FakeScoreStore, so
// the test needs neither MongoDB nor Redis.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { LeagueScoreJobData } from '../../../shared/jobs/types.js';

const fixtures = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('../../../modules/leagues/workers/leagueScore.worker.js', () => ({ enqueueLeagueScore: fixtures.enqueue }));
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitXpUpdated: vi.fn(), emitLevelUp: vi.fn() } }));
vi.mock('../../../shared/cache/cacheManager.js', () => ({ cacheManager: { invalidateAllUserCache: vi.fn() } }));
vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: { updateFromEvent: vi.fn() },
}));
vi.mock('../../../modules/missions/missionProgress.service.js', () => ({ updateMissionProgress: vi.fn() }));

import { LeagueStanding, UserAnalytics, UserXp, XpTransaction } from '../../../db/models/index.js';
import { processXpEvent } from '../../../modules/xp/processor.js';
import { recordXpAward } from '../../../modules/leagues/leagues.service.js';
import { cohortKey } from '../../../modules/leagues/leagues.constants.js';
import { weekKeyFor } from '../../../modules/leagues/weeks.js';
import { FakeScoreStore } from '../leagues/fakeScoreStore.js';

type Row = Record<string, any>;

/** A Mongoose-style query: awaitable, with a chainable `.session()`. */
function query<T>(value: () => T) {
  const q = {
    session: () => q,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve().then(value).then(resolve, reject),
  };
  return q as never;
}

let ledger: Row[];
let delivered: LeagueScoreJobData[];

const userId = new Types.ObjectId().toString();
const event = { userId, sourceType: 'dsa_accepted' as const, sourceId: 'sub-1', difficulty: 'hard' as const };

beforeEach(() => {
  vi.restoreAllMocks();
  ledger = [];
  delivered = [];
  fixtures.enqueue.mockReset().mockImplementation(async (job: LeagueScoreJobData) => { delivered.push(job); });

  const matches = (row: Row, filter: Row) =>
    Object.entries(filter).every(([key, value]) => String(row[key] ?? null) === String(value));
  vi.spyOn(XpTransaction, 'findOne').mockImplementation(((filter: Row) =>
    query(() => ledger.find(row => matches(row, filter)) ?? null)) as never);
  vi.spyOn(XpTransaction, 'create').mockImplementation((async (docs: Row[]) => docs.map(doc => {
    const row = { _id: new Types.ObjectId(), createdAt: new Date(), ...doc };
    ledger.push(row);
    return row;
  })) as never);
  vi.spyOn(XpTransaction, 'updateOne').mockImplementation((async (filter: Row, update: Row) => {
    Object.assign(ledger.find(row => matches(row, filter))!, update.$set);
  }) as never);
  vi.spyOn(XpTransaction, 'find').mockImplementation((() => query(() => ledger)) as never);

  const wallet = { _id: new Types.ObjectId(), totalXp: 0, currentLevel: 1, lifetimeStats: {} };
  vi.spyOn(UserXp.db, 'transaction').mockImplementation((async (fn: (session: object) => unknown) => fn({})) as never);
  vi.spyOn(UserXp, 'updateOne').mockImplementation((async () => ({})) as never);
  vi.spyOn(UserXp, 'findOne').mockImplementation((() => query(() => wallet)) as never);
  vi.spyOn(UserAnalytics, 'findOne').mockImplementation((() => query(() => ({ totalXp: 1_000_000 }))) as never);
  vi.spyOn(UserAnalytics, 'findOneAndUpdate').mockImplementation((async () => null) as never);
});

afterEach(() => { vi.restoreAllMocks(); });

/** Runs every queued league job through the real scoring code and returns the user's points. */
async function leaguePoints(store = new FakeScoreStore()): Promise<number> {
  const weekKey = weekKeyFor(ledger[0].createdAt);
  vi.spyOn(LeagueStanding, 'findOne').mockReturnValue({
    lean: async () => ({ weekKey, division: 'bronze', cohortId: 'c1', status: 'active', joinedAt: new Date(0) }),
  } as never);
  for (const job of delivered) await recordXpAward({ ...job, occurredAt: new Date(job.occurredAt) }, store);
  return store.score(cohortKey(weekKey, 'bronze', 'c1'), userId) ?? 0;
}

describe('league score dispatch on XP event replay', () => {
  it('delivers a score whose first enqueue failed exactly once', async () => {
    fixtures.enqueue.mockRejectedValueOnce(new Error('redis down'));

    const first = await processXpEvent(event);
    expect(first).toMatchObject({ awarded: true, xpAwarded: 50 });
    expect(delivered).toEqual([]);

    const replay = await processXpEvent(event);
    expect(replay).toMatchObject({ awarded: false, duplicate: true, xpAwarded: 0 });
    expect(delivered).toEqual([{
      userId, sourceType: 'dsa_accepted', sourceId: 'sub-1', xpAwarded: 50,
      occurredAt: ledger[0].createdAt.toISOString(), requestId: undefined,
    }]);
    expect(ledger[0].leagueDispatchedAt).toBeInstanceOf(Date);

    await processXpEvent(event);
    expect(delivered).toHaveLength(1);
    expect(ledger).toHaveLength(1);
    expect(await leaguePoints()).toBe(50);
  });

  it('does not enqueue again when the first dispatch succeeded', async () => {
    await processXpEvent(event);
    await processXpEvent(event);
    await processXpEvent(event);

    expect(delivered).toHaveLength(1);
    expect(await leaguePoints()).toBe(50);
  });

  it('keeps retrying on later replays while the queue stays down', async () => {
    fixtures.enqueue.mockRejectedValueOnce(new Error('redis down')).mockRejectedValueOnce(new Error('redis down'));

    await processXpEvent(event);
    await expect(processXpEvent(event)).resolves.toMatchObject({ duplicate: true });
    expect(delivered).toEqual([]);

    await processXpEvent(event);
    expect(fixtures.enqueue).toHaveBeenCalledTimes(3);
    expect(delivered).toHaveLength(1);
  });

  it('counts the points once when the job was queued but the marker write failed', async () => {
    vi.mocked(XpTransaction.updateOne).mockRejectedValueOnce(new Error('primary stepped down'));

    await expect(processXpEvent(event)).resolves.toMatchObject({ awarded: true });
    await processXpEvent(event);

    expect(delivered).toHaveLength(2);
    expect(delivered[1].occurredAt).toBe(delivered[0].occurredAt);
    expect(await leaguePoints()).toBe(50);
  });

  it('reconciles when the replay is only detected inside the transaction', async () => {
    fixtures.enqueue.mockRejectedValueOnce(new Error('redis down'));
    await processXpEvent(event);
    // The pre-check misses the row, as it does when two workers race on one event.
    vi.mocked(XpTransaction.findOne).mockImplementationOnce((() => query(() => null)) as never);

    await expect(processXpEvent(event)).resolves.toMatchObject({ duplicate: true });
    expect(delivered).toHaveLength(1);
  });

  it('reconciles after losing the unique-index race (E11000)', async () => {
    fixtures.enqueue.mockRejectedValueOnce(new Error('redis down'));
    await processXpEvent(event);
    vi.mocked(XpTransaction.findOne).mockImplementationOnce((() => query(() => null)) as never);
    vi.mocked(UserXp.db.transaction).mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));

    await expect(processXpEvent(event)).resolves.toMatchObject({ duplicate: true });
    expect(delivered).toHaveLength(1);
  });

  it('leaves rows without a delivery marker alone', async () => {
    ledger.push({
      _id: new Types.ObjectId(), userId: new Types.ObjectId(userId), sourceType: 'dsa_accepted', sourceId: 'sub-1',
      xpAwarded: 50, newTotalXp: 50, levelAfter: 1, createdAt: new Date(),
    });

    await expect(processXpEvent(event)).resolves.toMatchObject({ duplicate: true });
    expect(fixtures.enqueue).not.toHaveBeenCalled();
  });
});
