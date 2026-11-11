import { AIProviderAdapter, AIRequest } from '../provider/AIProviderAdapter.js';
import { ReadinessContextBuilder, ReadinessContext } from '../context/ReadinessContextBuilder.js';
import { SkillGraphNormalizationLayer } from '../../readiness/skillGraph/SkillGraphNormalizationLayer.js';
import { logger } from '../../../shared/logger.js';

export interface RoadmapGuidanceInput {
  userId: string;
  targetRole?: string;
  questionType: 'dependency' | 'sequencing' | 'importance' | 'architecture' | 'scalability';
  specificNode?: string;
  comparisonNodes?: string[];
  threadId?: string;
}

export interface RoadmapGuidanceResponse {
  explanation: string;
  contextUsed: ReadinessContext;
  provider: string;
  model: string;
  tokensUsed: number;
  latency: number;
  cached: boolean;
}

class AIRoadmapGuidanceClass {
  /**
   * Explain roadmap dependencies, sequencing, or importance
   */
  async explainRoadmap(input: RoadmapGuidanceInput): Promise<RoadmapGuidanceResponse> {
    const { userId, targetRole, questionType, specificNode, comparisonNodes } = input;
    
    try {
      logger.info('[AIRoadmapGuidance] Explaining roadmap concept', { userId, questionType });
      
      // Build deterministic context
      const context = await ReadinessContextBuilder.buildContext({
        userId,
        targetRole,
        contextType: 'roadmap',
      });
      
      // Construct system prompt
      const systemPrompt = this.constructSystemPrompt(context, targetRole);
      
      // Construct user prompt based on question type
      const userPrompt = this.constructUserPrompt(questionType, specificNode, comparisonNodes, context);
      
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
            `Roadmap ${questionType}: ${specificNode || ''}`,
            aiResponse.content,
            'roadmap',
            targetRole,
            aiResponse.tokensUsed
          );
        } catch (e) {
          logger.warn('[AIRoadmapGuidance] Failed to persist roadmap turn', { userId, error: e });
        }
      }
      
      logger.info('[AIRoadmapGuidance] Roadmap concept explained', { 
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
      logger.error('[AIRoadmapGuidance] Failed to explain roadmap concept', { userId, error });
      throw error;
    }
  }

  /**
   * Construct system prompt
   */
  private constructSystemPrompt(context: ReadinessContext, targetRole?: string): string {
    let prompt = `You are an engineering progression mentor for DevTrack. Your role is to explain roadmap dependencies, sequencing, and architectural importance clearly.\n\n`;
    
    prompt += `IMPORTANT CONSTRAINTS:\n`;
    prompt += `- You MUST ONLY use the deterministic context and skill graph provided\n`;
    prompt += `- You MUST NOT invent technical claims not supported by evidence\n`;
    prompt += `- You MUST remain technical and architecture-focused\n`;
    prompt += `- You MUST explain the engineering rationale clearly\n`;
    prompt += `- You MUST reference specific dependencies from the skill graph\n`;
    prompt += `- You MUST NOT make placement or salary promises\n\n`;
    
    prompt += `USER CONTEXT:\n`;
    prompt += `- Overall readiness: ${context.readinessSummary.overallScore}%\n`;
    prompt += `- Infrastructure score: ${context.readinessSummary.infrastructureScore}%\n`;
    prompt += `- Roadmap progress: ${context.readinessSummary.roadmapProgress}%\n`;
    
    if (targetRole) {
      prompt += `- Target role: ${targetRole}\n`;
    }
    
    prompt += `- Progression state: ${context.progressionState.currentState}\n`;
    
    prompt += `\nRESPONSE GUIDELINES:\n`;
    prompt += `- Be concise and technical\n`;
    prompt += `- Explain the engineering rationale clearly\n`;
    prompt += `- Reference specific dependencies from skill graph\n`;
    prompt += `- Focus on architecture and scalability reasoning\n`;
    prompt += `- Avoid generic roadmap advice\n`;
    
    return prompt;
  }

  /**
   * Construct user prompt based on question type
   */
  private constructUserPrompt(
    questionType: string,
    specificNode: string | undefined,
    comparisonNodes: string[] | undefined,
    context: ReadinessContext
  ): string {
    let prompt = '';
    
    switch (questionType) {
      case 'dependency':
        prompt = this.constructDependencyPrompt(specificNode, context);
        break;
      case 'sequencing':
        prompt = this.constructSequencingPrompt(specificNode, comparisonNodes, context);
        break;
      case 'importance':
        prompt = this.constructImportancePrompt(specificNode, context);
        break;
      case 'architecture':
        prompt = this.constructArchitecturePrompt(specificNode, context);
        break;
      case 'scalability':
        prompt = this.constructScalabilityPrompt(specificNode, context);
        break;
      default:
        prompt = 'Explain the roadmap concept based on the provided context.';
    }
    
    return prompt;
  }

  /**
   * Construct dependency explanation prompt
   */
  private constructDependencyPrompt(specificNode: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the roadmap dependencies for the user's engineering progression.\n\n`;
    
    prompt += `Current Roadmap Progress: ${context.readinessSummary.roadmapProgress}%\n`;
    prompt += `Infrastructure Score: ${context.readinessSummary.infrastructureScore}%\n\n`;
    
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
    
    if (context.roadmapGaps.length > 0) {
      prompt += `\nCurrent Roadmap Gaps:\n`;
      context.roadmapGaps.slice(0, 5).forEach(gap => {
        prompt += `- ${gap.nodeName}: ${gap.description} (severity: ${gap.severity})\n`;
      });
    }
    
    // Add skill graph dependencies for specific node
    if (specificNode) {
      const node = SkillGraphNormalizationLayer.getNode(specificNode);
      if (node) {
        prompt += `\n\nSpecific Node: ${specificNode}\n`;
        prompt += `Dependencies: ${node.dependencies.join(', ') || 'None'}\n`;
        prompt += `Category: ${node.category}\n`;
      }
    }
    
    prompt += `\nPlease explain the roadmap dependencies and why they are important for engineering progression.`;
    
    return prompt;
  }

  /**
   * Construct sequencing explanation prompt
   */
  private constructSequencingPrompt(
    specificNode: string | undefined,
    comparisonNodes: string[] | undefined,
    context: ReadinessContext
  ): string {
    let prompt = `Explain the roadmap sequencing and ordering for engineering progression.\n\n`;
    
    prompt += `Current Progression State: ${context.progressionState.currentState}\n`;
    prompt += `Readiness for Next State: ${context.progressionState.readinessForNextState}%\n\n`;
    
    if (specificNode && comparisonNodes && comparisonNodes.length > 0) {
      prompt += `Compare the sequencing of: ${specificNode} vs ${comparisonNodes.join(', ')}\n\n`;
      
      // Get dependencies for each node
      const nodes = [specificNode, ...comparisonNodes];
      nodes.forEach(nodeId => {
        const node = SkillGraphNormalizationLayer.getNode(nodeId);
        if (node) {
          prompt += `${nodeId}:\n`;
          prompt += `- Dependencies: ${node.dependencies.join(', ') || 'None'}\n`;
          prompt += `- Category: ${node.category}\n`;
          prompt += `- Verified: ${context.verifiedSkillData.verifiedSkills.includes(nodeId) ? 'Yes' : 'No'}\n\n`;
        }
      });
    } else if (specificNode) {
      const node = SkillGraphNormalizationLayer.getNode(specificNode);
      if (node) {
        prompt += `Specific Node: ${specificNode}\n`;
        prompt += `Dependencies: ${node.dependencies.join(', ') || 'None'}\n`;
        prompt += `Category: ${node.category}\n`;
        prompt += `Verified: ${context.verifiedSkillData.verifiedSkills.includes(specificNode) ? 'Yes' : 'No'}\n`;
      }
    }
    
    prompt += `\nPlease explain the roadmap sequencing and why this ordering is important for engineering maturity progression.`;
    
    return prompt;
  }

  /**
   * Construct importance explanation prompt
   */
  private constructImportancePrompt(specificNode: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the importance of roadmap skills for engineering progression.\n\n`;
    
    prompt += `Infrastructure Score: ${context.readinessSummary.infrastructureScore}%\n`;
    prompt += `Projects Score: ${context.readinessSummary.projectsScore}%\n\n`;
    
    if (specificNode) {
      const node = SkillGraphNormalizationLayer.getNode(specificNode);
      if (node) {
        prompt += `Specific Node: ${specificNode}\n`;
        prompt += `Category: ${node.category}\n`;
        prompt += `Dependencies: ${node.dependencies.join(', ') || 'None'}\n`;
        prompt += `Verified: ${context.verifiedSkillData.verifiedSkills.includes(specificNode) ? 'Yes' : 'No'}\n`;
      }
    }
    
    if (context.recommendations.length > 0) {
      prompt += `\nTop Recommendations:\n`;
      context.recommendations.slice(0, 3).forEach(rec => {
        prompt += `- ${rec.title} (${rec.type}, priority: ${rec.priority})\n`;
      });
    }
    
    prompt += `\nPlease explain why this skill is important for engineering progression and what impact it has on readiness.`;
    
    return prompt;
  }

  /**
   * Construct architecture explanation prompt
   */
  private constructArchitecturePrompt(specificNode: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the architectural importance of roadmap skills.\n\n`;
    
    prompt += `Infrastructure Score: ${context.readinessSummary.infrastructureScore}%\n`;
    prompt += `Projects Score: ${context.readinessSummary.projectsScore}%\n\n`;
    
    if (specificNode) {
      const node = SkillGraphNormalizationLayer.getNode(specificNode);
      if (node) {
        prompt += `Specific Node: ${specificNode}\n`;
        prompt += `Category: ${node.category}\n`;
        
        if (node.category === 'infrastructure') {
          prompt += `\nThis is an infrastructure skill critical for system architecture.\n`;
        }
      }
    }
    
    if (context.evidenceChains.length > 0) {
      prompt += `\nEvidence Chains:\n`;
      context.evidenceChains.forEach(chain => {
        prompt += `- ${chain.component}: ${chain.evidence.join(', ')}\n`;
      });
    }
    
    prompt += `\nPlease explain the architectural importance and how this skill contributes to system design maturity.`;
    
    return prompt;
  }

  /**
   * Construct scalability explanation prompt
   */
  private constructScalabilityPrompt(specificNode: string | undefined, context: ReadinessContext): string {
    let prompt = `Explain the scalability importance of roadmap skills.\n\n`;
    
    prompt += `Infrastructure Score: ${context.readinessSummary.infrastructureScore}%\n`;
    prompt += `Projects Score: ${context.readinessSummary.projectsScore}%\n\n`;
    
    if (specificNode) {
      const node = SkillGraphNormalizationLayer.getNode(specificNode);
      if (node) {
        prompt += `Specific Node: ${specificNode}\n`;
        prompt += `Category: ${node.category}\n`;
        
        // Common scalability skills
        const scalabilitySkills = ['Redis', 'Kubernetes', 'Docker', 'Queue', 'Load Balancer', 'Caching'];
        if (scalabilitySkills.some(skill => specificNode.toLowerCase().includes(skill.toLowerCase()))) {
          prompt += `\nThis skill is directly related to system scalability.\n`;
        }
      }
    }
    
    if (context.roadmapGaps.length > 0) {
      prompt += `\nCurrent Roadmap Gaps:\n`;
      context.roadmapGaps.slice(0, 5).forEach(gap => {
        prompt += `- ${gap.nodeName}: ${gap.description}\n`;
      });
    }
    
    prompt += `\nPlease explain the scalability importance and how this skill contributes to building scalable systems.`;
    
    return prompt;
  }
}

export const AIRoadmapGuidance = new AIRoadmapGuidanceClass();
