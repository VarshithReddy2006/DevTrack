import { Types } from 'mongoose';
import { AIProviderAdapter, AIRequest } from '../provider/AIProviderAdapter.js';
import { ReadinessContextBuilder, ReadinessContext } from '../context/ReadinessContextBuilder.js';
import { logger } from '../../../shared/logger.js';

export interface ConversationInput {
  userId: string;
  targetRole?: string;
  question: string;
  conversationHistory?: ConversationMessage[];
  threadId?: string;
  contextType?: 'copilot' | 'roadmap' | 'mentor' | 'general';
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ConversationResponse {
  answer: string;
  contextUsed: ReadinessContext;
  provider: string;
  model: string;
  tokensUsed: number;
  latency: number;
  cached: boolean;
  confidence: number;
  threadId: string;
}

function toUserQueryId(userId: string): any {
  return Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : userId;
}

class AIConversationServiceClass {
  private conversationHistory: Map<string, ConversationMessage[]> = new Map();
  private maxHistoryLength: number = 10;

  /**
   * Process conversational engineering guidance question
   */
  async processQuestion(input: ConversationInput): Promise<ConversationResponse> {
    const { userId, targetRole, question, conversationHistory, contextType = 'copilot' } = input;
    const threadId = input.threadId || 'career-copilot';
    
    try {
      logger.info('[AIConversationService] Processing question', { userId, threadId, question: question.substring(0, 50) });
      
      // Determine history: if caller didn't pass, load from DB / memory
      const historyToUse = conversationHistory && conversationHistory.length > 0
        ? conversationHistory
        : await this.getConversationHistory(userId, threadId);

      // Build deterministic context
      const context = await ReadinessContextBuilder.buildContext({
        userId,
        targetRole,
        contextType: contextType === 'roadmap' ? 'roadmap' : 'general',
      });
      
      // Construct system prompt
      const systemPrompt = this.constructSystemPrompt(context, targetRole);
      
      // Construct user prompt with context & history
      const userPrompt = this.constructUserPrompt(question, context, historyToUse);
      
      // Generate AI response
      const aiRequest: AIRequest = {
        prompt: userPrompt,
        tenantScope: userId,
        systemPrompt,
        temperature: 0.7,
        maxTokens: 500,
      };
      
      const aiResponse = await AIProviderAdapter.generateResponse(aiRequest);
      
      // Calculate confidence based on context quality
      const confidence = this.calculateConfidence(context);

      // Persist conversation turn in MongoDB and update in-memory cache
      await this.persistConversationTurn(
        userId,
        threadId,
        question,
        aiResponse.content,
        contextType,
        targetRole,
        aiResponse.tokensUsed,
        confidence
      );
      
      logger.info('[AIConversationService] Question processed', { 
        userId, 
        threadId,
        provider: aiResponse.provider,
        latency: aiResponse.latency 
      });
      
      return {
        answer: aiResponse.content,
        contextUsed: context,
        provider: aiResponse.provider,
        model: aiResponse.model,
        tokensUsed: aiResponse.tokensUsed,
        latency: aiResponse.latency,
        cached: aiResponse.cached,
        confidence,
        threadId,
      };
    } catch (error) {
      logger.error('[AIConversationService] Failed to process question', { userId, threadId, error });
      throw error;
    }
  }

  /**
   * Persist conversation turn in MongoDB and update in-memory cache
   */
  async persistConversationTurn(
    userId: string,
    threadId: string,
    question: string,
    answer: string,
    contextType: 'copilot' | 'roadmap' | 'mentor' | 'general' = 'copilot',
    targetRole?: string,
    tokensUsed?: number,
    confidence?: number
  ): Promise<void> {
    const userMsg: ConversationMessage = {
      role: 'user',
      content: question,
      timestamp: new Date(),
    };
    const assistantMsg: ConversationMessage = {
      role: 'assistant',
      content: answer,
      timestamp: new Date(),
    };

    // Update in-memory cache
    const cacheKey = `${userId}:${threadId}`;
    if (!this.conversationHistory.has(cacheKey)) {
      this.conversationHistory.set(cacheKey, []);
    }
    const memHistory = this.conversationHistory.get(cacheKey)!;
    memHistory.push(userMsg, assistantMsg);
    if (memHistory.length > this.maxHistoryLength * 2) {
      this.conversationHistory.set(cacheKey, memHistory.slice(-this.maxHistoryLength * 2));
    }

    // Persist to MongoDB
    try {
      const { AIConversation } = await import('../../../db/models/aiConversation.model.js');
      const userObjId = toUserQueryId(userId);
      await AIConversation.findOneAndUpdate(
        { userId: userObjId, threadId },
        {
          $setOnInsert: { contextType, targetRole, title: question.slice(0, 60) },
          $push: {
            messages: {
              $each: [
                { role: 'user', content: question, timestamp: userMsg.timestamp },
                { role: 'assistant', content: answer, timestamp: assistantMsg.timestamp, tokensUsed, confidence },
              ],
              $slice: -this.maxHistoryLength * 2,
            },
          },
          $set: { updatedAt: new Date() },
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      logger.warn('[AIConversationService] Non-fatal DB persistence failure', { userId, threadId, error: err });
    }
  }

  /**
   * Get conversation history for a user and thread
   */
  async getConversationHistory(userId: string, threadId: string = 'career-copilot'): Promise<ConversationMessage[]> {
    const cacheKey = `${userId}:${threadId}`;

    try {
      const { AIConversation } = await import('../../../db/models/aiConversation.model.js');
      const conv = await AIConversation.findOne({
        userId: toUserQueryId(userId),
        threadId,
      }).lean();

      if (conv && conv.messages && conv.messages.length > 0) {
        const msgs: ConversationMessage[] = conv.messages.map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: new Date(m.timestamp),
        }));
        this.conversationHistory.set(cacheKey, msgs);
        return msgs;
      }
    } catch (err) {
      logger.warn('[AIConversationService] Failed to load conversation history from DB', { userId, threadId, error: err });
    }

    if (this.conversationHistory.has(cacheKey)) {
      return this.conversationHistory.get(cacheKey)!;
    }

    return [];
  }

  /**
   * Clear conversation history for a user and thread
   */
  async clearConversationHistory(userId: string, threadId: string = 'career-copilot'): Promise<void> {
    const cacheKey = `${userId}:${threadId}`;
    this.conversationHistory.delete(cacheKey);

    try {
      const { AIConversation } = await import('../../../db/models/aiConversation.model.js');
      await AIConversation.deleteOne({
        userId: toUserQueryId(userId),
        threadId,
      });
      logger.info('[AIConversationService] Conversation history cleared', { userId, threadId });
    } catch (err) {
      logger.warn('[AIConversationService] Failed to delete conversation history from DB', { userId, threadId, error: err });
    }
  }

  /**
   * List conversation threads for a user
   */
  async listThreads(userId: string): Promise<Array<{ threadId: string; title?: string; contextType: string; messageCount: number; updatedAt: Date }>> {
    try {
      const { AIConversation } = await import('../../../db/models/aiConversation.model.js');
      const threads = await AIConversation.find({
        userId: toUserQueryId(userId),
      })
        .sort({ updatedAt: -1 })
        .lean();

      return threads.map((t) => ({
        threadId: t.threadId,
        title: t.title || 'Untitled Conversation',
        contextType: t.contextType,
        messageCount: t.messages?.length || 0,
        updatedAt: t.updatedAt,
      }));
    } catch (err) {
      logger.warn('[AIConversationService] Failed to list threads from DB', { userId, error: err });
      return [];
    }
  }

  /**
   * Construct system prompt
   */
  private constructSystemPrompt(context: ReadinessContext, targetRole?: string): string {
    let prompt = `You are an engineering progression mentor for DevTrack, a placement readiness system. Your role is to explain engineering readiness, roadmap progression, and technical growth guidance.\n\n`;
    
    prompt += `IMPORTANT CONSTRAINTS:\n`;
    prompt += `- You MUST ONLY use the deterministic readiness data provided in context\n`;
    prompt += `- You MUST NOT invent analytics, scores, or metrics not in the context\n`;
    prompt += `- You MUST NOT make placement guarantees, salary predictions, or hiring promises\n`;
    prompt += `- You MUST remain technical, evidence-backed, and engineering-focused\n`;
    prompt += `- You MUST acknowledge uncertainty honestly when confidence is low\n`;
    prompt += `- You MUST explain reasoning based on evidence chains provided\n\n`;
    
    prompt += `USER CONTEXT:\n`;
    prompt += `- Overall readiness score: ${context.readinessSummary.overallScore}%\n`;
    prompt += `- DSA score: ${context.readinessSummary.dsaScore}%\n`;
    prompt += `- Skills score: ${context.readinessSummary.skillsScore}%\n`;
    prompt += `- Projects score: ${context.readinessSummary.projectsScore}%\n`;
    prompt += `- Infrastructure score: ${context.readinessSummary.infrastructureScore}%\n`;
    prompt += `- Roadmap progress: ${context.readinessSummary.roadmapProgress}%\n`;
    prompt += `- Confidence score: ${context.readinessSummary.confidenceScore}%\n`;
    prompt += `- Evidence coverage: ${context.readinessSummary.evidenceCoverage}%\n`;
    
    if (targetRole) {
      prompt += `- Target role: ${targetRole}\n`;
    }
    
    prompt += `- Progression state: ${context.progressionState.currentState}\n`;
    prompt += `- Readiness for next state: ${context.progressionState.readinessForNextState}%\n`;
    
    if (context.providerFreshness.staleProviders.length > 0) {
      prompt += `\nIMPORTANT: Some data providers are stale: ${context.providerFreshness.staleProviders.join(', ')}\n`;
      prompt += `This may reduce confidence in certain metrics.\n`;
    }
    
    prompt += `\nRESPONSE GUIDELINES:\n`;
    prompt += `- Be concise and direct\n`;
    prompt += `- Reference specific evidence from context\n`;
    prompt += `- Explain technical reasoning clearly\n`;
    prompt += `- If confidence is low, acknowledge uncertainty\n`;
    prompt += `- Focus on engineering progression, not motivation\n`;
    
    return prompt;
  }

  /**
   * Construct user prompt
   */
  private constructUserPrompt(
    question: string,
    context: ReadinessContext,
    conversationHistory?: ConversationMessage[]
  ): string {
    let prompt = `Question: ${question}\n\n`;
    
    prompt += `RELEVANT CONTEXT:\n`;
    
    // Add evidence chains
    prompt += `\nEvidence Chains:\n`;
    context.evidenceChains.forEach(chain => {
      prompt += `- ${chain.component}: ${chain.evidence.join(', ')} (confidence: ${chain.confidence}%)\n`;
    });
    
    // Add roadmap gaps if relevant
    if (context.roadmapGaps.length > 0) {
      prompt += `\nRoadmap Gaps:\n`;
      context.roadmapGaps.slice(0, 5).forEach(gap => {
        prompt += `- ${gap.nodeName}: ${gap.description} (severity: ${gap.severity})\n`;
      });
    }
    
    // Add progression requirements
    if (context.progressionState.requirements.length > 0) {
      prompt += `\nProgression Requirements:\n`;
      context.progressionState.requirements.slice(0, 5).forEach(req => {
        prompt += `- ${req}\n`;
      });
    }
    
    // Add top recommendations
    if (context.recommendations.length > 0) {
      prompt += `\nTop Recommendations:\n`;
      context.recommendations.slice(0, 3).forEach(rec => {
        prompt += `- ${rec.title} (${rec.type}, priority: ${rec.priority}, confidence: ${rec.confidence}%)\n`;
        prompt += `  Reasoning: ${rec.reasoning}\n`;
      });
    }
    
    // Add momentum insights
    if (context.momentumSignals.insights.length > 0) {
      prompt += `\nMomentum Insights:\n`;
      context.momentumSignals.insights.slice(0, 3).forEach(insight => {
        prompt += `- ${insight}\n`;
      });
    }
    
    // Add conversation history if provided
    if (conversationHistory && conversationHistory.length > 0) {
      prompt += `\nConversation History:\n`;
      conversationHistory.slice(-5).forEach(msg => {
        prompt += `${msg.role}: ${msg.content}\n`;
      });
    }
    
    prompt += `\nPlease provide a technical, evidence-backed explanation based on the deterministic context above.`;
    
    return prompt;
  }

  /**
   * Calculate confidence based on context quality
   */
  private calculateConfidence(context: ReadinessContext): number {
    let confidence = context.readinessSummary.confidenceScore;
    
    // Reduce confidence if providers are stale
    if (context.providerFreshness.staleProviders.length > 0) {
      confidence -= 20;
    }
    
    // Reduce confidence if evidence coverage is low
    if (context.readinessSummary.evidenceCoverage < 50) {
      confidence -= 15;
    }
    
    // Ensure confidence stays within bounds
    return Math.max(0, Math.min(100, confidence));
  }

  /**
   * Clear all conversation history
   */
  clearAllHistory(): void {
    this.conversationHistory.clear();
    logger.info('[AIConversationService] All conversation history cleared');
  }
}

export const AIConversationService = new AIConversationServiceClass();
