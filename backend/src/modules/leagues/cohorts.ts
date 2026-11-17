// src/modules/leagues/cohorts.ts — Cohort partitioning for a league division (pure, no I/O).
import { createHash } from 'node:crypto';
import { MIN_COHORT_SIZE, TARGET_COHORT_SIZE } from './leagues.constants.js';

export interface CohortSizing {
  target?: number;
  min?: number;
}

export function cohortIdFor(index: number): string {
  return `c${index + 1}`;
}

/**
 * Splits the users of one division into cohorts of `target` (default 30). The order is a
 * shuffle seeded by `seed` (the week + division), so the same inputs always give the same
 * cohorts and a rerun after a crash assigns everybody the same way. A leftover group smaller
 * than `min` (default 10) is merged into the previous cohort instead of standing alone.
 */
export function partitionIntoCohorts(userIds: string[], seed: string, sizing: CohortSizing = {}): string[][] {
  const target = sizing.target ?? TARGET_COHORT_SIZE;
  const min = sizing.min ?? MIN_COHORT_SIZE;
  const shuffled = [...new Set(userIds)]
    .map(id => ({ id, order: createHash('sha1').update(`${seed}:${id}`).digest('hex') }))
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .map(entry => entry.id);

  const cohorts: string[][] = [];
  for (let i = 0; i < shuffled.length; i += target) cohorts.push(shuffled.slice(i, i + target));

  if (cohorts.length > 1 && cohorts[cohorts.length - 1].length < min) {
    const tail = cohorts.pop()!;
    cohorts[cohorts.length - 1].push(...tail);
  }
  return cohorts;
}

export interface CohortAssignment {
  userId: string;
  cohortId: string;
}

export function assignCohorts(userIds: string[], seed: string, sizing: CohortSizing = {}): CohortAssignment[] {
  return partitionIntoCohorts(userIds, seed, sizing).flatMap((members, index) =>
    members.map(userId => ({ userId, cohortId: cohortIdFor(index) })),
  );
}

/**
 * Picks the cohort for a user who joins after the week started: the emptiest cohort that is
 * still below the target size, otherwise a brand new one. Existing cohorts are never reshuffled
 * mid-week because their scores already exist.
 */
export function pickCohortForLateJoiner(sizes: Map<string, number>, sizing: CohortSizing = {}): string {
  const target = sizing.target ?? TARGET_COHORT_SIZE;
  let best: { id: string; size: number; index: number } | null = null;
  let highestIndex = 0;
  for (const [id, size] of sizes) {
    const index = Number(id.slice(1));
    highestIndex = Math.max(highestIndex, index);
    if (size >= target) continue;
    if (!best || size < best.size || (size === best.size && index < best.index)) best = { id, size, index };
  }
  return best ? best.id : cohortIdFor(highestIndex);
}
