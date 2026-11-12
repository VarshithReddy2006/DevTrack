export type Platform = 'leetcode' | 'codeforces' | 'manual';

export type TrendStatus = 'improving' | 'stable' | 'declining';

export interface TopicBreakdown {
  arrays: number;
  hashing: number;
  strings: number;
  linkedList: number;
  stack: number;
  queue: number;
  trees: number;
  graphs: number;
  heaps: number;
  recursion: number;
  backtracking: number;
  dp: number;
  greedy: number;
  binarySearch: number;
}

export interface DifficultyDistribution {
  easy: number;
  medium: number;
  hard: number;
  total: number;
}

export interface TopicAnalysis {
  topic: string;
  solved: number;
  mastery: number; // 0-100
}

export interface DSAIntelligenceInput {
  userId: string;
  platform?: Platform;
}

export interface DSAIntelligenceOutput {
  readinessScore: number;
  consistencyScore: number;
  hardProgressScore: number;
  readinessImpact: number;
  difficultyDistribution: DifficultyDistribution;
  strongTopics: TopicAnalysis[];
  weakTopics: TopicAnalysis[];
  nextTopics: string[];
  confidenceScore: number;
  verificationCoverage: number;
  status: TrendStatus;
  lastUpdated: Date;
}

export interface ReadinessScoreInput {
  totalSolved: number;
  easySolved: number;
  mediumSolved: number;
  hardSolved: number;
  topicBreakdown: TopicBreakdown;
  consistencyScore: number;
}

export interface ConsistencyScoreInput {
  currentStreak: number;
  longestStreak: number;
  lastSolvedDate: Date | null;
  totalSolved: number;
}

export interface HardProgressInput {
  hardSolved: number;
  totalSolved: number;
  hardGrowthTrend: number; // -1 to 1
}

export interface ConfidenceScoreInput {
  lastSyncedAt: Date | null;
  isVerified: boolean;
  totalSolved: number;
  lastSolvedDate: Date | null;
  platform: Platform;
}

export interface TrendInput {
  recentActivity: number[];
  currentStreak: number;
  hardGrowthTrend: number;
}

export interface RecommendationInput {
  targetRole?: string;
  topicBreakdown: TopicBreakdown;
}
