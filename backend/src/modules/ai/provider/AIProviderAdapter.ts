import { logger } from '../../../shared/logger.js';
import { getRedisClient } from '../../../shared/redis/index.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CircuitBreaker, CircuitOpenError } from '../../../shared/circuit-breaker/circuitBreaker.js';
import { AIResponseAuditLog } from '../audit/AIResponseAuditLog.js';
import type { AIAuditErrorCode } from '../../../db/models/aiResponseAuditLog.model.js';
import { AICacheManager } from '../cache/AICacheManager.js';
import { AIStreamInterruptedError } from './AIStreamInterruptedError.js';

export type AIProvider = 'openai' | 'gemini';
export interface AIRequest {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  providerPreference?: AIProvider;
  responseSchemaVersion?: string;
  tenantScope?: string;
  cache?: boolean;
}

type EffectiveAIRequest = AIRequest & { model: string; temperature: number; maxTokens: number };

export interface AIResponse {
  content: string;
  model: string;
  provider: AIProvider;
  tokensUsed: number;
  latency: number;
  cached: boolean;
  fallbackTriggered: boolean;
}

/** One increment of a streamed completion, or the final summary once the stream has ended. */
export type AIStreamEvent =
  | { type: 'delta'; delta: string }
  | { type: 'done'; response: AIResponse };

export interface AIStreamOptions {
  /** Aborts the provider call; the stream then ends with an AbortError. */
  signal?: AbortSignal;
}

export interface ProviderHealth {
  provider: AIProvider;
  status: 'healthy' | 'degraded' | 'down';
  lastCheck: Date;
  lastSuccess: Date | null;
  failureCount: number;
  avgLatency: number;
  rateLimitRemaining: number;
}

export interface TokenUsage {
  provider: AIProvider;
  model: string;
  tokens: number;
  timestamp: Date;
}

const defaultModels: Record<AIProvider, string> = { openai: 'gpt-4o-mini', gemini: 'gemini-1.5-flash' };
const providerTimeoutMs = 15_000;
/** A streamed reply may outlive the 15s request timeout, but never indefinitely. */
const streamMaxDurationMs = 90_000;

class ProviderConfigurationError extends Error {}

class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`Provider HTTP error: ${status}`);
  }
}

function isRetryableStreamError(error: unknown): boolean {
  if (error instanceof ProviderConfigurationError) return false;
  if (error instanceof Error && error.name === 'AbortError') return false;
  // A 4xx means the request itself is wrong; only rate limits are worth another attempt.
  if (error instanceof ProviderHttpError) return error.status === 429 || error.status >= 500;
  return true;
}

function auditErrorCode(error: unknown): AIAuditErrorCode {
  if (error instanceof CircuitOpenError) return 'provider_circuit_open';
  if (error instanceof ProviderConfigurationError) return 'provider_not_configured';
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'provider_timeout';
  }
  if (error instanceof Error && 'status' in error && error.status === 429) {
    return 'provider_rate_limited';
  }
  return 'provider_error';
}

function providerCircuit(provider: AIProvider): CircuitBreaker {
  return new CircuitBreaker({
    name: `ai-${provider}`,
    failureThreshold: 5,
    resetTimeoutMs: 60_000,
    resetJitterMs: 5_000,
    successThreshold: 1,
  });
}

class AIProviderAdapterClass {
  private readonly circuits = { openai: providerCircuit('openai'), gemini: providerCircuit('gemini') };
  private providerHealth: Map<AIProvider, ProviderHealth> = new Map();
  private tokenUsage: TokenUsage[] = [];
  private currentProvider: AIProvider = 'openai';
  private maxRetries: number = 3;
  private retryDelay: number = 1000; // ms
  private cacheTTL: number = 60 * 60 * 1000; // 1 hour for general AI responses

  constructor() {
    this.initializeProviderHealth();
  }

  /**
   * Initialize provider health tracking
   */
  private initializeProviderHealth(): void {
    const now = new Date();
    
    this.providerHealth.set('openai', {
      provider: 'openai',
      status: 'healthy',
      lastCheck: now,
      lastSuccess: null,
      failureCount: 0,
      avgLatency: 0,
      rateLimitRemaining: 100000,
    });
    
    this.providerHealth.set('gemini', {
      provider: 'gemini',
      status: 'healthy',
      lastCheck: now,
      lastSuccess: null,
      failureCount: 0,
      avgLatency: 0,
      rateLimitRemaining: 100000,
    });  }

  /**
   * Generate AI response with provider abstraction
   */
  async generateResponse(request: AIRequest): Promise<AIResponse> {
    const primary = request.providerPreference ?? this.currentProvider;
    const chain: AIProvider[] = [primary, primary === 'openai' ? 'gemini' : 'openai'];
    const startTime = Date.now();
    let lastFailure: { provider: AIProvider; model: string; errorCode: AIAuditErrorCode } | undefined;
    const audit = (outcome: {
      provider: AIProvider; model: string; tokensUsed: number; cached: boolean; success: boolean; errorCode?: AIAuditErrorCode;
    }) => {
      void AIResponseAuditLog.log({
        ...outcome,
        userId: request.tenantScope || 'unscoped',
        requestType: 'provider-generation',
        latency: Date.now() - startTime,
        contextVersion: request.responseSchemaVersion ?? '',
        responseConfidence: 0,
        moderationFlags: [],
        hallucinationFlags: [],
        safetyViolations: [],
      });
    };

    for (const provider of chain) {
      const fallbackTriggered = provider !== primary;
      const effectiveRequest = {
        ...request,
        model: (!fallbackTriggered && request.model) || defaultModels[provider],
        temperature: request.temperature ?? 0.7,
        maxTokens: request.maxTokens ?? 1000,
      };
      const cacheKey = request.cache === false ? null : AICacheManager.generatePromptKey({
        ...effectiveRequest,
        provider,
        userPrompt: request.prompt,
        responseFormat: provider === 'gemini' ? 'application/json' : 'text/plain',
      });
      const cached = cacheKey && await this.getFromCache(cacheKey);
      if (cached) {
        audit({ provider, model: cached.model, tokensUsed: 0, cached: true, success: true });
        return { ...cached, cached: true, fallbackTriggered };
      }

      try {
        const response = await this.generateWithRetry(provider, effectiveRequest);
        const latency = Date.now() - startTime;
        this.updateProviderHealth(provider, true, latency);
        this.trackTokenUsage(provider, response.model, response.tokensUsed);
        if (cacheKey) await this.setCache(cacheKey, { ...response, latency, cached: true, fallbackTriggered });
        audit({ provider, model: response.model, tokensUsed: response.tokensUsed, cached: false, success: true });
        return { ...response, latency, cached: false, fallbackTriggered };
      } catch (error) {
        const errorCode = auditErrorCode(error);
        lastFailure = { provider, model: effectiveRequest.model, errorCode };
        if (!(error instanceof CircuitOpenError)) {
          this.updateProviderHealth(provider, false, 0);
          logger.error('[AIProviderAdapter] Provider failed', { provider, errorCode });
        }
      }
    }

    // All providers failed
    if (lastFailure) audit({ ...lastFailure, tokensUsed: 0, cached: false, success: false });
    logger.error('[AIProviderAdapter] All providers failed', { errorCode: lastFailure?.errorCode });
    throw new Error(`All AI providers failed. Last error: ${lastFailure?.errorCode ?? 'provider_error'}`);
  }

  /**
   * Stream an AI response as text deltas, then a final `done` event with the usual AIResponse.
   *
   * Uses the same primary -> secondary provider order, models, API keys and circuit breakers
   * as generateResponse. Differences that come from streaming itself:
   * - Failover and retries only happen before the first delta. After that the caller already
   *   holds part of the text, so a failure surfaces as AIStreamInterruptedError.
   * - The circuit breaker guards opening the stream and receiving its first delta; a drop later
   *   in the stream is not counted against the provider.
   * - There is no response cache here (the LLMGateway owns prompt-hash caching).
   */
  async *streamResponse(request: AIRequest, options: AIStreamOptions = {}): AsyncGenerator<AIStreamEvent> {
    const primary = request.providerPreference ?? this.currentProvider;
    const chain: AIProvider[] = [primary, primary === 'openai' ? 'gemini' : 'openai'];
    const startTime = Date.now();
    let lastFailure: { provider: AIProvider; model: string; errorCode: AIAuditErrorCode } | undefined;
    const audit = (outcome: {
      provider: AIProvider; model: string; tokensUsed: number; success: boolean; errorCode?: AIAuditErrorCode;
    }) => {
      void AIResponseAuditLog.log({
        ...outcome,
        cached: false,
        userId: request.tenantScope || 'unscoped',
        requestType: 'provider-stream',
        latency: Date.now() - startTime,
        contextVersion: request.responseSchemaVersion ?? '',
        responseConfidence: 0,
        moderationFlags: [],
        hallucinationFlags: [],
        safetyViolations: [],
      });
    };

    for (const provider of chain) {
      const fallbackTriggered = provider !== primary;
      const effectiveRequest: EffectiveAIRequest = {
        ...request,
        model: (!fallbackTriggered && request.model) || defaultModels[provider],
        temperature: request.temperature ?? 0.7,
        maxTokens: request.maxTokens ?? 1000,
      };
      let content = '';
      try {
        const stream = this.streamWithRetry(provider, effectiveRequest, options.signal);
        let step = await stream.next();
        while (!step.done) {
          content += step.value;
          yield { type: 'delta', delta: step.value };
          step = await stream.next();
        }
        const latency = Date.now() - startTime;
        const tokensUsed = step.value;
        this.updateProviderHealth(provider, true, latency);
        this.trackTokenUsage(provider, effectiveRequest.model, tokensUsed);
        audit({ provider, model: effectiveRequest.model, tokensUsed, success: true });
        yield {
          type: 'done',
          response: {
            content, model: effectiveRequest.model, provider, tokensUsed, latency, cached: false, fallbackTriggered,
          },
        };
        return;
      } catch (error) {
        const errorCode = auditErrorCode(error);
        if (!(error instanceof CircuitOpenError)) {
          this.updateProviderHealth(provider, false, 0);
          logger.error('[AIProviderAdapter] Provider stream failed', { provider, errorCode });
        }
        if (content) {
          audit({ provider, model: effectiveRequest.model, tokensUsed: 0, success: false, errorCode });
          throw new AIStreamInterruptedError(provider, content, error);
        }
        if (options.signal?.aborted) throw error;
        lastFailure = { provider, model: effectiveRequest.model, errorCode };
      }
    }

    if (lastFailure) audit({ ...lastFailure, tokensUsed: 0, success: false });
    logger.error('[AIProviderAdapter] All providers failed to stream', { errorCode: lastFailure?.errorCode });
    throw new Error(`All AI providers failed. Last error: ${lastFailure?.errorCode ?? 'provider_error'}`);
  }

  /**
   * Open a provider stream behind the circuit breaker and retry the connection (not the body).
   * Returns the token count once the stream has been fully relayed.
   */
  private async *streamWithRetry(
    provider: AIProvider, request: EffectiveAIRequest, signal?: AbortSignal,
  ): AsyncGenerator<string, number> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      let probing = false;
      let opened: { iterator: AsyncGenerator<string, number>; first: IteratorResult<string, number> };
      try {
        opened = await this.circuits[provider].execute(async state => {
          probing = state === 'half_open';
          const iterator = this.streamProvider(provider, request, signal);
          const first = await iterator.next();
          if (first.done) throw new Error('Provider stream ended without content');
          return { iterator, first };
        });
      } catch (error) {
        if (probing || error instanceof CircuitOpenError || !isRetryableStreamError(error)) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        if (this.circuits[provider].getState() === 'open') throw lastError;

        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * attempt;
          logger.info('[AIProviderAdapter] Retrying stream', { provider, attempt, delay });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        continue;
      }

      let step = opened.first;
      while (!step.done) {
        yield step.value;
        step = await opened.iterator.next();
      }
      return step.value;
    }

    throw lastError || new Error('Unknown error in streamWithRetry');
  }

  /** Call one provider's streaming endpoint. Yields text deltas, returns the total token count. */
  private streamProvider(
    provider: AIProvider, request: EffectiveAIRequest, signal?: AbortSignal,
  ): AsyncGenerator<string, number> {
    switch (provider) {
      case 'openai':
        return this.streamOpenAI(request, signal);
      case 'gemini':
        return this.streamGemini(request, signal);
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  private async *streamOpenAI(request: EffectiveAIRequest, signal?: AbortSignal): AsyncGenerator<string, number> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.startsWith('sk-or-')) {
      throw new ProviderConfigurationError('OpenAI is not configured');
    }

    const messages = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });

    // The request timeout only covers getting a response; the whole stream has its own cap.
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const connectTimer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), providerTimeoutMs);
    const maxTimer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), streamMaxDurationMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: request.model,
          messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      clearTimeout(connectTimer);

      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw res.ok ? new Error('OpenAI returned an empty stream body') : new ProviderHttpError(res.status);
      }

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let totalTokens = 0;

      // Each SSE event is a `data: {json}` line; blank lines and comments are skipped.
      const readLine = (line: string): string | undefined => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return undefined;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return undefined;
        let parsed: { choices?: { delta?: { content?: unknown } }[]; usage?: { total_tokens?: number } };
        try { parsed = JSON.parse(data); } catch { return undefined; }
        if (parsed.usage?.total_tokens) totalTokens = parsed.usage.total_tokens;
        const delta = parsed.choices?.[0]?.delta?.content;
        return typeof delta === 'string' && delta ? delta : undefined;
      };

      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop() ?? '';
        for (const line of lines) {
          const delta = readLine(line);
          if (delta) { content += delta; yield delta; }
        }
        if (done) break;
      }

      return totalTokens || this.estimateTokens(request.prompt + content);
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(maxTimer);
      signal?.removeEventListener('abort', forwardAbort);
      await reader?.cancel().catch(() => {});
    }
  }

  private async *streamGemini(request: EffectiveAIRequest, signal?: AbortSignal): AsyncGenerator<string, number> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'dummy_key_for_dev') {
      throw new ProviderConfigurationError('Gemini is not configured');
    }

    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: request.model,
      systemInstruction: request.systemPrompt ? { parts: [{ text: request.systemPrompt }], role: 'system' } : undefined,
    });
    const result = await model.generateContentStream({
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      // Streamed replies are prose, unlike the JSON mime type generateResponse asks for.
      generationConfig: { temperature: request.temperature, maxOutputTokens: request.maxTokens },
    }, { timeout: providerTimeoutMs, signal });

    let content = '';
    for await (const chunk of result.stream) {
      const delta = chunk.text();
      if (delta) { content += delta; yield delta; }
    }
    const final = await result.response;
    return final.usageMetadata?.totalTokenCount || this.estimateTokens(request.prompt + content);
  }

  /**
   * Generate with retry logic
   */
  private async generateWithRetry(provider: AIProvider, request: EffectiveAIRequest): Promise<Omit<AIResponse, 'latency' | 'cached' | 'fallbackTriggered'>> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      let probing = false;
      try {
        return await this.circuits[provider].execute(state => {
          probing = state === 'half_open';
          return this.callProvider(provider, request);
        });
      } catch (error) {
        if (probing || error instanceof CircuitOpenError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        if (this.circuits[provider].getState() === 'open') throw lastError;
        
        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * attempt;
          logger.info('[AIProviderAdapter] Retrying', { provider, attempt, delay });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError || new Error('Unknown error in generateWithRetry');
  }

  /**
   * Call specific provider
   */
  private async callProvider(provider: AIProvider, request: EffectiveAIRequest): Promise<Omit<AIResponse, 'latency' | 'cached' | 'fallbackTriggered'>> {
    switch (provider) {
      case 'openai':
        return this.callOpenAI(request);
      case 'gemini':
        return this.callGemini(request);
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  /**
   * Call OpenAI API
   */
  private async callOpenAI(request: EffectiveAIRequest): Promise<Omit<AIResponse, 'latency' | 'cached' | 'fallbackTriggered'>> {
    const model = request.model;
    const apiKey = process.env.OPENAI_API_KEY;
    
    if (!apiKey || apiKey.startsWith('sk-or-')) {
      throw new ProviderConfigurationError('OpenAI is not configured');
    }

    const messages = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.prompt });

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(providerTimeoutMs),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens
      })
    });

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderHttpError(res.status);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const tokensUsed = data.usage?.total_tokens || this.estimateTokens(request.prompt + content);
    
    return {
      content,
      model,
      provider: 'openai',
      tokensUsed,
    };
  }

  /**
   * Call Gemini API
   */
  private async callGemini(request: EffectiveAIRequest): Promise<Omit<AIResponse, 'latency' | 'cached' | 'fallbackTriggered'>> {
    const modelName = request.model;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey || apiKey === 'dummy_key_for_dev') {
      throw new ProviderConfigurationError('Gemini is not configured');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: request.systemPrompt ? { parts: [{ text: request.systemPrompt }], role: 'system' } : undefined
    });

    const generationConfig = {
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
      responseMimeType: "application/json",
    };

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      generationConfig
    }, { timeout: providerTimeoutMs });

    const content = result.response.text();
    const tokensUsed = result.response.usageMetadata?.totalTokenCount || this.estimateTokens(request.prompt + content);

    return {
      content,
      model: modelName,
      provider: 'gemini',
      tokensUsed,
    };
  }

  /**
   * Estimate token count (rough approximation)
   */
  private estimateTokens(text: string): number {
    // Rough approximation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Update provider health
   */
  private updateProviderHealth(provider: AIProvider, success: boolean, latency: number): void {
    const health = this.providerHealth.get(provider);
    if (!health) return;

    health.lastCheck = new Date();
    
    if (success) {
      health.lastSuccess = new Date();
      health.avgLatency = (health.avgLatency * 0.9) + (latency * 0.1);
    }
  }

  /**
   * Track token usage
   */
  private trackTokenUsage(provider: AIProvider, model: string, tokens: number): void {
    const usage: TokenUsage = {
      provider,
      model,
      tokens,
      timestamp: new Date(),
    };

    this.tokenUsage.push(usage);
    
    // Keep only last 1000 entries
    if (this.tokenUsage.length > 1000) {
      this.tokenUsage = this.tokenUsage.slice(-1000);
    }
  }

  /**
   * Get provider health
   */
  getProviderHealth(provider: AIProvider): ProviderHealth | undefined {
    const health = this.providerHealth.get(provider);
    if (!health) return undefined;
    const { state, failureCount } = this.circuits[provider].getMetrics();
    const status = state === 'open' ? 'down' : state === 'half_open' || failureCount >= 3 ? 'degraded' : 'healthy';
    return { ...health, failureCount, status };
  }

  /**
   * Get all provider health
   */
  getAllProviderHealth(): ProviderHealth[] {
    return Array.from(this.providerHealth.keys(), provider => this.getProviderHealth(provider)!);
  }

  /**
   * Get current provider
   */
  getCurrentProvider(): AIProvider {
    return this.currentProvider;
  }

  /**
   * Set current provider
   */
  setCurrentProvider(provider: AIProvider): void {
    this.currentProvider = provider;
    logger.info('[AIProviderAdapter] Current provider changed', { provider });
  }

  /**
   * Get token usage statistics
   */
  getTokenUsageStats(): {
    totalTokens: number;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
  } {
    const totalTokens = this.tokenUsage.reduce((sum, u) => sum + u.tokens, 0);
    
    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    
    this.tokenUsage.forEach(usage => {
      byProvider[usage.provider] = (byProvider[usage.provider] || 0) + usage.tokens;
      byModel[usage.model] = (byModel[usage.model] || 0) + usage.tokens;
    });
    
    return {
      totalTokens,
      byProvider,
      byModel,
    };
  }

  /**
   * Cache operations
   */
  private async getFromCache(key: string): Promise<AIResponse | null> {
    try {
      const redis = getRedisClient();
      if (redis.status !== 'ready') {
        logger.warn('[AIProviderAdapter] Redis not ready, skipping cache get');
        return null;
      }
      const cached = await redis.get(`ai:cache:v2:${key}`);
      if (!cached) return null;
      return JSON.parse(cached) as AIResponse;
    } catch (err) {
      logger.warn('[AIProviderAdapter] Redis cache get failed', { err });
      return null;
    }
  }

  private async setCache(key: string, response: AIResponse): Promise<void> {
    try {
      const redis = getRedisClient();
      if (redis.status !== 'ready') {
        return;
      }
      await redis.set(`ai:cache:v2:${key}`, JSON.stringify(response), 'EX', Math.floor(this.cacheTTL / 1000));
    } catch (err) {
      logger.warn('[AIProviderAdapter] Redis cache set failed', { err });
    }
  }

  /**
   * Clear cache
   */
  async clearCache(): Promise<void> {
    try {
      const redis = getRedisClient();
      if (redis.status !== 'ready') {
        return;
      }
      const keys = await redis.keys('ai:cache:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      logger.info('[AIProviderAdapter] Cache cleared');
    } catch (err) {
      logger.warn('[AIProviderAdapter] Redis cache clear failed', { err });
    }
  }

  /**
   * Clear all data (for testing)
   */
  async clear(): Promise<void> {
    await this.clearCache();
    this.tokenUsage = [];
    for (const circuit of Object.values(this.circuits)) circuit.reset();
    this.initializeProviderHealth();
    logger.info('[AIProviderAdapter] All data cleared');
  }
}

export const AIProviderAdapter = new AIProviderAdapterClass();
