import { Types } from 'mongoose';
import { DsaContest, type IDsaContestRatingSyncCheckpoint } from '../../db/models/dsaContest.model.js';
import { DsaContestParticipation } from '../../db/models/dsaContestParticipation.model.js';
import { UserSettings } from '../../db/models/userSettings.model.js';
import { CircuitBreaker, CircuitOpenError } from '../../shared/circuit-breaker/circuitBreaker.js';
import { getOrCreateQueue } from '../../shared/jobs/queueFactory.js';
import { QueueNames } from '../../shared/jobs/types.js';
import { logger } from '../../shared/logger.js';
import { eventBus } from '../../shared/sse/eventBus.js';
import {
  ContestProviderRateLimit,
  fetchCodeforcesResults,
  fetchLeetcodeResult,
  type ContestResult,
} from './contestRatingSources.js';

export const CONTEST_RATING_DELAY_MS = 2 * 3600_000;
export const CONTEST_RATING_LOOKBACK_MS = 7 * 24 * 3600_000;
export const CONTEST_RATING_BATCH_SIZE = 25;
export const CONTEST_RATING_CONCURRENCY = 2;
export const CONTEST_RATING_REQUEST_DELAY_MS = 500;
export const CONTEST_RATING_BACKOFF_BASE_MS = 1_000;
export const CONTEST_RATING_MAX_BACKOFF_MS = 16_000;
export const CONTEST_RATING_MAX_RATE_LIMIT_RETRIES = 2;
export const CONTEST_RATING_CIRCUIT_FAILURE_THRESHOLD = 3;
export const CONTEST_RATING_CIRCUIT_RESET_TIMEOUT_MS = 30_000;
export const CONTEST_RATING_MAX_CIRCUIT_COOLDOWN_MS = 15 * 60_000;
export const CONTEST_RATING_CHECKPOINT_TTL_MS = 55 * 60_000;

const resultFields = ['handle', 'rank', 'score', 'problemsSolved', 'ratingBefore', 'ratingAfter', 'ratingChange'] as const;

export interface SyncContestRatingsOptions {
  batchSize?: number;
  concurrency?: number;
  requestDelayMs?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  maxRateLimitRetries?: number;
  circuitFailureThreshold?: number;
  circuitResetTimeoutMs?: number;
  maxCircuitCooldownMs?: number;
  rescheduleOnPause?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SyncContestRatingsResult {
  changed: number;
  failed: number;
  paused?: boolean;
  retryAfterMs?: number;
}

interface SettingsLeanRow {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  platforms: {
    codeforces?: { handle?: string };
    leetcode?: { username?: string };
  };
}

type ItemOutcome =
  | { status: 'done'; changed: number }
  | { status: 'failed' }
  | { status: 'aborted' };

class ContestProviderCircuitController {
  private breaker: CircuitBreaker;
  private cooldownUntil = 0;
  private consecutiveTrips = 0;
  private forcedOpen = false;

  constructor(
    private readonly name: string,
    private failureThreshold: number
  ) {
    this.breaker = this.createBreaker(failureThreshold);
  }

  private createBreaker(failureThreshold: number): CircuitBreaker {
    return new CircuitBreaker({
      name: this.name,
      failureThreshold,
      // Cooldown timing (exponential backoff + Retry-After) is enforced by cooldownUntil.
      resetTimeoutMs: 0,
      successThreshold: 1,
    });
  }

  configure(failureThreshold: number): void {
    const normalized = Math.max(1, Math.floor(failureThreshold));
    if (normalized !== this.failureThreshold) {
      this.failureThreshold = normalized;
      this.breaker = this.createBreaker(normalized);
      this.cooldownUntil = 0;
      this.consecutiveTrips = 0;
      this.forcedOpen = false;
    }
  }

  getRemainingCooldownMs(now = Date.now()): number {
    if (this.breaker.getState() === 'closed' && !this.forcedOpen) return 0;
    if (this.cooldownUntil === 0) return 0;
    return Math.max(0, this.cooldownUntil - now);
  }

  getState(now = Date.now()): 'closed' | 'open' | 'half_open' {
    if (this.forcedOpen) {
      return this.getRemainingCooldownMs(now) > 0 ? 'open' : 'half_open';
    }
    if (this.breaker.getState() === 'open') {
      if (this.cooldownUntil === 0) return 'open';
      return this.getRemainingCooldownMs(now) > 0 ? 'open' : 'half_open';
    }
    return this.breaker.getState();
  }

  getConsecutiveTrips(): number {
    return this.consecutiveTrips;
  }

  async execute<T>(fn: () => Promise<T>, now = Date.now()): Promise<T> {
    if (this.getState(now) === 'half_open') {
      // Previous trip's cooldown has elapsed; clear it so a failed probe
      // reports 'open' cleanly and receives a fresh exponential cooldown.
      this.forcedOpen = false;
      this.cooldownUntil = 0;
    }
    const result = await this.breaker.execute(fn);
    if (this.breaker.getState() === 'closed') {
      this.forcedOpen = false;
      this.consecutiveTrips = 0;
      this.cooldownUntil = 0;
    }
    return result;
  }

  openWithBackoff(
    baseResetMs: number,
    maxCooldownMs: number,
    retryAfterMs?: number,
    priorTrips = 0,
    now = Date.now()
  ): number {
    this.forcedOpen = true;
    this.consecutiveTrips = Math.max(this.consecutiveTrips, priorTrips) + 1;
    const expCooldown = Math.min(maxCooldownMs, baseResetMs * (2 ** (this.consecutiveTrips - 1)));
    const cooldownMs = Math.min(maxCooldownMs, Math.max(expCooldown, retryAfterMs ?? 0));
    this.cooldownUntil = now + cooldownMs;
    return cooldownMs;
  }

  reset(): void {
    this.breaker.reset();
    this.cooldownUntil = 0;
    this.consecutiveTrips = 0;
    this.forcedOpen = false;
  }
}

const providerCircuits = {
  leetcode: new ContestProviderCircuitController('contest-rating-leetcode', CONTEST_RATING_CIRCUIT_FAILURE_THRESHOLD),
  codeforces: new ContestProviderCircuitController('contest-rating-codeforces', CONTEST_RATING_CIRCUIT_FAILURE_THRESHOLD),
};

/** Resets shared contest-rating circuit breaker state (intended for test isolation). */
export function resetContestRatingCircuitBreakers(): void {
  providerCircuits.leetcode.reset();
  providerCircuits.codeforces.reset();
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classifyProviderError(
  error: unknown,
  maxBackoffMs: number
): { isRateLimitOrOverload: boolean; retryAfterMs?: number; immediatePause: boolean } {
  if (error instanceof ContestProviderRateLimit) {
    return {
      isRateLimitOrOverload: true,
      retryAfterMs: error.retryAfterMs,
      immediatePause: error.hasRetryAfterHeader && error.retryAfterMs > maxBackoffMs,
    };
  }
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined;
  if (status === 429 || status === 503) {
    return { isRateLimitOrOverload: true, immediatePause: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:429|503)\b|rate limit|too many requests|service unavailable/i.test(message)) {
    return { isRateLimitOrOverload: true, immediatePause: false };
  }
  return { isRateLimitOrOverload: false, immediatePause: false };
}

/** Runs async work items with bounded concurrency, preserving input order in outcomes. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}

async function persistCheckpoint(
  contestId: Types.ObjectId,
  checkpoint: IDsaContestRatingSyncCheckpoint | null
): Promise<void> {
  await DsaContest.updateOne(
    { _id: contestId },
    checkpoint ? { $set: { ratingSyncCheckpoint: checkpoint } } : { $set: { ratingSyncCheckpoint: null } }
  );
}

async function rescheduleRemainingUsers(contestId: string, delayMs: number): Promise<void> {
  try {
    const queue = getOrCreateQueue(QueueNames.CONTEST_RATING_SYNC);
    const resumeBucket = Math.floor((Date.now() + delayMs) / Math.max(1000, delayMs));
    await queue.add(
      'contest-rating-sync',
      { task: 'sync', contestId },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        delay: Math.max(0, Math.round(delayMs)),
        jobId: `contest-rating-resume-${contestId}-${resumeBucket}-${Date.now()}`,
      }
    );
  } catch (error) {
    logger.warn('[contest-rating] Failed to reschedule remaining users', {
      contestId,
      delayMs,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function saveUserParticipation(params: {
  settings: SettingsLeanRow;
  contestId: Types.ObjectId;
  contestIdStr: string;
  platform: 'codeforces' | 'leetcode';
  handleField: string;
  rawHandle: string;
  handle: string;
  result: ContestResult;
  observedAt: Date;
}): Promise<number> {
  const { settings, contestId, contestIdStr, platform, handleField, rawHandle, handle, result, observedAt } = params;
  const userId = settings.userId.toString();
  if (!await UserSettings.exists({ _id: settings._id, userId, [handleField]: rawHandle })) return 0;

  const key = { userId: new Types.ObjectId(userId), contestId };
  const existing = await DsaContestParticipation.findOne(key).lean();
  const values: ContestResult & { handle: string } = { ...result, handle };
  if (existing?.handle.toLowerCase() === handle.toLowerCase() && existing.ratingAfter != null && values.ratingAfter === null) {
    values.ratingBefore = existing.ratingBefore ?? null;
    values.ratingAfter = existing.ratingAfter ?? null;
    values.ratingChange = existing.ratingChange ?? null;
  }

  let before;
  try {
    before = await DsaContestParticipation.findOneAndUpdate(
      {
        ...key,
        $or: [{ observedAt: { $lte: observedAt } }, { observedAt: { $exists: false } }],
      },
      { $set: { ...values, platform, observedAt } },
      { upsert: true, returnDocument: 'before', runValidators: true }
    ).lean();
  } catch (error) {
    // A concurrent insert/newer observation won the unique key. The next
    // hourly reconciliation can refresh it; an old request must not overwrite it.
    if ((error as { code?: number }).code === 11000) return 0;
    throw error;
  }

  if (before && resultFields.every(field => before[field] === values[field])) return 0;

  try {
    await eventBus.publishEnvelope(userId, 'contest.rating_updated', {
      contestId: contestIdStr,
      platform,
      ...values,
    });
  } catch {
    logger.warn('[contest-rating] SSE delivery failed after participation save', { userId, contestId: contestIdStr });
  }

  return 1;
}

/**
 * Synchronizes post-contest ratings for all eligible linked users using batched keyset pagination,
 * bounded concurrency with request pacing, exponential backoff on 429/503 responses, and a
 * checkpointed circuit breaker so retries resume from remaining users.
 */
export async function syncContestRatings(
  contestId: string,
  options: SyncContestRatingsOptions = {}
): Promise<SyncContestRatingsResult> {
  if (!Types.ObjectId.isValid(contestId)) throw new Error('Invalid contest ID');

  const batchSize = Math.max(1, Math.floor(options.batchSize ?? CONTEST_RATING_BATCH_SIZE));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? CONTEST_RATING_CONCURRENCY));
  const requestDelayMs = Math.max(0, options.requestDelayMs ?? CONTEST_RATING_REQUEST_DELAY_MS);
  const backoffBaseMs = Math.max(0, options.backoffBaseMs ?? CONTEST_RATING_BACKOFF_BASE_MS);
  const maxBackoffMs = Math.max(backoffBaseMs, options.maxBackoffMs ?? CONTEST_RATING_MAX_BACKOFF_MS);
  const maxRateLimitRetries = Math.max(0, Math.floor(options.maxRateLimitRetries ?? CONTEST_RATING_MAX_RATE_LIMIT_RETRIES));
  const circuitFailureThreshold = Math.max(1, Math.floor(options.circuitFailureThreshold ?? CONTEST_RATING_CIRCUIT_FAILURE_THRESHOLD));
  const circuitResetTimeoutMs = Math.max(1, options.circuitResetTimeoutMs ?? CONTEST_RATING_CIRCUIT_RESET_TIMEOUT_MS);
  const maxCircuitCooldownMs = Math.max(circuitResetTimeoutMs, options.maxCircuitCooldownMs ?? CONTEST_RATING_MAX_CIRCUIT_COOLDOWN_MS);
  const rescheduleOnPause = options.rescheduleOnPause ?? true;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  const observedAt = new Date(now());
  const contest = await DsaContest.findOne({
    _id: contestId,
    kind: 'scheduled',
    platform: { $in: ['codeforces', 'leetcode'] },
    endTime: { $lte: new Date(observedAt.getTime() - CONTEST_RATING_DELAY_MS) },
  }).lean();
  if (!contest || !contest.externalId || !contest.startTime) return { changed: 0, failed: 0 };

  const platform = contest.platform as 'codeforces' | 'leetcode';
  const handleField = platform === 'codeforces' ? 'platforms.codeforces.handle' : 'platforms.leetcode.username';
  const settingsFilter = { [handleField]: { $type: 'string', $regex: /\S/ } };
  if (!await UserSettings.exists(settingsFilter)) return { changed: 0, failed: 0 };

  await DsaContestParticipation.init();

  if (platform === 'codeforces') {
    return syncCodeforcesContest(contest._id, contestId, contest.externalId, settingsFilter, handleField, observedAt);
  }

  const circuit = providerCircuits.leetcode;
  circuit.configure(circuitFailureThreshold);

  const openCooldownMs = circuit.getRemainingCooldownMs(now());
  if (openCooldownMs > 0) {
    logger.warn('[contest-rating] LeetCode circuit breaker open; skipping sync batch', {
      contestId,
      retryAfterMs: openCooldownMs,
    });
    if (rescheduleOnPause) {
      await rescheduleRemainingUsers(contestId, openCooldownMs);
    }
    return { changed: 0, failed: 0, paused: true, retryAfterMs: openCooldownMs };
  }

  const rawCheckpoint = contest.ratingSyncCheckpoint;
  const hasFreshCheckpoint = Boolean(
    rawCheckpoint &&
    rawCheckpoint.updatedAt &&
    observedAt.getTime() - new Date(rawCheckpoint.updatedAt).getTime() <= CONTEST_RATING_CHECKPOINT_TTL_MS
  );
  let lastUserSettingsId: Types.ObjectId | null = hasFreshCheckpoint ? (rawCheckpoint?.lastUserSettingsId ?? null) : null;
  let pendingRetryIds: Types.ObjectId[] = hasFreshCheckpoint ? [...(rawCheckpoint?.retryUserSettingsIds ?? [])] : [];
  let priorTrips = hasFreshCheckpoint ? (rawCheckpoint?.consecutiveTrips ?? 0) : 0;

  let changed = 0;
  let failed = 0;
  let paused = false;
  let pausedRetryAfterMs: number | undefined;
  let nextSlotAt = 0;
  let halfOpenProbe: Promise<void> | null = null;

  const acquirePaceSlot = async (): Promise<void> => {
    if (requestDelayMs <= 0) return;
    const current = now();
    const scheduledAt = Math.max(current, nextSlotAt);
    nextSlotAt = scheduledAt + requestDelayMs;
    const waitMs = scheduledAt - current;
    if (waitMs > 0) await sleep(waitMs);
  };

  const processLeetcodeUser = async (settings: SettingsLeanRow): Promise<ItemOutcome> => {
    const userId = settings.userId.toString();
    const rawHandle = settings.platforms.leetcode?.username;
    const handle = rawHandle?.trim();
    if (!handle || handle.length > 128 || !rawHandle) {
      return { status: 'done', changed: 0 };
    }

    for (let attempt = 0; ; attempt++) {
      while (halfOpenProbe) {
        await halfOpenProbe;
      }
      if (paused || circuit.getState(now()) === 'open') {
        return { status: 'aborted' };
      }

      const isHalfOpenProbe = circuit.getState(now()) === 'half_open';
      let releaseProbe: (() => void) | undefined;
      if (isHalfOpenProbe) {
        let resolver!: () => void;
        halfOpenProbe = new Promise<void>(resolve => {
          resolver = resolve;
        });
        releaseProbe = resolver;
      }

      try {
        await acquirePaceSlot();
        if (paused || circuit.getState(now()) === 'open') {
          return { status: 'aborted' };
        }

        // Only rate-limit/503 errors are thrown out of circuit.execute so individual
        // non-rate-limit errors do not trip the provider circuit breaker.
        const outcome = await circuit.execute(async (): Promise<{ ok: true; result: ContestResult | null } | { ok: false; error: unknown }> => {
          try {
            const result = await fetchLeetcodeResult(handle, contest.startTime!);
            return { ok: true, result };
          } catch (error) {
            const classification = classifyProviderError(error, maxBackoffMs);
            if (classification.isRateLimitOrOverload) {
              throw error;
            }
            return { ok: false, error };
          }
        }, now());

        if (!outcome.ok) {
          if (circuit.getState(now()) === 'closed') priorTrips = 0;
          logger.warn('[contest-rating] User result synchronization failed', { userId, contestId });
          return { status: 'failed' };
        }

        if (circuit.getState(now()) === 'closed') priorTrips = 0;
        if (!outcome.result) {
          return { status: 'done', changed: 0 };
        }

        const deltaChanged = await saveUserParticipation({
          settings,
          contestId: contest._id,
          contestIdStr: contestId,
          platform: 'leetcode',
          handleField,
          rawHandle,
          handle,
          result: outcome.result,
          observedAt,
        });
        return { status: 'done', changed: deltaChanged };
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          if (!paused) {
            paused = true;
            pausedRetryAfterMs = Math.max(error.retryAfterMs, circuit.getRemainingCooldownMs(now()) || circuitResetTimeoutMs);
          }
          return { status: 'aborted' };
        }

        const classification = classifyProviderError(error, maxBackoffMs);
        if (!classification.isRateLimitOrOverload) {
          logger.warn('[contest-rating] User result synchronization failed', { userId, contestId });
          return { status: 'failed' };
        }

        if (circuit.getState(now()) === 'open' || classification.immediatePause) {
          if (!paused) {
            paused = true;
            pausedRetryAfterMs = circuit.openWithBackoff(
              circuitResetTimeoutMs,
              maxCircuitCooldownMs,
              classification.retryAfterMs,
              priorTrips,
              now()
            );
            logger.warn('[contest-rating] Circuit breaker opened for LeetCode rating sync', {
              contestId,
              userId,
              retryAfterMs: pausedRetryAfterMs,
              consecutiveTrips: circuit.getConsecutiveTrips(),
            });
          }
          return { status: 'aborted' };
        }

        if (attempt >= maxRateLimitRetries) {
          logger.warn('[contest-rating] User rate-limit retries exhausted', { userId, contestId });
          return { status: 'failed' };
        }

        const expDelay = Math.min(maxBackoffMs, backoffBaseMs * (2 ** attempt));
        const retryWait = Math.min(maxBackoffMs, Math.max(expDelay, classification.retryAfterMs ?? 0));
        logger.warn('[contest-rating] Rate limited by provider, backing off before retry', {
          contestId,
          userId,
          attempt: attempt + 1,
          waitMs: retryWait,
        });
        await sleep(retryWait);
      } finally {
        if (releaseProbe) {
          halfOpenProbe = null;
          releaseProbe();
        }
      }
    }
  };

  // 1. Retry any previously failed users stored in checkpoint before advancing cursor.
  if (pendingRetryIds.length > 0) {
    const retryRows = await UserSettings.find({
      ...settingsFilter,
      _id: { $in: pendingRetryIds },
    })
      .sort({ _id: 1 })
      .select('userId platforms')
      .lean<SettingsLeanRow[]>();

    const retryOutcomes = await mapWithConcurrency(retryRows, concurrency, processLeetcodeUser);
    const remainingRetryIds: Types.ObjectId[] = [];
    for (let i = 0; i < retryRows.length; i++) {
      const outcome = retryOutcomes[i];
      if (outcome.status === 'done') {
        changed += outcome.changed;
      } else {
        if (outcome.status === 'failed') failed++;
        remainingRetryIds.push(retryRows[i]._id);
      }
    }
    pendingRetryIds = remainingRetryIds;
  }

  // 2. Process remaining users in keyset-paginated batches.
  let queryCursorId: Types.ObjectId | null = lastUserSettingsId;
  while (!paused) {
    const batchQuery: Record<string, unknown> = queryCursorId
      ? { ...settingsFilter, _id: { $gt: queryCursorId } }
      : settingsFilter;
    const batch: SettingsLeanRow[] = await UserSettings.find(batchQuery)
      .sort({ _id: 1 })
      .limit(batchSize)
      .select('userId platforms')
      .lean<SettingsLeanRow[]>();

    if (batch.length === 0) break;
    queryCursorId = batch[batch.length - 1]._id;

    const outcomes = await mapWithConcurrency(batch, concurrency, processLeetcodeUser);

    let maxDoneIndex = -1;
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      if (outcome.status === 'done') {
        changed += outcome.changed;
        maxDoneIndex = i;
      } else if (outcome.status === 'failed') {
        failed++;
      }
    }

    if (paused) {
      if (maxDoneIndex >= 0) {
        lastUserSettingsId = batch[maxDoneIndex]._id;
        for (let i = 0; i < maxDoneIndex; i++) {
          if (outcomes[i].status !== 'done') {
            pendingRetryIds.push(batch[i]._id);
          }
        }
      }
      break;
    }

    lastUserSettingsId = batch[batch.length - 1]._id;
    for (let i = 0; i < outcomes.length; i++) {
      if (outcomes[i].status !== 'done') {
        pendingRetryIds.push(batch[i]._id);
      }
    }
    if (batch.length < batchSize) break;
  }

  if (paused) {
    const retryAfterMs = pausedRetryAfterMs ?? circuitResetTimeoutMs;
    const dedupedRetryIds = Array.from(new Map(pendingRetryIds.map(id => [id.toString(), id])).values());
    await persistCheckpoint(contest._id, {
      lastUserSettingsId,
      retryUserSettingsIds: dedupedRetryIds,
      consecutiveTrips: circuit.getConsecutiveTrips(),
      updatedAt: new Date(now()),
    });
    if (rescheduleOnPause) {
      await rescheduleRemainingUsers(contestId, retryAfterMs);
    }
    return { changed, failed, paused: true, retryAfterMs };
  }

  if (failed > 0) {
    const dedupedRetryIds = Array.from(new Map(pendingRetryIds.map(id => [id.toString(), id])).values());
    await persistCheckpoint(contest._id, {
      lastUserSettingsId,
      retryUserSettingsIds: dedupedRetryIds,
      consecutiveTrips: 0,
      updatedAt: new Date(now()),
    });
    throw new Error(`Contest rating synchronization failed for ${failed} users`);
  }

  if (rawCheckpoint) {
    await persistCheckpoint(contest._id, null);
  }
  return { changed, failed: 0 };
}

async function syncCodeforcesContest(
  contestObjId: Types.ObjectId,
  contestId: string,
  externalId: string,
  settingsFilter: Record<string, unknown>,
  handleField: string,
  observedAt: Date
): Promise<SyncContestRatingsResult> {
  const standings = await fetchCodeforcesResults(externalId);
  let changed = 0;
  let failed = 0;
  let cursorId: Types.ObjectId | null = null;

  for (;;) {
    const query: Record<string, unknown> = cursorId ? { ...settingsFilter, _id: { $gt: cursorId } } : settingsFilter;
    const batch: SettingsLeanRow[] = await UserSettings.find(query)
      .sort({ _id: 1 })
      .limit(CONTEST_RATING_BATCH_SIZE)
      .select('userId platforms')
      .lean<SettingsLeanRow[]>();

    if (batch.length === 0) break;
    cursorId = batch[batch.length - 1]._id;

    for (const settings of batch) {
      const userId = settings.userId.toString();
      const rawHandle = settings.platforms.codeforces?.handle;
      const handle = rawHandle?.trim();
      if (!handle || handle.length > 128 || !rawHandle) continue;
      try {
        const result = standings.get(handle.toLowerCase()) ?? null;
        if (!result) continue; // Never manufacture a participation for a nonparticipant.
        changed += await saveUserParticipation({
          settings,
          contestId: contestObjId,
          contestIdStr: contestId,
          platform: 'codeforces',
          handleField,
          rawHandle,
          handle,
          result,
          observedAt,
        });
      } catch (error) {
        if (error instanceof ContestProviderRateLimit) throw error;
        failed++;
        logger.warn('[contest-rating] User result synchronization failed', { userId, contestId });
      }
    }

    if (batch.length < CONTEST_RATING_BATCH_SIZE) break;
  }

  if (failed) throw new Error(`Contest rating synchronization failed for ${failed} users`);
  return { changed, failed };
}
