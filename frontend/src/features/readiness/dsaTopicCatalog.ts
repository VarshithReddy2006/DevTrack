import type { TopicTier } from './services/dsaIntelligenceService';

export interface CuratedProblemRecommendation {
  title: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  url: string;
}

export interface TopicCatalogEntry {
  label: string;
  benchmarkPoints: number;
  priorityBadge: string;
  curatedProblem: CuratedProblemRecommendation;
}

export const TOPIC_CATALOG: Record<string, TopicCatalogEntry> = {
  arrays: {
    label: 'Arrays & Sliding Window',
    benchmarkPoints: 45,
    priorityBadge: 'Core Essential',
    curatedProblem: {
      title: 'Longest Substring Without Repeating Characters',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/longest-substring-without-repeating-characters/',
    },
  },
  hashing: {
    label: 'Hashing & Maps',
    benchmarkPoints: 35,
    priorityBadge: 'Core Essential',
    curatedProblem: {
      title: 'Group Anagrams',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/group-anagrams/',
    },
  },
  strings: {
    label: 'Strings',
    benchmarkPoints: 35,
    priorityBadge: 'Interview Staple',
    curatedProblem: {
      title: 'Longest Palindromic Substring',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/longest-palindromic-substring/',
    },
  },
  linkedList: {
    label: 'Linked Lists',
    benchmarkPoints: 30,
    priorityBadge: 'Core Pattern',
    curatedProblem: {
      title: 'LRU Cache',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/lru-cache/',
    },
  },
  stack: {
    label: 'Stacks',
    benchmarkPoints: 25,
    priorityBadge: 'High Leverage',
    curatedProblem: {
      title: 'Daily Temperatures',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/daily-temperatures/',
    },
  },
  queue: {
    label: 'Queues',
    benchmarkPoints: 25,
    priorityBadge: 'High Impact',
    curatedProblem: {
      title: 'Design Circular Queue',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/design-circular-queue/',
    },
  },
  trees: {
    label: 'Trees & Tries',
    benchmarkPoints: 50,
    priorityBadge: 'High Impact',
    curatedProblem: {
      title: 'Binary Tree Level Order Traversal',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/binary-tree-level-order-traversal/',
    },
  },
  graphs: {
    label: 'Graphs & Traversal',
    benchmarkPoints: 50,
    priorityBadge: 'High Impact',
    curatedProblem: {
      title: 'Course Schedule',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/course-schedule/',
    },
  },
  heaps: {
    label: 'Heaps & Priority Queues',
    benchmarkPoints: 25,
    priorityBadge: 'High Impact',
    curatedProblem: {
      title: 'Top K Frequent Elements',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/top-k-frequent-elements/',
    },
  },
  dp: {
    label: 'Dynamic Programming',
    benchmarkPoints: 60,
    priorityBadge: 'High Impact',
    curatedProblem: {
      title: 'Coin Change',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/coin-change/',
    },
  },
  greedy: {
    label: 'Greedy Algorithms',
    benchmarkPoints: 30,
    priorityBadge: 'Interview Favorite',
    curatedProblem: {
      title: 'Jump Game',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/jump-game/',
    },
  },
  binarySearch: {
    label: 'Binary Search',
    benchmarkPoints: 30,
    priorityBadge: 'High Leverage',
    curatedProblem: {
      title: 'Search in Rotated Sorted Array',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/search-in-rotated-sorted-array/',
    },
  },
  backtracking: {
    label: 'Backtracking',
    benchmarkPoints: 30,
    priorityBadge: 'Core Pattern',
    curatedProblem: {
      title: 'Combination Sum',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/combination-sum/',
    },
  },
  recursion: {
    label: 'Recursion & Divide-and-Conquer',
    benchmarkPoints: 30,
    priorityBadge: 'Core Pattern',
    curatedProblem: {
      title: 'K-th Symbol in Grammar',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/k-th-symbol-in-grammar/',
    },
  },
};

export function formatTopicLabel(topic: string): string {
  return TOPIC_CATALOG[topic]?.label ?? topic;
}

export function deriveTopicTier(mastery: number, explicitTier?: TopicTier): TopicTier {
  if (explicitTier) return explicitTier;
  if (mastery >= 90) return 'Mastery';
  if (mastery >= 70) return 'Advanced';
  if (mastery >= 35) return 'Proficient';
  return 'Novice';
}

export function estimateProblemsToBridge(topic: string, mastery: number): string {
  const benchmark = TOPIC_CATALOG[topic]?.benchmarkPoints ?? 30;
  const remainingPts = Math.max(0, benchmark * (1 - Math.min(100, Math.max(0, mastery)) / 100));
  if (remainingPts <= 2) return '~1-2 problems needed';
  const minCount = Math.max(1, Math.floor(remainingPts / 3.5));
  const maxCount = Math.max(minCount + 1, Math.ceil(remainingPts / 2.2));
  return `~${minCount}-${maxCount} problems needed`;
}

export function getProblemSearchUrl(topic: string): string {
  const entry = TOPIC_CATALOG[topic];
  if (entry) return entry.curatedProblem.url;
  return `https://leetcode.com/problemset/?search=${encodeURIComponent(topic)}`;
}
