import axiosClient from '../utils/axiosClient';
import type { RoadmapMilestone } from '../features/readiness/components/roadmapTimeline.types';

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
  knownSkills?: string[];
  jobTargetId?: string;
  targetDeadlineWeeks?: number;
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

export interface CrashCourseQA {
  question: string;
  answer: string;
}

export interface CrashCourseContent {
  revisionMinutes: number;
  paretoPriority: number;
  coreConcepts: string[];
  gotchas: string[];
  rapidQA: CrashCourseQA[];
  mustSolveTopics?: string[];
}

export type CrashCourseWindow = '48h' | '7d' | '14d';

export interface CrashCourseBlock {
  blockId: string;
  day: number;
  dayLabel: string;
  skill: string;
  title: string;
  whySelected: string;
  revisionMinutes: number;
  practiceMinutes: number;
  paretoPriority: number;
  crashCourse: CrashCourseContent;
  practiceProject: { title: string; description: string };
}

export interface CrashCoursePlan {
  window: CrashCourseWindow;
  targetRole: string;
  paretoSkillCount: number;
  totalMinutes: number;
  totalHoursLabel: string;
  blocks: CrashCourseBlock[];
}

export type ConceptDomain = 'system-design' | 'cs-concepts';
export type ConceptConfidence = 'got_it' | 'revise_again';
export type ConceptLevel = 'beginner' | 'intermediate' | 'advanced' | 'case-study';
export type CsSubTrack = 'os' | 'dbms' | 'networks' | 'distributed-systems';

export interface ConceptQA {
  id: string;
  question: string;
  answer: string;
}

export interface TradeOffComparison {
  topic: string;
  whenToUse: string;
  whenToAvoid: string;
  alternative?: string;
}

export interface ConceptItem {
  id: string;
  domain: ConceptDomain;
  title: string;
  subtitle: string;
  level: ConceptLevel;
  track: 'system-design' | 'core-cs' | 'distributed-systems';
  subTrack?: CsSubTrack;
  isOptional: boolean;
  isHighFrequencyCrashCourse: boolean;
  estimatedMinutes: number;
  summary: string;
  architectureFlow: string[];
  tradeOffs: TradeOffComparison[];
  scaleBenchmarks: Array<{ label: string; value: string; note?: string }>;
  rapidQA: ConceptQA[];
  practicePrompt: string;
  completed: boolean;
  confidence: ConceptConfidence | null;
  updatedAt: string | null;
}

export interface ConceptWorkspaceSummary {
  totalConcepts: number;
  completedConcepts: number;
  progressPercent: number;
  coreTotal: number;
  coreCompleted: number;
  coreProgressPercent: number;
  optionalTotal: number;
  optionalCompleted: number;
  optionalProgressPercent: number;
  gotItCount: number;
  reviseAgainCount: number;
  lastUpdatedAt: string | null;
}

export interface ConceptWorkspaceResponse {
  domain: ConceptDomain;
  summary: ConceptWorkspaceSummary;
  concepts: ConceptItem[];
}

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
  crashCourse?: CrashCourseContent;
  isFallback?: boolean;
}

export type VerifiedSkillSource = {
  skill: string;
  source: 'resume' | 'github' | 'project' | 'self';
};

export type RoadmapDomainNormalized = {
  domain: string;
  noRoleSelected?: boolean;
  targetRole?: string;
  goal?: string;
  experienceLevel?: string;
  weeklyHours?: number;
  targetDeadlineWeeks?: number;
  currentStage: string;
  roadmapProgress: number; // 0-100
  verifiedSkills: string[];
  verifiedSkillSources?: VerifiedSkillSource[];
  completedRoadmapSkills: string[];
  missingSkills: string[]; // missing skills
  prioritySkills: string[]; // highest value skills
  nextSkill: string;
  nextThreeSkills: string[];
  highestImpactSkill: string;
  readinessGain: number;
  skillGains?: Record<string, number>;
  estimatedWeeksToNextMilestone: number;
  nextSkillResource?: LearningResource | null;
  skillResources?: Record<string, LearningResource>;
  confidence?: number;
  lastSyncedAt?: string | null;
  verificationCoverage?: number;
};

export interface MilestoneRoadmapTaskApi {
  taskId: string;
  kind: 'learn' | 'build' | 'practice' | 'verify';
  title: string;
  completed: boolean;
  completedAt: string | null;
}

export interface MilestoneRoadmapItemApi {
  milestoneId: string;
  sequence: number;
  startWeek: number;
  endWeek: number;
  estimatedHours?: number;
  skills: string[];
  objective: string;
  projectArchitecture: string;
  keyConcepts: string[];
  dsaPatterns: string[];
  verificationCriteria: string[];
  tasks: MilestoneRoadmapTaskApi[];
  completed: boolean;
  completedAt: string | null;
  progress: number;
}

export interface MilestoneRoadmapApiResponse {
  id: string;
  targetRoleId: string;
  targetRole: string;
  targetSource: 'role_catalog' | 'job_target';
  targetDeadlineWeeks: number;
  weeklyHours?: number;
  baselineReadinessScore: number | null;
  missingSkills: string[];
  deferredSkills: string[];
  source: 'ai' | 'template';
  degradedReason: string | null;
  generatedAt: string;
  progress: number;
  milestones: MilestoneRoadmapItemApi[];
}

function formatMilestoneDateRange(generatedAt: string, startWeek: number, endWeek: number): string | undefined {
  const base = new Date(generatedAt);
  if (!Number.isFinite(base.getTime())) return undefined;
  const dayMs = 86_400_000;
  const start = new Date(base.getTime() + (startWeek - 1) * 7 * dayMs);
  const end = new Date(base.getTime() + endWeek * 7 * dayMs);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

function taskShortcut(
  kind: MilestoneRoadmapTaskApi['kind'] | string,
  title: string,
  skills: string[]
): { href?: string; actionLabel?: string } {
  const primarySkill = skills[0] || 'Core Engineering';
  const techCsv = skills.join(',');
  switch (kind) {
    case 'learn':
      return {
        href: `/focus?mission=${encodeURIComponent(title.replace(/^Learn:\s*/i, ''))}&duration=25&mode=core`,
        actionLabel: '25m Focus',
      };
    case 'build':
      return {
        href: `/projects?create=1&title=${encodeURIComponent(`${primarySkill} Architecture Project`)}&description=${encodeURIComponent(title.replace(/^Build:\s*/i, ''))}&tech=${encodeURIComponent(techCsv)}`,
        actionLabel: 'Create in Projects',
      };
    case 'practice':
      return {
        href: '/readiness/dsa',
        actionLabel: 'Practice DSA',
      };
    case 'verify':
      return {
        href: '/readiness/evidence',
        actionLabel: 'Attach Evidence',
      };
    default:
      return {};
  }
}

export function mapMilestoneRoadmapToTimeline(api: MilestoneRoadmapApiResponse | null): RoadmapMilestone[] {
  if (!api || !Array.isArray(api.milestones)) return [];
  let foundActive = false;
  const weeklyHours = api.weeklyHours && api.weeklyHours > 0 ? api.weeklyHours : 10;
  const generatedMs = new Date(api.generatedAt).getTime();
  const nowMs = Date.now();

  return [...api.milestones]
    .sort((a, b) => a.sequence - b.sequence || a.startWeek - b.startWeek)
    .map((m) => {
      let status: 'completed' | 'active' | 'locked' = 'locked';
      if (m.completed) {
        status = 'completed';
      } else if (!foundActive) {
        status = 'active';
        foundActive = true;
      }
      const title = m.skills?.length
        ? m.skills.join(' & ')
        : `Sprint ${m.sequence}`;
      const weekSpan = Math.max(1, m.endWeek - m.startWeek + 1);
      const estimatedHours = m.estimatedHours ?? weekSpan * weeklyHours;
      const dateRangeLabel = formatMilestoneDateRange(api.generatedAt, m.startWeek, m.endWeek);
      const milestoneEndMs = Number.isFinite(generatedMs)
        ? generatedMs + m.endWeek * 7 * 86_400_000
        : Number.POSITIVE_INFINITY;
      const paceStatus: 'on_track' | 'behind_pace' =
        !m.completed && status === 'active' && nowMs > milestoneEndMs
          ? 'behind_pace'
          : 'on_track';

      return {
        id: m.milestoneId,
        title,
        objective: m.objective,
        weekStart: m.startWeek,
        weekEnd: m.endWeek,
        estimatedHours,
        status,
        dateRangeLabel,
        paceStatus,
        skills: m.skills,
        tasks: (m.tasks || []).map((t) => {
          const shortcut = taskShortcut(t.kind, t.title, m.skills ?? []);
          return {
            id: t.taskId,
            title: t.title,
            completed: t.completed,
            kind: t.kind,
            ...shortcut,
          };
        }),
      };
    });
}

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
  },

  async getMilestoneRoadmap(options?: { signal?: AbortSignal }): Promise<MilestoneRoadmapApiResponse | null> {
    try {
      const res = await axiosClient.get<{ success: boolean; data: MilestoneRoadmapApiResponse }>('/readiness/roadmap', { signal: options?.signal });
      return res.data?.data ?? null;
    } catch (error: any) {
      if (error?.response?.status === 404) return null;
      throw error;
    }
  },

  async generateMilestoneRoadmap(payload: { targetRoleId: string; targetDeadlineWeeks?: number }): Promise<MilestoneRoadmapApiResponse> {
    const res = await axiosClient.post<{ success: boolean; data: MilestoneRoadmapApiResponse }>('/readiness/roadmap/generate', payload);
    return res.data.data;
  },

  async toggleMilestoneTask(milestoneId: string, taskId: string, completed: boolean): Promise<MilestoneRoadmapApiResponse> {
    const res = await axiosClient.patch<{ success: boolean; data: MilestoneRoadmapApiResponse }>(
      `/readiness/roadmap/milestones/${encodeURIComponent(milestoneId)}/tasks/${encodeURIComponent(taskId)}`,
      { completed }
    );
    return res.data.data;
  },

  async getSkillResource(skill: string, options?: { signal?: AbortSignal }): Promise<LearningResource> {
    const res = await axiosClient.get<{ success: boolean; data: LearningResource }>(
      `/readiness/roadmap/resource?skill=${encodeURIComponent(skill)}`,
      { signal: options?.signal }
    );
    return res.data.data;
  },

  async getCrashCoursePlan(window: CrashCourseWindow = '7d', options?: { signal?: AbortSignal }): Promise<CrashCoursePlan> {
    const res = await axiosClient.get<{ success: boolean; data: CrashCoursePlan }>(
      `/readiness/roadmap/crash-course?duration=${encodeURIComponent(window)}`,
      { signal: options?.signal }
    );
    return res.data.data;
  },

  async getConceptWorkspace(
    domain: ConceptDomain,
    options?: { signal?: AbortSignal }
  ): Promise<ConceptWorkspaceResponse> {
    const res = await axiosClient.get<{ success: boolean; data: ConceptWorkspaceResponse }>(
      `/readiness/concepts/${encodeURIComponent(domain)}`,
      { signal: options?.signal }
    );
    return res.data.data;
  },

  async updateConceptProgress(
    domain: ConceptDomain,
    conceptId: string,
    patch: { completed?: boolean; confidence?: ConceptConfidence | null }
  ): Promise<ConceptWorkspaceResponse> {
    const res = await axiosClient.patch<{ success: boolean; data: ConceptWorkspaceResponse }>(
      `/readiness/concepts/${encodeURIComponent(domain)}/${encodeURIComponent(conceptId)}`,
      patch
    );
    return res.data.data;
  }
};
