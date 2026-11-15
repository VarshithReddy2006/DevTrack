// src/modules/ai/provider/LLMGateway.ts — Centralized LLM Gateway
// Implements G7 centralized gateway, G8 heuristic fallback, prompt-hash caching, and daily quotas.

import crypto from 'crypto';
import { getRedisClient, isRedisConfigured } from '../../../shared/redis/client.js';
import { logger } from '../../../shared/logger.js';
import { AIResponseAuditLog } from '../../../db/models/aiResponseAuditLog.model.js';
import { quotaService, AIQuotaExceededError } from '../quota.service.js';
import { AIProviderAdapter, type AIRequest } from './AIProviderAdapter.js';

export interface LLMCompletionRequest {
  userId: string;
  prompt: string;
  systemPrompt?: string;
  feature?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  preferredProvider?: 'gemini' | 'openai';
  bypassCache?: boolean;
  heuristicFallback?: (prompt: string, systemPrompt?: string) => string;
}

export interface LLMCompletionResponse {
  content: string;
  model: string;
  provider: string;
  tokensUsed: number;
  latencyMs: number;
  cached: boolean;
  cacheHit: boolean;
  cost: number;
  fallbackTriggered: boolean;
  promptHash: string;
}

export class LLMGateway {
  private readonly defaultTtlSeconds = 24 * 60 * 60; // 24 hours

  /**
   * Generates a deterministic SHA-256 hash for prompt deduplication caching.
   */
  computePromptHash(model: string, systemPrompt: string | undefined, prompt: string): string {
    const normalizedPrompt = prompt.trim();
    const normalizedSystem = (systemPrompt || '').trim();
    return crypto
      .createHash('sha256')
      .update(`${model}:${normalizedSystem}:${normalizedPrompt}`)
      .digest('hex');
  }

  /**
   * Calculates estimated inference cost based on model and token usage.
   */
  estimateCost(provider: string, tokensUsed: number): number {
    if (provider === 'gemini') {
      // ~$0.00015 per 1,000 tokens
      return Number(((tokensUsed / 1000) * 0.00015).toFixed(6));
    }
    if (provider === 'openai') {
      // ~$0.00030 per 1,000 tokens
      return Number(((tokensUsed / 1000) * 0.00030).toFixed(6));
    }
    return 0; // heuristic fallback is zero cost
  }

  /**
   * Main completion entry point enforcing quota, cache, and provider fallback chain.
   */
  async generateCompletion(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const startTime = Date.now();
    const {
      userId,
      prompt,
      systemPrompt,
      feature = 'general',
      temperature = 0.7,
      maxTokens = 1000,
      bypassCache = false,
      heuristicFallback,
    } = request;

    // 1. Quota Check & Consumption
    const quota = await quotaService.checkAndConsumeQuota(userId, feature);
    if (!quota.allowed) {
      throw new AIQuotaExceededError(feature, quota.limit, quota.used, quota.resetAt);
    }

    const preferredProvider = request.preferredProvider || 'gemini';
    const targetModel = request.model || (preferredProvider === 'gemini' ? 'gemini-1.5-flash' : 'gpt-4o-mini');
    const promptHash = this.computePromptHash(targetModel, systemPrompt, prompt);
    const cacheKey = `devtrack:ai:prompt_cache:${promptHash}`;

    // 2. Redis Prompt-Hash Cache Check
    if (!bypassCache && isRedisConfigured()) {
      try {
        const redis = getRedisClient();
        const cachedPayload = await redis.get(cacheKey);
        if (cachedPayload) {
          const parsed = JSON.parse(cachedPayload);
          const latencyMs = Math.max(1, Date.now() - startTime);

          // Audit cached response
          await this.auditLog({
            userId,
            promptHash,
            requestType: feature,
            model: parsed.model || targetModel,
            provider: parsed.provider || preferredProvider,
            latencyMs,
            tokensUsed: parsed.tokensUsed || 0,
            cost: 0,
            cached: true,
            cacheHit: true,
            fallbackTriggered: false,
            success: true,
          });

          return {
            content: parsed.content,
            model: parsed.model || targetModel,
            provider: parsed.provider || preferredProvider,
            tokensUsed: parsed.tokensUsed || 0,
            latencyMs,
            cached: true,
            cacheHit: true,
            cost: 0,
            fallbackTriggered: false,
            promptHash,
          };
        }
      } catch (err) {
        logger.warn('[LLMGateway] Prompt cache lookup error', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 3. Provider Chain Execution: Primary -> Fallback -> Heuristic
    let content = '';
    let selectedModel = targetModel;
    let selectedProvider: string = preferredProvider;
    let tokensUsed = 0;
    let fallbackTriggered = false;

    // Primary: Gemini
    try {
      const adapterReq: AIRequest = {
        prompt,
        systemPrompt,
        temperature,
        maxTokens,
        providerPreference: preferredProvider,
        tenantScope: userId,
        cache: false,
      };

      const res = await AIProviderAdapter.generateResponse(adapterReq);
      content = res.content;
      selectedModel = res.model;
      selectedProvider = res.provider;
      tokensUsed = res.tokensUsed;
      fallbackTriggered = res.fallbackTriggered;
    } catch (primaryErr) {
      logger.warn('[LLMGateway] Primary provider failed, attempting secondary provider', {
        provider: preferredProvider,
        error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
      });

      // Secondary Fallback: OpenAI (or Gemini if OpenAI was preferred)
      const secondaryProvider = preferredProvider === 'gemini' ? 'openai' : 'gemini';
      try {
        const adapterReq: AIRequest = {
          prompt,
          systemPrompt,
          temperature,
          maxTokens,
          providerPreference: secondaryProvider,
          tenantScope: userId,
          cache: false,
        };

        const res = await AIProviderAdapter.generateResponse(adapterReq);
        content = res.content;
        selectedModel = res.model;
        selectedProvider = res.provider;
        tokensUsed = res.tokensUsed;
        fallbackTriggered = true;
      } catch (secondaryErr) {
        logger.error('[LLMGateway] Secondary provider failed, triggering heuristic fallback', {
          provider: secondaryProvider,
          error: secondaryErr instanceof Error ? secondaryErr.message : String(secondaryErr),
        });

        // Heuristic Rule-Based Fallback (Guardrail G8)
        content = heuristicFallback
          ? heuristicFallback(prompt, systemPrompt)
          : this.defaultHeuristicFallback(prompt);
        selectedModel = 'heuristic-rule-engine';
        selectedProvider = 'heuristic';
        tokensUsed = 0;
        fallbackTriggered = true;
      }
    }

    const latencyMs = Math.max(1, Date.now() - startTime);
    const cost = this.estimateCost(selectedProvider, tokensUsed);

    // 4. Cache Response in Redis
    if (isRedisConfigured() && content) {
      try {
        const redis = getRedisClient();
        await redis.set(
          cacheKey,
          JSON.stringify({
            content,
            model: selectedModel,
            provider: selectedProvider,
            tokensUsed,
          }),
          'EX',
          this.defaultTtlSeconds
        );
      } catch (err) {
        logger.warn('[LLMGateway] Failed to save response to prompt cache', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 5. Audit Logging
    await this.auditLog({
      userId,
      promptHash,
      requestType: feature,
      model: selectedModel,
      provider: selectedProvider,
      latencyMs,
      tokensUsed,
      cost,
      cached: false,
      cacheHit: false,
      fallbackTriggered,
      success: true,
    });

    return {
      content,
      model: selectedModel,
      provider: selectedProvider,
      tokensUsed,
      latencyMs,
      cached: false,
      cacheHit: false,
      cost,
      fallbackTriggered,
      promptHash,
    };
  }

  /**
   * Deterministic rule-based heuristic output when all providers are unavailable.
   */
  private defaultHeuristicFallback(prompt: string): string {
    return `[Heuristic Fallback]: Analysis completed using offline rules for query: "${prompt.slice(0, 80)}..."`;
  }

  /**
   * Records execution details into AIResponseAuditLog.
   */
  private async auditLog(data: {
    userId: string;
    promptHash: string;
    requestType: string;
    model: string;
    provider: string;
    latencyMs: number;
    tokensUsed: number;
    cost: number;
    cached: boolean;
    cacheHit: boolean;
    fallbackTriggered: boolean;
    success: boolean;
  }): Promise<void> {
    try {
      await AIResponseAuditLog.create({
        userId: data.userId,
        promptHash: data.promptHash,
        requestType: data.requestType,
        model: data.model,
        provider: data.provider,
        latencyMs: data.latencyMs,
        tokensUsed: data.tokensUsed,
        cost: data.cost,
        cached: data.cached,
        cacheHit: data.cacheHit,
        fallbackTriggered: data.fallbackTriggered,
        success: data.success,
        moderationFlags: [],
        hallucinationFlags: [],
        safetyViolations: [],
      });
    } catch (err) {
      logger.warn('[LLMGateway] Failed to record AIResponseAuditLog', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const llmGateway = new LLMGateway();
