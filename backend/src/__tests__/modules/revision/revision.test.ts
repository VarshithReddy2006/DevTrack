// backend/src/__tests__/modules/revision/revision.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import {
  computeNextSm2State,
  calculateEaseFactor,
  calculateIntervalDays,
  ratingToQuality,
} from '../../../modules/revision/sm2.js';
import { RevisionCard } from '../../../db/models/revisionCard.model.js';
import { UserXp, XpTransaction } from '../../../db/models/index.js';
import { handleDsaProblemSolved } from '../../../modules/revision/consumers/dsaProblemSolved.consumer.js';
import {
  RevisionService,
  RevisionCardStaleError,
  RevisionCardNotFoundError,
} from '../../../modules/revision/revision.service.js';
import { handleRevisionReviewed } from '../../../modules/xp/consumers/revisionReviewed.consumer.js';

describe('Revision SM-2 Engine Unit Tests', () => {
  describe('Quality and Ease Factor', () => {
    it('maps ratings to quality scores correctly', () => {
      expect(ratingToQuality('failed')).toBe(1);
      expect(ratingToQuality('hard')).toBe(3);
      expect(ratingToQuality('easy')).toBe(5);
    });

    it('adjusts ease factor with 1.3 minimum floor', () => {
      expect(calculateEaseFactor(2.5, 5)).toBe(2.6);
      expect(calculateEaseFactor(2.5, 3)).toBe(2.36);
      expect(calculateEaseFactor(2.5, 1)).toBe(1.96);
      expect(calculateEaseFactor(1.4, 1)).toBe(1.3); // Clamped
    });
  });

  describe('Interval Progression', () => {
    it('resets to 1 day on quality < 3 (failed)', () => {
      expect(calculateIntervalDays(1, 4, 30, 2.5)).toBe(1);
    });

    it('follows 1 -> 3 -> 7 seed ladder for first three successful reviews', () => {
      expect(calculateIntervalDays(5, 0, 1, 2.5)).toBe(1);
      expect(calculateIntervalDays(5, 1, 1, 2.6)).toBe(3);
      expect(calculateIntervalDays(5, 2, 3, 2.7)).toBe(7);
    });

    it('multiplies interval by EF for repetitions > 2', () => {
      expect(calculateIntervalDays(5, 3, 7, 2.8)).toBe(20);
    });
  });

  describe('computeNextSm2State', () => {
    it('computes full state transition for easy solve', () => {
      const now = new Date('2026-06-01T12:00:00.000Z');
      const next = computeNextSm2State(
        { repetitions: 1, easeFactor: 2.6, intervalDays: 1 },
        'easy',
        now
      );

      expect(next.repetitions).toBe(2);
      expect(next.easeFactor).toBe(2.7);
      expect(next.intervalDays).toBe(3);
      expect(next.dueAt).toEqual(new Date('2026-06-04T00:00:00.000Z'));
    });

    it('resets repetitions to 0 on failed rating', () => {
      const now = new Date('2026-06-01T12:00:00.000Z');
      const next = computeNextSm2State(
        { repetitions: 4, easeFactor: 2.5, intervalDays: 20 },
        'failed',
        now
      );

      expect(next.repetitions).toBe(0);
      expect(next.intervalDays).toBe(1);
      expect(next.easeFactor).toBe(1.96);
      expect(next.dueAt).toEqual(new Date('2026-06-02T00:00:00.000Z'));
    });
  });
});

describe('Revision Radar Services & Transactions (Replica Set)', () => {
  beforeEach(async () => {
    await RevisionCard.deleteMany({});
    await UserXp.deleteMany({});
    await XpTransaction.deleteMany({});
  });

  describe('dsaProblemSolved.consumer', () => {
    it('creates exactly one card with SM-2 defaults and is idempotent on repeat events', async () => {
      const userId = new Types.ObjectId().toString();

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

      // Repeat solved event should NOT duplicate card
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

      await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:1',
        title: 'Problem 1',
        dueAt: new Date(now.getTime() - 2 * 86_400_000),
      });

      await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:2',
        title: 'Problem 2',
        dueAt: now,
      });

      await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:3',
        title: 'Problem 3',
        dueAt: new Date(now.getTime() + 86_400_000),
      });

      await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:4',
        title: 'Problem 4',
        dueAt: new Date(now.getTime() - 86_400_000),
        snoozedUntil: new Date(now.getTime() + 86_400_000),
      });

      const dueCards = await RevisionService.getDueCards({ userId, now, limit: 10 });
      expect(dueCards.length).toBe(2);
      expect(dueCards[0].problemKey).toBe('leetcode:1');
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
      expect(updated.dueAt).toEqual(new Date('2026-06-02T00:00:00.000Z'));
    });

    it('makes late-night reviews due the next morning at start of day without drift', async () => {
      const userId = new Types.ObjectId().toString();
      const userObjId = new Types.ObjectId(userId);
      const lateReviewTime = new Date('2026-06-01T23:30:00.000Z');

      const card = await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:late-night-review',
        title: 'Late Night Problem',
        difficulty: 'medium',
        repetitions: 0,
        easeFactor: 2.5,
        intervalDays: 1,
        dueAt: lateReviewTime,
        reviewSeq: 0,
      });

      const updated = await RevisionService.submitReview({
        userId,
        cardId: card._id.toString(),
        rating: 'easy',
        reviewSeq: 0,
        now: lateReviewTime,
      });

      expect(updated.dueAt).toEqual(new Date('2026-06-02T00:00:00.000Z'));

      const nextMorning = await RevisionService.getDueCards({
        userId,
        now: new Date('2026-06-02T08:00:00.000Z'),
      });
      expect(nextMorning.map(c => c._id.toString())).toEqual([card._id.toString()]);
    });

    it('rejects stale review submission with RevisionCardStaleError', async () => {
      const userId = new Types.ObjectId().toString();
      const userObjId = new Types.ObjectId(userId);
      const now = new Date('2026-06-01T12:00:00.000Z');

      const card = await RevisionCard.create({
        userId: userObjId,
        problemKey: 'leetcode:stale-test',
        title: 'Stale Concurrency Problem',
        reviewSeq: 2,
        repetitions: 2,
        easeFactor: 2.6,
        intervalDays: 3,
        dueAt: now,
      });

      await expect(
        RevisionService.submitReview({
          userId,
          cardId: card._id.toString(),
          rating: 'easy',
          reviewSeq: 1,
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

  describe('handleRevisionReviewed XP Consumer', () => {
    it('awards exactly 5 XP with natural idempotency on repeat delivery', async () => {
      const userId = new Types.ObjectId().toString();
      const cardId = new Types.ObjectId().toString();
      const reviewSeq = 1;

      const res1 = await handleRevisionReviewed({
        userId,
        cardId,
        reviewSeq,
        rating: 'easy',
      });

      expect(res1.awarded).toBe(true);
      expect(res1.xpAwarded).toBe(5);
      expect(res1.duplicate).toBe(false);

      const userXp = await UserXp.findOne({ userId: new Types.ObjectId(userId) });
      expect(userXp?.totalXp).toBe(5);

      // Repeat delivery
      const res2 = await handleRevisionReviewed({
        userId,
        cardId,
        reviewSeq,
        rating: 'easy',
      });

      expect(res2.awarded).toBe(false);
      expect(res2.duplicate).toBe(true);
      expect(res2.xpAwarded).toBe(0);

      const userXpAfter = await UserXp.findOne({ userId: new Types.ObjectId(userId) });
      expect(userXpAfter?.totalXp).toBe(5);
    });
  });
});
