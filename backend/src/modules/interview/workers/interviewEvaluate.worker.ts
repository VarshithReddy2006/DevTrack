import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Worker } from 'bullmq';
import type { ClientSession } from 'mongoose';
import { InterviewEvaluationRequest, InterviewReport } from '../../../db/models/interviewReport.model.js';
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { QueueNames, JobRetryConfig } from '../../../shared/jobs/types.js';
import { getRedisClient } from '../../../shared/redis/index.js';
import { eventBus } from '../../../shared/sse/eventBus.js';
import { logger } from '../../../shared/logger.js';
import { evaluateInterview, evaluationInputSchema, type EvaluationInput } from '../rubricEvaluator.service.js';
import type { ScoringSession } from './interviewSessionPort.js';

const jobSchema = z.object({ sessionId: z.string().min(1).max(200) }).strict();
export type InterviewEvaluateJob = z.infer<typeof jobSchema>;
const duplicate = (error: unknown) => (error as { code?: number })?.code === 11000;

/** Internal server-side API only. Call inside the final-session transaction to close the commit/enqueue gap. */
export async function stageInterviewEvaluation(value: EvaluationInput, session?: ClientSession): Promise<void> {
  const input = evaluationInputSchema.parse(value);
  const sourceHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  let request;
  try {
    request = await InterviewEvaluationRequest.findOneAndUpdate(
      { sessionId: input.sessionId },
      { $setOnInsert: { sessionId: input.sessionId, userId: input.userId, sourceHash, input } },
      { upsert: true, new: true, runValidators: true, session },
    ).lean();
  } catch (error) {
    if (!duplicate(error) || session) throw error;
    request = await InterviewEvaluationRequest.findOne({ sessionId: input.sessionId }).lean();
  }
  if (!request || request.sourceHash !== sourceHash || request.userId !== input.userId) {
    throw new Error('Conflicting interview evaluation source');
  }
}

export function completedEvaluationInput(session: ScoringSession): EvaluationInput {
  if (session.status !== 'completed') throw new Error('Only completed interviews may be evaluated');
  return evaluationInputSchema.parse({
    sessionId: session.id, userId: session.userId, role: session.role,
    durationSeconds: session.durationSeconds ?? null, mode: session.mode ?? 'ai',
    turns: session.turns.map(turn => ({
      question: turn.question.prompt, answer: turn.answer,
      code: turn.code ?? null, feedback: turn.feedback,
    })),
  });
}

async function queueEvaluation(sessionId: string): Promise<void> {
  await getOrCreateQueue(QueueNames.INTERVIEW_EVALUATE).add('interview.evaluate', { sessionId }, {
    ...JobRetryConfig.standard,
    jobId: `evaluation-${createHash('sha256').update(sessionId).digest('hex')}`,
    removeOnComplete: true, removeOnFail: true,
  });
}

export async function enqueueCompletedInterview(session: ScoringSession): Promise<void> {
  await stageInterviewEvaluation(completedEvaluationInput(session));
  await queueEvaluation(session.id);
}

export interface EvaluationDeps {
  evaluate: typeof evaluateInterview;
  publish: (userId: string, payload: { sessionId: string; reportId: string; mode: 'ai' | 'basic_mode' }) => Promise<void>;
}
const defaultDeps: EvaluationDeps = {
  evaluate: evaluateInterview,
  publish: (userId, payload) => eventBus.publishEnvelope(userId, 'interview.report_ready', payload),
};

export async function processInterviewEvaluation(data: InterviewEvaluateJob, deps: EvaluationDeps = defaultDeps) {
  const { sessionId } = jobSchema.parse(data);
  const leaseToken = randomUUID();
  const request = await InterviewEvaluationRequest.findOneAndUpdate(
    { sessionId, deliveredAt: null, leaseUntil: { $lte: new Date() } },
    { $set: { leaseToken, leaseUntil: new Date(Date.now() + 5 * 60_000) } },
    { new: true },
  ).lean();
  if (!request) return 'skipped' as const;
  try {
    const input = evaluationInputSchema.parse(request.input);
    if (input.userId !== request.userId || input.sessionId !== sessionId) throw new Error('Invalid evaluation owner');
    if (createHash('sha256').update(JSON.stringify(input)).digest('hex') !== request.sourceHash) throw new Error('Invalid evaluation source hash');
    let report = await InterviewReport.findOne({ sessionId }).lean();
    if (!report) {
      const result = await deps.evaluate(input);
      // Fence a late model result after another worker has acquired the expired lease.
      const active = await InterviewEvaluationRequest.exists({ sessionId, leaseToken, leaseUntil: { $gt: new Date() } });
      if (!active) throw new Error('Interview evaluation lease expired');
      try {
        report = (await InterviewReport.create({ sessionId, userId: input.userId, sourceHash: request.sourceHash, report: result })).toObject();
      } catch (error) {
        if (!duplicate(error)) throw error;
        report = await InterviewReport.findOne({ sessionId }).lean();
      }
    }
    if (!report || report.userId !== input.userId || report.sourceHash !== request.sourceHash) throw new Error('Conflicting interview report');
    const active = await InterviewEvaluationRequest.exists({ sessionId, leaseToken, leaseUntil: { $gt: new Date() } });
    if (!active) throw new Error('Interview evaluation lease expired');
    await deps.publish(input.userId, { sessionId, reportId: String(report._id), mode: report.report.mode });
    await InterviewEvaluationRequest.updateOne({ sessionId, leaseToken }, { $set: { deliveredAt: new Date() } });
    return 'ready' as const;
  } finally {
    await InterviewEvaluationRequest.updateOne({ sessionId, leaseToken }, { $set: { leaseUntil: new Date(0), leaseToken: null } });
  }
}

/** Durable requests recover failed Redis enqueue and notification attempts without re-scoring saved reports. */
export async function recoverInterviewEvaluations(): Promise<void> {
  const cursor = InterviewEvaluationRequest.find({ deliveredAt: null, leaseUntil: { $lte: new Date() } })
    .select({ sessionId: 1 }).sort({ _id: 1 }).lean().cursor();
  for await (const request of cursor) await queueEvaluation(request.sessionId);
}

let worker: Worker<InterviewEvaluateJob> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let recovery: Promise<void> | null = null;
let starting: Promise<void> | null = null;
function recover() {
  if (!recovery) recovery = recoverInterviewEvaluations().catch(error => {
    logger.error('[interview-evaluate] Recovery failed', error);
  }).finally(() => { recovery = null; });
  return recovery;
}
export async function startInterviewEvaluateWorker(): Promise<void> {
  if (starting) return starting;
  if (worker) return;
  starting = (async () => {
    // Establish uniqueness even when production disables Mongoose autoIndex.
    await Promise.all([InterviewReport.createIndexes(), InterviewEvaluationRequest.createIndexes()]);
    worker = createDlqWorker<InterviewEvaluateJob>(QueueNames.INTERVIEW_EVALUATE,
      job => processInterviewEvaluation(job.data), { connection: getRedisClient(), concurrency: 2 });
    worker.on('error', error => logger.error('[interview-evaluate] Worker error', error));
    timer = setInterval(() => { void recover(); }, 60_000);
    timer.unref();
    await recover();
  })();
  try { await starting; } finally { starting = null; }
}
export async function stopInterviewEvaluateWorker(): Promise<void> {
  await starting;
  if (timer) clearInterval(timer);
  timer = null;
  await recovery;
  const active = worker;
  worker = null;
  await active?.close();
}
