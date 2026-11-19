import { Types } from 'mongoose';
import { z } from 'zod';
import { RevisionCard, type ProblemDifficulty } from '../../db/models/revisionCard.model.js';
import { DAY_IN_MS } from './sm2.js';

export const RevisionQueueQuerySchema = z.object({
  limit: z.union([z.number(), z.string().regex(/^[1-9]\d*$/).transform(Number)])
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .transform(value => Math.min(value, 50)).default(20),
  pattern: z.string().trim().min(1).max(100).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
});

export interface RevisionQueueCard {
  id: string;
  problemKey: string;
  title: string;
  difficulty: ProblemDifficulty;
  tags: string[];
  pattern: string | null;
  dueAt: Date;
  reviewSeq: number;
  daysOverdue: number;
  tagWeight: number;
  priorityScore: number;
  priorityTier: 'standard' | 'overdue-easy';
  retentionPercentage: number;
  estimatedReviewMinutes: number;
}

export class RevisionQueueService {
  static async getQueue(options: z.input<typeof RevisionQueueQuerySchema> & { userId: string; now?: Date }): Promise<RevisionQueueCard[]> {
    const { userId, now = new Date(), ...query } = options;
    const { limit, pattern, difficulty } = RevisionQueueQuerySchema.parse(query);
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);

    return RevisionCard.aggregate<RevisionQueueCard>([
      // dueAt is the existing scheduler's next-review field, indexed with userId.
      { $match: {
        userId: new Types.ObjectId(userId), dueAt: { $lte: now },
        $or: [{ snoozedUntil: null }, { snoozedUntil: { $lte: now } }],
        ...(pattern ? { tags: pattern } : {}),
        ...(difficulty ? { difficulty } : {}),
      } },
      { $set: {
        priorityScore: { $multiply: [
          { $divide: [{ $subtract: [now, '$dueAt'] }, DAY_IN_MS] },
          { $divide: [2.5, { $max: [1.3, { $ifNull: ['$easeFactor', 2.5] }] }] },
          { $ifNull: ['$tagWeight', 1] },
        ] },
        // The issue explicitly puts today's due cards before overdue easy cards.
        deferredEasy: { $cond: [{ $and: [{ $eq: ['$difficulty', 'easy'] }, { $lt: ['$dueAt', today] }] }, 1, 0] },
      } },
      { $sort: { deferredEasy: 1, priorityScore: -1, dueAt: 1, _id: 1 } },
      { $limit: limit },
      // Compute the display-only retention estimate after limiting, not for every candidate.
      { $project: {
        _id: 0, id: { $toString: '$_id' }, problemKey: 1, title: 1, difficulty: 1,
        tags: { $ifNull: ['$tags', []] },
        pattern: pattern ? { $literal: pattern } : { $ifNull: [{ $arrayElemAt: ['$tags', 0] }, null] },
        dueAt: 1, reviewSeq: 1, priorityScore: 1,
        daysOverdue: { $divide: [{ $subtract: [now, '$dueAt'] }, DAY_IN_MS] },
        tagWeight: { $ifNull: ['$tagWeight', 1] },
        priorityTier: { $cond: ['$deferredEasy', 'overdue-easy', 'standard'] },
        retentionPercentage: { $multiply: [100, { $exp: { $divide: [
          { $multiply: [-1, { $max: [0, { $divide: [
            { $subtract: [now, { $ifNull: ['$lastReviewedAt', '$createdAt'] }] }, DAY_IN_MS,
          ] }] }] }, { $max: [1, '$intervalDays'] },
        ] } }] },
        estimatedReviewMinutes: { $switch: { branches: [
          { case: { $eq: ['$difficulty', 'easy'] }, then: 5 },
          { case: { $eq: ['$difficulty', 'hard'] }, then: 15 },
        ], default: 10 } },
      } },
    ]).exec();
  }
}
