// src/modules/revision/consumers/dsaProblemSolved.consumer.ts — Ingests dsa.problem.solved into RevisionCard
import { Types } from 'mongoose';
import { RevisionCard, type ProblemDifficulty } from '../../../db/models/revisionCard.model.js';
import { logger } from '../../../shared/logger.js';
import { DAY_IN_MS, INITIAL_EASE_FACTOR } from '../sm2.js';

export interface DsaProblemSolvedEvent {
  userId: string;
  platform: string;
  problemId: string;
  title: string;
  difficulty?: ProblemDifficulty;
  tags?: string[];
  solvedAt?: Date | string;
}

/**
 * Handles dsa.problem.solved domain event.
 * Performs an idempotent insert on { userId, problemKey } to ensure exactly
 * one revision card exists per problem per user, seeded with initial SM-2 defaults.
 */
export async function handleDsaProblemSolved(
  event: DsaProblemSolvedEvent
): Promise<{ cardId: string; created: boolean }> {
  const { userId, platform, problemId, title, difficulty = 'medium', tags = [] } = event;

  if (!userId || !platform || !problemId) {
    throw new Error('handleDsaProblemSolved: missing required fields (userId, platform, problemId)');
  }

  const problemKey = `${platform.toLowerCase()}:${problemId.trim()}`;
  const now = event.solvedAt ? new Date(event.solvedAt) : new Date();
  const dueTomorrow = new Date(now.getTime() + DAY_IN_MS);
  const userObjId = new Types.ObjectId(userId);

  try {
    const card = await RevisionCard.create({
      userId: userObjId,
      problemKey,
      title: title || problemId,
      difficulty,
      tags,
      reviewSeq: 0,
      repetitions: 0,
      easeFactor: INITIAL_EASE_FACTOR,
      intervalDays: 1,
      dueAt: dueTomorrow,
    });

    logger.info('handleDsaProblemSolved: created new revision card', {
      userId,
      problemKey,
      cardId: card._id,
    });

    return {
      cardId: card._id.toString(),
      created: true,
    };
  } catch (err: any) {
    if (err.code === 11000) {
      // Duplicate key error: card already exists for this problem
      const existing = await RevisionCard.findOne({ userId: userObjId, problemKey });
      return {
        cardId: existing?._id.toString() || '',
        created: false,
      };
    }
    throw err;
  }
}
