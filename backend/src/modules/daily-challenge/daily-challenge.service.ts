// src/modules/daily-challenge/daily-challenge.service.ts
import { Types } from 'mongoose';
import { DailyChallenge, DsaProblem, DsaSubmission, XpTransaction, UserAnalytics } from '../../db/models/index.js';
import type { IDailyChallenge } from '../../db/models/dailyChallenge.model.js';
import { processXpEvent } from '../xp/processor.js';
import { eventBus } from '../../shared/sse/index.js';
import { logger } from '../../shared/logger.js';
import { localDateString, localDayBounds } from './daily-challenge.time.js';
import { getUserTimezone } from '../../shared/userTimezone.js';

// ---------------------------------------------------------------------------
// Expanded Challenge Pool — organized by difficulty
// ---------------------------------------------------------------------------

interface ChallengeTemplate {
  title: string;
  titleSlug: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  platform: 'leetcode' | 'codeforces' | 'codechef';
  problemUrl: string;
  xpReward: number;
  completionCount: number;
}

const CHALLENGE_POOL: Record<'easy' | 'medium' | 'hard', ChallengeTemplate[]> = {
  easy: [
    { title: 'Two Sum', titleSlug: 'two-sum', description: 'Find two numbers that add up to a specific target.', difficulty: 'easy', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/two-sum', xpReward: 30, completionCount: 320 },
    { title: 'Valid Parentheses', titleSlug: 'valid-parentheses', description: 'Determine if the input string has valid brackets.', difficulty: 'easy', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/valid-parentheses', xpReward: 30, completionCount: 245 },
    { title: 'Watermelon', titleSlug: '4-a', description: 'Divide the watermelon into two even parts.', difficulty: 'easy', platform: 'codeforces', problemUrl: 'https://codeforces.com/problemset/problem/4/A', xpReward: 30, completionCount: 512 },
    { title: 'Best Time to Buy and Sell Stock', titleSlug: 'best-time-to-buy-and-sell-stock', description: 'Find the maximum profit from a single stock transaction.', difficulty: 'easy', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/best-time-to-buy-and-sell-stock', xpReward: 30, completionCount: 410 },
    { title: 'Merge Two Sorted Lists', titleSlug: 'merge-two-sorted-lists', description: 'Merge two sorted linked lists into one.', difficulty: 'easy', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/merge-two-sorted-lists', xpReward: 30, completionCount: 380 },
    { title: 'Climbing Stairs', titleSlug: 'climbing-stairs', description: 'Count distinct ways to climb n stairs taking 1 or 2 steps.', difficulty: 'easy', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/climbing-stairs', xpReward: 30, completionCount: 356 },
    { title: 'Maximum Subarray', titleSlug: 'maximum-subarray', description: 'Find the contiguous subarray with the largest sum.', difficulty: 'easy', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/maximum-subarray', xpReward: 30, completionCount: 290 },
    { title: 'Palindrome Number', titleSlug: 'palindrome-number', description: 'Determine whether an integer is a palindrome.', difficulty: 'easy', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/palindrome-number', xpReward: 30, completionCount: 445 },
  ],
  medium: [
    { title: 'Longest Substring Without Repeating Characters', titleSlug: 'longest-substring-without-repeating-characters', description: 'Find the length of the longest substring without repeating characters.', difficulty: 'medium', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/longest-substring-without-repeating-characters', xpReward: 50, completionCount: 188 },
    { title: 'Container With Most Water', titleSlug: 'container-with-most-water', description: 'Find two lines that together form a container holding the most water.', difficulty: 'medium', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/container-with-most-water', xpReward: 50, completionCount: 195 },
    { title: '3Sum', titleSlug: '3sum', description: 'Find all unique triplets that sum to zero.', difficulty: 'medium', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/3sum', xpReward: 50, completionCount: 165 },
    { title: 'Group Anagrams', titleSlug: 'group-anagrams', description: 'Group strings that are anagrams of each other.', difficulty: 'medium', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/group-anagrams', xpReward: 50, completionCount: 210 },
    { title: 'Coin Change', titleSlug: 'coin-change', description: 'Find the minimum number of coins to make a given amount.', difficulty: 'medium', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/coin-change', xpReward: 50, completionCount: 178 },
    { title: 'Binary Tree Level Order', titleSlug: 'binary-tree-level-order-traversal', description: 'Return the level order traversal of a binary tree.', difficulty: 'medium', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/binary-tree-level-order-traversal', xpReward: 50, completionCount: 202 },
    { title: 'Product of Array Except Self', titleSlug: 'product-of-array-except-self', description: 'Return array where each element is the product of all other elements.', difficulty: 'medium', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/product-of-array-except-self', xpReward: 50, completionCount: 225 },
    { title: 'Word Search', titleSlug: 'word-search', description: 'Determine if a word exists in a 2D grid of characters.', difficulty: 'medium', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/word-search', xpReward: 50, completionCount: 145 },
  ],
  hard: [
    { title: 'Trapping Rain Water', titleSlug: 'trapping-rain-water', description: 'Compute how much water is trapped after raining.', difficulty: 'hard', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/trapping-rain-water', xpReward: 80, completionCount: 85 },
    { title: 'Merge k Sorted Lists', titleSlug: 'merge-k-sorted-lists', description: 'Merge k sorted linked lists into one sorted list.', difficulty: 'hard', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/merge-k-sorted-lists', xpReward: 80, completionCount: 92 },
    { title: 'Minimum Window Substring', titleSlug: 'minimum-window-substring', description: 'Find the minimum window containing all characters of another string.', difficulty: 'hard', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/minimum-window-substring', xpReward: 80, completionCount: 72 },
    { title: 'Median of Two Sorted Arrays', titleSlug: 'median-of-two-sorted-arrays', description: 'Find the median of two sorted arrays in O(log(m+n)).', difficulty: 'hard', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/median-of-two-sorted-arrays', xpReward: 80, completionCount: 65 },
    { title: 'Serialize and Deserialize Binary Tree', titleSlug: 'serialize-and-deserialize-binary-tree', description: 'Design an algorithm to serialize and deserialize a binary tree.', difficulty: 'hard', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/serialize-and-deserialize-binary-tree', xpReward: 80, completionCount: 78 },
    { title: 'Word Ladder', titleSlug: 'word-ladder', description: 'Find the shortest transformation sequence from one word to another.', difficulty: 'hard', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/word-ladder', xpReward: 80, completionCount: 88 },
    { title: 'Longest Increasing Path in a Matrix', titleSlug: 'longest-increasing-path-in-a-matrix', description: 'Find the longest increasing path in a matrix.', difficulty: 'hard', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/longest-increasing-path-in-a-matrix', xpReward: 80, completionCount: 70 },
    { title: 'Regular Expression Matching', titleSlug: 'regular-expression-matching', description: 'Implement regular expression matching with . and *.', difficulty: 'hard', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/regular-expression-matching', xpReward: 80, completionCount: 55 },
  ],
};

const CHALLENGE_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

// ---------------------------------------------------------------------------
// Adaptive Difficulty Selection
// ---------------------------------------------------------------------------

async function selectAdaptiveDifficulty(userId: string, dateStr: string): Promise<'easy' | 'medium' | 'hard'> {
  try {
    const analytics = await UserAnalytics.findOne({ userId: new Types.ObjectId(userId) }).lean();
    const currentStreak = analytics?.currentStreak ?? 0;

    // Weekend/weekday balancing — easier on weekends
    const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    if (isWeekend) {
      return currentStreak >= 14 ? 'medium' : 'easy';
    }

    // Streak-sensitive difficulty
    if (currentStreak >= 30) return 'hard';
    if (currentStreak >= 14) return 'medium';
    if (currentStreak >= 7) {
      // Mix: 60% medium, 40% easy based on date hash
      const dateHash = hashDateString(dateStr);
      return dateHash % 5 < 3 ? 'medium' : 'easy';
    }
    if (currentStreak >= 3) {
      // Mix: 70% easy, 30% medium
      const dateHash = hashDateString(dateStr);
      return dateHash % 10 < 3 ? 'medium' : 'easy';
    }
    return 'easy'; // New or low-streak users get easy
  } catch (err) {
    logger.debug('[daily-challenge] Difficulty calculation failed, defaulting to easy', { userId, error: err instanceof Error ? err.message : String(err) });
    return 'easy';
  }
}

function getChallengeForDate(dateStr: string, difficulty: 'easy' | 'medium' | 'hard') {
  const pool = CHALLENGE_POOL[difficulty];
  const hash = hashDateString(dateStr);
  const index = hash % pool.length;
  const selected = pool[index];
  
  return { ...selected };
}

function hashDateString(dateStr: string): number {
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = dateStr.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

async function seedChallenge(date: string, difficulty: IDailyChallenge['difficulty']) {
  const key = { date, difficulty };
  const { difficulty: _difficulty, ...template } = getChallengeForDate(date, difficulty);
  const now = new Date();
  // Use the compound unique index for both scheduled and on-demand writes.
  // Existing challenges keep their IDs, counters, and timestamps.
  return DailyChallenge.findOneAndUpdate(
    key,
    { $setOnInsert: {
      ...template,
      completionCount: 0,
      createdAt: now,
      updatedAt: now,
    } },
    { upsert: true, new: true, timestamps: false },
  ).orFail();
}

export async function seedDailyChallengeWindow(now = new Date()): Promise<void> {
  const utcDate = new Date(now);
  utcDate.setUTCHours(0, 0, 0, 0);
  for (const offset of [-1, 0, 1]) {
    const date = new Date(utcDate);
    date.setUTCDate(date.getUTCDate() + offset);
    const dateKey = date.toISOString().slice(0, 10);
    await Promise.all(CHALLENGE_DIFFICULTIES.map(difficulty => seedChallenge(dateKey, difficulty)));
  }
}

export async function getTodayChallenge(userId: string) {
  const now = new Date();
  const timezone = await getUserTimezone(userId);
  const dateStr = localDateString(now, timezone);
  const adaptiveDifficulty = await selectAdaptiveDifficulty(userId, dateStr);
  const challenge = await seedChallenge(dateStr, adaptiveDifficulty);

  // Check completion
  const completedTx = await XpTransaction.findOne({
    userId: new Types.ObjectId(userId),
    sourceType: 'challenge_completed',
    sourceId: challenge._id.toString(),
  }).lean();

  let userCompleted = !!completedTx;

  if (!userCompleted) {
    const problem = await DsaProblem.findOne({
      userId: new Types.ObjectId(userId),
      platform: challenge.platform,
      externalId: challenge.titleSlug,
      status: 'solved',
    }).lean();

    if (problem) {
      const { start: startOfDay, end: nextDay } = localDayBounds(dateStr, timezone);
      const submissionToday = await DsaSubmission.findOne({
        userId: new Types.ObjectId(userId),
        problemId: problem._id,
        status: 'accepted',
        submittedAt: { $gte: startOfDay, $lt: nextDay },
      }).lean();

      if (submissionToday) {
        const newlyCompleted = await awardChallengeCompletion(userId, challenge);
        if (newlyCompleted) {
          challenge.completionCount += 1;
        }
        userCompleted = true;
      }
    }
  }

  return {
    challenge,
    userCompleted,
  };
}

export async function checkChallengeCompletion(
  userId: string,
  platform: string,
  titleSlug: string,
  submittedAt: Date,
): Promise<boolean> {
  if (!Number.isFinite(submittedAt.getTime())) return false;
  const now = new Date();
  const timezone = await getUserTimezone(userId);
  const dateStr = localDateString(now, timezone);
  if (localDateString(submittedAt, timezone) !== dateStr) return false;

  const difficulty = await selectAdaptiveDifficulty(userId, dateStr);
  const challenge = await DailyChallenge.findOne({ date: dateStr, difficulty });
  if (
    !challenge ||
    challenge.platform !== platform.toLowerCase() ||
    challenge.titleSlug.toLowerCase() !== titleSlug.toLowerCase()
  ) {
    return false;
  }

  return awardChallengeCompletion(userId, challenge);
}

async function awardChallengeCompletion(userId: string, challenge: IDailyChallenge): Promise<boolean> {
  const challengeId = challenge._id.toString();
  const existingTx = await XpTransaction.findOne({
    userId: new Types.ObjectId(userId),
    sourceType: 'challenge_completed',
    sourceId: challengeId,
  });
  if (existingTx) return false;

  logger.info('[daily-challenge] Awarding XP for daily challenge completion', {
    userId,
    challengeId,
    title: challenge.title,
  });

  const result = await processXpEvent({
    userId,
    sourceType: 'challenge_completed',
    sourceId: challengeId,
    metadata: {
      xpReward: challenge.xpReward,
      challengeId,
      title: challenge.title,
    },
  });

  // The XP ledger's unique key decides which concurrent caller is new.
  if (!result.awarded) return false;

  await eventBus.emitChallengeCompleted(userId, challengeId, challenge.title, challenge.xpReward);
  await DailyChallenge.findByIdAndUpdate(challenge._id, { $inc: { completionCount: 1 } });
  return true;
}
