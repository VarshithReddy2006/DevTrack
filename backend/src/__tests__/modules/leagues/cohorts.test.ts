import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { LeagueCohort, LeagueStanding } from '../../../db/models/index.js';
import { TARGET_COHORT_SIZE } from '../../../modules/leagues/leagues.constants.js';
import { joinCurrentWeek, setParticipation } from '../../../modules/leagues/leagues.service.js';
import { assignCohorts, cohortIdFor, partitionIntoCohorts, pickCohortForLateJoiner } from '../../../modules/leagues/cohorts.js';
import { FakeScoreStore } from './fakeScoreStore.js';

const users = (n: number) => Array.from({ length: n }, (_, i) => `user-${String(i).padStart(3, '0')}`);
const objectIds = (n: number) => Array.from({ length: n }, () => new Types.ObjectId().toString());
const MID_WEEK = new Date('2026-11-18T12:00:00.000Z');
const WEEK = '2026-11-15';

describe('partitionIntoCohorts', () => {
  it('returns nothing for an empty division', () => {
    expect(partitionIntoCohorts([], 'seed')).toEqual([]);
  });

  it('keeps a division smaller than the minimum in a single cohort', () => {
    expect(partitionIntoCohorts(users(4), 'seed')).toHaveLength(1);
  });

  it('fills cohorts of 30', () => {
    const cohorts = partitionIntoCohorts(users(60), 'seed');
    expect(cohorts.map(c => c.length)).toEqual([30, 30]);
  });

  it('keeps a leftover of exactly the minimum (10) as its own cohort', () => {
    expect(partitionIntoCohorts(users(70), 'seed').map(c => c.length)).toEqual([30, 30, 10]);
  });

  it('merges a leftover smaller than 10 into the previous cohort', () => {
    expect(partitionIntoCohorts(users(69), 'seed').map(c => c.length)).toEqual([30, 39]);
    expect(partitionIntoCohorts(users(31), 'seed').map(c => c.length)).toEqual([31]);
    expect(partitionIntoCohorts(users(129), 'seed').map(c => c.length)).toEqual([30, 30, 30, 39]);
  });

  it('places every user exactly once, even if the input repeats an id', () => {
    const ids = [...users(45), 'user-000', 'user-001'];
    const placed = partitionIntoCohorts(ids, 'seed').flat();
    expect(placed).toHaveLength(45);
    expect(new Set(placed).size).toBe(45);
  });

  it('is deterministic for a seed and independent of input order', () => {
    const forward = partitionIntoCohorts(users(75), 'week-a');
    const backward = partitionIntoCohorts([...users(75)].reverse(), 'week-a');
    expect(backward).toEqual(forward);
  });

  it('shuffles differently for another seed', () => {
    expect(partitionIntoCohorts(users(75), 'week-a')).not.toEqual(partitionIntoCohorts(users(75), 'week-b'));
  });

  it('honours custom sizing', () => {
    expect(partitionIntoCohorts(users(25), 'seed', { target: 10, min: 5 }).map(c => c.length)).toEqual([10, 10, 5]);
    expect(partitionIntoCohorts(users(23), 'seed', { target: 10, min: 5 }).map(c => c.length)).toEqual([10, 13]);
  });
});

describe('assignCohorts', () => {
  it('labels cohorts c1, c2, ... and covers all users', () => {
    const assignments = assignCohorts(users(61), 'seed');
    expect(new Set(assignments.map(a => a.cohortId))).toEqual(new Set(['c1', 'c2']));
    expect(assignments).toHaveLength(61);
    expect(cohortIdFor(0)).toBe('c1');
  });
});

describe('pickCohortForLateJoiner', () => {
  it('starts c1 when the division has no cohorts yet', () => {
    expect(pickCohortForLateJoiner(new Map())).toBe('c1');
  });

  it('joins the emptiest cohort that has room', () => {
    expect(pickCohortForLateJoiner(new Map([['c1', 30], ['c2', 12], ['c3', 20]]))).toBe('c2');
  });

  it('breaks size ties by cohort number, not by string order', () => {
    expect(pickCohortForLateJoiner(new Map([['c10', 5], ['c2', 5]]))).toBe('c2');
  });

  it('opens a new cohort when every cohort is full', () => {
    expect(pickCohortForLateJoiner(new Map([['c1', 30], ['c2', 30]]))).toBe('c3');
  });
});

describe('concurrent late-joiner cohort reservation', () => {
  async function cohortSizesForWeek(weekKey = WEEK) {
    return LeagueStanding.aggregate<{ _id: string; count: number }>([
      { $match: { weekKey, division: 'bronze', status: 'active' } },
      { $group: { _id: '$cohortId', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
  }

  it('partitions 50 parallel joinCurrentWeek calls without exceeding TARGET_COHORT_SIZE or starving cohorts', async () => {
    const store = new FakeScoreStore();
    const userIds = objectIds(50);

    await Promise.all(userIds.map(id => joinCurrentWeek(id, MID_WEEK, store)));

    const cohorts = await cohortSizesForWeek();
    expect(cohorts.every(c => c.count <= TARGET_COHORT_SIZE)).toBe(true);
    expect(cohorts).toEqual([
      { _id: 'c1', count: 30 },
      { _id: 'c2', count: 20 },
    ]);

    const cohortDocs = await LeagueCohort.find({ weekKey: WEEK, division: 'bronze' }).sort({ cohortIndex: 1 }).lean();
    expect(cohortDocs.map(c => ({ id: c.cohortId, memberCount: c.memberCount }))).toEqual([
      { id: 'c1', memberCount: 30 },
      { id: 'c2', memberCount: 20 },
    ]);
  });

  it('prevents over-allocation when 20 users concurrently race for the final slot of c1', async () => {
    const store = new FakeScoreStore();
    const initial = objectIds(29);
    for (const id of initial) {
      await joinCurrentWeek(id, MID_WEEK, store);
    }

    const burst = objectIds(20);
    await Promise.all(burst.map(id => joinCurrentWeek(id, MID_WEEK, store)));

    const cohorts = await cohortSizesForWeek();
    expect(cohorts.every(c => c.count <= TARGET_COHORT_SIZE)).toBe(true);
    expect(cohorts).toEqual([
      { _id: 'c1', count: 30 },
      { _id: 'c2', count: 19 },
    ]);
  });

  it('bootstraps cohort metadata from pre-existing LeagueStanding rows before concurrent late joins', async () => {
    const store = new FakeScoreStore();
    const seeded = objectIds(29);
    await LeagueStanding.insertMany(
      seeded.map(id => ({
        weekKey: WEEK,
        userId: new Types.ObjectId(id),
        division: 'bronze',
        cohortId: 'c1',
        status: 'active',
        joinedAt: MID_WEEK,
      })),
    );

    const lateJoiners = objectIds(15);
    await Promise.all(lateJoiners.map(id => joinCurrentWeek(id, MID_WEEK, store)));

    const cohorts = await cohortSizesForWeek();
    expect(cohorts.every(c => c.count <= TARGET_COHORT_SIZE)).toBe(true);
    expect(cohorts).toEqual([
      { _id: 'c1', count: 30 },
      { _id: 'c2', count: 14 },
    ]);
  });

  it('compensates reserved slots when one user joins concurrently multiple times', async () => {
    const store = new FakeScoreStore();
    const repeatedUser = new Types.ObjectId().toString();
    const others = objectIds(29);

    const [repeatedResults] = await Promise.all([
      Promise.all(Array.from({ length: 5 }, () => joinCurrentWeek(repeatedUser, MID_WEEK, store))),
      Promise.all(others.map(id => joinCurrentWeek(id, MID_WEEK, store))),
    ]);

    expect(new Set(repeatedResults.map(r => r.cohortId)).size).toBe(1);
    const cohorts = await cohortSizesForWeek();
    expect(cohorts).toEqual([{ _id: 'c1', count: 30 }]);

    const cohortDoc = await LeagueCohort.findOne({ weekKey: WEEK, division: 'bronze', cohortId: 'c1' }).lean();
    expect(cohortDoc?.memberCount).toBe(30);
  });

  it('frees a cohort slot when a member opts out so the next late joiner refills it', async () => {
    const store = new FakeScoreStore();
    const initial = objectIds(30);
    await Promise.all(initial.map(id => joinCurrentWeek(id, MID_WEEK, store)));

    await setParticipation(initial[0], false, MID_WEEK, store);
    const newcomer = new Types.ObjectId().toString();
    const row = await joinCurrentWeek(newcomer, MID_WEEK, store);

    expect(row.cohortId).toBe('c1');
    expect(await cohortSizesForWeek()).toEqual([{ _id: 'c1', count: 30 }]);
  });
});
