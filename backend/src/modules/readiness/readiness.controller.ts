import { z } from 'zod';
import { CareerIntentService } from './services/CareerIntentService.js';
import { ReadinessOrchestratorService } from './engine/ReadinessOrchestratorService.js';
import { DomainIntelligenceService } from './engine/ReadinessOrchestratorService.js';
import { UserSkillProgress } from '../../db/models/userSkillProgress.model.js';
import { normalizeSkill } from './role/roleSkills.js';
import { ApiResponse } from '../../shared/response.js';
import { withAuth } from '../../shared/controllerUtils.js';

export const ReadinessController = {
  getSnapshot: withAuth('[readiness]', 'get snapshot', async (userId, _req, res) => {
    const dynamicSnapshot = await ReadinessOrchestratorService.computeDynamicSnapshot(userId);
    res.json({ success: true, data: dynamicSnapshot });
  }),

  getDomainIntelligence: withAuth('[readiness]', 'get domain intelligence', async (userId, req, res) => {
    const domain = req.params.domain as string;
    const validDomains = ['dsa', 'engineering', 'roadmap', 'evolution', 'copilot'];
    if (!validDomains.includes(domain)) {
      ApiResponse.badRequest(res, `Invalid domain: ${domain}`);
      return;
    }

    const intelligence = await DomainIntelligenceService.computeDomainIntelligence(userId, domain);

    if (domain === 'roadmap') {
      const roadmapIntelligence = (intelligence as any)?.intelligence ?? (intelligence as any);
      const normalizedRoadmap = {
        domain: 'roadmap',
        currentStage: roadmapIntelligence?.currentStage ?? 'Unknown',
        roadmapProgress: roadmapIntelligence?.roadmapProgress ?? 0,
        verifiedSkills: roadmapIntelligence?.verifiedSkills ?? [],
        completedRoadmapSkills: roadmapIntelligence?.completedRoadmapSkills ?? [],
        missingSkills: roadmapIntelligence?.missingSkills ?? [],
        prioritySkills: roadmapIntelligence?.prioritySkills ?? [],
        nextSkill: roadmapIntelligence?.nextSkill ?? '',
        nextThreeSkills: roadmapIntelligence?.nextThreeSkills ?? [],
        highestImpactSkill: roadmapIntelligence?.highestImpactSkill ?? '',
        readinessGain: roadmapIntelligence?.readinessGain ?? 0,
        estimatedWeeksToNextMilestone: roadmapIntelligence?.estimatedWeeksToNextMilestone ?? 0,
        nextSkillResource: roadmapIntelligence?.nextSkillResource ?? null,
      };
      res.json({ success: true, data: normalizedRoadmap });
      return;
    }

    if (domain === 'evolution') {
      const evo = (intelligence as any)?.intelligence ?? (intelligence as any);
      res.json({ success: true, data: evo });
      return;
    }

    res.json({ success: true, data: intelligence });
  }),

  setCareerIntent: withAuth('[readiness]', 'set career intent', async (userId, req, res) => {
    const SetCareerIntentSchema = z.object({
      dreamRole: z.string().optional(),
      targetRole: z.string().optional(),
      goal: z.string().optional(),
      experienceLevel: z.string().optional(),
      weeklyHours: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).optional(),
      targetPackage: z.string().optional(),
      targetCompanyTier: z.string().optional(),
      timelineGoals: z.string().optional(),
      currentStrongestSkills: z.array(z.string()).optional(),
      desiredSkills: z.array(z.string()).optional(),
    });

    const validationResult = SetCareerIntentSchema.safeParse(req.body);
    if (!validationResult.success) {
      ApiResponse.badRequest(res, 'Invalid payload data');
      return;
    }

    const { dreamRole, targetRole, goal, experienceLevel, weeklyHours, targetPackage, targetCompanyTier, timelineGoals,
      currentStrongestSkills, desiredSkills } = validationResult.data;
    const resolvedRole = dreamRole?.trim() || targetRole?.trim();
    if (!resolvedRole) {
      ApiResponse.badRequest(res, 'A career role is required');
      return;
    }

    const intent = await CareerIntentService.upsertCareerIntent({
      userId,
      dreamRole: resolvedRole,
      targetPackage: targetPackage || '',
      targetCompanyTier: targetCompanyTier || '',
      timelineGoals: timelineGoals || '',
      goal: goal || '',
      experienceLevel: experienceLevel || '',
      weeklyHours: weeklyHours ?? 0,
      currentStrongestSkills,
      desiredSkills,
    });

    res.json({ success: true, data: intent });
  }),

  setSkillProgress: withAuth('[readiness]', 'set skill progress', async (userId, req, res) => {
    const { skill, completed } = req.body;
    if (!skill) {
      ApiResponse.badRequest(res, 'Skill is required');
      return;
    }

    const normalized = normalizeSkill(skill);

    await UserSkillProgress.findOneAndUpdate(
      { userId, skill: normalized },
      {
        userId,
        skill: normalized,
        completed,
        completedAt: completed ? new Date() : undefined,
        source: 'manual'
      },
      { upsert: true, new: true }
    );

    res.json({ success: true });
  }),

  chatGuidance: withAuth('[readiness]', 'copilot chat guidance', async (userId, req, res) => {
    const ChatGuidanceSchema = z.object({
      prompt: z.string().min(1),
      threadId: z.string().optional(),
      targetRole: z.string().optional(),
      contextType: z.enum(['copilot', 'roadmap', 'mentor', 'general']).optional(),
    });

    const parsed = ChatGuidanceSchema.safeParse(req.body);
    if (!parsed.success) {
      ApiResponse.badRequest(res, 'Invalid chat payload');
      return;
    }

    const { prompt, threadId = 'career-copilot', targetRole, contextType = 'copilot' } = parsed.data;

    const { AIConversationService } = await import('../ai/conversation/AIConversationService.js');
    const result = await AIConversationService.processQuestion({
      userId,
      question: prompt,
      threadId,
      targetRole,
      contextType,
    });

    res.json({
      success: true,
      data: {
        answer: result.answer,
        threadId: result.threadId,
        confidence: result.confidence,
        model: result.model,
      },
    });
  }),

  getGuidanceHistory: withAuth('[readiness]', 'get copilot guidance history', async (userId, req, res) => {
    const threadId = (req.query.threadId as string) || 'career-copilot';
    const { AIConversationService } = await import('../ai/conversation/AIConversationService.js');
    const history = await AIConversationService.getConversationHistory(userId, threadId);

    res.json({
      success: true,
      data: {
        threadId,
        messages: history.map((m, idx) => ({
          id: `${threadId}-${idx}-${new Date(m.timestamp).getTime()}`,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        })),
      },
    });
  }),

  clearGuidanceHistory: withAuth('[readiness]', 'clear copilot guidance history', async (userId, req, res) => {
    const threadId = (req.query.threadId as string) || 'career-copilot';
    const { AIConversationService } = await import('../ai/conversation/AIConversationService.js');
    await AIConversationService.clearConversationHistory(userId, threadId);

    res.json({
      success: true,
      message: 'Conversation history cleared',
      threadId,
    });
  }),

  listGuidanceThreads: withAuth('[readiness]', 'list copilot guidance threads', async (userId, _req, res) => {
    const { AIConversationService } = await import('../ai/conversation/AIConversationService.js');
    const threads = await AIConversationService.listThreads(userId);

    res.json({
      success: true,
      data: threads,
    });
  }),
};

