import { RecommendationInput, TopicAnalysis, TopicBreakdown } from '../types/dsa.types';

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
    const { targetRole, topicBreakdown } = input;

    // Calculate topic mastery for all topics
    const allTopics = this.calculateAllTopicMastery(topicBreakdown);

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
   * Calculate mastery for all topics
   * Mastery is based on solve count relative to expected baseline
   */
  private calculateAllTopicMastery(topicBreakdown: TopicBreakdown): TopicAnalysis[] {
    const topics: TopicAnalysis[] = [];

    // Expected baseline for each topic (minimum problems for mastery)
    const BASELINE_PROBLEMS: Record<string, number> = {
      arrays: 20,
      hashing: 15,
      strings: 20,
      linkedList: 15,
      stack: 15,
      queue: 15,
      trees: 25,
      graphs: 20,
      heaps: 10,
      recursion: 15,
      backtracking: 15,
      dp: 25,
      greedy: 15,
      binarySearch: 10,
    };

    Object.entries(topicBreakdown).forEach(([topic, solved]) => {
      const baseline = BASELINE_PROBLEMS[topic] || 15;
      const mastery = Math.min(100, (solved / baseline) * 100);

      topics.push({
        topic,
        solved,
        mastery: Math.round(mastery),
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
