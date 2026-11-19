import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DsaProblem } from '../../../db/models/dsaProblem.model.js';
import { DsaSubmission } from '../../../db/models/dsaSubmission.model.js';
import { RevisionCard } from '../../../db/models/revisionCard.model.js';
import { OutboxEvent } from '../../../db/models/outboxEvent.model.js';
import { DAY_IN_MS } from '../../../modules/revision/sm2.js';
import { enqueueSubmissionEvaluation, generateStruggleCard } from '../../../modules/revision/cardGenerator.service.js';
import * as generator from '../../../modules/revision/cardGenerator.service.js';
import { registerRevisionConsumers, revisionCardCreatedConsumer, struggleCardConsumer } from '../../../modules/revision/dsaEvents.consumer.js';
import { persistSubmissions } from '../../../modules/platform-sync/sync.persistence.js';
import { createDomainOutboxRelay } from '../../../workers/focus-completion.worker.js';
import { processDomainReadinessJob } from '../../../modules/readiness/workers/domainReadiness.worker.js';
import { consumerRegistry } from '../../../shared/events/consumerRegistry.js';
import { createDomainEvent, type DomainEventEnvelope } from '../../../shared/events/eventContract.js';
import { eventBus } from '../../../shared/sse/eventBus.js';
import { QueueNames } from '../../../shared/jobs/types.js';

vi.mock('../../../shared/sse/eventBus.js', () => ({ eventBus: { publishEnvelope: vi.fn() } }));
vi.mock('../../../modules/activity/activity.service.js', () => ({ createActivity: vi.fn(), incrementDailyActivity: vi.fn() }));
vi.mock('../../../modules/daily-challenge/daily-challenge.service.js', () => ({ checkChallengeCompletion: vi.fn().mockResolvedValue(false) }));

const owner = '000000000000000000000431';
const other = '000000000000000000000432';
let problem: InstanceType<typeof DsaProblem>;
let sequence = 0;
async function submission(status = 'wrong', minute = 0, fields: Record<string, unknown> = {}) {
  return DsaSubmission.create({ userId: owner, problemId: problem._id, platform: 'leetcode', externalId: `submission-${++sequence}`,
    status, language: 'typescript', submittedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)), ...fields });
}
const generate = (id: string, userId = owner) => generateStruggleCard(userId, { submissionId: id });

beforeAll(async () => { await Promise.all([DsaProblem.init(), DsaSubmission.init(), RevisionCard.init(), OutboxEvent.init()]); });
beforeEach(async () => {
  consumerRegistry.clear();
  vi.clearAllMocks();
  vi.mocked(eventBus.publishEnvelope).mockResolvedValue(undefined);
  problem = await DsaProblem.create({ userId: owner, platform: 'leetcode', externalId: 'two-sum', problemKey: 'leetcode:two-sum', title: 'Two Sum', difficulty: 'easy', tags: ['arrays'], url: 'https://leetcode.com/problems/two-sum/', category: 'Arrays' });
});
afterEach(() => { consumerRegistry.clear(); vi.restoreAllMocks(); });

describe('authoritative struggle triggers and scheduling', () => {
  it('waits for three failed attempts, then creates a one-day high-priority card', async () => {
    expect((await generate((await submission('wrong', 1)).id))?.created).toBe(false);
    expect((await generate((await submission('runtime_error', 2)).id))?.created).toBe(false);
    const third = await submission('compilation_error', 3);
    const start = Date.now();
    expect((await generate(third.id))?.created).toBe(true);
    const card = await RevisionCard.findOne().lean();
    expect(card).toMatchObject({ problemKey: 'leetcode:two-sum', intervalDays: 1, easeFactor: 2.5, repetitions: 0, reviewSeq: 0, tagWeight: 2, tags: ['arrays', 'struggle_topic'] });
    expect(card!.dueAt.getTime()).toBeGreaterThanOrEqual(start + DAY_IN_MS);
    expect(card!.dueAt.getTime()).toBeLessThanOrEqual(Date.now() + DAY_IN_MS);
    expect((await OutboxEvent.findOne({ type: 'revision.card_created' }).lean())?.payload.reasons).toEqual(['failed_attempts']);
  });

  it.each([0, 24.999, 25, 100, null])('applies the strict <25 percentile threshold to accepted submissions: %s', async runtimePercentile => {
    const row = await submission('accepted', 1, { runtimePercentile });
    const expected = runtimePercentile !== null && runtimePercentile < 25;
    expect((await generate(row.id))?.created).toBe(expected);
    expect(await RevisionCard.countDocuments()).toBe(expected ? 1 : 0);
  });

  it('creates a card immediately for TLE without requiring three failures', async () => {
    expect((await generate((await submission('time_limit_exceeded')).id))?.created).toBe(true);
  });

  it('does not interpret milliseconds or a failed submission percentile as an accepted runtime rank', async () => {
    expect((await generate((await submission('accepted', 1, { executionTime: 2 })).id))?.created).toBe(false);
    expect((await generate((await submission('wrong', 2, { runtimePercentile: 1 })).id))?.created).toBe(false);
  });

  it('resets the failure window after an acceptance and ignores future/other-problem/user failures', async () => {
    await submission('wrong', 1); await submission('wrong', 2); await submission('accepted', 3);
    const row = await submission('wrong', 4);
    await submission('wrong', 5); await submission('wrong', 6);
    await submission('wrong', 4, { userId: other });
    await submission('wrong', 4, { problemId: new Types.ObjectId() });
    await submission('wrong', 4, { platform: 'codeforces' });
    await submission('wrong', 4, { platform: 'codeforces' });
    expect((await generate(row.id))?.created).toBe(false);
  });

  it('counts failed attempts before a successful acceptance even when events arrive out of order', async () => {
    const accepted = await submission('accepted', 4);
    await submission('wrong', 1); await submission('wrong', 2); await submission('wrong', 3);
    expect((await generate(accepted.id))?.created).toBe(true);
  });

  it('does not expose or create cards from another user’s submission or problem', async () => {
    const row = await submission('time_limit_exceeded');
    expect((await generate(row.id, other))?.created).toBe(false);
    await DsaProblem.updateOne({ _id: problem._id }, { $set: { userId: other } });
    expect((await generate(row.id))?.created).toBe(false);
  });

  it('rejects forged event metrics, malformed IDs, and unsupported event versions', async () => {
    const row = await submission('accepted');
    await expect(generateStruggleCard(owner, { submissionId: row.id, failedAttempts: 99 })).rejects.toThrow();
    await expect(generate('invalid')).rejects.toThrow();
    await expect(struggleCardConsumer.handle({ ...createDomainEvent('dsa.submission.evaluated', { submissionId: row.id }, { userId: owner }), schemaVersion: 2 })).rejects.toThrow('Unsupported');
    expect(await RevisionCard.countDocuments()).toBe(0);
  });
});

describe('idempotence and transactional progress preservation', () => {
  it('deduplicates repeated and concurrent events across submissions for the same question', async () => {
    const rows = await Promise.all([submission('time_limit_exceeded', 1), submission('time_limit_exceeded', 2), submission('accepted', 3, { runtimePercentile: 10 })]);
    await Promise.all(rows.map(row => generate(row.id)));
    await generate(rows[0].id);
    expect(await RevisionCard.countDocuments()).toBe(1);
    expect(await OutboxEvent.countDocuments({ type: 'revision.card_created' })).toBe(1);
  });

  it.each(['leetcode:two-sum', 'legacy-mongo-key'])('preserves progressed cards and snoozes for key %s', async key => {
    const dueAt = new Date(Date.now() + 30 * DAY_IN_MS);
    const before = await RevisionCard.create({ userId: owner, problemKey: key === 'legacy-mongo-key' ? `leetcode:${problem._id}` : key,
      title: 'Existing', difficulty: 'hard', dueAt, snoozedUntil: dueAt, lastReviewedAt: new Date(),
      easeFactor: 1.8, repetitions: 4, reviewSeq: 8, intervalDays: 30, tags: ['graphs'], tagWeight: 3 });
    expect(await generate((await submission('time_limit_exceeded')).id)).toEqual({ created: false, cardId: before.id });
    expect(await RevisionCard.findById(before._id).lean()).toMatchObject({ easeFactor: 1.8, repetitions: 4, reviewSeq: 8, intervalDays: 30, dueAt, snoozedUntil: dueAt, tagWeight: 3 });
    expect((await RevisionCard.findById(before._id).lean())?.tags).toContain('struggle_topic');
    expect(await OutboxEvent.countDocuments({ type: 'revision.card_created' })).toBe(0);
  });

  it('rolls back card creation if its notification outbox write fails, then recovers on retry', async () => {
    const row = await submission('time_limit_exceeded');
    vi.spyOn(OutboxEvent, 'create').mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(generate(row.id)).rejects.toThrow('outbox unavailable');
    expect(await RevisionCard.countDocuments()).toBe(0);
    expect((await generate(row.id))?.created).toBe(true);
  });

  it('rolls back the evaluation marker on outbox failure and enqueues each submission once', async () => {
    const row = await submission('time_limit_exceeded');
    vi.spyOn(OutboxEvent, 'create').mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(enqueueSubmissionEvaluation(owner, row.id)).rejects.toThrow('outbox unavailable');
    expect((await DsaSubmission.findById(row._id).lean())?.revisionEvaluationQueued).toBe(false);
    await enqueueSubmissionEvaluation(owner, row.id); await enqueueSubmissionEvaluation(owner, row.id);
    expect(await OutboxEvent.countDocuments({ type: 'dsa.submission.evaluated' })).toBe(1);
  });
});

describe('production producer -> outbox -> domain consumer -> SSE route', () => {
  const normalized = { externalId: 'synced-1', problemExternalId: 'two-sum', platform: 'leetcode' as const, title: 'Two Sum',
    difficulty: 'easy' as const, status: 'time_limit' as const, submittedAt: new Date('2026-01-01T00:00:00Z') };

  it('processes actual platform-sync evaluations through the existing relay and worker', async () => {
    expect(await persistSubmissions(owner, [normalized])).toBe(1);
    const jobs: Array<{ queue: string; event: DomainEventEnvelope }> = [];
    const relay = createDomainOutboxRelay(async (queue, _jobId, event) => { jobs.push({ queue, event }); });
    await relay.tick();
    expect(jobs).toHaveLength(1); expect(jobs[0].queue).toBe(QueueNames.DOMAIN_READINESS);
    await processDomainReadinessJob(jobs.shift()!.event);
    expect(await RevisionCard.countDocuments()).toBe(1);
    await relay.tick();
    expect(jobs[0].event.type).toBe('revision.card_created');
    await processDomainReadinessJob(jobs.shift()!.event);
    expect(eventBus.publishEnvelope).toHaveBeenCalledWith(owner, 'revision.card_created', expect.objectContaining({ problemKey: 'leetcode:two-sum' }), expect.any(String), 1);
    expect(await persistSubmissions(owner, [normalized])).toBe(0);
    expect(await OutboxEvent.countDocuments({ type: 'dsa.submission.evaluated' })).toBe(1);
  });

  it('repairs an interrupted source handoff when the submission is replayed', async () => {
    vi.spyOn(OutboxEvent, 'create').mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(persistSubmissions(owner, [normalized])).rejects.toThrow('outbox unavailable');
    expect(await DsaSubmission.countDocuments()).toBe(1);
    expect(await persistSubmissions(owner, [normalized])).toBe(0);
    expect(await OutboxEvent.countDocuments({ type: 'dsa.submission.evaluated' })).toBe(1);
  });

  it('admits the entire newest-first batch before publishing evaluations', async () => {
    const enqueue = generator.enqueueSubmissionEvaluation;
    vi.spyOn(generator, 'enqueueSubmissionEvaluation').mockImplementation(async (userId, submissionId) => {
      expect(await DsaSubmission.countDocuments()).toBe(4);
      await enqueue(userId, submissionId);
    });
    const batch = [4, 3, 2, 1].map(minute => ({ ...normalized, externalId: `ordered-${minute}`,
      status: minute === 4 ? 'accepted' as const : 'wrong_answer' as const,
      submittedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)) }));
    await persistSubmissions(owner, batch);
    registerRevisionConsumers();
    const accepted = await DsaSubmission.findOne({ status: 'accepted' }).orFail();
    await struggleCardConsumer.handle(createDomainEvent('dsa.submission.evaluated', { submissionId: accepted.id }, { userId: owner }));
    expect(await RevisionCard.countDocuments()).toBe(1);
  });

  it('preserves provider-supplied runtime percentiles and rejects invalid values', async () => {
    await persistSubmissions(owner, [{ ...normalized, status: 'accepted', runtimePercentile: 12.5 }]);
    expect((await DsaSubmission.findOne({ externalId: normalized.externalId }).lean())?.runtimePercentile).toBe(12.5);
    for (const runtimePercentile of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(persistSubmissions(owner, [{ ...normalized, externalId: `bad-${runtimePercentile}`, runtimePercentile }])).rejects.toThrow('Invalid submission runtime percentile');
    }
  });

  it('registers consumers idempotently and suppresses foreign-card SSE while retrying delivery errors', async () => {
    registerRevisionConsumers(); registerRevisionConsumers();
    expect(consumerRegistry.getQueues('dsa.submission.evaluated')).toEqual([QueueNames.DOMAIN_READINESS]);
    const row = await submission('time_limit_exceeded'); await generate(row.id);
    const outbox = await OutboxEvent.findOne({ type: 'revision.card_created' }).orFail();
    const event = createDomainEvent('revision.card_created', outbox.payload, { userId: other });
    await revisionCardCreatedConsumer.handle(event); expect(eventBus.publishEnvelope).not.toHaveBeenCalled();
    vi.mocked(eventBus.publishEnvelope).mockRejectedValueOnce(new Error('SSE offline'));
    await expect(revisionCardCreatedConsumer.handle({ ...event, userId: owner })).rejects.toThrow('SSE offline');
    await revisionCardCreatedConsumer.handle({ ...event, userId: owner });
    expect(eventBus.publishEnvelope).toHaveBeenCalledTimes(2);
  });
});
