import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { DsaSubmission } from '../../db/models/dsaSubmission.model.js';
import { DsaProblem } from '../../db/models/dsaProblem.model.js';
import { RevisionCard } from '../../db/models/revisionCard.model.js';
import { writeOutboxEvent } from '../../shared/events/outbox.js';
import { DAY_IN_MS, INITIAL_EASE_FACTOR } from './sm2.js';
import { dsaProblemIdentity } from '../dsa/dsa-problem-identity.js';

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/);
export const submissionEvaluationSchema = z.object({ submissionId: objectId }).strict();
export const revisionCardCreatedSchema = z.object({
  cardId: objectId, problemKey: z.string().min(1), title: z.string(),
  reasons: z.array(z.enum(['failed_attempts', 'low_runtime_percentile', 'time_limit_exceeded'])).min(1),
});

/** Replayed syncs repair an interrupted submission -> outbox handoff. */
export async function enqueueSubmissionEvaluation(userId: string, submissionId: string): Promise<void> {
  await mongoose.connection.transaction(async session => {
    const submission = await DsaSubmission.findOneAndUpdate({
      _id: submissionId, userId, revisionEvaluationQueued: { $ne: true },
    }, { $set: { revisionEvaluationQueued: true } }, { session, new: true });
    if (!submission) return;
    await writeOutboxEvent(session, {
      type: 'dsa.submission.evaluated', aggregateType: 'DsaSubmission',
      aggregateId: submissionId, userId, payload: { submissionId },
    });
  });
}

/** Reads authoritative owned records; event producers cannot supply a failure count. */
export async function generateStruggleCard(userId: string, input: unknown) {
  const { submissionId } = submissionEvaluationSchema.parse(input);
  objectId.parse(userId);
  const now = new Date();
  await RevisionCard.init();
  for (let attempt = 0; ; attempt++) {
    try {
      return await mongoose.connection.transaction(async session => {
        const submission = await DsaSubmission.findOne({ _id: submissionId, userId }).session(session).lean();
        if (!submission) return { created: false, cardId: null };
        const problem = await DsaProblem.findOne({ _id: submission.problemId, userId, platform: submission.platform }).session(session).lean();
        if (!problem) return { created: false, cardId: null };
        const previousAcceptance = await DsaSubmission.findOne({
          userId, problemId: problem._id, platform: submission.platform, status: 'accepted', submittedAt: { $lt: submission.submittedAt },
        }).sort({ submittedAt: -1 }).session(session).lean();
        const failures = await DsaSubmission.countDocuments({
          userId, problemId: problem._id, platform: submission.platform, status: { $ne: 'accepted' },
          submittedAt: { $lte: submission.submittedAt, ...(previousAcceptance ? { $gt: previousAcceptance.submittedAt } : {}) },
        }).session(session);
        const reasons: z.infer<typeof revisionCardCreatedSchema>['reasons'] = [];
        if (failures >= 3) reasons.push('failed_attempts');
        if (submission.status === 'accepted' && typeof submission.runtimePercentile === 'number' &&
          Number.isFinite(submission.runtimePercentile) && submission.runtimePercentile >= 0 && submission.runtimePercentile < 25) reasons.push('low_runtime_percentile');
        if (submission.status === 'time_limit_exceeded') reasons.push('time_limit_exceeded');
        if (!reasons.length) return { created: false, cardId: null };

        const canonical = problem.problemKey || dsaProblemIdentity(problem).key || `${problem.platform}:${problem.externalId.trim() || problem._id}`;
        const aliases = [...new Set([canonical, `${problem.platform}:${problem.externalId.trim()}`, `${problem.platform}:${problem._id}`])];
        const existing = await RevisionCard.findOne({ userId, problemKey: { $in: aliases } }).session(session).lean();
        const problemKey = existing?.problemKey ?? canonical;
        const cardId = new Types.ObjectId();
        const tags = [...new Set([...(problem.tags ?? []), ...(submission.topicTags ?? []), 'struggle_topic'])];
        const before = await RevisionCard.findOneAndUpdate({ userId, problemKey }, {
          $setOnInsert: { _id: cardId, userId, problemKey, title: problem.title, difficulty: problem.difficulty,
            reviewSeq: 0, repetitions: 0, easeFactor: INITIAL_EASE_FACTOR, intervalDays: 1,
            dueAt: new Date(now.getTime() + DAY_IN_MS), snoozedUntil: null, lastReviewedAt: null, notes: '' },
          $addToSet: { tags: { $each: tags } }, $max: { tagWeight: 2 },
        }, { session, upsert: true, returnDocument: 'before', setDefaultsOnInsert: false });
        if (before) return { created: false, cardId: before._id.toString() };
        await writeOutboxEvent(session, {
          type: 'revision.card_created', aggregateType: 'RevisionCard', aggregateId: cardId.toString(), userId,
          payload: { cardId: cardId.toString(), problemKey, title: problem.title, reasons },
        });
        return { created: true, cardId: cardId.toString() };
      });
    } catch (error) {
      // A concurrent solve/struggle insert can win the unique card key.
      if ((error as { code?: number }).code !== 11000 || attempt >= 1) throw error;
    }
  }
}
