// src/__tests__/modules/dsa/dsa-distribution.test.ts
// Unit tests for DSA problem inventory distribution analytics

import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { DsaProblem } from '../../../db/models/index.js';
import { getProblemDistribution } from '../../../modules/dsa/dsa.service.js';

describe('DSA Problem Distribution Analytics', () => {
  const userId = new Types.ObjectId().toHexString();
  const foreignUserId = new Types.ObjectId().toHexString();

  beforeEach(async () => {
    await DsaProblem.deleteMany({});
  });

  it('aggregates difficulties, statuses, platforms, tags, and favorites accurately', async () => {
    await DsaProblem.create([
      {
        userId: new Types.ObjectId(userId),
        title: 'Two Sum',
        platform: 'leetcode',
        difficulty: 'easy',
        url: 'https://leetcode.com/problems/two-sum',
        tags: ['array', 'hash-table'],
        category: 'arrays',
        status: 'solved',
        isFavorite: true,
      },
      {
        userId: new Types.ObjectId(userId),
        title: '3Sum',
        platform: 'leetcode',
        difficulty: 'medium',
        url: 'https://leetcode.com/problems/3sum',
        tags: ['array', 'two-pointers'],
        category: 'arrays',
        status: 'attempted',
        isFavorite: false,
      },
      {
        userId: new Types.ObjectId(userId),
        title: 'Trapping Rain Water',
        platform: 'leetcode',
        difficulty: 'hard',
        url: 'https://leetcode.com/problems/trapping-rain-water',
        tags: ['array', 'two-pointers', 'dynamic-programming'],
        category: 'arrays',
        status: 'revisit',
        isFavorite: true,
      },
      {
        userId: new Types.ObjectId(userId),
        title: 'Watermelon',
        platform: 'codeforces',
        difficulty: 'easy',
        url: 'https://codeforces.com/problemset/problem/4/A',
        tags: ['math', 'brute force'],
        category: 'math',
        status: 'solved',
        isFavorite: false,
      },
      {
        userId: new Types.ObjectId(foreignUserId),
        title: 'Foreign Problem',
        platform: 'leetcode',
        difficulty: 'hard',
        url: 'https://leetcode.com/problems/foreign',
        tags: ['math'],
        category: 'math',
        status: 'solved',
        isFavorite: true,
      },
    ]);

    const result = await getProblemDistribution(userId);

    expect(result.totalProblems).toBe(4);
    expect(result.totalSolved).toBe(2);
    expect(result.favoriteCount).toBe(2);

    expect(result.difficultyDistribution).toEqual({
      easy: 2,
      medium: 1,
      hard: 1,
    });

    expect(result.statusDistribution).toEqual({
      unsolved: 0,
      attempted: 1,
      solved: 2,
      revisit: 1,
    });

    expect(result.platformDistribution.leetcode).toEqual({
      total: 3,
      solved: 1,
      easy: 1,
      medium: 1,
      hard: 1,
    });

    expect(result.platformDistribution.codeforces).toEqual({
      total: 1,
      solved: 1,
      easy: 1,
      medium: 0,
      hard: 0,
    });

    // Verify tag frequency ranking
    expect(result.tagFrequency[0].tag).toBe('array');
    expect(result.tagFrequency[0].count).toBe(3);
    const twoPointers = result.tagFrequency.find((t) => t.tag === 'two-pointers');
    expect(twoPointers?.count).toBe(2);
  });

  it('handles empty problem inventory cleanly', async () => {
    const result = await getProblemDistribution(userId);

    expect(result.totalProblems).toBe(0);
    expect(result.totalSolved).toBe(0);
    expect(result.favoriteCount).toBe(0);
    expect(result.difficultyDistribution).toEqual({ easy: 0, medium: 0, hard: 0 });
    expect(result.statusDistribution).toEqual({ unsolved: 0, attempted: 0, solved: 0, revisit: 0 });
    expect(result.platformDistribution).toEqual({});
    expect(result.tagFrequency).toEqual([]);
  });
});
