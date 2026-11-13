import { CareerIntent, ICareerIntent } from '../../../db/models/careerIntent.model.js';
import { logger } from '../../../shared/logger.js';
import { normalizeSkill, ROLE_SKILL_MATRIX } from '../role/roleSkills.js';

export interface CareerIntentInput {
  userId: string;
  dreamRole: string;
  targetPackage?: string;
  targetCompanyTier?: string;
  preferredDomain?: string;
  currentStrongestSkills?: string[];
  desiredSkills?: string[];
  specializationGoals?: string[];
  timelineGoals?: string;
  goal?: string;
  experienceLevel?: string;
  weeklyHours?: number;
}

const dayMs = 24 * 60 * 60 * 1000;
const roleAliases = new Map([
  ['backend engineer', 'backend developer'],
  ['frontend engineer', 'frontend developer'],
  ['full stack engineer', 'full stack developer'],
  ['ml engineer', 'ai engineer'],
  ['machine learning engineer', 'ai engineer'],
]);
const roleRequirements = new Map(Object.entries(ROLE_SKILL_MATRIX).map(([role, skills]) =>
  [role.toLowerCase(), new Set(skills.map(normalizeSkill))] as const,
));

function normalizeRole(role: string): string {
  const normalized = role.trim().toLowerCase().replace(/[-\s]+/g, ' ');
  return roleAliases.get(normalized) ?? normalized;
}

export const CareerIntentService = {
  /**
   * Create or update career intent with history tracking
   */
  async upsertCareerIntent(input: CareerIntentInput): Promise<ICareerIntent> {
    try {
      const existing = await CareerIntent.findOne({ userId: input.userId });
      const now = new Date();
      
      if (existing) {
        // Track history if role or package changed
        const roleChanged = normalizeRole(existing.dreamRole ?? '') !== normalizeRole(input.dreamRole);
        const packageChanged = input.targetPackage !== undefined && existing.targetPackage !== input.targetPackage;
        
        if (roleChanged || packageChanged) {
          existing.history.push({
            role: existing.dreamRole,
            package: existing.targetPackage,
            recordedAt: now,
          });
        }
        
        // Update current intent
        existing.dreamRole = input.dreamRole;
        existing.targetPackage = input.targetPackage ?? existing.targetPackage;
        existing.targetCompanyTier = input.targetCompanyTier ?? existing.targetCompanyTier;
        existing.preferredDomain = input.preferredDomain ?? existing.preferredDomain;
        existing.currentStrongestSkills = input.currentStrongestSkills ?? existing.currentStrongestSkills;
        existing.desiredSkills = input.desiredSkills ?? existing.desiredSkills;
        existing.specializationGoals = input.specializationGoals ?? existing.specializationGoals;
        existing.timelineGoals = input.timelineGoals ?? existing.timelineGoals;
        
        existing.goal = input.goal ?? existing.goal;
        existing.experienceLevel = input.experienceLevel ?? existing.experienceLevel;
        existing.weeklyHours = input.weeklyHours ?? existing.weeklyHours;

        // Explicit confirmation also refreshes an otherwise unchanged intent.
        existing.updatedAt = now;
        existing.confidenceState = this.calculateConfidenceState(existing, now.getTime());
        
        await existing.save();
        logger.info('[CareerIntentService] Updated career intent', { userId: input.userId });
        return existing;
      } else {
        // Create new intent
        const newIntent = await CareerIntent.create({
          userId: input.userId,
          dreamRole: input.dreamRole,
          targetPackage: input.targetPackage || '',
          targetCompanyTier: input.targetCompanyTier || '',
          preferredDomain: input.preferredDomain || '',
          currentStrongestSkills: input.currentStrongestSkills || [],
          desiredSkills: input.desiredSkills || [],
          specializationGoals: input.specializationGoals || [],
          timelineGoals: input.timelineGoals || '',
          goal: input.goal,
          experienceLevel: input.experienceLevel,
          weeklyHours: input.weeklyHours,
          confidenceState: this.calculateConfidenceState(input, now.getTime()),
          history: [],
        });
        
        logger.info('[CareerIntentService] Created career intent', { userId: input.userId });
        return newIntent;
      }
    } catch (error) {
      logger.error('[CareerIntentService] Failed to upsert career intent', { userId: input.userId, error });
      throw error;
    }
  },

  /**
   * Calculate confidence from completeness, skill relevance, freshness, and role changes.
   */
  calculateConfidenceState(intent: CareerIntentInput | ICareerIntent, now = Date.now()): ICareerIntent['confidenceState'] {
    const role = normalizeRole(intent.dreamRole ?? '');
    const requiredSkills = roleRequirements.get(role);
    const hasRelevantSkill = (skills: string[] = []) => skills.some(skill => requiredSkills?.has(normalizeSkill(skill)));

    let score = 0;
    if (role) score += 30;
    if (intent.targetPackage?.trim()) score += 20;
    if (hasRelevantSkill(intent.currentStrongestSkills)) score += 20;
    if (hasRelevantSkill(intent.desiredSkills)) score += 15;
    if (intent.timelineGoals?.trim()) score += 15;

    if ('updatedAt' in intent) {
      const age = now - (intent.updatedAt ?? intent.createdAt)?.getTime();
      if (age > 90 * dayMs) score *= 0.5;
      else if (age >= 30 * dayMs) score *= 0.8;

      let nextRole = role;
      let recentRoleChanges = 0;
      // Each entry stores the role immediately before that update.
      for (const entry of [...(intent.history ?? [])].reverse()) {
        const previousRole = normalizeRole(entry.role ?? '');
        const changedAt = entry.recordedAt?.getTime();
        if (changedAt >= now - 30 * dayMs && changedAt <= now && previousRole && nextRole && previousRole !== nextRole) {
          recentRoleChanges += 1;
        }
        nextRole = previousRole;
      }
      if (recentRoleChanges > 2) score -= 25;
    }

    if (score >= 80) return 'high';
    if (score >= 50) return 'medium';
    return 'low';
  },

  /**
   * Get career intent for a user
   */
  async getCareerIntent(userId: string): Promise<ICareerIntent | null> {
    try {
      const intent = await CareerIntent.findOne({ userId });
      if (intent) intent.confidenceState = this.calculateConfidenceState(intent);
      return intent;
    } catch (error) {
      logger.error('[CareerIntentService] Failed to get career intent', { userId, error });
      throw error;
    }
  },

  /**
   * Get intent evolution history
   */
  async getIntentEvolution(userId: string): Promise<Array<{ role: string; package: string; recordedAt: Date }>> {
    try {
      const intent = await CareerIntent.findOne({ userId });
      return intent?.history || [];
    } catch (error) {
      logger.error('[CareerIntentService] Failed to get intent evolution', { userId, error });
      throw error;
    }
  },

  /**
   * Analyze role alignment based on current skills vs target role requirements
   */
  async analyzeRoleAlignment(userId: string): Promise<{
    alignmentScore: number;
    gaps: string[];
    strengths: string[];
  }> {
    try {
      const intent = await CareerIntent.findOne({ userId });
      if (!intent) {
        return { alignmentScore: 0, gaps: [], strengths: [] };
      }

      // Simplified role alignment analysis
      // In production, this would use a role-skill mapping database
      const roleSkillRequirements: Record<string, string[]> = {
        'Backend Engineer': ['databases', 'api-design', 'system-design', 'caching', 'queues'],
        'Frontend Engineer': ['react', 'typescript', 'css', 'state-management', 'performance'],
        'Full Stack Engineer': ['databases', 'api-design', 'react', 'typescript', 'deployment'],
        'ML Engineer': ['python', 'machine-learning', 'data-processing', 'statistics', 'deployment'],
        'DevOps Engineer': ['docker', 'kubernetes', 'ci-cd', 'cloud', 'monitoring'],
      };

      const requiredSkills = roleSkillRequirements[intent.dreamRole] || [];
      const userSkills = intent.currentStrongestSkills || [];
      
      const strengths = userSkills.filter(skill => requiredSkills.includes(skill));
      const gaps = requiredSkills.filter(skill => !userSkills.includes(skill));
      
      const alignmentScore = requiredSkills.length > 0 
        ? Math.round((strengths.length / requiredSkills.length) * 100)
        : 0;

      return { alignmentScore, gaps, strengths };
    } catch (error) {
      logger.error('[CareerIntentService] Failed to analyze role alignment', { userId, error });
      throw error;
    }
  },
};
