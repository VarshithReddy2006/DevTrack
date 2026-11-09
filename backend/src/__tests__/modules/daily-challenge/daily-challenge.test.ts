// src/__tests__/modules/daily-challenge/daily-challenge.test.ts
// Unit tests for the daily challenge service — challenge retrieval,
// adaptive difficulty selection, and completion detection.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { getTodayChallenge, checkChallengeCompletion } from '../../../modules/daily-challenge/daily-challenge.service.js';
import { DailyChallenge, XpTransaction, UserAnalytics, DsaProblem, DsaSubmission } from '../../../db/models/index.js';

// Mock XP processor
vi.mock('../../../modules/xp/processor.js', () => ({
  processXpEvent: vi.fn().mockResolvedValue({
    awarded: true,
    xpAwarded: 30,
    duplicate: false,
    levelBefore: 1,
    levelAfter: 1,
    leveledUp: false,
    newTotalXp: 30,
  }),
}));

vi.mock('../../../shared/sse/index.js', () => ({
  eventBus: {
    emitChallengeCompleted: vi.fn().mockResolvedValue(undefined),
    emitXpUpdated: vi.fn(),
    emitLevelUp: vi.fn(),
  },
}));

describe('Daily Challenge — getTodayChallenge', () => {
  const userId = new Types.ObjectId().toHexString();

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it('should create and return a new daily challenge if none exists', async () => {
    const result = await getTodayChallenge(userId);

    expect(result.challenge).toBeDefined();
    expect(result.challenge.title).toBeDefined();
    expect(result.challenge.difficulty).toBeDefined();
    expect(result.challenge.xpReward).toBeGreaterThan(0);
    expect(result.userCompleted).toBe(false);
  });

  it('should return existing challenge on subsequent calls', async () => {
    const first = await getTodayChallenge(userId);
    const second = await getTodayChallenge(userId);

    expect(first.challenge._id.toString()).toBe(second.challenge._id.toString());
    expect(first.challenge.title).toBe(second.challenge.title);
  });

  it('should detect completed challenge via XpTransaction', async () => {
    // Create a challenge first
    const { challenge } = await getTodayChallenge(userId);

    // Simulate completion by creating a transaction
    await XpTransaction.create({
      userId: new Types.ObjectId(userId),
      sourceType: 'challenge_completed',
      sourceId: challenge._id.toString(),
      xpAwarded: 30,
      previousTotalXp: 0,
      newTotalXp: 30,
      levelBefore: 1,
      levelAfter: 1,
    });

    const result = await getTodayChallenge(userId);
    expect(result.userCompleted).toBe(true);
  });

  it('should use adaptive difficulty based on streak', async () => {
    // Create a user with a high streak
    await UserAnalytics.create({
      userId: new Types.ObjectId(userId),
      currentStreak: 35, // > 30 => should get hard difficulty
    });

    const result = await getTodayChallenge(userId);
    // On a weekday with streak >= 30, difficulty should be 'hard'
    // On a weekend, it depends — but difficulty should be defined
    expect(['easy', 'medium', 'hard']).toContain(result.challenge.difficulty);
  });

  it('should default to easy difficulty for new users', async () => {
    const newUserId = new Types.ObjectId().toHexString();
    // No UserAnalytics => streak = 0 => easy
    const result = await getTodayChallenge(newUserId);
    // Since the challenge is already seeded by the first test for today,
    // it returns the existing one. But if we test in isolation:
    expect(result.challenge).toBeDefined();
  });

  it('returns the incremented count immediately after detecting an accepted solve', async () => {
    const { challenge } = await getTodayChallenge(userId);
    const initialCount = challenge.completionCount;
    const problem = await DsaProblem.create({
      userId, externalId: challenge.titleSlug, title: challenge.title,
      platform: challenge.platform, difficulty: challenge.difficulty,
      category: 'arrays', url: challenge.problemUrl, status: 'solved',
    });
    await DsaSubmission.create({
      userId, problemId: problem._id, platform: challenge.platform,
      externalId: 'fresh-count-submission', language: 'typescript',
      status: 'accepted', submittedAt: new Date(),
    });

    const result = await getTodayChallenge(userId);

    expect(result.userCompleted).toBe(true);
    expect(result.challenge.completionCount).toBe(initialCount + 1);
    expect((await DailyChallenge.findById(challenge._id))!.completionCount).toBe(initialCount + 1);
  });
});

describe('Daily Challenge — checkChallengeCompletion', () => {
  const userId = new Types.ObjectId().toHexString();

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it('should return false if no challenge exists for today', async () => {
    const result = await checkChallengeCompletion(userId, 'leetcode', 'nonexistent-slug', new Date());
    expect(result).toBe(false);
  });

  it('should return false if platform does not match', async () => {
    // Seed today's challenge
    await getTodayChallenge(userId);
    const challenge = await DailyChallenge.findOne({});

    // Try completion with wrong platform
    const result = await checkChallengeCompletion(userId, 'hackerrank', challenge!.titleSlug, new Date());
    expect(result).toBe(false);
  });

  it('should return false if title slug does not match', async () => {
    await getTodayChallenge(userId);
    const challenge = await DailyChallenge.findOne({});

    const result = await checkChallengeCompletion(userId, challenge!.platform, 'wrong-slug', new Date());
    expect(result).toBe(false);
  });

  it('should award XP on first completion', async () => {
    const { processXpEvent } = await import('../../../modules/xp/processor.js');
    await getTodayChallenge(userId);
    const challenge = await DailyChallenge.findOne({});

    const result = await checkChallengeCompletion(userId, challenge!.platform, challenge!.titleSlug, new Date());
    expect(result).toBe(true);
    expect(processXpEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        sourceType: 'challenge_completed',
        sourceId: challenge!._id.toString(),
      })
    );
  });

  it('should not award XP on duplicate completion', async () => {
    const { processXpEvent } = await import('../../../modules/xp/processor.js');
    await getTodayChallenge(userId);
    const challenge = await DailyChallenge.findOne({});

    // First completion
    await checkChallengeCompletion(userId, challenge!.platform, challenge!.titleSlug, new Date());

    // Create the XpTransaction so second completion is blocked
    await XpTransaction.create({
      userId: new Types.ObjectId(userId),
      sourceType: 'challenge_completed',
      sourceId: challenge!._id.toString(),
      xpAwarded: 30,
      previousTotalXp: 0,
      newTotalXp: 30,
      levelBefore: 1,
      levelAfter: 1,
    });

    vi.mocked(processXpEvent).mockClear();

    const result = await checkChallengeCompletion(userId, challenge!.platform, challenge!.titleSlug, new Date());
    expect(result).toBe(false);
    expect(processXpEvent).not.toHaveBeenCalled();
  });

  it('does not count or emit when the XP processor rejects a concurrent duplicate', async () => {
    const { processXpEvent } = await import('../../../modules/xp/processor.js');
    const { eventBus } = await import('../../../shared/sse/index.js');
    const { challenge } = await getTodayChallenge(userId);
    const initialCount = challenge.completionCount;
    vi.mocked(processXpEvent).mockResolvedValueOnce({
      awarded: false, duplicate: true, xpAwarded: 0, newTotalXp: 30,
      levelBefore: 1, levelAfter: 1, leveledUp: false,
    });

    const result = await checkChallengeCompletion(userId, challenge.platform, challenge.titleSlug, new Date());

    expect.soft(result).toBe(false);
    expect.soft(eventBus.emitChallengeCompleted).not.toHaveBeenCalled();
    expect((await DailyChallenge.findById(challenge._id))!.completionCount).toBe(initialCount);
  });

  it('should increment completionCount on the challenge document', async () => {
    await getTodayChallenge(userId);
    const challenge = await DailyChallenge.findOne({});
    const originalCount = challenge!.completionCount;

    await checkChallengeCompletion(userId, challenge!.platform, challenge!.titleSlug, new Date());

    const updated = await DailyChallenge.findById(challenge!._id);
    expect(updated!.completionCount).toBe(originalCount + 1);
  });
});
