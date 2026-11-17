// backend/src/__tests__/integration/revision-review.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { RevisionCard } from '../../db/models/revisionCard.model.js';
import { UserXp, XpTransaction } from '../../db/models/index.js';
import { handleDsaProblemSolved } from '../../modules/revision/consumers/dsaProblemSolved.consumer.js';
import {
  RevisionService,
  RevisionCardStaleError,
  RevisionCardNotFoundError,
} from '../../modules/revision/revision.service.js';

describe('Revision Radar Integration & Optimistic Concurrency', () => {
  beforeAll(async () => {
    // Duplicate detection depends on the compound unique index being ready.
    await RevisionCard.init();
  });

  beforeEach(async () => {
    await RevisionCard.deleteMany({});
    await UserXp.deleteMany({});
    await XpTransaction.deleteMany({});
  });

  describe('dsaProblemSolved.consumer', () => {
    it('creates exactly one card with SM-2 defaults and is idempotent on repeat events', async () => {
      const userId = new Types.ObjectId().toString();

      // First solved event
      const res1 = await handleDsaProblemSolved({
        userId,
        platform: 'leetcode',
        problemId: 'two-sum',
        title: 'Two Sum',
        difficulty: 'easy',
        tags: ['array', 'hash-table'],
      });

      expect(res1.created).toBe(true);

      const card = await RevisionCard.findById(res1.cardId);
      expect(card).toBeDefined();
      expect(card?.problemKey).toBe('leetcode:two-sum');
      expect(card?.easeFactor).toBe(2.5);
      expect(card?.repetitions).toBe(0);
      expect(card?.intervalDays).toBe(1);
      expect(card?.reviewSeq).toBe(0);

      // Repeat solved event for same problem should NOT duplicate card
      const res2 = await handleDsaProblemSolved({
        userId,
        platform: 'leetcode',
        problemId: 'two-sum',
        title: 'Two Sum',
        difficulty: 'easy',
      });

      expect(res2.created).toBe(false);
      expect(res2.cardId).toBe(res1.cardId);

      const count = await RevisionCard.countDocuments({
        userId: new Types.ObjectId(userId),
        problemKey: 'leetcode:two-sum',
      });
      expect(count).toBe(1);
    });
  });

  describe('RevisionService.getDueCards', () => {
    it('filters due cards by dueAt and snoozedUntil and respects limit', async () => {
      const userId = new Types.ObjectId().toString();
      const userObjId = new Types.ObjectId(userId);
      const now = new Date('2026-06-01T12:00:00.000Z');

      // Card 1: Overdue, due 2 days ago
      await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:1',
        title: 'Problem 1',
        dueAt: new Date(now.getTime() - 2 * 86_400_000),
      });

      // Card 2: Due now
      await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:2',
        title: 'Problem 2',
        dueAt: now,
      });

      // Card 3: Due tomorrow (should NOT be returned)
      await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:3',
        title: 'Problem 3',
        dueAt: new Date(now.getTime() + 86_400_000),
      });

      // Card 4: Overdue but snoozed until tomorrow (should NOT be returned)
      await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:4',
        title: 'Problem 4',
        dueAt: new Date(now.getTime() - 86_400_000),
        snoozedUntil: new Date(now.getTime() + 86_400_000),
      });

      const dueCards = await RevisionService.getDueCards({ userId, now, limit: 10 });
      expect(dueCards.length).toBe(2);
      expect(dueCards[0].problemKey).toBe('leetcode:1'); // Sorted by dueAt ASC
      expect(dueCards[1].problemKey).toBe('leetcode:2');
    });
  });

  describe('RevisionService.submitReview & Optimistic Concurrency', () => {
    it('advances SM-2 state and increments reviewSeq on valid review', async () => {
      const userId = new Types.ObjectId().toString();
      const userObjId = new Types.ObjectId(userId);
      const now = new Date('2026-06-01T12:00:00.000Z');

      const card = await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:valid-review',
        title: 'Valid Review Problem',
        difficulty: 'medium',
        repetitions: 0,
        easeFactor: 2.5,
        intervalDays: 1,
        dueAt: now,
        reviewSeq: 0,
      });

      const updated = await RevisionService.submitReview({
        userId,
        cardId: card._id.toString(),
        rating: 'easy',
        reviewSeq: 0,
        now,
      });

      expect(updated.reviewSeq).toBe(1);
      expect(updated.repetitions).toBe(1);
      expect(updated.easeFactor).toBe(2.6);
      expect(updated.intervalDays).toBe(1);
      expect(updated.dueAt).toEqual(new Date(now.getTime() + 1 * 86_400_000));
    });

    it('rejects stale review submission with RevisionCardStaleError (HTTP 409 pattern)', async () => {
      const userId = new Types.ObjectId().toString();
      const userObjId = new Types.ObjectId(userId);
      const now = new Date('2026-06-01T12:00:00.000Z');

      const card = await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:stale-test',
        title: 'Stale Concurrency Problem',
        reviewSeq: 2, // card is already at seq 2
        repetitions: 2,
        easeFactor: 2.6,
        intervalDays: 3,
        dueAt: now,
      });

      // Client submits with stale reviewSeq 1 (outdated)
      await expect(
        RevisionService.submitReview({
          userId,
          cardId: card._id.toString(),
          rating: 'easy',
          reviewSeq: 1, // Mismatch: expects 2
          now,
        })
      ).rejects.toThrow(RevisionCardStaleError);
    });

    it('throws RevisionCardNotFoundError for nonexistent card', async () => {
      const userId = new Types.ObjectId().toString();
      const fakeId = new Types.ObjectId().toString();

      await expect(
        RevisionService.submitReview({
          userId,
          cardId: fakeId,
          rating: 'easy',
          reviewSeq: 0,
        })
      ).rejects.toThrow(RevisionCardNotFoundError);
    });
  });
});
