import axiosClient from '../utils/axiosClient';

export type ReadinessSnapshot = {
  dynamicState: {
    progressionState: string;
    momentumTrend: 'improving' | 'stagnating' | 'declining';
    roleAlignment: {
      role: string;
      matchScore: number;
      strongAreas: string[];
      weakAreas: string[];
    };
    confidence: number;
    overallScore: number;
  };
  nextBestActions: Array<{
    id: string;
    title: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
    category: 'dsa' | 'project' | 'core';
    actionUrl?: string;
    why: string;
  }>;
  intelligenceFeed: Array<{
    id: string;
    message: string;
    type: 'achievement' | 'warning' | 'insight' | 'action_needed';
    timestamp: string;
    evidenceChain: Array<{
      label: string;
      type: 'positive' | 'negative' | 'neutral';
    }>;
  }>;
  adaptiveRoadmap: any[];
  rawMetrics: {
    core: any;
    dsa: any;
    projects: any;
    skills: any;
    benchmarks: any;
  };
};

export type CareerIntentInput = {
  dreamRole?: string;
  targetRole?: string;
  goal?: string;
  experienceLevel?: string;
  weeklyHours?: number;
  targetPackage?: string;
  targetCompanyTier?: string;
  timelineGoals?: string;
};

// ─── Domain Intelligence Types ───

export type DomainShared = {
  overallScore: number;
  confidence: number;
  momentumTrend: 'improving' | 'stagnating' | 'declining';
  progressionState: string;
  roleAlignment: {
    role: string;
    matchScore: number;
    strongAreas: string[];
    weakAreas: string[];
  };
};

export type DomainIntelligenceBase = {
  domain: string;
  coreQuestion: string;
  shared: DomainShared;
  nextBestActions?: Array<{
    id: string;
    title: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
    category: string;
    actionUrl?: string;
    why: string;
  }>;
  intelligence: Record<string, any>;
};

export type DsaIntelligence = DomainIntelligenceBase & {
  domain: 'dsa';
  intelligence: {
    overallScore: number;
    totalSolved: number;
    easySolved: number;
    mediumSolved: number;
    hardSolved: number;
    consistencyScore: number;
    hardProblemProgression: number;
    recentSubmissionsCount: number;
    contestRating: number | null;
    topicMastery: Array<{ topic?: string; name?: string; mastery: number }>;
    weakTopics: Array<{ topic?: string; name?: string; mastery: number }>;
    strongTopics: Array<{ topic?: string; name?: string; mastery: number }>;
    difficultyDistribution: { easy: number; medium: number; hard: number };
    stagnationSignals: string[];
    topicMomentum: Array<{ topic: string; trend: string }>;
    readinessImpact: number;
  };
};

export type EngineeringIntelligence = DomainIntelligenceBase & {
  domain: 'engineering';
  intelligence: {
    projectCount: number;
    projectMaturity: number;
    architectureSophistication: number;
    verifiedSkills: string[];
    skillCategories: string[];
    deploymentMaturity: { hasDocker: boolean; hasCI: boolean; hasMonitoring: boolean; score: number };
    infraSophistication: { hasRedis: boolean; hasBullMQ: boolean; hasMessageQueue: boolean; hasWebSocket: boolean; score: number };
    productionReadiness: { hasErrorHandling: boolean; hasLogging: boolean; hasRateLimiting: boolean; score: number };
    scalabilityIndicators: { hasCaching: boolean; hasLoadBalancing: boolean; hasHorizontalScaling: boolean };
    repositoryQuality: number;
    engineeringConsistency: number;
    tutorialProjectDetection: boolean;
    credibilityScore: number;
    readinessImpact: number;
  };
};

export interface LearningResource {
  skill: string;
  whyLearn: string;
  estimatedTime: string;
  practiceProject: {
    title: string;
    description: string;
  };
  resources: Array<{
    title: string;
    type: 'docs' | 'course' | 'video' | 'article';
    url: string;
    provider: string;
  }>;
  isFallback?: boolean;
}

export type RoadmapDomainNormalized = {
  domain: string;
  currentStage: string;
  roadmapProgress: number; // 0-100
  verifiedSkills: string[];
  completedRoadmapSkills: string[];
  missingSkills: string[]; // missing skills
  prioritySkills: string[]; // highest value skills
  nextSkill: string;
  nextThreeSkills: string[];
  highestImpactSkill: string;
  readinessGain: number;
  estimatedWeeksToNextMilestone: number;
  nextSkillResource?: LearningResource;
};

/**
 * Backend returns the normalized roadmap schema directly as `success.data` for:
 * GET /readiness/domain/roadmap
 * (i.e., not wrapped under `shared`/`intelligence` like other domains).
 */
export type ReadinessRoadmapDomainResponse = RoadmapDomainNormalized;

export type EvolutionIntelligenceNormalized = {
  currentStage: { stage: string; progress: number };
  nextStage: { stage: string; requiredSkillsRemaining: number } | null;
  evolutionSummary: {
    skillsCompletedThisMonth: number;
    roadmapProgressChange: number;
    verifiedSkillsCount: number;
  };
  growthTimeline: Array<{ date: string; event: string }>;
  biggestBlocker: { skill: string; reason: string } | null;
  nextMilestone: { title: string; remainingSkills: number; estimatedWeeks: number } | null;
  activitySummary: { streakDays: number; skillsCompleted: number; tasksCompleted: number };
};

export type CopilotIntelligence = DomainIntelligenceBase & {
  domain: 'copilot';
  intelligence: {
    contextualGuidance: Array<{
      id: string;
      question: string;
      answer: string;
      category: string;
      evidence: string[];
    }>;
    totalQuestions: number;
    categories: string[];
  };
};

export type DomainIntelligence =
  | DsaIntelligence
  | EngineeringIntelligence
  | CopilotIntelligence;

export const readinessService = {
  async getSnapshot(options?: { signal?: AbortSignal }): Promise<{ success: boolean; data: ReadinessSnapshot }> {
    const res = await axiosClient.get('/readiness/snapshot', { signal: options?.signal });
    return res.data;
  },

  async getDomainIntelligence(domain: string, options?: { signal?: AbortSignal }): Promise<{ success: boolean; data: DomainIntelligence | EvolutionIntelligenceNormalized | ReadinessRoadmapDomainResponse }> {
    const res = await axiosClient.get(`/readiness/domain/${domain}`, { signal: options?.signal });
    return res.data;
  },

  async setIntent(intent: CareerIntentInput): Promise<{ success: boolean; data: any }> {
    const res = await axiosClient.post('/readiness/intent', intent);
    return res.data;
  },

  async sendCopilotChatRequest(
    prompt: string,
    _context?: any,
    _history?: Array<{ role: string; content: string }>,
    threadId: string = 'career-copilot'
  ): Promise<string> {
    const res = await axiosClient.post('/readiness/guidance/chat', {
      prompt,
      threadId,
    });
    return res.data?.data?.answer || '';
  },

  async getCopilotHistory(threadId: string = 'career-copilot'): Promise<Array<{ id: string; role: 'user' | 'assistant'; content: string }>> {
    try {
      const res = await axiosClient.get(`/readiness/guidance/history?threadId=${encodeURIComponent(threadId)}`);
      return res.data?.data?.messages || [];
    } catch (e) {
      console.warn('Failed to fetch copilot history', e);
      return [];
    }
  },

  async clearCopilotHistory(threadId: string = 'career-copilot'): Promise<{ success: boolean }> {
    try {
      const res = await axiosClient.delete(`/readiness/guidance/history?threadId=${encodeURIComponent(threadId)}`);
      return res.data;
    } catch (e) {
      console.warn('Failed to clear copilot history', e);
      return { success: false };
    }
  },

  async toggleSkillProgress(skill: string, completed: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await axiosClient.post('/readiness/skill-progress', { skill, completed });
      return res.data;
    } catch (error: any) {
      console.error('Failed to set skill progress', error);
      return { success: false, error: error.response?.data?.error || error.message };
    }
  }
};
