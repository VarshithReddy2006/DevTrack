import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
const mocks = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue(undefined), publish: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined), on: vi.fn(), worker: vi.fn(),
}));
vi.mock('../../../modules/ai/provider/LLMGateway.js', () => ({ llmGateway: { generateCompletion: vi.fn() } }));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getOrCreateQueue: () => ({ add: mocks.add }) }));
vi.mock('../../../shared/sse/eventBus.js', () => ({ eventBus: { publishEnvelope: mocks.publish } }));
vi.mock('../../../shared/redis/index.js', () => ({ getRedisClient: () => ({}) }));
vi.mock('../../../shared/jobs/dlq.service.js', () => ({ createDlqWorker: mocks.worker }));
import { InterviewEvaluationRequest, InterviewReport } from '../../../db/models/interviewReport.model.js';
import { evaluateInterview, REPORT_DIMENSIONS, type EvaluationInput } from '../../../modules/interview/rubricEvaluator.service.js';
import {
  completedEvaluationInput, enqueueCompletedInterview, processInterviewEvaluation, recoverInterviewEvaluations,
  stageInterviewEvaluation, startInterviewEvaluateWorker, stopInterviewEvaluateWorker, type EvaluationDeps,
} from '../../../modules/interview/workers/interviewEvaluate.worker.js';
import { scoringSession } from './helpers/memorySessionPort.js';

const input: EvaluationInput = {
  sessionId: 's-443', userId: 'owner', role: 'backend', durationSeconds: 120, mode: 'basic_mode',
  turns: [{ question: 'Discuss a set', answer: 'Use a set', code: 'new Set()', feedback: null }],
};
delete process.env.MONGODB_URI;
let db: MongoMemoryReplSet;
beforeAll(async () => {
  if (process.env.MONGODB_URI) throw new Error('Tests require an owned temporary MongoDB, not MONGODB_URI');
  db = await MongoMemoryReplSet.create({
    binary: { version: '7.0.14' },
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25', '--wiredTigerEngineConfigString', 'log=(file_max=1MB,prealloc=false)'] }],
  });
  await mongoose.connect(db.getUri());
  await Promise.all([InterviewReport.init(), InterviewEvaluationRequest.init()]);
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.add.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue(undefined);
  mocks.worker.mockReturnValue({ on: mocks.on, close: mocks.close });
});
afterEach(async () => {
  await stopInterviewEvaluateWorker();
  await InterviewReport.deleteMany({});
  await InterviewEvaluationRequest.deleteMany({});
});
afterAll(async () => { await mongoose.disconnect(); await db?.stop(); });

function deps(): EvaluationDeps {
  return { evaluate: vi.fn(evaluateInterview), publish: mocks.publish };
}

describe('durable post-interview evaluation pipeline', () => {
  it('persists a complete model report with verbatim evidence and the derived overall score', async () => {
    const source = { ...input, mode: 'ai' as const };
    const output = {
      dimensions: Object.fromEntries(REPORT_DIMENSIONS.map(key => [key, {
        score: 76, rationale: 'Describes an approach but needs edge-case analysis.',
        citations: [{ turnIndex: 0, source: 'answer', quote: 'Use a set', explanation: 'Candidate approach' }],
      }])),
      strengths: ['States approach'], improvements: ['Explain complexity'], modelAnswer: 'Explain a set.', optimalApproach: 'One pass, O(n).',
    };
    await stageInterviewEvaluation(source);
    const ports = deps();
    ports.evaluate = value => evaluateInterview(value, { generateCompletion: vi.fn().mockResolvedValue({
      provider: 'gemini', model: 'fixture-model', content: JSON.stringify(output),
    }) });
    await processInterviewEvaluation({ sessionId: input.sessionId }, ports);
    expect((await InterviewReport.findOne().lean())?.report).toMatchObject({
      ...output, overallScore: 76, mode: 'ai', model: 'fixture-model',
    });
  });
  it('persists exactly one immutable report, publishes to the owner, and ignores redelivery', async () => {
    await stageInterviewEvaluation(input);
    const ports = deps();
    expect(await processInterviewEvaluation({ sessionId: input.sessionId }, ports)).toBe('ready');
    const report = await InterviewReport.findOne({ sessionId: input.sessionId }).lean();
    expect(report).toMatchObject({ userId: input.userId, report: { mode: 'basic_mode', overallScore: 0 } });
    expect(mocks.publish).toHaveBeenCalledWith(input.userId, { sessionId: input.sessionId, reportId: String(report!._id), mode: 'basic_mode' });
    expect(await processInterviewEvaluation({ sessionId: input.sessionId }, ports)).toBe('skipped');
    expect(ports.evaluate).toHaveBeenCalledOnce();
    expect(await InterviewReport.countDocuments()).toBe(1);
  });
  it('retries failed notifications from the saved report without another AI call', async () => {
    await stageInterviewEvaluation(input);
    const ports = deps();
    mocks.publish.mockRejectedValueOnce(new Error('bus offline'));
    await expect(processInterviewEvaluation({ sessionId: input.sessionId }, ports)).rejects.toThrow('bus offline');
    const before = await InterviewReport.findOne().lean();
    expect((await InterviewEvaluationRequest.findOne().lean())?.deliveredAt).toBeNull();
    expect(await processInterviewEvaluation({ sessionId: input.sessionId }, ports)).toBe('ready');
    expect(ports.evaluate).toHaveBeenCalledOnce();
    expect((await InterviewReport.findOne().lean())?._id).toEqual(before?._id);
  });
  it('serializes concurrent deliveries across worker processes using a database lease', async () => {
    await stageInterviewEvaluation(input);
    const ports = deps();
    const results = await Promise.all(Array.from({ length: 8 }, () => processInterviewEvaluation({ sessionId: input.sessionId }, ports)));
    expect(results.filter(value => value === 'ready')).toHaveLength(1);
    expect(ports.evaluate).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });
  it('allows identical staging races but rejects another owner or changed transcript', async () => {
    await Promise.all(Array.from({ length: 6 }, () => stageInterviewEvaluation(input)));
    await expect(stageInterviewEvaluation({ ...input, userId: 'foreign' })).rejects.toThrow('Conflicting');
    await expect(stageInterviewEvaluation({ ...input, turns: [{ ...input.turns[0], answer: 'changed' }] })).rejects.toThrow('Conflicting');
    expect((await InterviewEvaluationRequest.findOne().lean())?.input).toEqual(input);
  });
  it('rolls back source staging with the owning session transaction', async () => {
    const transaction = await mongoose.startSession();
    try {
      await expect(transaction.withTransaction(async () => {
        await stageInterviewEvaluation(input, transaction);
        throw new Error('session completion aborted');
      })).rejects.toThrow('aborted');
    } finally { await transaction.endSession(); }
    expect(await InterviewEvaluationRequest.countDocuments()).toBe(0);
    expect(mocks.add).not.toHaveBeenCalled();
  });
  it('recovers a failed enqueue from durable storage and keeps raw transcript out of Redis', async () => {
    const session = scoringSession({ id: input.sessionId, status: 'completed' });
    mocks.add.mockRejectedValueOnce(new Error('Redis offline'));
    await expect(enqueueCompletedInterview(session)).rejects.toThrow('Redis offline');
    expect(await InterviewEvaluationRequest.countDocuments()).toBe(1);
    await recoverInterviewEvaluations();
    expect(mocks.add).toHaveBeenLastCalledWith('interview.evaluate', { sessionId: input.sessionId }, expect.objectContaining({ attempts: 3, jobId: expect.stringMatching(/^evaluation-[a-f0-9]{64}$/) }));
  });
  it('skips unknown requests and rejects caller-supplied ownership/transcript fields', async () => {
    const ports = deps();
    expect(await processInterviewEvaluation({ sessionId: 'missing' }, ports)).toBe('skipped');
    await expect(processInterviewEvaluation({ sessionId: input.sessionId, userId: 'foreign' } as never, ports)).rejects.toThrow();
    expect(ports.evaluate).not.toHaveBeenCalled();
  });
  it('refuses corrupted source ownership and transcript hashes', async () => {
    await stageInterviewEvaluation(input);
    const ports = deps();
    await InterviewEvaluationRequest.collection.updateOne({ sessionId: input.sessionId }, { $set: { 'input.userId': 'foreign' } });
    await expect(processInterviewEvaluation({ sessionId: input.sessionId }, ports)).rejects.toThrow('owner');
    await InterviewEvaluationRequest.collection.updateOne({ sessionId: input.sessionId }, { $set: { 'input.userId': input.userId, 'input.turns.0.answer': 'tampered' } });
    await expect(processInterviewEvaluation({ sessionId: input.sessionId }, ports)).rejects.toThrow('hash');
    expect(ports.evaluate).not.toHaveBeenCalled();
  });
  it('recovers expired leases but fences a late model result', async () => {
    await stageInterviewEvaluation(input);
    const ports = deps();
    ports.evaluate = vi.fn(async value => {
      await InterviewEvaluationRequest.updateOne({ sessionId: input.sessionId }, { $set: { leaseToken: 'new-owner', leaseUntil: new Date(Date.now() + 60000) } });
      return evaluateInterview(value);
    });
    await expect(processInterviewEvaluation({ sessionId: input.sessionId }, ports)).rejects.toThrow('lease expired');
    expect(await InterviewReport.countDocuments()).toBe(0);
    expect(mocks.publish).not.toHaveBeenCalled();
    await InterviewEvaluationRequest.updateOne({ sessionId: input.sessionId }, { $set: { leaseUntil: new Date(0) } });
    expect(await processInterviewEvaluation({ sessionId: input.sessionId }, deps())).toBe('ready');
  });
  it('releases the lease after evaluation failure for a later retry', async () => {
    await stageInterviewEvaluation(input);
    const ports = deps();
    ports.evaluate = vi.fn().mockRejectedValue(new Error('temporary storage failure'));
    await expect(processInterviewEvaluation({ sessionId: input.sessionId }, ports)).rejects.toThrow('temporary');
    expect((await InterviewEvaluationRequest.findOne().lean())?.leaseToken).toBeNull();
    expect(await processInterviewEvaluation({ sessionId: input.sessionId }, deps())).toBe('ready');
  });
  it('rejects save, updates, replacements, pipelines and bulk mutation of persisted reports', async () => {
    await stageInterviewEvaluation(input);
    await processInterviewEvaluation({ sessionId: input.sessionId }, deps());
    const report = await InterviewReport.findOne();
    report!.report.overallScore = 100;
    report!.markModified('report');
    await expect(report!.save()).rejects.toThrow('immutable');
    await expect(report!.save({ validateBeforeSave: false })).rejects.toThrow('immutable');
    await expect(InterviewReport.updateOne({}, { $set: { 'report.overallScore': 100 } })).rejects.toThrow('immutable');
    await expect(InterviewReport.findOneAndUpdate({}, [{ $set: { userId: 'foreign' } }])).rejects.toThrow('immutable');
    await expect(InterviewReport.replaceOne({}, { sessionId: 'replacement' })).rejects.toThrow('immutable');
    await expect(InterviewReport.bulkWrite([{ updateMany: { filter: {}, update: { $set: { userId: 'foreign' } } } }])).rejects.toThrow('bulk');
    expect((await InterviewReport.findOne().lean())?.report.overallScore).toBe(0);
  });
  it('uses source code and measured time when available, otherwise keeps them null', () => {
    const session = scoringSession({ status: 'completed', durationSeconds: 90 });
    session.turns[0].code = 'return 1;';
    expect(completedEvaluationInput(session)).toMatchObject({ durationSeconds: 90, turns: [expect.objectContaining({ code: 'return 1;' }), ...Array(4).fill(expect.objectContaining({ code: null }))] });
    expect(() => completedEvaluationInput({ ...session, status: 'in_progress' })).toThrow('completed');
  });
  it('starts only one consumer and stops recovery and the consumer cleanly', async () => {
    await stageInterviewEvaluation(input);
    await Promise.all([startInterviewEvaluateWorker(), startInterviewEvaluateWorker()]);
    expect(mocks.worker).toHaveBeenCalledOnce();
    expect(mocks.worker).toHaveBeenCalledWith('interview-evaluate', expect.any(Function), expect.objectContaining({ concurrency: 2 }));
    const processor = mocks.worker.mock.calls[0][1];
    expect(await processor({ data: { sessionId: input.sessionId } })).toBe('ready');
    expect(mocks.publish).toHaveBeenCalledWith('owner', 'interview.report_ready', expect.objectContaining({ sessionId: input.sessionId }));
    await stopInterviewEvaluateWorker();
    await stopInterviewEvaluateWorker();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
