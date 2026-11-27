import { describe, expect, it } from 'vitest';
import {
  BASELINE_PROBLEMS,
  getTopicTier,
  RecommendationEngine,
} from './RecommendationEngine.js';
import type { TopicBreakdown } from '../types/dsa.types.js';

function emptyBreakdown(overrides: Partial<TopicBreakdown> = {}): TopicBreakdown {
  return {
    arrays: 0,
    hashing: 0,
    strings: 0,
    linkedList: 0,
    stack: 0,
    queue: 0,
    trees: 0,
    graphs: 0,
    heaps: 0,
    recursion: 0,
    backtracking: 0,
    dp: 0,
    greedy: 0,
    binarySearch: 0,
    ...overrides,
  };
}

describe('RecommendationEngine', () => {
  const engine = new RecommendationEngine();

  it('defines realistic industry target benchmarks for core interview topics', () => {
    expect(BASELINE_PROBLEMS.arrays).toBe(45);
    expect(BASELINE_PROBLEMS.dp).toBe(60);
    expect(BASELINE_PROBLEMS.trees).toBe(50);
    expect(BASELINE_PROBLEMS.graphs).toBe(50);
    expect(BASELINE_PROBLEMS.binarySearch).toBe(30);
    expect(BASELINE_PROBLEMS.heaps).toBe(25);
    expect(BASELINE_PROBLEMS.stack).toBe(25);
    expect(BASELINE_PROBLEMS.queue).toBe(25);
    expect(BASELINE_PROBLEMS.backtracking).toBe(30);
  });

  it('weights mastery by problem difficulty (1.0 Easy + 2.5 Medium + 5.0 Hard) instead of flat solve count', () => {
    const result = engine.generateRecommendations({
      topicBreakdown: emptyBreakdown({ dp: 15, heaps: 8 }),
      topicDifficultyBreakdown: {
        // 15 Easy DP = 15 / 60 = 25% (not 60% from naive 15/25)
        dp: { easy: 15, medium: 0, hard: 0 },
        // 2 Easy + 4 Medium + 2 Hard Heaps = 2 + 10 + 10 = 22 / 25 = 88%
        heaps: { easy: 2, medium: 4, hard: 2 },
      },
    });

    const dpTopic = result.weakTopics.find((t) => t.topic === 'dp');
    const heapsTopic = result.strongTopics.find((t) => t.topic === 'heaps');

    expect(dpTopic).toEqual({
      topic: 'dp',
      solved: 15,
      mastery: 25,
      tier: 'Novice',
      difficulty: { easy: 15, medium: 0, hard: 0 },
    });
    expect(heapsTopic).toEqual({
      topic: 'heaps',
      solved: 8,
      mastery: 88,
      tier: 'Advanced',
      difficulty: { easy: 2, medium: 4, hard: 2 },
    });
  });

  it('assigns accurate Novice, Proficient, Advanced, and Mastery tiers', () => {
    expect(getTopicTier(0)).toBe('Novice');
    expect(getTopicTier(34)).toBe('Novice');
    expect(getTopicTier(35)).toBe('Proficient');
    expect(getTopicTier(69)).toBe('Proficient');
    expect(getTopicTier(70)).toBe('Advanced');
    expect(getTopicTier(89)).toBe('Advanced');
    expect(getTopicTier(90)).toBe('Mastery');
    expect(getTopicTier(100)).toBe('Mastery');

    const result = engine.generateRecommendations({
      topicBreakdown: emptyBreakdown({
        arrays: 20,      // weighted: 4 + 25 + 25 = 54 / 45 -> 100 (Mastery)
        binarySearch: 9, // weighted: 3 + 10 + 10 = 23 / 30 -> 77 (Advanced)
        backtracking: 8, // weighted: 4 + 10 + 0  = 14 / 30 -> 47 (Proficient)
        queue: 5,        // weighted: 5 + 0  + 0  = 5  / 25 -> 20 (Novice)
      }),
      topicDifficultyBreakdown: {
        arrays: { easy: 4, medium: 10, hard: 5 },
        binarySearch: { easy: 3, medium: 4, hard: 2 },
        backtracking: { easy: 4, medium: 4, hard: 0 },
        queue: { easy: 5, medium: 0, hard: 0 },
      },
    });

    const all = [...result.strongTopics, ...result.weakTopics];
    expect(all.find((t) => t.topic === 'arrays')?.tier).toBe('Mastery');
    expect(all.find((t) => t.topic === 'binarySearch')?.tier).toBe('Advanced');
    expect(all.find((t) => t.topic === 'backtracking')?.tier).toBe('Proficient');
    expect(all.find((t) => t.topic === 'queue')?.tier).toBe('Novice');
  });

  it('proportionally infers per-topic difficulty breakdown when only aggregate stats exist', () => {
    const result = engine.generateRecommendations({
      topicBreakdown: emptyBreakdown({ arrays: 20 }),
      difficultyDistribution: { easy: 100, medium: 80, hard: 20 }, // 50% E, 40% M, 10% H
    });

    const arrays = result.strongTopics.find((t) => t.topic === 'arrays');
    expect(arrays?.difficulty).toEqual({ easy: 10, medium: 8, hard: 2 });
    // 10*1 + 8*2.5 + 2*5 = 40 / 45 = 89%
    expect(arrays?.mastery).toBe(89);
    expect(arrays?.tier).toBe('Advanced');
  });

  it('caps mastery at 100 even when weighted points exceed baseline', () => {
    const result = engine.generateRecommendations({
      topicBreakdown: emptyBreakdown({ arrays: 253 }),
      topicDifficultyBreakdown: {
        arrays: { easy: 120, medium: 110, hard: 23 },
      },
    });

    const arrays = result.strongTopics.find((t) => t.topic === 'arrays');
    expect(arrays?.mastery).toBe(100);
    expect(arrays?.tier).toBe('Mastery');
  });
});
