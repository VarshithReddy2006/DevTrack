import { z } from 'zod';

// Request DTOs
export const GetDSAIntelligenceQuerySchema = z.object({
  platform: z.enum(['leetcode', 'codeforces', 'manual']).optional(),
});

export type GetDSAIntelligenceQuery = z.infer<typeof GetDSAIntelligenceQuerySchema>;

export const UpdateDSAProfileSchema = z.object({
  platform: z.enum(['leetcode', 'codeforces', 'manual']),
  totalSolved: z.number().int().min(0).default(0),
  easySolved: z.number().int().min(0).default(0),
  mediumSolved: z.number().int().min(0).default(0),
  hardSolved: z.number().int().min(0).default(0),
  currentStreak: z.number().int().min(0).default(0),
  longestStreak: z.number().int().min(0).default(0),
  lastSolvedDate: z.coerce.date().nullable().default(null),
  topicBreakdown: z.object({
    arrays: z.number().int().min(0).default(0),
    hashing: z.number().int().min(0).default(0),
    strings: z.number().int().min(0).default(0),
    linkedList: z.number().int().min(0).default(0),
    stack: z.number().int().min(0).default(0),
    queue: z.number().int().min(0).default(0),
    trees: z.number().int().min(0).default(0),
    graphs: z.number().int().min(0).default(0),
    heaps: z.number().int().min(0).default(0),
    recursion: z.number().int().min(0).default(0),
    backtracking: z.number().int().min(0).default(0),
    dp: z.number().int().min(0).default(0),
    greedy: z.number().int().min(0).default(0),
    binarySearch: z.number().int().min(0).default(0),
  }).default({}),
}).partial().required({ platform: true });

export type UpdateDSAProfileInput = z.infer<typeof UpdateDSAProfileSchema>;

// Response DTOs
export const DifficultyDistributionSchema = z.object({
  easy: z.number().int().min(0),
  medium: z.number().int().min(0),
  hard: z.number().int().min(0),
  total: z.number().int().min(0),
});

export const TopicAnalysisSchema = z.object({
  topic: z.string(),
  solved: z.number().int().min(0),
  mastery: z.number().min(0).max(100),
});

export const DSAIntelligenceResponseSchema = z.object({
  readinessScore: z.number().min(0).max(100),
  consistencyScore: z.number().min(0).max(100),
  hardProgressScore: z.number().min(0).max(100),
  readinessImpact: z.number().min(0).max(100),
  difficultyDistribution: DifficultyDistributionSchema,
  strongTopics: z.array(TopicAnalysisSchema),
  weakTopics: z.array(TopicAnalysisSchema),
  nextTopics: z.array(z.string()),
  confidenceScore: z.number().min(0).max(100),
  verificationCoverage: z.number().min(0).max(100),
  status: z.enum(['improving', 'stable', 'declining']),
  lastUpdated: z.coerce.date(),
});

export type DSAIntelligenceResponse = z.infer<typeof DSAIntelligenceResponseSchema>;

// Internal DTOs for engines
export const ReadinessScoreInputSchema = z.object({
  totalSolved: z.number().int().min(0),
  easySolved: z.number().int().min(0),
  mediumSolved: z.number().int().min(0),
  hardSolved: z.number().int().min(0),
  topicBreakdown: z.object({
    arrays: z.number().int().min(0),
    hashing: z.number().int().min(0),
    strings: z.number().int().min(0),
    linkedList: z.number().int().min(0),
    stack: z.number().int().min(0),
    queue: z.number().int().min(0),
    trees: z.number().int().min(0),
    graphs: z.number().int().min(0),
    heaps: z.number().int().min(0),
    recursion: z.number().int().min(0),
    backtracking: z.number().int().min(0),
    dp: z.number().int().min(0),
    greedy: z.number().int().min(0),
    binarySearch: z.number().int().min(0),
  }),
  consistencyScore: z.number().min(0).max(100),
});

export type ReadinessScoreInput = z.infer<typeof ReadinessScoreInputSchema>;

export const ConsistencyScoreInputSchema = z.object({
  currentStreak: z.number().int().min(0),
  longestStreak: z.number().int().min(0),
  lastSolvedDate: z.coerce.date().nullable(),
  totalSolved: z.number().int().min(0),
});

export type ConsistencyScoreInput = z.infer<typeof ConsistencyScoreInputSchema>;

export const HardProgressInputSchema = z.object({
  hardSolved: z.number().int().min(0),
  totalSolved: z.number().int().min(0),
  hardGrowthTrend: z.number().min(-1).max(1),
});

export type HardProgressInput = z.infer<typeof HardProgressInputSchema>;

export const ConfidenceScoreInputSchema = z.object({
  lastSyncedAt: z.coerce.date().nullable(),
  isVerified: z.boolean(),
  totalSolved: z.number().int().min(0),
  lastSolvedDate: z.coerce.date().nullable(),
  platform: z.enum(['leetcode', 'codeforces', 'manual']),
});

export type ConfidenceScoreInput = z.infer<typeof ConfidenceScoreInputSchema>;

export const TrendInputSchema = z.object({
  recentActivity: z.array(z.number().int().min(0)),
  currentStreak: z.number().int().min(0),
  hardGrowthTrend: z.number().min(-1).max(1),
});

export type TrendInput = z.infer<typeof TrendInputSchema>;

export const RecommendationInputSchema = z.object({
  weakTopics: z.array(z.object({
    topic: z.string(),
    solved: z.number().int().min(0),
    mastery: z.number().min(0).max(100),
  })),
  targetRole: z.string().optional(),
  topicBreakdown: z.object({
    arrays: z.number().int().min(0),
    hashing: z.number().int().min(0),
    strings: z.number().int().min(0),
    linkedList: z.number().int().min(0),
    stack: z.number().int().min(0),
    queue: z.number().int().min(0),
    trees: z.number().int().min(0),
    graphs: z.number().int().min(0),
    heaps: z.number().int().min(0),
    recursion: z.number().int().min(0),
    backtracking: z.number().int().min(0),
    dp: z.number().int().min(0),
    greedy: z.number().int().min(0),
    binarySearch: z.number().int().min(0),
  }),
});

export type RecommendationInput = z.infer<typeof RecommendationInputSchema>;
