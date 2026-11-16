import { describe, expect, it } from 'vitest';
import { assignCohorts, cohortIdFor, partitionIntoCohorts, pickCohortForLateJoiner } from '../../../modules/leagues/cohorts.js';

const users = (n: number) => Array.from({ length: n }, (_, i) => `user-${String(i).padStart(3, '0')}`);

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
