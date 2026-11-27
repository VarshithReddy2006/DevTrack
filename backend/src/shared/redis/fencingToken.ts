// src/shared/redis/fencingToken.ts
// Monotonic fencing token storage guards for Redis distributed locks.
// Rejects out-of-order writes from workers whose lock lease expired or was superseded.

import type { FilterQuery } from 'mongoose';

/** Strictly increasing fencing token issued alongside a Redis lock lease. */
export type FencingToken = number;

/**
 * Thrown when a storage mutation attempts to commit with a fencing token that is
 * less than or equal to the version already recorded on the target document.
 */
export class StaleFencingTokenError extends Error {
  public readonly token: FencingToken;
  public readonly target: string;
  public readonly observedVersion: number | null;

  constructor(token: FencingToken, target: string, observedVersion: number | null = null) {
    super(
      `Stale fencing token ${token} rejected for ${target}` +
        (observedVersion !== null ? ` (current stateVersion: ${observedVersion})` : '')
    );
    this.name = 'StaleFencingTokenError';
    this.token = token;
    this.target = target;
    this.observedVersion = observedVersion;
    Object.setPrototypeOf(this, StaleFencingTokenError.prototype);
  }
}

/**
 * Wraps a MongoDB filter so updates succeed only when the stored version is strictly
 * less than the caller's fencing token (or not yet initialized). When token is null,
 * the original filter is returned unchanged so unfenced callers remain unaffected.
 */
export function fencedFilter<T>(
  filter: FilterQuery<T>,
  token: FencingToken | null | undefined,
  field = 'stateVersion'
): FilterQuery<T> {
  if (token === null || token === undefined) {
    return filter;
  }

  return {
    $and: [
      filter,
      {
        $or: [
          { [field]: { $lt: token } },
          { [field]: { $exists: false } },
          { [field]: null },
        ],
      },
    ],
  } as FilterQuery<T>;
}

/**
 * Returns the `$set` fragment recording the active fencing token on the target document.
 */
export function fenceStamp(
  token: FencingToken | null | undefined,
  field = 'stateVersion'
): Record<string, number> {
  return token === null || token === undefined ? {} : { [field]: token };
}

/**
 * Checks whether a Mongoose/MongoDB error is a duplicate-key collision (E11000),
 * which occurs on upsert when a fenced filter rejects an update on an existing document.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === 11000) {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('E11000');
}
