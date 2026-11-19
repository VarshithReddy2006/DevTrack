import { OutboxEvent } from '../../db/models/outboxEvent.model.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DsaSubmission } from '../../db/models/dsaSubmission.model.js';
import { DsaProblem } from '../../db/models/dsaProblem.model.js';
import { FocusSession } from '../../db/models/focusSession.model.js';
import { RevisionCard } from '../../db/models/revisionCard.model.js';
import { ProcessedEvent } from '../../db/models/processedEvent.model.js';
import { UserQuestProgress } from '../../db/models/userQuestProgress.model.js';
import { User } from '../../db/models/user.model.js';
import type { QuestKind } from '../../db/models/quest.model.js';
import { registerConsumer, type ConsumerDefinition } from '../../shared/events/consumerRegistry.js';
import type { DomainEventEnvelope } from '../../shared/events/eventContract.js';
import { writeOutboxEvent } from '../../shared/events/outbox.js';
import { QueueNames } from '../../shared/jobs/types.js';
import { eventBus } from '../../shared/sse/eventBus.js';
import { decideFocusXp } from '../activity/focusXpDecision.js';
import { generateUserQuests, questObjectId, questTransaction } from './questEngine.service.js';
import { reconcileQuestReward } from '../xp/processor.js';

const progressPayload = z.object({ progressId: questObjectId });
type Evidence = { kind: QuestKind; key: string; amount: number; at: Date };

async function evidence(event: DomainEventEnvelope): Promise<Evidence | null> {
  const payload = z.object({
    submissionId: questObjectId.optional(), problemId: z.string().min(1).max(200).optional(), platform: z.string().min(1).max(30).optional(),
    sessionId: questObjectId.optional(), cardId: questObjectId.optional(),
    reviewSeq: z.number().int().positive().optional(),
  }).passthrough().parse(event.payload);
  if (event.type === 'dsa.submission.evaluated' || event.type === 'dsa.problem.solved') {
    if (!payload.submissionId && !payload.problemId) throw new Error('Missing solve identity');
    const canonicalProblem = payload.submissionId ? null : await DsaProblem.findOne({
      userId: event.userId, ...(questObjectId.safeParse(payload.problemId).success
        ? { _id: payload.problemId } : { platform: payload.platform ?? 'leetcode', externalId: payload.problemId }),
    }).lean();
    if (!payload.submissionId && !canonicalProblem) return null;
    const submission = await DsaSubmission.findOne({
      userId: event.userId, status: 'accepted',
      ...(payload.submissionId ? { _id: payload.submissionId } : { problemId: canonicalProblem!._id }),
    }).sort({ submittedAt: 1, _id: 1 }).lean();
    if (!submission) return null;
    // Count the first accepted solve of an owned problem, never repeated accepts.
    const first = await DsaSubmission.findOne({ userId: event.userId, problemId: submission.problemId, status: 'accepted' })
      .sort({ submittedAt: 1, _id: 1 }).lean();
    const problem = await DsaProblem.findOne({ _id: submission.problemId, userId: event.userId }).lean();
    if (!problem || !first) return null;
    return { kind: 'dsa_solve', key: first.problemId.toString(), amount: 1, at: first.submittedAt };
  }
  if (event.type === 'focus.session.completed') {
    if (!payload.sessionId) throw new Error('Missing session identity');
    const focus = await FocusSession.findOne({ _id: payload.sessionId, userId: event.userId, status: 'completed' }).lean();
    if (!focus?.completedAt) return null;
    const decision = decideFocusXp({ plannedSec: focus.plannedDurationMinutes * 60,
      activeSec: focus.activeDurationMs / 1000, coveredHeartbeatIntervals: focus.coveredHeartbeatIntervals ?? 0 }, []);
    if (!decision.qualified) return null;
    return { kind: 'focus_minutes', key: focus._id.toString(), amount: Math.floor(focus.activeDurationMs / 60_000), at: focus.completedAt };
  }
  if (!payload.cardId || !payload.reviewSeq) throw new Error('Missing review identity');
  const card = await RevisionCard.findOne({ _id: payload.cardId, userId: event.userId, reviewSeq: { $gte: payload.reviewSeq } }).lean();
  if (!card) return null;
  // Bind review identity and time to the producer's committed outbox record.
  const proof = await OutboxEvent.findOne({ userId: event.userId, type: 'revision.reviewed',
    'payload.cardId': payload.cardId, 'payload.reviewSeq': payload.reviewSeq }).lean();
  if (!proof) return null;
  const reviewedAt = z.object({ reviewedAt: z.string().datetime() }).parse(proof.payload).reviewedAt;
  return { kind: 'revision_review', key: `${payload.cardId}:${payload.reviewSeq}`, amount: 1, at: new Date(reviewedAt) };
}

export async function trackQuestEvent(event: DomainEventEnvelope, now = new Date()) {
  if (!['dsa.problem.solved', 'dsa.submission.evaluated', 'focus.session.completed', 'revision.reviewed', 'revision.card_reviewed'].includes(event.type) || event.schemaVersion !== 1) throw new Error('Unsupported quest event schema');
  questObjectId.parse(event.userId);
  if (!await User.exists({ _id: event.userId })) return;
  const source = await evidence(event);
  if (!source || !Number.isFinite(+source.at) || source.at > now || source.amount <= 0) return;
  await generateUserQuests(event.userId, now);
  await questTransaction(async session => {
    const rows = await UserQuestProgress.find({
      userId: event.userId, kind: source.kind, completed: false,
      startsAt: { $lte: source.at }, expiresAt: { $gt: now },
    }).session(session);
    for (const row of rows) {
      const eventId = createHash('sha256').update(JSON.stringify([event.userId, row._id.toString(), source.kind, source.key])).digest('hex');
      if (await ProcessedEvent.exists({ consumer: 'quests.progress', eventId }).session(session)) continue;
      await ProcessedEvent.create([{ consumer: 'quests.progress', eventId, eventType: event.type, userId: event.userId,
        processedAt: now, result: { success: true } }], { session });
      row.currentCount = Math.min(row.targetCount, row.currentCount + source.amount);
      if (row.currentCount >= row.targetCount) { row.completed = true; row.completedAt = now; }
      await row.save({ session });
      if (row.completed) await writeOutboxEvent(session, {
        type: 'quest.completed', aggregateType: 'UserQuestProgress', aggregateId: row._id.toString(), userId: event.userId,
        payload: { progressId: row._id.toString() }, traceContext: { correlationId: event.correlationId, causationId: event.id },
      });
    }
  });
}

export const questProgressConsumer: ConsumerDefinition = {
  name: 'quests.progress', pool: 'xp', queue: QueueNames.DOMAIN_READINESS, dedup: 'natural',
  handle: event => trackQuestEvent(event),
};
export const questNotificationConsumer: ConsumerDefinition = {
  name: 'quests.notification', pool: 'xp', queue: QueueNames.DOMAIN_READINESS, dedup: 'natural',
  handle: async event => {
    if (!['quest.completed', 'quest.claimed'].includes(event.type) || event.schemaVersion !== 1) throw new Error('Unsupported quest notification schema');
    questObjectId.parse(event.userId);
    const { progressId } = progressPayload.parse(event.payload);
    const progress = await UserQuestProgress.findOne({ _id: progressId, userId: event.userId, completed: true }).lean();
    if (!progress) return;
    if (event.type === 'quest.claimed') {
      if (!progress.claimed) return;
      await reconcileQuestReward(event.userId, progressId);
    }
    await eventBus.publishEnvelope(event.userId, event.type === 'quest.claimed' ? 'quest.claimed' : 'quest.completed', {
      questId: progressId, title: progress.title, currentCount: progress.currentCount, targetCount: progress.targetCount,
      claimed: progress.claimed, xpReward: progress.xpReward, trophyReward: progress.trophyReward,
    }, event.correlationId, event.schemaVersion);
  },
};
export function registerQuestConsumers() {
  for (const type of ['dsa.problem.solved', 'dsa.submission.evaluated', 'focus.session.completed', 'revision.reviewed', 'revision.card_reviewed']) {
    registerConsumer(type, questProgressConsumer);
  }
  registerConsumer('quest.completed', questNotificationConsumer);
  registerConsumer('quest.claimed', questNotificationConsumer);
}
