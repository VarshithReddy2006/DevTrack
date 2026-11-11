import { AIProviderAdapter, AIRequest } from '../provider/AIProviderAdapter.js';
import { ReadinessContextBuilder, ReadinessContext } from '../context/ReadinessContextBuilder.js';
import { logger } from '../../../shared/logger.js';

export interface MentorInput {
  userId: string;
  targetRole?: string;
  questionType: 'dependency' | 'progression' | 'readiness-shift' | 'benchmark-change' | 'maturity-gap';
  specificItem?: string;
  threadId?: string;
}

export interface MentorResponse {
  explanation: string;
  contextUsed: ReadinessContext;
  provider: string;
  model: string;
  tokensUsed: number;
  latency: number;
  cached: boolean;
}

class ContextualEngineeringMentorClass {
  /**
   * Explain engineering dependencies, progression, or shifts
   */
  async explain(input: MentorInput): Promise<MentorResponse> {
    const { userId, targetRole, questionType, specificItem } = input;
    
    try {
      logger.info('[ContextualEngineeringMentor] Explaining engineering concept', { userId, questionType });
      
      // Build deterministic context
      const context = await ReadinessContextBuilder.buildContext({
        userId,
        targetRole,
        contextType: 'progression',
      });
      
      // Construct system prompt
      const systemPrompt = this.constructSystemPrompt(context, targetRole);
      
      // Construct user prompt based on question type
      const userPrompt = this.constructUserPrompt(questionType, specificItem, context);
      
      // Generate AI response
      const aiRequest: AIRequest = {
        prompt: userPrompt,
        tenantScope: userId,
        systemPrompt,
        temperature: 0.6,
        maxTokens: 400,
      };
      
      const aiResponse = await AIProviderAdapter.generateResponse(aiRequest);

      if (input.threadId) {
        try {
          const { AIConversationService } = await import('../conversation/AIConversationService.js');
          await AIConversationService.persistConversationTurn(
            userId,
            input.threadId,
            `Explain ${questionType}: ${specificItem || ''}`,
            aiResponse.content,
            'mentor',
            targetRole,
            aiResponse.tokensUsed
          );
        } catch (e) {
          logger.warn('[ContextualEngineeringMentor] Failed to persist mentor turn', { userId, error: e });
        }
      }
      
      logger.info('[ContextualEngineeringMentor] Engineering concept explained', { 
        userId, 
        questionType,
        provider: aiResponse.provider,
        latency: aiResponse.latency 
      });
      
      return {
        explanation: aiResponse.content,
        contextUsed: context,
        provider: aiResponse.provider,
        model: aiResponse.model,
        tokensUsed: aiResponse.tokensUsed,
        latency: aiResponse.latency,
        cached: aiResponse.cached,
      };
    } catch (error) {
      logger.error('[ContextualEngineeringMentor] Failed to explain engineering concept', { userId, error });
      throw error;
    }
  }

  /**
   * Construct system prompt
   */
  private constructSystemPrompt(context: ReadinessContext, targetRole?: string): string {
    let prompt = `You are an engineering progression mentor for DevTrack. Your role is to explain technical dependencies, progression ordering, and engineering maturity concepts clearly.\n\n`;
    
    prompt += `IMPORTANT CONSTRAINTS:\n`;
    prompt += `- You MUST ONLY use the deterministic context provided\n`;
    prompt += `- You MUST NOT invent technical claims not supported by evidence\n`;
    prompt += `- You MUST remain technical and engineering-focused\n`;
    prompt += `- You MUST explain the engineering rationale clearly\n`;
    prompt += `- You MUST reference specific evidence when explaining\n`;
    prompt += `- You MUST NOT make placement or salary promises\n\n`;
    
    prompt += `USER CONTEXT:\n`;
    prompt += `- Overall readiness: ${context.readinessSummary.overallScore}%\n`;
    prompt += `- DSA score: ${context.readinessSummary.dsaScore}%\n`;
    prompt += `- Skills score: ${context.readinessSummary.skillsScore}%\n`;
    prompt += `- Projects score: ${context.readinessSummary.projectsScore}%\n`;
    prompt += `- Infrastructure score: ${context.readinessSummary.infrastructureScore}%\n`;
    prompt += `- Roadmap progress: ${context.readinessSummary.roadmapProgress}%\n`;
    
    if (targetRole) {
      prompt += `- Target role: ${targetRole}\n`;
    }
    
    prompt += `- Progression state: ${context.progressionState.currentState}\n`;
    prompt += `- Readiness for next state: ${context.progressionState.readinessForNextState}%\n`;
    
    prompt += `\nRESPONSE GUIDELINES:\n`;
    prompt += `- Be concise and technical\n`;
    prompt += `- Explain the engineering rationale clearly\n`;
    prompt += `- Reference specific evidence from context\n`;
    prompt += `- Focus on technical progression, not motivation\n`;
    
    return prompt;
  }

  /**
   * Construct user prompt based on question type
   */
  private constructUserPrompt(questionType: string, specificItem: string | undefined, context: ReadinessContext): string {
    let prompt = '';
    
    switch (questionType) {
      case 'dependency':
        prompt = this.constructDependencyPrompt(specificItem, context);
        break;
      case 'progression':
        prompt = this.constructProgressionPrompt(specificItem, context);
        break;
      case 'readiness-shift':
        prompt = this.constructReadinessShiftPrompt(specificItem, context);
        break;
      case 'benchmark-change':
        prompt = this.constructBenchmarkChangePrompt(specificItem, context);
        break;
      case 'maturity-gap':
        prompt = this.constructMaturityGapPrompt(specificItem, context);
        break;
      default:
        prompt = 'Explain the engineering progression concept based on the provided context.';
    }
    
    return prompt;
  }

  /**
   * Construct dependency explanation prompt
   */
  private constructDependencyPrompt(specificItem: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the engineering dependencies for the user's progression.\n\n`;
    
    prompt += `Current Progression State: ${context.progressionState.currentState}\n`;
    prompt += `Readiness for Next State: ${context.progressionState.readinessForNextState}%\n\n`;
    
    if (context.progressionState.requirements.length > 0) {
      prompt += `Requirements for Next State:\n`;
      context.progressionState.requirements.forEach(req => {
        prompt += `- ${req}\n`;
      });
    }
    
    if (context.roadmapGaps.length > 0) {
      prompt += `\nCurrent Roadmap Gaps:\n`;
      context.roadmapGaps.slice(0, 5).forEach(gap => {
        prompt += `- ${gap.nodeName}: ${gap.description} (severity: ${gap.severity})\n`;
      });
    }
    
    if (specificItem) {
      prompt += `\nSpecific focus: ${specificItem}\n`;
    }
    
    prompt += `\nPlease explain the engineering dependencies and why they are important for progression.`;
    
    return prompt;
  }

  /**
   * Construct progression explanation prompt
   */
  private constructProgressionPrompt(specificItem: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the engineering progression ordering for the user.\n\n`;
    
    prompt += `Current Progression State: ${context.progressionState.currentState}\n`;
    prompt += `Readiness for Next State: ${context.progressionState.readinessForNextState}%\n\n`;
    
    prompt += `Component Scores:\n`;
    prompt += `- DSA: ${context.readinessSummary.dsaScore}%\n`;
    prompt += `- Skills: ${context.readinessSummary.skillsScore}%\n`;
    prompt += `- Projects: ${context.readinessSummary.projectsScore}%\n`;
    prompt += `- Infrastructure: ${context.readinessSummary.infrastructureScore}%\n\n`;
    
    if (context.verifiedSkillData.verifiedSkills.length > 0) {
      prompt += `Verified Skills:\n`;
      context.verifiedSkillData.verifiedSkills.slice(0, 5).forEach(skill => {
        prompt += `- ${skill}\n`;
      });
    }
    
    if (context.verifiedSkillData.missingDependencies.length > 0) {
      prompt += `\nMissing Dependencies:\n`;
      context.verifiedSkillData.missingDependencies.slice(0, 5).forEach(dep => {
        prompt += `- ${dep}\n`;
      });
    }
    
    if (specificItem) {
      prompt += `\nSpecific focus: ${specificItem}\n`;
    }
    
    prompt += `\nPlease explain the engineering progression ordering and rationale.`;
    
    return prompt;
  }

  /**
   * Construct readiness shift explanation prompt
   */
  private constructReadinessShiftPrompt(specificItem: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the readiness shifts observed for the user.\n\n`;
    
    prompt += `Current Readiness Scores:\n`;
    prompt += `- Overall: ${context.readinessSummary.overallScore}%\n`;
    prompt += `- DSA: ${context.readinessSummary.dsaScore}%\n`;
    prompt += `- Skills: ${context.readinessSummary.skillsScore}%\n`;
    prompt += `- Projects: ${context.readinessSummary.projectsScore}%\n`;
    prompt += `- Infrastructure: ${context.readinessSummary.infrastructureScore}%\n\n`;
    
    prompt += `Momentum Signals:\n`;
    prompt += `- Overall Momentum: ${context.momentumSignals.overallMomentum}\n`;
    prompt += `- Momentum State: ${context.momentumSignals.momentumState}\n\n`;
    
    if (context.momentumSignals.insights.length > 0) {
      prompt += `Momentum Insights:\n`;
      context.momentumSignals.insights.forEach(insight => {
        prompt += `- ${insight}\n`;
      });
    }
    
    if (specificItem) {
      prompt += `\nSpecific focus: ${specificItem}\n`;
    }
    
    prompt += `\nPlease explain the readiness shifts and what they indicate about engineering progression.`;
    
    return prompt;
  }

  /**
   * Construct benchmark change explanation prompt
   */
  private constructBenchmarkChangePrompt(specificItem: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the benchmark positioning for the user.\n\n`;
    
    prompt += `Benchmark Insights:\n`;
    prompt += `- Percentile Ranking: ${context.benchmarkInsights.percentileRanking}%\n`;
    prompt += `- Confidence Level: ${context.benchmarkInsights.confidenceLevel}%\n\n`;
    
    if (context.benchmarkInsights.relativeComparisons.length > 0) {
      prompt += `Relative Comparisons:\n`;
      context.benchmarkInsights.relativeComparisons.forEach((comp: string) => {
        prompt += `- ${comp}\n`;
      });
    }
    
    prompt += `\nTrust Confidence:\n`;
    prompt += `- Overall Confidence: ${context.trustConfidence.overallConfidence}%\n`;
    prompt += `- Evidence Coverage: ${context.trustConfidence.evidenceCoverage}%\n`;
    
    if (specificItem) {
      prompt += `\nSpecific focus: ${specificItem}\n`;
    }
    
    prompt += `\nPlease explain the benchmark positioning and what it indicates relative to the cohort.`;
    
    return prompt;
  }

  /**
   * Construct maturity gap explanation prompt
   */
  private constructMaturityGapPrompt(specificItem: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the engineering maturity gaps for the user.\n\n`;
    
    prompt += `Component Scores:\n`;
    prompt += `- DSA: ${context.readinessSummary.dsaScore}%\n`;
    prompt += `- Skills: ${context.readinessSummary.skillsScore}%\n`;
    prompt += `- Projects: ${context.readinessSummary.projectsScore}%\n`;
    prompt += `- Infrastructure: ${context.readinessSummary.infrastructureScore}%\n\n`;
    
    if (context.evidenceChains.length > 0) {
      prompt += `Evidence Chains:\n`;
      context.evidenceChains.forEach(chain => {
        prompt += `- ${chain.component}: confidence ${chain.confidence}%, evidence: ${chain.evidence.join(', ')}\n`;
      });
    }
    
    if (context.roadmapGaps.length > 0) {
      prompt += `\nRoadmap Gaps:\n`;
      context.roadmapGaps.slice(0, 5).forEach(gap => {
        prompt += `- ${gap.nodeName}: ${gap.description} (severity: ${gap.severity})\n`;
      });
    }
    
    if (specificItem) {
      prompt += `\nSpecific focus: ${specificItem}\n`;
    }
    
    prompt += `\nPlease explain the engineering maturity gaps and how to address them.`;
    
    return prompt;
  }
}

export const ContextualEngineeringMentor = new ContextualEngineeringMentorClass();
