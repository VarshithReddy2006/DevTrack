import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { JobTarget } from '../../../db/models/jobTarget.model.js';
import { ProcessedEvent } from '../../../db/models/processedEvent.model.js';
import { ReadinessInput } from '../../../db/models/readinessInput.model.js';
import { OutboxEvent } from '../../../db/models/outboxEvent.model.js';
import { runInTransaction } from '../../../db/transaction.js';
import { entries, redis } from '../../fixtures/cacheRedis.js';
import { CACHE_KEYS } from '../../../shared/cache/cacheManager.js';
import { clearConsumerRegistry, getConsumersForEvent, getQueuesForEvent } from '../../../shared/events/consumerRegistry.js';
import { createDomainEvent, type JobTargetScoredPayload } from '../../../shared/events/eventContract.js';
import { runConsumer, executeInboxNonTransactional } from '../../../shared/events/runConsumer.js';
import { writeOutboxEvent } from '../../../shared/events/outbox.js';
import { OutboxRelay } from '../../../shared/events/outboxRelay.js';
import { eventBus, type SseClient } from '../../../shared/sse/eventBus.js';
import { handleJobTargetScored, jobTargetScoredConsumer } from '../../../modules/job-targets/jobTargetScored.consumer.js';
import { registerReadinessConsumers } from '../../../modules/readiness/consumers/index.js';
import { getJobTargetGaps } from '../../../modules/readiness/jobTargetGaps.service.js';
import { ReadinessSnapshotService } from '../../../modules/readiness/snapshot/ReadinessSnapshotService.js';
import { processDomainReadinessJob } from '../../../modules/readiness/workers/domainReadiness.worker.js';
import { processJdParse } from '../../../modules/job-targets/workers/jdParse.worker.js';
import { processJdScore } from '../../../modules/job-targets/workers/jdScore.worker.js';
import { analyzeTaxonomy, missingTaxonomySkills } from '../../../modules/job-targets/analysis/taxonomyFallback.js';
import { FakeLlm, InMemoryJobTargetPort, target } from './helpers.js';

vi.mock('../../../shared/redis/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../shared/redis/client.js')>(),
  getRedisClient: () => redis,
  isRedisConfigured: () => false,
}));

const userId = new Types.ObjectId().toHexString();
const at = '2026-11-19T10:00:00.000Z';
let targetId: string;
const event = (payload: Partial<JobTargetScoredPayload> = {}) => createDomainEvent('jobtarget.scored', {
  jobTargetId: targetId, matchScore: 45, missingSkills: ['PostgreSQL', 'Docker', 'Kubernetes', 'Go'], scoredAt: at, ...payload,
}, { userId });

beforeAll(async () => {
  await Promise.all([JobTarget.init(), ReadinessInput.init(), ProcessedEvent.init(), OutboxEvent.init()]);
});
beforeEach(async () => {
  entries.clear(); redis.status = 'ready';
  redis.mget.mockReset(); redis.eval.mockReset();
  targetId = String((await JobTarget.create({ userId, text: 'Backend engineer', status: 'ready' }))._id);
});
afterEach(() => { vi.restoreAllMocks(); clearConsumerRegistry(); });

describe('transactional jobtarget.scored projection', () => {
  it('commits the owned target, readiness goals and inbox before publishing once', async () => {
    const publish = vi.spyOn(eventBus, 'publish');
    const scored = event();
    expect((await runConsumer(jobTargetScoredConsumer, scored)).reason).toBe('executed');
    expect(await JobTarget.findById(targetId).lean()).toMatchObject({
      status: 'completed', matchScore: 45, scoredAt: new Date(at), scoreEventId: scored.id,
      missingSkills: scored.payload.missingSkills,
    });
    expect(await ProcessedEvent.findOne({ eventId: scored.id }).lean()).toMatchObject({ consumer: 'jd.jobTargetScored' });
    expect((await ProcessedEvent.findOne({ eventId: scored.id }).lean())?.ttlExpiresAt).toBeUndefined();
    expect(await getJobTargetGaps(userId)).toMatchObject({
      jobTargetId: targetId, matchScore: 45, highPrioritySkills: ['PostgreSQL', 'Docker', 'Kubernetes'], scoredAt: at,
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: scored.id, type: 'jobtarget.updated', userId,
      payload: expect.objectContaining({ jobTargetId: targetId, matchScore: 45, status: 'completed' }),
    }), userId);
    expect((await ReadinessSnapshotService.getInputs(userId)).jobTargets.latestScore?.matchScore).toBe(45);
  });

  it('does not notify or change data on sequential and concurrent redelivery', async () => {
    const publish = vi.spyOn(eventBus, 'publish');
    const scored = event();
    await runConsumer(jobTargetScoredConsumer, scored);
    const results = await Promise.all(Array.from({ length: 4 }, () => runConsumer(jobTargetScoredConsumer, scored)));
    expect(results.every(result => result.reason === 'duplicate_inbox')).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await ProcessedEvent.countDocuments()).toBe(1);
    expect(await ReadinessInput.countDocuments()).toBe(1);
  });

  it('serializes competing first deliveries and sends at most one notification', async () => {
    const publish = vi.spyOn(eventBus, 'publish');
    const scored = event();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => runConsumer(jobTargetScoredConsumer, scored)));
    // A simultaneous afterCommit lease may cause a retry, but never an extra publish.
    for (const result of results) if (result.status === 'rejected') {
      expect(result.reason.message).toMatch(/leased/);
      await runConsumer(jobTargetScoredConsumer, scored);
    }
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await ProcessedEvent.countDocuments()).toBe(1);
  });

  it('rolls back the target and inbox if readiness persistence fails, then retries cleanly', async () => {
    const publish = vi.spyOn(eventBus, 'publish');
    const update = vi.spyOn(ReadinessInput, 'updateOne').mockRejectedValueOnce(new Error('readiness DB failure'));
    const scored = event();
    await expect(runConsumer(jobTargetScoredConsumer, scored)).rejects.toThrow('readiness DB failure');
    expect(await JobTarget.findById(targetId).lean()).toMatchObject({ status: 'ready' });
    expect(await ProcessedEvent.countDocuments()).toBe(0);
    expect(await ReadinessInput.countDocuments()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    update.mockRestore();
    await runConsumer(jobTargetScoredConsumer, scored);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('does not publish when the target write fails', async () => {
    const publish = vi.spyOn(eventBus, 'publish');
    vi.spyOn(JobTarget, 'findOneAndUpdate').mockRejectedValueOnce(new Error('target DB failure'));
    await expect(runConsumer(jobTargetScoredConsumer, event())).rejects.toThrow('target DB failure');
    expect(await ProcessedEvent.countDocuments()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('requires transactions instead of leaving standalone partial writes', async () => {
    const scored = event();
    await expect(handleJobTargetScored(scored)).rejects.toThrow('requires an inbox transaction');
    await expect(executeInboxNonTransactional(jobTargetScoredConsumer, scored)).rejects.toThrow('requires an inbox transaction');
    expect(await ProcessedEvent.countDocuments()).toBe(0);
    expect((await JobTarget.findById(targetId))?.status).toBe('ready');
  });

  it.each([60, 100, 0])('applies the strictly-below-60 goal threshold at score %s', async matchScore => {
    await runConsumer(jobTargetScoredConsumer, event({ matchScore, missingSkills: ['A', ' a ', 'B', 'C', 'D'] }));
    expect(await getJobTargetGaps(userId)).toMatchObject({
      matchScore, missingSkills: ['A', 'B', 'C', 'D'], highPrioritySkills: matchScore < 60 ? ['A', 'B', 'C'] : [],
    });
  });

  it('accepts an empty gap list and replaces goals when a newer score improves', async () => {
    await runConsumer(jobTargetScoredConsumer, event());
    await runConsumer(jobTargetScoredConsumer, event({ matchScore: 90, missingSkills: [], scoredAt: '2026-11-19T11:00:00.000Z' }));
    expect(await getJobTargetGaps(userId)).toMatchObject({ matchScore: 90, missingSkills: [], highPrioritySkills: [] });
  });

  it('accepts legacy nullable score timestamps and preserves other readiness inputs', async () => {
    await JobTarget.collection.updateOne({ _id: new Types.ObjectId(targetId) }, { $set: { scoredAt: null } });
    await ReadinessInput.create({ userId, jobTargets: { targetIds: ['parsed-before'] }, focusDays: { '2026-11-19': { sessions: 1, qualifiedSessions: 1, qualifiedMinutes: 25 } } });
    await runConsumer(jobTargetScoredConsumer, event());
    expect((await JobTarget.findById(targetId))?.matchScore).toBe(45);
    const inputs = await ReadinessInput.findOne({ userId });
    expect(inputs?.jobTargets.targetIds).toEqual(['parsed-before']);
    expect(inputs?.focusDays.get('2026-11-19')?.qualifiedMinutes).toBe(25);
  });

  it('ignores stale scores and replay after inbox deletion without regressing state or notifying', async () => {
    const publish = vi.spyOn(eventBus, 'publish');
    const newer = event({ matchScore: 80, scoredAt: '2026-11-19T11:00:00.000Z' });
    await runConsumer(jobTargetScoredConsumer, newer);
    await runConsumer(jobTargetScoredConsumer, event());
    await ProcessedEvent.deleteMany({});
    await runConsumer(jobTargetScoredConsumer, newer);
    expect((await JobTarget.findById(targetId))?.matchScore).toBe(80);
    expect((await getJobTargetGaps(userId))?.matchScore).toBe(80);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('uses a deterministic tie breaker for scores with equal timestamps', async () => {
    await runConsumer(jobTargetScoredConsumer, { ...event({ matchScore: 75 }), id: 'score-z' });
    await runConsumer(jobTargetScoredConsumer, { ...event({ matchScore: 25 }), id: 'score-a' });
    expect((await JobTarget.findById(targetId))?.matchScore).toBe(75);
    expect((await getJobTargetGaps(userId))?.matchScore).toBe(75);
  });

  it('updates different targets but keeps only the latest score as user readiness context', async () => {
    const other = await JobTarget.create({ userId, text: 'Another target' });
    await runConsumer(jobTargetScoredConsumer, event({ jobTargetId: String(other._id), matchScore: 85, scoredAt: '2026-11-19T12:00:00.000Z' }));
    await runConsumer(jobTargetScoredConsumer, event());
    expect((await JobTarget.findById(targetId))?.matchScore).toBe(45);
    expect(await getJobTargetGaps(userId)).toMatchObject({ jobTargetId: String(other._id), matchScore: 85, highPrioritySkills: [] });
  });

  it('converges on the newest readiness context when scores for different targets race', async () => {
    await ReadinessInput.create({ userId });
    const other = await JobTarget.create({ userId, text: 'Another target' });
    await Promise.all([
      runConsumer(jobTargetScoredConsumer, event()),
      runConsumer(jobTargetScoredConsumer, event({ jobTargetId: String(other._id), matchScore: 90, scoredAt: '2026-11-19T11:00:00.000Z' })),
    ]);
    expect(await getJobTargetGaps(userId)).toMatchObject({ jobTargetId: String(other._id), matchScore: 90 });
    expect(await JobTarget.countDocuments({ status: 'completed' })).toBe(2);
  });

  it('ignores foreign, missing and deleted targets without creating readiness goals or notifications', async () => {
    const publish = vi.spyOn(eventBus, 'publish');
    await runConsumer(jobTargetScoredConsumer, { ...event(), userId: new Types.ObjectId().toHexString() });
    await runConsumer(jobTargetScoredConsumer, event({ jobTargetId: new Types.ObjectId().toHexString() }));
    await JobTarget.deleteOne({ _id: targetId });
    await runConsumer(jobTargetScoredConsumer, event());
    expect(await ReadinessInput.countDocuments()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    { matchScore: -1 }, { matchScore: 101 }, { matchScore: Number.NaN }, { matchScore: Infinity },
    { matchScore: '50' }, { missingSkills: [''] }, { missingSkills: ['x'.repeat(201)] },
    { missingSkills: Array(51).fill('A') }, { missingSkills: 'Docker' }, { scoredAt: 'bad' }, { jobTargetId: 'bad' },
  ])('drops invalid scored payload %j', async payload => {
    const publish = vi.spyOn(eventBus, 'publish');
    await runConsumer(jobTargetScoredConsumer, event(payload as never));
    expect((await JobTarget.findById(targetId))?.status).toBe('ready');
    expect(await ReadinessInput.countDocuments()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects unsupported versions, wrong types and malformed envelope identifiers', async () => {
    for (const bad of [{ schemaVersion: 2 }, { type: 'jobtarget.parsed' }, { userId: 'bad' }, { id: '' }, { id: 12 }]) {
      await handleJobTargetScored({ ...event(), ...bad } as never);
    }
    expect(await ReadinessInput.countDocuments()).toBe(0);
  });
});

describe('post-commit cache and SSE delivery', () => {
  it('invalidates a warm gap cache without affecting another user', async () => {
    const otherUser = new Types.ObjectId().toHexString();
    expect(await getJobTargetGaps(userId)).toBeNull();
    expect(await getJobTargetGaps(otherUser)).toBeNull();
    expect(entries.has(CACHE_KEYS.readinessGaps(userId))).toBe(true);
    await runConsumer(jobTargetScoredConsumer, event());
    expect(entries.has(CACHE_KEYS.readinessGaps(userId))).toBe(false);
    expect(entries.has(CACHE_KEYS.readinessGaps(otherUser))).toBe(true);
    expect((await getJobTargetGaps(userId))?.matchScore).toBe(45);
  });

  it('retries cache invalidation failure before notifying and advances the generation fence', async () => {
    const scored = event();
    const publish = vi.spyOn(eventBus, 'publish');
    await getJobTargetGaps(userId); // cached null before scoring
    redis.eval.mockRejectedValueOnce(new Error('Redis write failed'));
    await expect(runConsumer(jobTargetScoredConsumer, scored)).rejects.toThrow('Redis write failed');
    expect((await JobTarget.findById(targetId))?.status).toBe('completed');
    expect(publish).not.toHaveBeenCalled();
    expect((await runConsumer(jobTargetScoredConsumer, scored)).reason).toBe('duplicate_inbox');
    expect((await getJobTargetGaps(userId))?.matchScore).toBe(45);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(entries.get(`${CACHE_KEYS.readinessGaps(userId)}:generation`)?.value).toBe('1');
  });

  it('keeps a disconnected cache invalidation retryable and allows reads from MongoDB', async () => {
    const scored = event();
    redis.status = 'reconnecting';
    await expect(runConsumer(jobTargetScoredConsumer, scored)).rejects.toThrow('Redis unavailable');
    expect((await getJobTargetGaps(userId))?.matchScore).toBe(45);
    redis.status = 'ready';
    expect((await runConsumer(jobTargetScoredConsumer, scored)).reason).toBe('duplicate_inbox');
  });

  it('normalizes uppercase owner IDs for cache invalidation and SSE targeting', async () => {
    await getJobTargetGaps(userId);
    const publish = vi.spyOn(eventBus, 'publish');
    await runConsumer(jobTargetScoredConsumer, { ...event(), userId: userId.toUpperCase() });
    expect(entries.has(CACHE_KEYS.readinessGaps(userId))).toBe(false);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ userId }), userId);
  });

  it('publishes only to connected clients belonging to the event owner', async () => {
    const owner = vi.fn(); const other = vi.fn();
    const client = (id: string, ownerId: string, enqueue: ReturnType<typeof vi.fn>) => ({
      id, userId: ownerId, connectedAt: Date.now(), controller: { enqueue }, emit: vi.fn(), destroy: vi.fn(),
    } as unknown as SseClient);
    eventBus.register(client('score-owner', userId, owner));
    eventBus.register(client('score-other', new Types.ObjectId().toHexString(), other));
    try {
      await runConsumer(jobTargetScoredConsumer, event());
      expect(owner).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(owner.mock.calls[0][0])).toContain('jobtarget.updated');
      expect(other).not.toHaveBeenCalled();
    } finally { eventBus.unregister('score-owner'); eventBus.unregister('score-other'); }
  });

  it('retries failed notification work after inbox dedup, using committed data', async () => {
    const publish = vi.spyOn(eventBus, 'publish').mockImplementationOnce(() => { throw new Error('SSE failed'); });
    const scored = event();
    await expect(runConsumer(jobTargetScoredConsumer, scored)).rejects.toThrow('SSE failed');
    expect((await JobTarget.findById(targetId))?.status).toBe('completed');
    const replay = { ...scored, payload: { ...scored.payload, matchScore: 99 } };
    expect((await runConsumer(jobTargetScoredConsumer, replay)).reason).toBe('duplicate_inbox');
    expect(publish.mock.calls[1][0].payload.matchScore).toBe(45);
    await runConsumer(jobTargetScoredConsumer, scored);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('reclaims expired notification leases, but retries an active lease', async () => {
    const scored = event();
    await runInTransaction(session => handleJobTargetScored(scored, session));
    await JobTarget.updateOne({ _id: targetId }, { $set: { scoreNotification: { leaseToken: 'crashed', leaseUntil: new Date(Date.now() + 60_000) } } });
    await expect(runConsumer(jobTargetScoredConsumer, scored)).rejects.toThrow('leased');
    await JobTarget.updateOne({ _id: targetId }, { $set: { 'scoreNotification.leaseUntil': new Date(0) } });
    const publish = vi.spyOn(eventBus, 'publish');
    await runConsumer(jobTargetScoredConsumer, scored);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('worker and outbox routing', () => {
  it('matches candidate skills by the scorer\'s exact aliases and prioritizes mandatory gaps', () => {
    const candidate = new InMemoryJobTargetPort().candidate;
    candidate.skills = ['go', 'rest', 'TypeScript and Node.js'];
    const requirements = analyzeTaxonomy('Requirements: Go, REST, TypeScript, Node.js.\nNice to have: Docker.').requirements;
    expect(missingTaxonomySkills(requirements, candidate)).toEqual(['TypeScript', 'Node.js', 'Docker']);
  });

  it('routes a committed outbox event through the registered domain-readiness worker', async () => {
    registerReadinessConsumers(); registerReadinessConsumers();
    expect(getQueuesForEvent('jobtarget.scored')).toEqual(['domain-readiness']);
    expect(getConsumersForEvent('jobtarget.scored')).toHaveLength(1);
    const scored = event();
    await runInTransaction(session => writeOutboxEvent(session, {
      type: 'jobtarget.scored', aggregateType: 'job_target', aggregateId: targetId, userId, payload: scored.payload,
    }));
    const relay = new OutboxRelay({ resolveQueues: getQueuesForEvent, enqueue: async (_queue, _id, envelope) => {
      await processDomainReadinessJob(envelope);
      await processDomainReadinessJob(envelope);
    } });
    const publish = vi.spyOn(eventBus, 'publish');
    expect(await relay.tick()).toBe(1);
    expect((await OutboxEvent.findOne())?.status).toBe('published');
    expect((await JobTarget.findById(targetId))?.status).toBe('completed');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('builds the scored contract alongside the existing parsed event from the scoring worker', async () => {
    const port = new InMemoryJobTargetPort();
    port.targets.set(targetId, target({ userId, jobTargetId: targetId }));
    port.candidate.skills = ['typescript', 'nodejs'];
    const job = { userId, jobTargetId: targetId };
    const now = () => new Date(at);
    await processJdParse(job, { port, llm: new FakeLlm(false), now, enqueueScore: async () => {} });
    const result = await processJdScore(job, { port, llm: new FakeLlm(false), now });
    expect(port.events).toHaveLength(1);
    expect(port.scoredEvents).toHaveLength(1);
    expect(port.scoredEvents[0]).toMatchObject({ type: 'jobtarget.scored', userId, payload: {
      jobTargetId: targetId, matchScore: result.score, missingSkills: ['PostgreSQL', 'Docker', 'Kubernetes'], scoredAt: at,
    } });
    await runConsumer(jobTargetScoredConsumer, createDomainEvent('jobtarget.scored', port.scoredEvents[0].payload, { userId }));
    expect((await JobTarget.findById(targetId))?.matchScore).toBe(result.score);
  });
});
