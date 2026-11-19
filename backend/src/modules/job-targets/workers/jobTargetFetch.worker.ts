import { createHash, randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { z } from 'zod';
import type { Worker } from 'bullmq';
import { JobTarget } from '../../../db/models/jobTarget.model.js';
import { NonRetryableError, RetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';
import { WorkerFactory } from '../../../infrastructure/queues/WorkerFactory.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { JobRetryConfig, QueueNames, type JdParseJobData } from '../../../shared/jobs/types.js';
import { safeFetch, SafeFetchError } from '../safeFetch.js';
import { hasEnoughJobText, normalizeJobText, scrapeJobText } from './headlessScraper.js';

export const SCRAPE_LIMIT_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 60000)
if redis.call('ZCARD', KEYS[1]) >= 3 then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('PEXPIRE', KEYS[1], 60000)
return 1
`;

export async function reserveScrape(userId: string): Promise<void> {
  const { getRedisClient } = await import('../../../shared/redis/index.js');
  const redis = getRedisClient();
  if (redis.status !== 'ready') throw new RetryableError('Scraper rate limit unavailable');
  const key = 'jd:scrape-limit:' + createHash('sha256').update(userId).digest('hex');
  let admitted: unknown;
  try {
    admitted = await redis.eval(SCRAPE_LIMIT_SCRIPT, 1, key, randomUUID());
  } catch (error) {
    throw new RetryableError('Scraper rate limit unavailable', error instanceof Error ? error : undefined);
  }
  if (Number(admitted) !== 1) {
    throw new RetryableError('Scraper limit reached: 3 renders per minute per user');
  }
}

export function staticJobText(html: string): string {
  const $ = load(html);
  $('script, style, noscript, nav, header, footer, iframe, svg').remove();
  // Insert boundaries so adjacent block elements never merge separate words.
  $('p, div, li, h1, h2, h3, h4, br, section, article').append(' ');
  const root = $('main, article').first();
  return normalizeJobText(root.length ? root.text() : $('body').text()).slice(0, 50_000);
}

interface StoredTarget { text: string | null; url: string | null; status: string }
export interface JobTargetFetchDeps {
  load: (userId: string, targetId: string) => Promise<StoredTarget | null>;
  fetching: (userId: string, targetId: string) => Promise<void>;
  save: (userId: string, targetId: string, text: string) => Promise<boolean>;
  failed: (userId: string, targetId: string, reason: string) => Promise<void>;
  fetch: typeof safeFetch;
  scrape: typeof scrapeJobText;
  reserve: (userId: string) => Promise<void>;
  enqueue: (data: JdParseJobData) => Promise<void>;
}

const defaults: JobTargetFetchDeps = {
  load: (userId, targetId) => JobTarget.findOne({ _id: targetId, userId }).lean(),
  async fetching(userId, targetId) {
    await JobTarget.updateOne({ _id: targetId, userId, status: { $ne: 'ready' } },
      { $set: { status: 'fetching', failureReason: null } });
  },
  async save(userId, targetId, text) {
    const result = await JobTarget.updateOne({ _id: targetId, userId }, { $set: { text, status: 'ready', failureReason: null } });
    return result.matchedCount === 1;
  },
  async failed(userId, targetId, reason) {
    await JobTarget.updateOne({ _id: targetId, userId, status: { $ne: 'ready' } }, { $set: { status: 'failed', failureReason: reason } });
  },
  fetch: safeFetch,
  scrape: scrapeJobText,
  reserve: reserveScrape,
  async enqueue(data) {
    await getOrCreateQueue(QueueNames.JD_PARSE).add('jd-parse', data, {
      ...JobRetryConfig.standard, jobId: `jd-parse-${data.jobTargetId}`,
      removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { count: 500 },
    });
  },
};

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const submittedSchema = z.object({
  type: z.literal('jobtarget.submitted'), schemaVersion: z.literal(1), userId: objectId,
  payload: z.object({ jobTargetId: objectId }), correlationId: z.string().max(128).optional(),
});
const terminalCodes = new Set(['INVALID_URL', 'BLOCKED_PROTOCOL', 'BLOCKED_HOST', 'BLOCKED_ADDRESS', 'RESPONSE_TOO_LARGE', 'TOO_MANY_REDIRECTS', 'BAD_REDIRECT']);

/** Runs only in ai/all. Load the URL from owned storage, never from the event payload. */
export async function processJobTargetFetch(rawEvent: unknown, deps: JobTargetFetchDeps = defaults): Promise<void> {
  const parsed = submittedSchema.safeParse(rawEvent);
  if (!parsed.success) throw new NonRetryableError('Malformed jobtarget.submitted event');
  const { userId, payload: { jobTargetId }, correlationId: requestId } = parsed.data;
  const target = await deps.load(userId, jobTargetId);
  if (!target) return; // Deleted or not owned: no URL fetch and no resurrection.
  try {
    if (target.status !== 'ready' || !target.text) {
      let text = target.text;
      if (target.url) {
        await deps.fetching(userId, jobTargetId);
        const response = await deps.fetch(target.url, { headers: { 'accept-encoding': 'identity' } });
        if (response.status < 200 || response.status >= 300) throw new RetryableError('Job posting HTTP request failed');
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          throw new NonRetryableError('Encoded static posting refused');
        }
        text = staticJobText(response.body.toString('utf8'));
        if (!hasEnoughJobText(text)) {
          await deps.reserve(userId);
          text = await deps.scrape(response.url);
        }
        if (!hasEnoughJobText(text)) throw new NonRetryableError('Job posting has fewer than 150 words');
      }
      text = normalizeJobText(text ?? '').slice(0, 50_000);
      if (!text) throw new NonRetryableError('Job description is empty');
      if (!await deps.save(userId, jobTargetId, text)) return;
    }
    // Persist before enqueue. A queue failure retries from the saved text without another browser.
    try {
      await deps.enqueue({ userId, jobTargetId, requestId });
    } catch (error) {
      throw new RetryableError('Job parsing queue unavailable', error instanceof Error ? error : undefined);
    }
  } catch (error) {
    const code = error instanceof SafeFetchError ? error.code : 'fetch_failed';
    await deps.failed(userId, jobTargetId, code);
    if (error instanceof SafeFetchError && terminalCodes.has(error.code)) throw new NonRetryableError(`Job fetch refused: ${code}`);
    if (error instanceof SafeFetchError) throw new RetryableError(`Job fetch temporarily failed: ${code}`, error);
    throw error;
  }
}

let worker: Worker<unknown> | null = null;
export function startJobTargetFetchWorker(): Worker<unknown> {
  worker ??= WorkerFactory.createWorker(QueueNames.JD_FETCH, job => processJobTargetFetch(job.data), { concurrency: 1 });
  return worker;
}
export async function stopJobTargetFetchWorker(): Promise<void> {
  if (!worker) return;
  const closing = worker;
  worker = null;
  await closing.close();
}
