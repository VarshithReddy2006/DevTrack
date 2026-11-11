import { AIProviderAdapter, AIRequest } from '../provider/AIProviderAdapter.js';
import { ReadinessContextBuilder, ReadinessContext } from '../context/ReadinessContextBuilder.js';
import { logger } from '../../../shared/logger.js';

export interface ExplanationInput {
  userId: string;
  targetRole?: string;
  recommendationId: string;
  recommendation: {
    title: string;
    description: string;
    type: string;
    priority: string;
    confidence: number;
    reasoning: string;
    expectedImpact: string;
    evidenceChain: string[];
    roadmapDependencies: string[];
  };
}

export interface ExplanationResponse {
  explanation: string;
  contextUsed: ReadinessContext;
  provider: string;
  model: string;
  tokensUsed: number;
  latency: number;
  cached: boolean;
}

class RecommendationExplanationEngineClass {
  /**
   * Generate human-readable explanation for a recommendation
   */
  async explainRecommendation(input: ExplanationInput): Promise<ExplanationResponse> {
    const { userId, targetRole, recommendationId, recommendation } = input;
    
    try {
      logger.info('[RecommendationExplanationEngine] Explaining recommendation', { userId, recommendationId });
      
      // Build deterministic context
      const context = await ReadinessContextBuilder.buildContext({
        userId,
        targetRole,
        contextType: 'recommendation',
        specificId: recommendationId,
      });
      
      // Construct system prompt
      const systemPrompt = this.constructSystemPrompt(context, targetRole);
      
      // Construct user prompt with recommendation details
      const userPrompt = this.constructUserPrompt(recommendation, context);
      
      // Generate AI response
      const aiRequest: AIRequest = {
        prompt: userPrompt,
        tenantScope: userId,
        systemPrompt,
        temperature: 0.5,
        maxTokens: 300,
      };
      
      const aiResponse = await AIProviderAdapter.generateResponse(aiRequest);
      
      logger.info('[RecommendationExplanationEngine] Recommendation explained', { 
        userId, 
        recommendationId,
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
      logger.error('[RecommendationExplanationEngine] Failed to explain recommendation', { userId, error });
      throw error;
    }
  }

  /**
   * Construct system prompt
   */
  private constructSystemPrompt(context: ReadinessContext, targetRole?: string): string {
    let prompt = `You are an engineering progression mentor for DevTrack. Your role is to explain deterministic recommendations in clear, technical, human-readable language.\n\n`;
    
    prompt += `IMPORTANT CONSTRAINTS:\n`;
    prompt += `- You MUST ONLY use the deterministic context provided\n`;
    prompt += `- You MUST NOT invent evidence or reasoning not in the context\n`;
    prompt += `- You MUST remain technical and engineering-focused\n`;
    prompt += `- You MUST explain the "why" behind recommendations clearly\n`;
    prompt += `- You MUST reference specific evidence chains when explaining\n`;
    prompt += `- You MUST NOT make placement or salary promises\n\n`;
    
    prompt += `USER CONTEXT:\n`;
    prompt += `- Overall readiness: ${context.readinessSummary.overallScore}%\n`;
    prompt += `- DSA score: ${context.readinessSummary.dsaScore}%\n`;
    prompt += `- Skills score: ${context.readinessSummary.skillsScore}%\n`;
    prompt += `- Projects score: ${context.readinessSummary.projectsScore}%\n`;
    prompt += `- Infrastructure score: ${context.readinessSummary.infrastructureScore}%\n`;
    prompt += `- Confidence: ${context.readinessSummary.confidenceScore}%\n`;
    
    if (targetRole) {
      prompt += `- Target role: ${targetRole}\n`;
    }
    
    prompt += `- Progression state: ${context.progressionState.currentState}\n`;
    
    if (context.providerFreshness.staleProviders.length > 0) {
      prompt += `\nNOTE: Some data providers are stale: ${context.providerFreshness.staleProviders.join(', ')}\n`;
    }
    
    prompt += `\nRESPONSE GUIDELINES:\n`;
    prompt += `- Be concise (2-3 sentences)\n`;
    prompt += `- Start with the technical context\n`;
    prompt += `- Explain the engineering rationale clearly\n`;
    prompt += `- Reference specific evidence from context\n`;
    prompt += `- End with expected impact\n`;
    
    return prompt;
  }

  /**
   * Construct user prompt
   */
  private constructUserPrompt(
    recommendation: any,
    context: ReadinessContext
  ): string {
    let prompt = `Recommendation: ${recommendation.title}\n`;
    prompt += `Description: ${recommendation.description}\n`;
    prompt += `Type: ${recommendation.type}\n`;
    prompt += `Priority: ${recommendation.priority}\n`;
    prompt += `Confidence: ${recommendation.confidence}%\n`;
    prompt += `Expected Impact: ${recommendation.expectedImpact}\n\n`;
    
    prompt += `Deterministic Reasoning: ${recommendation.reasoning}\n\n`;
    
    prompt += `Evidence Chain:\n`;
    recommendation.evidenceChain.forEach((evidence: string) => {
      prompt += `- ${evidence}\n`;
    });
    
    if (recommendation.roadmapDependencies.length > 0) {
      prompt += `\nRoadmap Dependencies:\n`;
      recommendation.roadmapDependencies.forEach((dep: string) => {
        prompt += `- ${dep}\n`;
      });
    }
    
    prompt += `\nRelevant Context:\n`;
    prompt += `- Current ${recommendation.type} score: ${this.getComponentScore(context, recommendation.type)}%\n`;
    prompt += `- Overall confidence: ${context.readinessSummary.confidenceScore}%\n`;
    prompt += `- Evidence coverage: ${context.readinessSummary.evidenceCoverage}%\n`;
    
    prompt += `\nPlease explain this recommendation in clear, human-readable engineering language. Focus on the technical rationale and expected impact.`;
    
    return prompt;
  }

  /**
   * Get component score from context
   */
  private getComponentScore(context: ReadinessContext, type: string): number {
    switch (type) {
      case 'dsa':
        return context.readinessSummary.dsaScore;
      case 'skills':
        return context.readinessSummary.skillsScore;
      case 'projects':
        return context.readinessSummary.projectsScore;
      case 'infrastructure':
        return context.readinessSummary.infrastructureScore;
      case 'roadmap':
        return context.readinessSummary.roadmapProgress;
      default:
        return context.readinessSummary.overallScore;
    }
  }

  /**
   * Batch explain multiple recommendations
   */
  async explainBatchRecommendations(
    userId: string,
    targetRole: string | undefined,
    recommendations: any[]
  ): Promise<ExplanationResponse[]> {
    const explanations: ExplanationResponse[] = [];
    
    for (const recommendation of recommendations) {
      try {
        const explanation = await this.explainRecommendation({
          userId,
          targetRole,
          recommendationId: recommendation.recommendationId,
          recommendation,
        });
        explanations.push(explanation);
      } catch (error) {
        logger.error('[RecommendationExplanationEngine] Failed to explain recommendation in batch', { 
          userId, 
          recommendationId: recommendation.recommendationId,
          error 
        });
      }
    }
    
    return explanations;
  }
}

export const RecommendationExplanationEngine = new RecommendationExplanationEngineClass();
