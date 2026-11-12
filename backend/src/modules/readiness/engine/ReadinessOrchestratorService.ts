import { logger } from '../../../shared/logger.js';
import { ReadinessCore } from '../../../db/models/readinessCore.model.js';
import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { ReadinessSkills } from '../../../db/models/readinessSkills.model.js';
import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { ReadinessRoadmap } from '../../../db/models/readinessRoadmap.model.js';
import { ReadinessBenchmarks } from '../../../db/models/readinessBenchmarks.model.js';
import { CareerIntent } from '../../../db/models/careerIntent.model.js';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { UserSkillProgress } from '../../../db/models/userSkillProgress.model.js';
import { getRequiredSkills, normalizeSkill } from '../role/roleSkills.js';
import { getResourceForSkill } from '../resources/learningResources.js';

import { NextBestActionEngine } from './NextBestActionEngine.js';
import { AdaptiveReadinessFeed } from './AdaptiveReadinessFeed.js';
import { RoleAlignmentEngine } from './RoleAlignmentEngine.js';
import { READINESS_FRESHNESS_MS, TrustAwareReadinessScoringEngine } from '../scoring/TrustAwareReadinessScoringEngine.js';
import { ReadinessMomentumEngine } from './ReadinessMomentumEngine.js';
import { EngineeringEvolutionTimeline } from '../evolution/EngineeringEvolutionTimeline.js';

export const ReadinessOrchestratorService = {
  async computeDynamicSnapshot(userId: string) {
    try {
      const unavailablePillars: string[] = [];
      const readPillar = async <T>(name: string, query: PromiseLike<T>): Promise<T | null> => {
        try {
          return await query;
        } catch (error) {
          unavailablePillars.push(name);
          logger.warn('[ReadinessOrchestratorService] Readiness input unavailable', { userId, name, error });
          return null;
        }
      };
      const [core, dsa, skills, projects, roadmap, benchmarks] = await Promise.all([
        ReadinessCore.findOne({ userId }).lean(),
        readPillar('DSA', ReadinessDsa.findOne({ userId }).lean()),
        readPillar('Skills', ReadinessSkills.findOne({ userId }).lean()),
        readPillar('Projects', ReadinessProjects.findOne({ userId }).lean()),
        readPillar('Roadmap', ReadinessRoadmap.findOne({ userId }).lean()),
        readPillar('Benchmarks', ReadinessBenchmarks.findOne({ userId }).lean()),
      ]);

      const freshnessThreshold = Date.now() - READINESS_FRESHNESS_MS;
      const fragmentsChanged = core && [dsa, skills, projects, roadmap, benchmarks].some(fragment => {
        if (!fragment?.computedAt) return false;
        const computedAt = fragment.computedAt.getTime();
        const coreComputedAt = core.computedAt.getTime();
        return computedAt > coreComputedAt
          || (computedAt < freshnessThreshold && computedAt >= coreComputedAt - READINESS_FRESHNESS_MS);
      });
      const score = core?.completeness === undefined || unavailablePillars.length || fragmentsChanged
        ? await TrustAwareReadinessScoringEngine.calculateReadinessScore({ userId, unavailablePillars, persist: false })
        : null;

      // 1. Compute Momentum
      const momentumTrend = await ReadinessMomentumEngine.computeMomentum(userId, dsa, projects);

      // 2. Evaluate Role Alignment
      const roleAlignment = await RoleAlignmentEngine.evaluateAlignment(userId, dsa, projects);

      // 3. Compute Next Best Actions
      const nextBestActions = await NextBestActionEngine.computeActions(userId, dsa, projects);

      // 4. Generate Adaptive Feed
      const overallScore = score?.overallScore ?? core?.overallScore ?? 0;
      const feedCoreData = { ...core, momentumTrend, overallScore };
      const intelligenceFeed = await AdaptiveReadinessFeed.generateFeed(userId, dsa, projects, feedCoreData);

      // 5. Determine Progression State (simplified logic)
      let progressionState = core?.progressionState || 'Discovery & Foundation';
      if (roleAlignment.matchScore > 80 && projectDataHasProdSignals(projects)) {
        progressionState = 'Production Engineering';
      } else if (roleAlignment.matchScore > 50) {
        progressionState = 'Infrastructure Expansion';
      } else if ((dsa as any)?.overallScore && (dsa as any).overallScore > 60) {
        progressionState = 'Early Backend Foundation';
      }

      const dynamicState = {
        progressionState,
        momentumTrend,
        roleAlignment,
        confidence: score?.confidenceLevel ?? core?.confidence ?? 0,
        overallScore,
        completeness: score?.completeness ?? core?.completeness,
        missingPillars: score?.missingPillars ?? core?.missingPillars ?? [],
        staleProviders: score?.staleProviders ?? core?.staleProviders ?? [],
        isDegraded: score?.isDegraded ?? core?.isDegraded ?? false,
      };

      // Ensure we have an adaptive roadmap payload structure
      // For now we map existing roadmap nodes but add a prioritized flag based on blockers.
      const adaptiveRoadmap = (roadmap as any)?.nodes?.map((node: any) => ({
        ...node,
        isPrioritizedBlocker: isBlocker(node, nextBestActions)
      })) || [];

      return {
        dynamicState,
        nextBestActions,
        intelligenceFeed,
        adaptiveRoadmap,
        rawMetrics: {
          core,
          dsa,
          projects,
          skills,
          benchmarks
        }
      };
    } catch (error) {
      logger.error('[ReadinessOrchestratorService] Failed to compute dynamic snapshot', { userId, error });
      throw error;
    }
  }
};

// Helper to determine if project has production level signals
function projectDataHasProdSignals(projects: any): boolean {
  return projects?.systemDesignSignals?.hasDocker && projects?.systemDesignSignals?.hasRedis;
}

// Helper to mark a node as a blocker if it relates to our next best actions
function isBlocker(node: any, nextActions: any[]): boolean {
  if (!node.id) return false;
  return nextActions.some(action => action.id.includes(node.id.toLowerCase()));
}

/**
 * Domain Intelligence — deep workspace data for each readiness domain
 */
export const DomainIntelligenceService = {
  async computeDomainIntelligence(userId: string, domain: string) {
    try {
      let [core, dsa, skills, projects, roadmap, benchmarks] = await Promise.all([
        ReadinessCore.findOne({ userId }).lean(),
        ReadinessDsa.findOne({ userId }).lean(),
        ReadinessSkills.findOne({ userId }).lean(),
        ReadinessProjects.findOne({ userId }).lean(),
        ReadinessRoadmap.findOne({ userId }).lean(),
        ReadinessBenchmarks.findOne({ userId }).lean()
      ]);



      const momentumTrend = await ReadinessMomentumEngine.computeMomentum(userId, dsa, projects);
      const roleAlignment = await RoleAlignmentEngine.evaluateAlignment(userId, dsa, projects);
      const nextBestActions = await NextBestActionEngine.computeActions(userId, dsa, projects);

      const shared = {
        overallScore: core?.overallScore || 0,
        confidence: core?.confidence || 0,
        momentumTrend,
        progressionState: core?.progressionState || 'Discovery & Foundation',
        roleAlignment
      };

      switch (domain) {
        case 'dsa':
          return buildDsaIntelligence(dsa, shared, nextBestActions);
        case 'engineering':
          return buildEngineeringIntelligence(projects, skills, shared, nextBestActions);
        case 'roadmap':
          return await buildRoadmapIntelligence(userId, roadmap, shared, nextBestActions);
        case 'evolution':
          return await buildEvolutionIntelligence(userId, roadmap, core, shared);
        case 'copilot':
          return buildCopilotIntelligence(core, dsa, projects, skills, shared, nextBestActions);
        default:
          throw new Error(`Unknown domain: ${domain}`);
      }
    } catch (error) {
      logger.error('[DomainIntelligenceService] Failed to compute domain intelligence', { userId, domain, error });
      throw error;
    }
  }
};

function buildDsaIntelligence(dsa: any, shared: any, nextBestActions: any[]) {
  const topicMastery = dsa?.topicBreakdown || [];
  const weakTopics = topicMastery
    .filter((t: any) => t.mastery < 40)
    .sort((a: any, b: any) => a.mastery - b.mastery);
  const strongTopics = topicMastery
    .filter((t: any) => t.mastery >= 70)
    .sort((a: any, b: any) => b.mastery - a.mastery);

  return {
    domain: 'dsa',
    coreQuestion: 'How strong is my problem-solving maturity?',
    shared,
    intelligence: {
      overallScore: dsa?.overallScore || 0,
      totalSolved: dsa?.totalSolved || 0,
      easySolved: dsa?.easySolved || 0,
      mediumSolved: dsa?.mediumSolved || 0,
      hardSolved: dsa?.hardSolved || 0,
      consistencyScore: dsa?.consistencyScore || 0,
      hardProblemProgression: dsa?.hardProblemProgression || 0,
      recentSubmissionsCount: dsa?.recentSubmissionsCount || 0,
      contestRating: dsa?.contestRating || null,
      topicMastery,
      weakTopics: weakTopics.slice(0, 5),
      strongTopics: strongTopics.slice(0, 5),
      difficultyDistribution: {
        easy: dsa?.easySolved || 0,
        medium: dsa?.mediumSolved || 0,
        hard: dsa?.hardSolved || 0
      },
      stagnationSignals: detectDsaStagnation(dsa),
      topicMomentum: computeTopicMomentum(dsa),
      readinessImpact: dsa?.overallScore ? Math.round(dsa.overallScore * 0.35) : 0
    },
    nextBestActions: nextBestActions.filter(a => a.category === 'dsa')
  };
}

function buildEngineeringIntelligence(projects: any, skills: any, shared: any, nextBestActions: any[]) {
  const signals = projects?.systemDesignSignals || {};
  return {
    domain: 'engineering',
    coreQuestion: 'How credible and mature is my engineering execution?',
    shared,
    intelligence: {
      projectCount: projects?.projectCount || 0,
      projectMaturity: projects?.maturityScore || 0,
      architectureSophistication: computeArchitectureScore(signals),
      verifiedSkills: skills?.verifiedSkills || [],
      skillCategories: skills?.categories || [],
      deploymentMaturity: {
        hasDocker: signals.hasDocker || false,
        hasCI: signals.hasCI || false,
        hasMonitoring: signals.hasMonitoring || false,
        score: computeDeploymentScore(signals)
      },
      infraSophistication: {
        hasRedis: signals.hasRedis || false,
        hasBullMQ: signals.hasBullMQ || false,
        hasMessageQueue: signals.hasMessageQueue || false,
        hasWebSocket: signals.hasWebSocket || false,
        score: computeInfraScore(signals)
      },
      productionReadiness: {
        hasErrorHandling: signals.hasErrorHandling || false,
        hasLogging: signals.hasLogging || false,
        hasRateLimiting: signals.hasRateLimiting || false,
        score: computeProductionScore(signals)
      },
      scalabilityIndicators: {
        hasCaching: signals.hasRedis || false,
        hasLoadBalancing: signals.hasLoadBalancing || false,
        hasHorizontalScaling: signals.hasHorizontalScaling || false
      },
      repositoryQuality: projects?.repositoryQuality || 0,
      engineeringConsistency: projects?.recentCommitsCount || 0,
      tutorialProjectDetection: projects?.isTutorialProject || false,
      credibilityScore: computeCredibilityScore(projects, skills, signals),
      readinessImpact: projects?.maturityScore ? Math.round(projects.maturityScore * 0.40) : 0
    },
    nextBestActions: nextBestActions.filter(a => a.category === 'project' || a.category === 'core')
  };
}

async function buildRoadmapIntelligence(userId: string, roadmap: any, shared: any, nextBestActions: any[]) {
  const [careerIntent, resumeProfile, userSkillProgress] = await Promise.all([
    CareerIntent.findOne({ userId }).lean(),
    ResumeProfile.findOne({ userId }).lean(),
    UserSkillProgress.find({ userId, completed: true }).lean()
  ]);

  if (!careerIntent || !careerIntent.dreamRole) {
    return {
      domain: 'roadmap',
      coreQuestion: 'What should I learn next, and why?',
      shared,
      intelligence: {
        noRoleSelected: true,
        currentStage: 'Unknown',
        roadmapProgress: 0,
        verifiedSkills: [],
        completedRoadmapSkills: [],
        missingSkills: [],
        prioritySkills: [],
        nextSkill: '',
        nextThreeSkills: [],
        highestImpactSkill: '',
        readinessGain: 0,
        estimatedWeeksToNextMilestone: 0
      },
      nextBestActions: []
    };
  }

  const targetRole = careerIntent.dreamRole;
  const requiredSkills = getRequiredSkills(targetRole);

  // Normalize skills
  const resumeSkills = resumeProfile?.selectedSkills || [];
  const normalizedResume = new Set(resumeSkills.map(s => normalizeSkill(s)));

  const manualSkills = userSkillProgress.map(p => p.skill);
  const normalizedManual = new Set(manualSkills.map(s => normalizeSkill(s)));

  const verifiedSkills: string[] = [];
  const completedRoadmapSkills: string[] = [];
  const missingSkills: string[] = [];

  requiredSkills.forEach(skill => {
    const norm = normalizeSkill(skill);
    if (normalizedResume.has(norm)) {
      verifiedSkills.push(skill);
    } else if (normalizedManual.has(norm)) {
      completedRoadmapSkills.push(skill);
    } else {
      missingSkills.push(skill);
    }
  });

  const prioritySkills = missingSkills.slice(0, 3);
  const nextSkill = prioritySkills[0] || '';

  const totalCompleted = verifiedSkills.length + completedRoadmapSkills.length;
  const roadmapProgress = requiredSkills.length > 0
    ? Math.round((totalCompleted / requiredSkills.length) * 100)
    : 0;

  let currentStage = 'Foundation';
  if (roadmapProgress >= 71) {
    currentStage = 'Advanced';
  } else if (roadmapProgress >= 31) {
    currentStage = 'Intermediate';
  }

  // Calculate dynamic weekly commitment estimation
  const hours = Number(careerIntent.weeklyHours || 10);
  const estimatedWeeksToNextMilestone = Math.max(1, Math.round(missingSkills.length * (15 / hours)));

  const nextSkillResource = getResourceForSkill(nextSkill);

  const intelligence = {
    currentStage,
    roadmapProgress,
    verifiedSkills,
    completedRoadmapSkills,
    missingSkills,
    prioritySkills,
    nextSkill,
    nextThreeSkills: prioritySkills,
    highestImpactSkill: nextSkill,
    readinessGain: requiredSkills.length > 0 ? Math.round(100 / requiredSkills.length) : 10,
    estimatedWeeksToNextMilestone,
    nextSkillResource
  };

  return {
    domain: 'roadmap',
    coreQuestion: 'What should I learn next, and why?',
    shared,
    intelligence,
    nextBestActions
  };
}

async function buildEvolutionIntelligence(userId: string, roadmap: any, core: any, shared: any) {
  const roadmapIntelResponse = await buildRoadmapIntelligence(userId, roadmap, shared, []);
  const roadmapIntel = roadmapIntelResponse.intelligence;

  const [userSkillProgress, snapshotTimeline] = await Promise.all([
    UserSkillProgress.find({ userId, completed: true }).sort({ updatedAt: 1 }).lean(),
    EngineeringEvolutionTimeline.generateTimeline({ userId }),
  ]);

  // Calculate evolution Summary
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  const skillsThisMonth = userSkillProgress.filter((p: any) => p.updatedAt && new Date(p.updatedAt) >= oneMonthAgo).length;

  const evolutionSummary = {
    skillsCompletedThisMonth: skillsThisMonth,
    roadmapProgressChange: Math.min(100, Math.round(skillsThisMonth * 2.5)),
    verifiedSkillsCount: roadmapIntel.verifiedSkills.length
  };

  // Build Growth Timeline
  const growthTimeline = userSkillProgress.map((p: any) => ({
    date: new Date(p.updatedAt || p.createdAt).toISOString().split('T')[0],
    event: `${p.skill} Completed`
  }));

  const resumeProfile = await ResumeProfile.findOne({ userId }).lean();
  if (resumeProfile && resumeProfile.createdAt) {
    growthTimeline.push({
      date: new Date(resumeProfile.createdAt).toISOString().split('T')[0],
      event: 'Resume Uploaded'
    });
  }

  const careerIntent = await CareerIntent.findOne({ userId }).lean();
  if (careerIntent && careerIntent.createdAt) {
    growthTimeline.push({
      date: new Date(careerIntent.createdAt).toISOString().split('T')[0],
      event: 'Career Discovery Complete'
    });
  }

  growthTimeline.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Biggest Blocker
  const biggestBlocker = roadmapIntel.prioritySkills.length > 0 ? {
    skill: roadmapIntel.prioritySkills[0],
    reason: `Required for ${roadmapIntel.currentStage === 'Foundation' ? 'Intermediate' : 'Advanced'} Backend Stage`
  } : null;

  // Next Milestone
  const targetStage = roadmapIntel.currentStage === 'Foundation' ? 'Intermediate'
    : roadmapIntel.currentStage === 'Intermediate' ? 'Advanced'
      : 'Mastery';
  const nextMilestone = roadmapIntel.missingSkills.length > 0 ? {
    title: `Reach ${targetStage} Backend Developer`,
    remainingSkills: roadmapIntel.missingSkills.length,
    estimatedWeeks: roadmapIntel.estimatedWeeksToNextMilestone
  } : null;

  // Activity Summary
  const activitySummary = {
    streakDays: core?.streakDays || 0,
    skillsCompleted: userSkillProgress.length,
    tasksCompleted: userSkillProgress.length * 2
  };

  const nextStage = {
    stage: targetStage,
    requiredSkillsRemaining: roadmapIntel.missingSkills.length
  };

  return {
    domain: 'evolution',
    coreQuestion: 'How far have I progressed toward my career goal?',
    shared,
    intelligence: {
      currentStage: {
        stage: roadmapIntel.currentStage,
        progress: roadmapIntel.roadmapProgress
      },
      nextStage,
      evolutionSummary,
      growthTimeline,
      snapshotTimeline,
      biggestBlocker,
      nextMilestone,
      activitySummary
    }
  };
}

function buildCopilotIntelligence(core: any, dsa: any, projects: any, skills: any, shared: any, nextBestActions: any[]) {
  const guidance: Array<{ id: string; question: string; answer: string; category: string; evidence: string[] }> = [];

  // Generate contextual Q&A based on readiness state
  if (shared.momentumTrend === 'stagnating' || shared.momentumTrend === 'declining') {
    guidance.push({
      id: 'momentum_explanation',
      question: 'How is my engineering momentum measured?',
      answer: `Your momentum is currently "${shared.momentumTrend}". We compare DSA submissions and the latest repository commits on verified projects across two consecutive seven-day windows. If those signals move in opposite directions, we use their consistency scores to resolve the disagreement.`,
      category: 'momentum',
      evidence: ['DSA submissions', 'Verified repository activity', 'Solve and contribution consistency']
    });
  }

  if (shared.roleAlignment.weakAreas.length > 0) {
    guidance.push({
      id: 'weak_areas_explanation',
      question: `What blocks my readiness for ${shared.roleAlignment.role}?`,
      answer: `Your role alignment for "${shared.roleAlignment.role}" is at ${shared.roleAlignment.matchScore}%. Key gaps: ${shared.roleAlignment.weakAreas.join(', ')}. Addressing these will have the highest impact on your readiness score.`,
      category: 'readiness',
      evidence: shared.roleAlignment.weakAreas
    });
  }

  if (dsa?.hardProblemProgression < 20) {
    guidance.push({
      id: 'dsa_hard_explanation',
      question: 'Why is hard problem maturity important?',
      answer: 'Hard problems (especially Graph, DP, and Trees) are the primary differentiator in technical interviews at top-tier companies. Your hard problem progression is at ' + (dsa?.hardProblemProgression || 0) + '%, which limits your competitive readiness. Focus on Graph and DP hard problems first.',
      category: 'dsa',
      evidence: ['Hard problem solve rate', 'Interview pattern correlation', 'Topic difficulty distribution']
    });
  }

  const signals = projects?.systemDesignSignals || {};
  if (!signals.hasDocker || !signals.hasRedis) {
    guidance.push({
      id: 'infra_explanation',
      question: 'Why should I learn infrastructure before advanced topics?',
      answer: `Infrastructure maturity (Docker, Redis, CI/CD) directly correlates with engineering credibility. ${!signals.hasDocker ? 'Docker containerization is missing. ' : ''}${!signals.hasRedis ? 'Redis caching is not detected. ' : ''}These are table-stakes for backend roles and should be prioritized before Kubernetes or advanced orchestration.`,
      category: 'engineering',
      evidence: ['Deployment maturity signals', 'Infrastructure detection results', 'Role alignment requirements']
    });
  }

  if (nextBestActions.length > 0) {
    guidance.push({
      id: 'next_action_reasoning',
      question: 'Why are these my top recommended actions?',
      answer: `Your top action "${nextBestActions[0].title}" was prioritized because: ${nextBestActions[0].why}. Each recommendation is computed from your current readiness state, target role alignment, and engineering gap analysis.`,
      category: 'actions',
      evidence: ['Gap analysis', 'Role alignment scoring', 'Readiness delta potential']
    });
  }

  // Always add a confidence explanation
  guidance.push({
    id: 'confidence_explanation',
    question: 'How confident is DevTrack in its analysis?',
    answer: `Current confidence: ${shared.confidence || 0}%. Confidence is based on data freshness, provider connectivity, and the volume of signals available. ${(shared.confidence || 0) < 50 ? 'Low confidence means some data may be stale or missing. Connect more platforms to improve accuracy.' : 'Your data coverage is good, providing reliable analysis.'}`,
    category: 'trust',
    evidence: ['Provider freshness', 'Data coverage', 'Signal volume']
  });

  return {
    domain: 'copilot',
    coreQuestion: 'Why is this happening?',
    shared,
    intelligence: {
      contextualGuidance: guidance,
      totalQuestions: guidance.length,
      categories: [...new Set(guidance.map(g => g.category))]
    },
    nextBestActions: nextBestActions.slice(0, 3)
  };
}

// ─── Helper Functions ───

function detectDsaStagnation(dsa: any): string[] {
  const signals: string[] = [];
  if (dsa?.recentSubmissionsCount < 3) signals.push('Very low recent submission activity');
  if (dsa?.consistencyScore < 30) signals.push('Consistency dropped below 30%');
  if (dsa?.hardProblemProgression < 10) signals.push('No meaningful hard problem progress');
  return signals;
}

function computeTopicMomentum(dsa: any): Array<{ topic: string; trend: string }> {
  const topics = dsa?.topicBreakdown || [];
  return topics.slice(0, 8).map((t: any) => ({
    topic: t.topic || t.name || 'Unknown',
    trend: t.mastery > 60 ? 'strong' : t.mastery > 30 ? 'developing' : 'weak'
  }));
}

function computeArchitectureScore(signals: any): number {
  let score = 0;
  if (signals.hasDocker) score += 20;
  if (signals.hasRedis) score += 20;
  if (signals.hasBullMQ || signals.hasMessageQueue) score += 15;
  if (signals.hasWebSocket) score += 10;
  if (signals.hasStateManagement) score += 15;
  if (signals.hasCI) score += 10;
  if (signals.hasMonitoring) score += 10;
  return Math.min(score, 100);
}

function computeDeploymentScore(signals: any): number {
  let score = 0;
  if (signals.hasDocker) score += 40;
  if (signals.hasCI) score += 35;
  if (signals.hasMonitoring) score += 25;
  return Math.min(score, 100);
}

function computeInfraScore(signals: any): number {
  let score = 0;
  if (signals.hasRedis) score += 30;
  if (signals.hasBullMQ || signals.hasMessageQueue) score += 25;
  if (signals.hasWebSocket) score += 20;
  if (signals.hasDocker) score += 25;
  return Math.min(score, 100);
}

function computeProductionScore(signals: any): number {
  let score = 0;
  if (signals.hasErrorHandling) score += 30;
  if (signals.hasLogging) score += 25;
  if (signals.hasRateLimiting) score += 25;
  if (signals.hasMonitoring) score += 20;
  return Math.min(score, 100);
}

function computeCredibilityScore(projects: any, skills: any, signals: any): number {
  let score = 0;
  score += Math.min((projects?.projectCount || 0) * 10, 30);
  score += Math.min((skills?.verifiedSkills?.length || 0) * 5, 20);
  score += computeArchitectureScore(signals) * 0.3;
  score += (projects?.repositoryQuality || 0) * 0.2;
  return Math.min(Math.round(score), 100);
}

function computeAdaptiveSequence(nodes: any[], roleAlignment: any): Array<{ id: string; label: string; reason: string }> {
  const pending = nodes.filter((n: any) => n.status === 'pending' || !n.status);
  return pending.slice(0, 5).map((n: any) => ({
    id: n.id,
    label: n.label || n.id,
    reason: `Aligned with ${roleAlignment.role} progression`
  }));
}

function findMissingDependencies(nodes: any[]): Array<{ id: string; label: string }> {
  const completedIds = new Set(nodes.filter((n: any) => n.status === 'completed').map((n: any) => n.id));
  const missing: Array<{ id: string; label: string }> = [];
  for (const node of nodes) {
    if (node.dependencies) {
      for (const dep of node.dependencies) {
        if (!completedIds.has(dep)) {
          missing.push({ id: dep, label: dep });
        }
      }
    }
  }
  return [...new Map(missing.map(m => [m.id, m])).values()].slice(0, 5);
}

function computeCadenceScore(dsa: any, projects: any): number {
  let score = 0;
  if (dsa?.recentSubmissionsCount > 10) score += 40;
  else if (dsa?.recentSubmissionsCount > 5) score += 25;
  else if (dsa?.recentSubmissionsCount > 0) score += 10;
  if (projects?.recentCommitsCount > 15) score += 40;
  else if (projects?.recentCommitsCount > 5) score += 25;
  else if (projects?.recentCommitsCount > 0) score += 10;
  if (dsa?.consistencyScore > 60) score += 20;
  return Math.min(score, 100);
}

function computeMilestones(core: any, dsa: any, projects: any): Array<{ id: string; label: string; type: string; timestamp: string | null }> {
  const milestones: Array<{ id: string; label: string; type: string; timestamp: string | null }> = [];
  if (dsa?.totalSolved > 0) {
    milestones.push({ id: 'first_solve', label: `${dsa.totalSolved} problems solved`, type: 'achievement', timestamp: null });
  }
  if (dsa?.hardSolved > 0) {
    milestones.push({ id: 'hard_solves', label: `${dsa.hardSolved} hard problems conquered`, type: 'achievement', timestamp: null });
  }
  if (projects?.projectCount > 0) {
    milestones.push({ id: 'projects', label: `${projects.projectCount} projects analyzed`, type: 'progress', timestamp: null });
  }
  const signals = projects?.systemDesignSignals || {};
  if (signals.hasDocker) {
    milestones.push({ id: 'docker_verified', label: 'Docker deployment verified', type: 'infrastructure', timestamp: null });
  }
  if (signals.hasRedis) {
    milestones.push({ id: 'redis_verified', label: 'Redis infrastructure verified', type: 'infrastructure', timestamp: null });
  }
  return milestones;
}

function detectStagnationSignals(dsa: any, projects: any): string[] {
  const signals: string[] = [];
  if (dsa?.recentSubmissionsCount < 3) signals.push('DSA practice dropped significantly');
  if (dsa?.consistencyScore < 30) signals.push('Consistency score critically low');
  if (projects?.recentCommitsCount < 3) signals.push('Project contributions nearly inactive');
  return signals;
}
