// src/modules/leagues/leagues.service.ts — Weekly league membership, live scoring and standings reads.
//
// Live scores are Redis sorted sets (see scoreStore.ts). MongoDB `LeagueStanding` rows say who
// is in which cohort, so a flushed Redis can always be rebuilt from those rows plus the
// `XpTransaction` ledger.

import { Types } from 'mongoose';
import { LeagueStanding, UserSettings, User, XpTransaction } from '../../db/models/index.js';
import type { ILeagueStanding, LeagueDivision } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import { pickCohortForLateJoiner } from './cohorts.js';
import {
  DEFAULT_DIVISION,
  DEMOTION_PERCENT,
  PROMOTION_PERCENT,
  cohortKey,
  dedupeSetKey,
} from './leagues.constants.js';
import type { LeagueScoreStore } from './scoreStore.js';
import { secondsUntilReset, weekKeyFor, weekRange } from './weeks.js';

type StandingRow = Pick<ILeagueStanding, 'weekKey' | 'division' | 'cohortId' | 'status' | 'joinedAt'> & {
  userId: Types.ObjectId;
};

export interface XpAwardInput {
  userId: string;
  sourceType: string;
  sourceId: string;
  xpAwarded: number;
  /** When the XP ledger row was written. Decides which week the points belong to. */
  occurredAt: Date;
}

export type ScoreResult =
  | { applied: true; weekKey: string; score: number }
  | { applied: false; reason: 'no_xp' | 'not_participating' | 'week_closed' | 'before_join' | 'duplicate' };

export interface RankedMember {
  userId: string;
  points: number;
}

export interface LeagueStandingsView {
  participating: boolean;
  weekKey: string;
  weekStartsAt: string;
  resetsAt: string;
  secondsUntilReset: number;
  division: LeagueDivision | null;
  cohortId: string | null;
  cohortSize: number;
  promotionSlots: number;
  demotionSlots: number;
  me: { rank: number; points: number } | null;
  standings: Array<{
    rank: number;
    userId: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    points: number;
    isMe: boolean;
  }>;
}

/** Top and bottom slots for a cohort of `size` members (20% each, rounded down). */
export function zoneSlots(size: number): { promotion: number; demotion: number } {
  return {
    promotion: Math.floor((size * PROMOTION_PERCENT) / 100),
    demotion: Math.floor((size * DEMOTION_PERCENT) / 100),
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number })?.code === 11000;
}

// ─── Membership ─────────────────────────────────────────────────────────────

export async function isParticipating(userId: string): Promise<boolean> {
  return Boolean(await UserSettings.exists({ userId: new Types.ObjectId(userId), 'leagues.participate': true }));
}

/** Division a user starts the week in: where their last finalized week sent them, else bronze. */
async function divisionForNextWeek(userObjId: Types.ObjectId): Promise<LeagueDivision> {
  const last = await LeagueStanding.findOne({ userId: userObjId, status: 'finalized' })
    .sort({ weekKey: -1 })
    .select('nextDivision')
    .lean();
  return last?.nextDivision ?? DEFAULT_DIVISION;
}

/**
 * Places the user in a cohort for the week containing `now`. Safe to call repeatedly:
 * an existing row for the week is returned untouched (the unique week+user index
 * settles concurrent calls).
 */
export async function joinCurrentWeek(userId: string, now: Date, store: LeagueScoreStore): Promise<StandingRow> {
  const userObjId = new Types.ObjectId(userId);
  const weekKey = weekKeyFor(now);

  const existing = await LeagueStanding.findOne({ weekKey, userId: userObjId }).lean<StandingRow>();
  if (existing) return existing;

  const division = await divisionForNextWeek(userObjId);
  const counts = await LeagueStanding.aggregate<{ _id: string; n: number }>([
    { $match: { weekKey, division, status: 'active' } },
    { $group: { _id: '$cohortId', n: { $sum: 1 } } },
  ]);
  const cohortId = pickCohortForLateJoiner(new Map(counts.map(c => [c._id, c.n])));

  let row: StandingRow;
  try {
    const created = await LeagueStanding.create({
      weekKey, userId: userObjId, division, cohortId, status: 'active', joinedAt: now,
    });
    row = created.toObject() as StandingRow;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    return (await LeagueStanding.findOne({ weekKey, userId: userObjId }).lean<StandingRow>())!;
  }
  await store.seed(cohortKey(weekKey, row.division, row.cohortId), [userId]);
  return row;
}

/** Opt in or out. Opting out removes the user from the live week; finished weeks stay as history. */
export async function setParticipation(
  userId: string,
  participate: boolean,
  now: Date,
  store: LeagueScoreStore,
): Promise<{ participating: boolean }> {
  const userObjId = new Types.ObjectId(userId);
  await UserSettings.updateOne({ userId: userObjId }, { $set: { 'leagues.participate': participate } }, { upsert: true });

  if (participate) {
    await joinCurrentWeek(userId, now, store);
  } else {
    const weekKey = weekKeyFor(now);
    const row = await LeagueStanding.findOneAndDelete({ weekKey, userId: userObjId, status: 'active' }).lean<StandingRow>();
    if (row) await store.remove(cohortKey(weekKey, row.division, row.cohortId), userId);
  }
  return { participating: participate };
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Adds a server-awarded XP amount to the user's cohort score. Only ledger-backed awards reach
 * this point (the XP processor writes the ledger row and emits the job; focus sessions that
 * do not qualify end up with 0 XP and never produce one), so there is nothing client
 * controlled here.
 */
export async function recordXpAward(input: XpAwardInput, store: LeagueScoreStore, now = new Date()): Promise<ScoreResult> {
  if (!Number.isSafeInteger(input.xpAwarded) || input.xpAwarded <= 0) return { applied: false, reason: 'no_xp' };

  const userObjId = new Types.ObjectId(input.userId);
  const weekKey = weekKeyFor(input.occurredAt);

  let row = await LeagueStanding.findOne({ weekKey, userId: userObjId }).lean<StandingRow>();
  if (!row) {
    // Opted in but not placed yet: only possible for the running week.
    if (weekKey !== weekKeyFor(now) || !(await isParticipating(input.userId))) {
      return { applied: false, reason: 'not_participating' };
    }
    row = await joinCurrentWeek(input.userId, now, store);
  }
  if (row.status !== 'active') return { applied: false, reason: 'week_closed' };
  if (input.occurredAt < row.joinedAt) return { applied: false, reason: 'before_join' };

  const score = await store.incrementOnce(
    cohortKey(weekKey, row.division, row.cohortId),
    input.userId,
    input.xpAwarded,
    { setKey: dedupeSetKey(weekKey), id: `${input.userId}|${input.sourceType}|${input.sourceId}` },
  );
  if (score === null) return { applied: false, reason: 'duplicate' };
  return { applied: true, weekKey, score };
}

// ─── Rebuild from the XP ledger ─────────────────────────────────────────────

/**
 * Recomputes one cohort's sorted set from `XpTransaction`. Each member only counts XP
 * from their own join time onward, exactly like live scoring does.
 */
export async function rebuildCohortFromLedger(
  weekKey: string,
  division: LeagueDivision,
  cohortId: string,
  store: LeagueScoreStore,
): Promise<void> {
  const rows = await LeagueStanding.find({ weekKey, division, cohortId })
    .select('userId joinedAt')
    .lean<Array<{ userId: Types.ObjectId; joinedAt: Date }>>();
  const key = cohortKey(weekKey, division, cohortId);
  if (rows.length === 0) return;

  const { start, end } = weekRange(weekKey);
  const totals = await XpTransaction.aggregate<{ _id: Types.ObjectId; points: number }>([
    {
      $match: {
        xpAwarded: { $gt: 0 },
        $or: rows.map(row => ({
          userId: row.userId,
          createdAt: { $gte: row.joinedAt > start ? row.joinedAt : start, $lt: end },
        })),
      },
    },
    { $group: { _id: '$userId', points: { $sum: '$xpAwarded' } } },
  ]);
  const pointsByUser = new Map(totals.map(t => [t._id.toString(), t.points]));
  await store.replace(
    key,
    rows.map(row => ({ member: row.userId.toString(), score: pointsByUser.get(row.userId.toString()) ?? 0 })),
  );
  logger.info('[leagues] Rebuilt cohort standings from XP ledger', {
    event: 'league_cohort_rebuilt', weekKey, division, cohortId, members: rows.length,
  });
}

/** Rebuilds every active cohort of a week, e.g. after Redis was flushed. */
export async function rebuildWeekFromLedger(weekKey: string, store: LeagueScoreStore): Promise<number> {
  const cohorts = await LeagueStanding.aggregate<{ _id: { division: LeagueDivision; cohortId: string } }>([
    { $match: { weekKey, status: 'active' } },
    { $group: { _id: { division: '$division', cohortId: '$cohortId' } } },
  ]);
  for (const { _id } of cohorts) await rebuildCohortFromLedger(weekKey, _id.division, _id.cohortId, store);
  return cohorts.length;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * Current ranking of one cohort, highest score first, covering every member of the cohort. If the Redis set is gone it is rebuilt from the ledger first. Equal scores keep the
 * order Redis gives them (reverse lexicographic by member id), which is stable between calls.
 */
export async function readCohortBoard(
  weekKey: string,
  division: LeagueDivision,
  cohortId: string,
  store: LeagueScoreStore,
): Promise<RankedMember[]> {
  const key = cohortKey(weekKey, division, cohortId);
  if (!(await store.exists(key))) await rebuildCohortFromLedger(weekKey, division, cohortId, store);

  const members = await LeagueStanding.find({ weekKey, division, cohortId })
    .select('userId')
    .lean<Array<{ userId: Types.ObjectId }>>();
  const memberIds = new Set(members.map(m => m.userId.toString()));

  const board: RankedMember[] = (await store.ranked(key, 0, -1))
    .filter(entry => memberIds.has(entry.member))
    .map(entry => ({ userId: entry.member, points: entry.score }));
  const seen = new Set(board.map(b => b.userId));
  const missing = [...memberIds].filter(id => !seen.has(id)).sort().reverse();
  for (const userId of missing) board.push({ userId, points: 0 });
  return board;
}

export async function getCurrentStandings(userId: string, store: LeagueScoreStore, now = new Date()): Promise<LeagueStandingsView> {
  const weekKey = weekKeyFor(now);
  const { start, end } = weekRange(weekKey);
  const base = {
    weekKey,
    weekStartsAt: start.toISOString(),
    resetsAt: end.toISOString(),
    secondsUntilReset: secondsUntilReset(now),
  };

  if (!(await isParticipating(userId))) {
    return {
      ...base, participating: false, division: null, cohortId: null, cohortSize: 0,
      promotionSlots: 0, demotionSlots: 0, me: null, standings: [],
    };
  }

  const row = await joinCurrentWeek(userId, now, store);
  const board = await readCohortBoard(weekKey, row.division, row.cohortId, store);

  const profiles = await User.find({ _id: { $in: board.map(b => new Types.ObjectId(b.userId)) } })
    .select('username displayName avatarUrl')
    .lean<Array<{ _id: Types.ObjectId; username: string; displayName: string; avatarUrl: string | null }>>();
  const profileById = new Map(profiles.map(p => [p._id.toString(), p]));

  const standings = board.map((member, index) => {
    const profile = profileById.get(member.userId);
    return {
      rank: index + 1,
      userId: member.userId,
      username: profile?.username ?? null,
      displayName: profile?.displayName ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      points: member.points,
      isMe: member.userId === userId,
    };
  });
  const mine = standings.find(s => s.isMe);
  const slots = zoneSlots(board.length);

  return {
    ...base,
    participating: true,
    division: row.division,
    cohortId: row.cohortId,
    cohortSize: board.length,
    promotionSlots: slots.promotion,
    demotionSlots: slots.demotion,
    me: mine ? { rank: mine.rank, points: mine.points } : null,
    standings,
  };
}
