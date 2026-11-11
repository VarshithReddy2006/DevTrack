import { AIProviderAdapter, AIRequest } from '../provider/AIProviderAdapter.js';
import { ReadinessContextBuilder, ReadinessContext } from '../context/ReadinessContextBuilder.js';
import { logger } from '../../../shared/logger.js';

export interface ReadinessExplanationInput {
  userId: string;
  targetRole?: string;
  explanationType: 'movement' | 'benchmark-change' | 'momentum-shift' | 'weak-area' | 'confidence-reduction' | 'provider-degradation';
  component?: string;
  timeframe?: string;
}

export interface ReadinessExplanationResponse {
  explanation: string;
  contextUsed: ReadinessContext;
  provider: string;
  model: string;
  tokensUsed: number;
  latency: number;
  cached: boolean;
}

class AIReadinessExplanationLayerClass {
  /**
   * Explain readiness movement, benchmark changes, or other readiness phenomena
   */
  async explainReadiness(input: ReadinessExplanationInput): Promise<ReadinessExplanationResponse> {
    const { userId, targetRole, explanationType, component, timeframe } = input;
    
    try {
      logger.info('[AIReadinessExplanationLayer] Explaining readiness phenomenon', { userId, explanationType });
      
      // Build deterministic context
      const context = await ReadinessContextBuilder.buildContext({
        userId,
        targetRole,
        contextType: 'readiness',
      });
      
      // Construct system prompt
      const systemPrompt = this.constructSystemPrompt(context, targetRole);
      
      // Construct user prompt based on explanation type
      const userPrompt = this.constructUserPrompt(explanationType, component, timeframe, context);
      
      // Generate AI response
      const aiRequest: AIRequest = {
        prompt: userPrompt,
        tenantScope: userId,
        systemPrompt,
        temperature: 0.6,
        maxTokens: 400,
      };
      
      const aiResponse = await AIProviderAdapter.generateResponse(aiRequest);
      
      logger.info('[AIReadinessExplanationLayer] Readiness phenomenon explained', { 
        userId, 
        explanationType,
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
      logger.error('[AIReadinessExplanationLayer] Failed to explain readiness phenomenon', { userId, error });
      throw error;
    }
  }

  /**
   * Construct system prompt
   */
  private constructSystemPrompt(context: ReadinessContext, targetRole?: string): string {
    let prompt = `You are an engineering progression mentor for DevTrack. Your role is to explain readiness movements, benchmark changes, and confidence shifts clearly.\n\n`;
    
    prompt += `IMPORTANT CONSTRAINTS:\n`;
    prompt += `- You MUST ONLY use the deterministic context provided\n`;
    prompt += `- You MUST NOT invent analytics or metrics not in the context\n`;
    prompt += `- You MUST remain technical and evidence-focused\n`;
    prompt += `- You MUST explain the engineering rationale clearly\n`;
    prompt += `- You MUST reference specific evidence chains when explaining\n`;
    prompt += `- You MUST acknowledge uncertainty honestly when confidence is low\n`;
    prompt += `- You MUST NOT make placement or salary promises\n\n`;
    
    prompt += `USER CONTEXT:\n`;
    prompt += `- Overall readiness: ${context.readinessSummary.overallScore}%\n`;
    prompt += `- DSA score: ${context.readinessSummary.dsaScore}%\n`;
    prompt += `- Skills score: ${context.readinessSummary.skillsScore}%\n`;
    prompt += `- Projects score: ${context.readinessSummary.projectsScore}%\n`;
    prompt += `- Infrastructure score: ${context.readinessSummary.infrastructureScore}%\n`;
    prompt += `- Confidence: ${context.readinessSummary.confidenceScore}%\n`;
    prompt += `- Evidence coverage: ${context.readinessSummary.evidenceCoverage}%\n`;
    
    if (targetRole) {
      prompt += `- Target role: ${targetRole}\n`;
    }
    
    prompt += `- Momentum state: ${context.momentumSignals.momentumState}\n`;
    prompt += `- Overall momentum: ${context.momentumSignals.overallMomentum}\n`;
    
    if (context.providerFreshness.staleProviders.length > 0) {
      prompt += `\nIMPORTANT: Stale providers: ${context.providerFreshness.staleProviders.join(', ')}\n`;
    }
    
    prompt += `\nRESPONSE GUIDELINES:\n`;
    prompt += `- Be concise and technical\n`;
    prompt += `- Explain the engineering rationale clearly\n`;
    prompt += `- Reference specific evidence from context\n`;
    prompt += `- Acknowledge uncertainty when confidence is low\n`;
    prompt += `- Focus on technical factors, not motivation\n`;
    
    return prompt;
  }

  /**
   * Construct user prompt based on explanation type
   */
  private constructUserPrompt(
    explanationType: string,
    component: string | undefined,
    timeframe: string | undefined,
    context: ReadinessContext
  ): string {
    let prompt = '';
    
    switch (explanationType) {
      case 'movement':
        prompt = this.constructMovementPrompt(component, timeframe, context);
        break;
      case 'benchmark-change':
        prompt = this.constructBenchmarkChangePrompt(component, timeframe, context);
        break;
      case 'momentum-shift':
        prompt = this.constructMomentumShiftPrompt(component, timeframe, context);
        break;
      case 'weak-area':
        prompt = this.constructWeakAreaPrompt(component, context);
        break;
      case 'confidence-reduction':
        prompt = this.constructConfidenceReductionPrompt(component, context);
        break;
      case 'provider-degradation':
        prompt = this.constructProviderDegradationPrompt(component, context);
        break;
      default:
        prompt = 'Explain the readiness phenomenon based on the provided context.';
    }
    
    return prompt;
  }

  /**
   * Construct movement explanation prompt
   */
  private constructMovementPrompt(component: string | undefined, timeframe: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the readiness movement observed for the user.\n\n`;
    
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
    
    if (component) {
      prompt += `\nSpecific Component: ${component}\n`;
      prompt += `Current Score: ${this.getComponentScore(context, component)}%\n`;
    }
    
    if (timeframe) {
      prompt += `\nTimeframe: ${timeframe}\n`;
    }
    
    prompt += `\nPlease explain the readiness movement and what technical factors contributed to it.`;
    
    return prompt;
  }

  /**
   * Construct benchmark change explanation prompt
   */
  private constructBenchmarkChangePrompt(component: string | undefined, timeframe: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the benchmark positioning change for the user.\n\n`;
    
    prompt += `Benchmark Insights:\n`;
    prompt += `- Percentile Ranking: ${context.benchmarkInsights.percentileRanking}%\n`;
    prompt += `- Confidence Level: ${context.benchmarkInsights.confidenceLevel}%\n\n`;
    
    if (context.benchmarkInsights.relativeComparisons.length > 0) {
      prompt += `Relative Comparisons:\n`;
      context.benchmarkInsights.relativeComparisons.forEach((comp: string) => {
        prompt += `- ${comp}\n`;
      });
    }
    
    prompt += `\nCurrent Readiness:\n`;
    prompt += `- Overall: ${context.readinessSummary.overallScore}%\n`;
    prompt += `- Confidence: ${context.readinessSummary.confidenceScore}%\n`;
    
    if (component) {
      prompt += `\nSpecific Component: ${component}\n`;
      prompt += `Current Score: ${this.getComponentScore(context, component)}%\n`;
    }
    
    if (timeframe) {
      prompt += `\nTimeframe: ${timeframe}\n`;
    }
    
    prompt += `\nPlease explain the benchmark positioning change and what technical factors contributed to it.`;
    
    return prompt;
  }

  /**
   * Construct momentum shift explanation prompt
   */
  private constructMomentumShiftPrompt(component: string | undefined, timeframe: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the momentum shift observed for the user.\n\n`;
    
    prompt += `Momentum Signals:\n`;
    prompt += `- Overall Momentum: ${context.momentumSignals.overallMomentum}\n`;
    prompt += `- Momentum State: ${context.momentumSignals.momentumState}\n\n`;
    
    if (context.momentumSignals.insights.length > 0) {
      prompt += `Momentum Insights:\n`;
      context.momentumSignals.insights.forEach(insight => {
        prompt += `- ${insight}\n`;
      });
    }
    
    prompt += `\nReadiness Scores:\n`;
    prompt += `- Overall: ${context.readinessSummary.overallScore}%\n`;
    prompt += `- DSA: ${context.readinessSummary.dsaScore}%\n`;
    prompt += `- Skills: ${context.readinessSummary.skillsScore}%\n`;
    prompt += `- Projects: ${context.readinessSummary.projectsScore}%\n`;
    
    if (component) {
      prompt += `\nSpecific Component: ${component}\n`;
      prompt += `Current Score: ${this.getComponentScore(context, component)}%\n`;
    }
    
    if (timeframe) {
      prompt += `\nTimeframe: ${timeframe}\n`;
    }
    
    prompt += `\nPlease explain the momentum shift and what technical factors contributed to it.`;
    
    return prompt;
  }

  /**
   * Construct weak area explanation prompt
   */
  private constructWeakAreaPrompt(component: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the weak areas detected for the user.\n\n`;
    
    prompt += `Component Scores:\n`;
    prompt += `- DSA: ${context.readinessSummary.dsaScore}%\n`;
    prompt += `- Skills: ${context.readinessSummary.skillsScore}%\n`;
    prompt += `- Projects: ${context.readinessSummary.projectsScore}%\n`;
    prompt += `- Infrastructure: ${context.readinessSummary.infrastructureScore}%\n\n`;
    
    if (context.roadmapGaps.length > 0) {
      prompt += `Roadmap Gaps:\n`;
      context.roadmapGaps.slice(0, 5).forEach(gap => {
        prompt += `- ${gap.nodeName}: ${gap.description} (severity: ${gap.severity})\n`;
      });
    }
    
    if (context.verifiedSkillData.missingDependencies.length > 0) {
      prompt += `\nMissing Dependencies:\n`;
      context.verifiedSkillData.missingDependencies.slice(0, 5).forEach(dep => {
        prompt += `- ${dep}\n`;
      });
    }
    
    if (component) {
      prompt += `\nSpecific Component: ${component}\n`;
      prompt += `Current Score: ${this.getComponentScore(context, component)}%\n`;
    }
    
    prompt += `\nPlease explain the weak areas and how to address them technically.`;
    
    return prompt;
  }

  /**
   * Construct confidence reduction explanation prompt
   */
  private constructConfidenceReductionPrompt(component: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the confidence reduction observed for the user.\n\n`;
    
    prompt += `Trust Confidence:\n`;
    prompt += `- Overall Confidence: ${context.trustConfidence.overallConfidence}%\n`;
    prompt += `- Evidence Coverage: ${context.trustConfidence.evidenceCoverage}%\n`;
    prompt += `- Confidence Reasoning: ${context.trustConfidence.confidenceReasoning}\n\n`;
    
    if (context.providerFreshness.staleProviders.length > 0) {
      prompt += `Stale Providers:\n`;
      context.providerFreshness.staleProviders.forEach(provider => {
        prompt += `- ${provider}\n`;
      });
    }
    
    if (context.evidenceChains.length > 0) {
      prompt += `\nEvidence Chains:\n`;
      context.evidenceChains.forEach(chain => {
        prompt += `- ${chain.component}: confidence ${chain.confidence}%, evidence: ${chain.evidence.join(', ')}\n`;
      });
    }
    
    if (component) {
      prompt += `\nSpecific Component: ${component}\n`;
      const chain = context.evidenceChains.find(c => c.component.toLowerCase() === component.toLowerCase());
      if (chain) {
        prompt += `Confidence: ${chain.confidence}%\n`;
        prompt += `Evidence: ${chain.evidence.join(', ')}\n`;
      }
    }
    
    prompt += `\nPlease explain the confidence reduction and what factors contributed to it.`;
    
    return prompt;
  }

  /**
   * Construct provider degradation explanation prompt
   */
  private constructProviderDegradationPrompt(component: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the provider degradation impact on readiness.\n\n`;
    
    prompt += `Provider Freshness:\n`;
    prompt += `- GitHub: ${context.providerFreshness.githubFreshness}%\n`;
    prompt += `- LeetCode: ${context.providerFreshness.leetcodeFreshness}%\n`;
    prompt += `- Codeforces: ${context.providerFreshness.codeforcesFreshness}%\n\n`;
    
    if (context.providerFreshness.staleProviders.length > 0) {
      prompt += `Stale Providers:\n`;
      context.providerFreshness.staleProviders.forEach(provider => {
        prompt += `- ${provider}\n`;
      });
    }
    
    prompt += `\nTrust Confidence:\n`;
    prompt += `- Overall Confidence: ${context.trustConfidence.overallConfidence}%\n`;
    prompt += `- Evidence Coverage: ${context.trustConfidence.evidenceCoverage}%\n`;
    
    if (component) {
      prompt += `\nSpecific Component: ${component}\n`;
      prompt += `Current Score: ${this.getComponentScore(context, component)}%\n`;
    }
    
    prompt += `\nPlease explain the provider degradation impact and how it affects readiness confidence.`;
    
    return prompt;
  }

  /**
   * Get component score from context
   */
  private getComponentScore(context: ReadinessContext, component: string): number {
    switch (component.toLowerCase()) {
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
}

export const AIReadinessExplanationLayer = new AIReadinessExplanationLayerClass();
