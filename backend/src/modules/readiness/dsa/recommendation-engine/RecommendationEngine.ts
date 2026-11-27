import {
  RecommendationInput,
  TopicAnalysis,
  TopicBreakdown,
  TopicDifficultyBreakdown,
  TopicDifficultyBreakdownMap,
  TopicTier,
} from '../types/dsa.types';

// Interview-critical topics with priority weights
const INTERVIEW_CRITICAL_TOPICS: Record<string, number> = {
  arrays: 0.9,
  hashing: 0.85,
  strings: 0.85,
  linkedList: 0.8,
  stack: 0.8,
  queue: 0.75,
  trees: 0.95,
  graphs: 0.95,
  heaps: 0.7,
  recursion: 0.8,
  backtracking: 0.85,
  dp: 0.95,
  greedy: 0.8,
  binarySearch: 0.75,
};

// Realistic weighted-point target benchmarks by topic interview importance
export const BASELINE_PROBLEMS: Record<string, number> = {
  arrays: 45,
  hashing: 35,
  strings: 35,
  linkedList: 30,
  stack: 25,
  queue: 25,
  trees: 50,
  graphs: 50,
  heaps: 25,
  recursion: 30,
  backtracking: 30,
  dp: 60,
  greedy: 30,
  binarySearch: 30,
};

const DIFFICULTY_WEIGHTS = {
  easy: 1.0,
  medium: 2.5,
  hard: 5.0,
} as const;

export function getTopicTier(mastery: number): TopicTier {
  if (mastery >= 90) return 'Mastery';
  if (mastery >= 70) return 'Advanced';
  if (mastery >= 35) return 'Proficient';
  return 'Novice';
}

function allocateByDistribution(
  count: number,
  dist?: { easy: number; medium: number; hard: number }
): TopicDifficultyBreakdown {
  if (count <= 0) return { easy: 0, medium: 0, hard: 0 };

  const easyWeight = Math.max(0, dist?.easy ?? 0);
  const mediumWeight = Math.max(0, dist?.medium ?? 0);
  const hardWeight = Math.max(0, dist?.hard ?? 0);
  const weightSum = easyWeight + mediumWeight + hardWeight;

  if (weightSum <= 0) {
    return { easy: count, medium: 0, hard: 0 };
  }

  const keys = ['easy', 'medium', 'hard'] as const;
  const weights = { easy: easyWeight, medium: mediumWeight, hard: hardWeight };
  const exact = {
    easy: (count * easyWeight) / weightSum,
    medium: (count * mediumWeight) / weightSum,
    hard: (count * hardWeight) / weightSum,
  };

  const result: TopicDifficultyBreakdown = {
    easy: Math.floor(exact.easy),
    medium: Math.floor(exact.medium),
    hard: Math.floor(exact.hard),
  };

  let remainder = count - (result.easy + result.medium + result.hard);
  const sortedRemainders = [...keys].sort((a, b) => {
    const diff = (exact[b] - result[b]) - (exact[a] - result[a]);
    return diff !== 0 ? diff : weights[b] - weights[a];
  });

  for (let i = 0; i < remainder; i++) {
    result[sortedRemainders[i % keys.length]] += 1;
  }

  return result;
}

function resolveTopicDifficulty(
  solved: number,
  explicit?: TopicDifficultyBreakdown,
  globalDist?: { easy: number; medium: number; hard: number }
): TopicDifficultyBreakdown {
  const totalSolved = Math.max(0, Math.floor(solved));
  if (totalSolved === 0) return { easy: 0, medium: 0, hard: 0 };

  const expEasy = Math.max(0, Math.floor(explicit?.easy ?? 0));
  const expMedium = Math.max(0, Math.floor(explicit?.medium ?? 0));
  const expHard = Math.max(0, Math.floor(explicit?.hard ?? 0));
  const expSum = expEasy + expMedium + expHard;

  if (expSum === totalSolved) {
    return { easy: expEasy, medium: expMedium, hard: expHard };
  }
  if (expSum > totalSolved) {
    return allocateByDistribution(totalSolved, { easy: expEasy, medium: expMedium, hard: expHard });
  }

  const remaining = allocateByDistribution(totalSolved - expSum, globalDist);
  return {
    easy: expEasy + remaining.easy,
    medium: expMedium + remaining.medium,
    hard: expHard + remaining.hard,
  };
}

export class RecommendationEngine {
  /**
   * Generate topic analysis (strong/weak topics)
   * Recommend highest-impact missing interview topics
   */
  generateRecommendations(input: RecommendationInput): {
    strongTopics: TopicAnalysis[];
    weakTopics: TopicAnalysis[];
    nextTopics: string[];
  } {
    const { targetRole, topicBreakdown, difficultyDistribution, topicDifficultyBreakdown } = input;

    // Calculate difficulty-weighted topic mastery for all topics
    const allTopics = this.calculateAllTopicMastery(
      topicBreakdown,
      difficultyDistribution,
      topicDifficultyBreakdown
    );

    // Separate into strong and weak topics
    const strong = allTopics.filter(t => t.mastery >= 60);
    const weak = allTopics.filter(t => t.mastery < 60);

    // Generate next topic recommendations
    const nextTopics = this.generateNextTopics(weak, targetRole);

    return {
      strongTopics: strong,
      weakTopics: weak,
      nextTopics,
    };
  }

  /**
   * Calculate difficulty-weighted mastery and tier for all topics.
   * Formula: Weighted Solves = (1.0 * Easy) + (2.5 * Medium) + (5.0 * Hard)
   */
  private calculateAllTopicMastery(
    topicBreakdown: TopicBreakdown,
    difficultyDistribution?: { easy: number; medium: number; hard: number },
    topicDifficultyBreakdown?: TopicDifficultyBreakdownMap
  ): TopicAnalysis[] {
    const topics: TopicAnalysis[] = [];

    Object.entries(topicBreakdown).forEach(([topic, solved]) => {
      const difficulty = resolveTopicDifficulty(
        solved,
        topicDifficultyBreakdown?.[topic as keyof TopicBreakdown],
        difficultyDistribution
      );
      const weightedSolves =
        DIFFICULTY_WEIGHTS.easy * difficulty.easy +
        DIFFICULTY_WEIGHTS.medium * difficulty.medium +
        DIFFICULTY_WEIGHTS.hard * difficulty.hard;
      const baseline = BASELINE_PROBLEMS[topic] || 30;
      const mastery = Math.min(100, Math.round((weightedSolves / baseline) * 100));

      topics.push({
        topic,
        solved,
        mastery,
        tier: getTopicTier(mastery),
        difficulty,
      });
    });

    // Sort by mastery (descending)
    topics.sort((a, b) => b.mastery - a.mastery);

    return topics;
  }

  /**
   * Generate next topic recommendations
   * Prioritizes high-impact interview topics that are weak
   */
  private generateNextTopics(weakTopics: TopicAnalysis[], targetRole?: string): string[] {
    // Sort weak topics by interview criticality and current mastery
    const prioritized = weakTopics
      .map(topic => ({
        ...topic,
        priority: this.calculateTopicPriority(topic.topic, topic.mastery, targetRole),
      }))
      .sort((a, b) => b.priority - a.priority);

    // Return top 5 recommendations
    return prioritized.slice(0, 5).map(t => t.topic);
  }

  /**
   * Calculate topic priority for recommendations
   * Considers interview criticality and current mastery
   */
  private calculateTopicPriority(topic: string, mastery: number, targetRole?: string): number {
    const criticality = INTERVIEW_CRITICAL_TOPICS[topic] || 0.5;
    
    // Lower mastery = higher priority
    const masteryPriority = (100 - mastery) / 100;

    // Role-specific adjustments
    let roleBonus = 0;
    if (targetRole) {
      const role = targetRole.toLowerCase();
      if (role.includes('backend') || role.includes('full')) {
        if (['trees', 'graphs', 'dp', 'hashing'].includes(topic)) {
          roleBonus = 0.2;
        }
      }
      if (role.includes('frontend')) {
        if (['arrays', 'strings', 'recursion', 'trees'].includes(topic)) {
          roleBonus = 0.15;
        }
      }
    }

    return (criticality * 0.7) + (masteryPriority * 0.3) + roleBonus;
  }
}

export const recommendationEngine = new RecommendationEngine();
