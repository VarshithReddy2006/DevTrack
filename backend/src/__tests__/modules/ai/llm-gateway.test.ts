// backend/src/__tests__/modules/ai/llm-gateway.test.ts
// Unit tests for LLMGateway, Redis prompt-hash caching, provider fallback chain, and QuotaService.

import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { Types } from 'mongoose';
import { AIResponseAuditLog } from '../../../db/models/aiResponseAuditLog.model.js';
import { User } from '../../../db/models/user.model.js';
import { LLMGateway, llmGateway } from '../../../modules/ai/provider/LLMGateway.js';
import { QuotaService, quotaService, AIQuotaExceededError } from '../../../modules/ai/quota.service.js';
import { AIProviderAdapter } from '../../../modules/ai/provider/AIProviderAdapter.js';
import { semanticCacheService } from '../../../shared/ai/semanticCache.service.js';
import { aiQuotaRoutes } from '../../../modules/ai/quota.routes.js';
import { errorHandler } from '../../../middleware/error.js';
import { quotaEval } from '../../fixtures/quotaRedis.js';

// In-memory Redis simulation for stateful quota and caching tests
const redisStore = new Map<string, string>();
const listStore = new Map<string, string[]>();

const mockRedis = {
  status: 'ready',
  get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  set: vi.fn(async (key: string, val: string) => {
    redisStore.set(key, String(val));
    return 'OK';
  }),
  mget: vi.fn(async (...keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
  lpush: vi.fn(async (key: string, ...values: string[]) => {
    const list = listStore.get(key) || [];
    list.unshift(...values);
    listStore.set(key, list);
    return list.length;
  }),
  lrange: vi.fn(async (key: string, start: number, stop: number) => {
    const list = listStore.get(key) || [];
    if (stop === -1) return list.slice(start);
    return list.slice(start, stop + 1);
  }),
  ltrim: vi.fn(async (key: string, start: number, stop: number) => {
    const list = listStore.get(key) || [];
    const trimmed = stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
    listStore.set(key, trimmed);
    return 'OK';
  }),
  incr: vi.fn(async (key: string) => {
    const curr = parseInt(redisStore.get(key) || '0', 10);
    const next = curr + 1;
    redisStore.set(key, String(next));
    return next;
  }),
  expire: vi.fn(async () => 1),
  eval: vi.fn(quotaEval(redisStore)),
  del: vi.fn(async (...keys: string[]) => {
    let count = 0;
    for (const k of keys) {
      if (redisStore.delete(k)) count++;
      if (listStore.delete(k)) count++;
    }
    return count;
  }),
  keys: vi.fn(async (pattern: string) => {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return Array.from(redisStore.keys()).filter((k) => regex.test(k));
  }),
  call: vi.fn(async () => []),
  send_command: vi.fn(async () => []),
};

vi.mock('../../../shared/redis/client.js', () => ({
  getRedisClient: () => mockRedis,
  isRedisConfigured: () => true,
  disconnectRedis: vi.fn(),
  getRedisHealth: () => ({ status: 'connected', host: '127.0.0.1', port: 6379, lastError: null, reconnectAttempts: 0 }),
}));

vi.mock('../../../shared/redis/index.js', () => ({
  getRedisClient: () => mockRedis,
  isRedisConfigured: () => true,
  disconnectRedis: vi.fn(),
  getRedisHealth: () => ({ status: 'connected', host: '127.0.0.1', port: 6379, lastError: null, reconnectAttempts: 0 }),
}));

const fixture = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('@clerk/backend', () => ({ verifyToken: fixture.verify }));
vi.mock('../../../services/auth/ClerkUserSyncService.js', () => ({ syncClerkUser: vi.fn() }));

describe('LLMGateway & QuotaService', () => {
  const userId = '000000000000000000000088';
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await Promise.all([User.init(), AIResponseAuditLog.init()]);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/ai', aiQuotaRoutes);
    app.use(errorHandler);

    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1');
      listener.once('error', reject);
      listener.once('listening', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/ai`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    listStore.clear();
    semanticCacheService.clearMemoryCache();
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_llm_gateway');
    fixture.verify.mockResolvedValue({ sub: 'clerk_llm_user' });

    await User.deleteMany({});
    await AIResponseAuditLog.deleteMany({});

    await User.create({
      _id: userId,
      clerkId: 'clerk_llm_user',
      username: 'llmtester',
      email: 'llm@example.test',
      displayName: 'LLM Tester',
      timezone: 'UTC',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('QuotaService', () => {
    it('tracks daily usage and enforces per-feature limits', async () => {
      const customQuota = new QuotaService({ test_feature: 3 });

      // Calls 1, 2, 3 should be permitted
      const res1 = await customQuota.checkAndConsumeQuota(userId, 'test_feature');
      expect(res1.allowed).toBe(true);
      expect(res1.used).toBe(1);
      expect(res1.remaining).toBe(2);

      const res2 = await customQuota.checkAndConsumeQuota(userId, 'test_feature');
      expect(res2.allowed).toBe(true);
      expect(res2.used).toBe(2);

      const res3 = await customQuota.checkAndConsumeQuota(userId, 'test_feature');
      expect(res3.allowed).toBe(true);
      expect(res3.used).toBe(3);
      expect(res3.remaining).toBe(0);

      // Call 4 is over the limit and must not bump the counter
      const res4 = await customQuota.checkAndConsumeQuota(userId, 'test_feature');
      expect(res4.allowed).toBe(false);
      expect(res4.used).toBe(3);
      expect(res4.remaining).toBe(0);

      const status = await customQuota.getQuotaStatus(userId, ['test_feature']);
      expect(status.test_feature.used).toBe(3);
    });

    it('returns structured quota status across features', async () => {
      await quotaService.checkAndConsumeQuota(userId, 'resume_rewrite');
      await quotaService.checkAndConsumeQuota(userId, 'resume_rewrite');

      const status = await quotaService.getQuotaStatus(userId, ['resume_rewrite', 'interview']);
      expect(status.resume_rewrite.used).toBe(2);
      expect(status.resume_rewrite.limit).toBe(20);
      expect(status.resume_rewrite.remaining).toBe(18);
      expect(status.interview.used).toBe(0);
      expect(status.interview.remaining).toBe(10);
    });

    it('GET /api/v1/ai/quota endpoint returns quota allowances for authenticated user', async () => {
      await quotaService.checkAndConsumeQuota(userId, 'explanation');

      const res = await fetch(`${baseUrl}/quota`, {
        headers: { Authorization: 'Bearer mock_token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.explanation.used).toBe(1);
      expect(body.data.explanation.limit).toBe(30);
    });
  });

  describe('LLMGateway - Prompt Hashing & Caching', () => {
    it('computes deterministic SHA-256 prompt hashes', () => {
      const gateway = new LLMGateway();
      const hash1 = gateway.computePromptHash('gemini-1.5-flash', 'You are an assistant', 'Explain QuickSort');
      const hash2 = gateway.computePromptHash('gemini-1.5-flash', 'You are an assistant', 'Explain QuickSort');
      const hash3 = gateway.computePromptHash('gemini-1.5-flash', 'You are an assistant', 'Explain MergeSort');

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1).toHaveLength(64);
    });

    it('returns cached response on duplicate prompt without calling AI provider', async () => {
      const generateSpy = vi.spyOn(AIProviderAdapter, 'generateResponse').mockResolvedValue({
        content: 'QuickSort is an efficient divide-and-conquer sorting algorithm.',
        model: 'gemini-1.5-flash',
        provider: 'gemini',
        tokensUsed: 42,
        latency: 120,
        cached: false,
        fallbackTriggered: false,
      });

      // First invocation: cache miss, calls provider
      const first = await llmGateway.generateCompletion({
        userId,
        prompt: 'Explain QuickSort in 1 sentence',
        feature: 'explanation',
      });

      expect(first.cached).toBe(false);
      expect(first.cacheHit).toBe(false);
      expect(first.content).toContain('QuickSort');
      expect(generateSpy).toHaveBeenCalledTimes(1);

      // Second invocation with identical prompt: hits Redis cache
      const second = await llmGateway.generateCompletion({
        userId,
        prompt: 'Explain QuickSort in 1 sentence',
        feature: 'explanation',
      });

      expect(second.cached).toBe(true);
      expect(second.cacheHit).toBe(true);
      expect(second.content).toContain('QuickSort');
      expect(generateSpy).toHaveBeenCalledTimes(1); // Provider NOT called a second time
    });

    it('bypasses cache when bypassCache flag is set', async () => {
      const generateSpy = vi.spyOn(AIProviderAdapter, 'generateResponse').mockResolvedValue({
        content: 'Fresh response from provider',
        model: 'gemini-1.5-flash',
        provider: 'gemini',
        tokensUsed: 25,
        latency: 90,
        cached: false,
        fallbackTriggered: false,
      });

      await llmGateway.generateCompletion({
        userId,
        prompt: 'Bypass cache test prompt',
        feature: 'general',
      });

      const second = await llmGateway.generateCompletion({
        userId,
        prompt: 'Bypass cache test prompt',
        feature: 'general',
        bypassCache: true,
      });

      expect(second.cached).toBe(false);
      expect(generateSpy).toHaveBeenCalledTimes(2);
    });

    it('returns semantic cache hit for paraphrased query with cosine similarity >= 0.95', async () => {
      const generateSpy = vi.spyOn(AIProviderAdapter, 'generateResponse').mockResolvedValue({
        content: 'Engineered serverless microservices with AWS Lambda, reducing latency by 45%.',
        model: 'gemini-1.5-flash',
        provider: 'gemini',
        tokensUsed: 30,
        latency: 120,
        cached: false,
        fallbackTriggered: false,
      });

      // Mock high similarity embedding for paraphrased prompts (>= 0.95)
      const embedding1 = [0.98, 0.05, 0.02, 0.01];
      const embedding2 = [0.97, 0.06, 0.02, 0.01];
      let embeddingCallCount = 0;
      vi.spyOn(semanticCacheService, 'generateEmbedding').mockImplementation(async () => {
        embeddingCallCount++;
        return embeddingCallCount === 1 ? embedding1 : embedding2;
      });

      // Query 1: Initial call
      const first = await llmGateway.generateCompletion({
        userId,
        prompt: 'Optimize my bullet point for AWS Lambda',
        feature: 'resume_rewrite',
      });

      expect(first.cached).toBe(false);
      expect(first.cacheHit).toBe(false);
      expect(generateSpy).toHaveBeenCalledTimes(1);

      // Query 2: Paraphrased query that shares high semantic similarity (cosine similarity >= 0.95)
      const second = await llmGateway.generateCompletion({
        userId,
        prompt: 'Optimize this bullet point for AWS Lambda serverless',
        feature: 'resume_rewrite',
      });

      // Semantic similarity hit, provider shouldn't be called again
      expect(second.cached).toBe(true);
      expect(second.cacheHit).toBe(true);
      expect(second.cacheType).toBe('SEMANTIC');
      expect(second.headers?.['X-Cache']).toBe('HIT-SEMANTIC');
      expect(second.content).toContain('Engineered serverless microservices');
      expect(generateSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('LLMGateway - Provider Fallback Chain (G7 & G8)', () => {
    it('falls back to OpenAI when primary Gemini provider fails', async () => {
      const generateSpy = vi.spyOn(AIProviderAdapter, 'generateResponse')
        .mockRejectedValueOnce(new Error('Gemini API 503 Service Unavailable'))
        .mockResolvedValueOnce({
          content: 'Response generated by OpenAI GPT-4o-mini fallback',
          model: 'gpt-4o-mini',
          provider: 'openai',
          tokensUsed: 35,
          latency: 210,
          cached: false,
          fallbackTriggered: true,
        });

      const res = await llmGateway.generateCompletion({
        userId,
        prompt: 'Review this resume bullet',
        feature: 'resume_rewrite',
        preferredProvider: 'gemini',
      });

      expect(generateSpy).toHaveBeenCalledTimes(2);
      expect(res.provider).toBe('openai');
      expect(res.model).toBe('gpt-4o-mini');
      expect(res.fallbackTriggered).toBe(true);
      expect(res.content).toContain('OpenAI');
    });

    it('falls back gracefully to deterministic heuristics (G8) when all providers fail', async () => {
      vi.spyOn(AIProviderAdapter, 'generateResponse')
        .mockRejectedValueOnce(new Error('Gemini connection timeout'))
        .mockRejectedValueOnce(new Error('OpenAI rate limit exceeded'));

      const res = await llmGateway.generateCompletion({
        userId,
        prompt: 'Analyze system architecture diagram',
        feature: 'general',
        heuristicFallback: (prompt) => `Rule-based fallback for: ${prompt}`,
      });

      expect(res.provider).toBe('heuristic');
      expect(res.model).toBe('heuristic-rule-engine');
      expect(res.fallbackTriggered).toBe(true);
      expect(res.content).toBe('Rule-based fallback for: Analyze system architecture diagram');
      expect(res.cost).toBe(0);
    });

    it('throws AIQuotaExceededError when user exceeds daily quota limit', async () => {
      const tightQuota = new QuotaService({ tight_feature: 1 });
      vi.spyOn(quotaService, 'checkAndConsumeQuota').mockImplementation((uid, feat) =>
        tightQuota.checkAndConsumeQuota(uid, feat)
      );

      vi.spyOn(AIProviderAdapter, 'generateResponse').mockResolvedValue({
        content: 'OK',
        model: 'gemini-1.5-flash',
        provider: 'gemini',
        tokensUsed: 10,
        latency: 50,
        cached: false,
        fallbackTriggered: false,
      });

      // Request 1 succeeds
      await llmGateway.generateCompletion({
        userId,
        prompt: 'Quota call 1',
        feature: 'tight_feature',
      });

      // Request 2 rejected with AIQuotaExceededError
      await expect(
        llmGateway.generateCompletion({
          userId,
          prompt: 'Quota call 2',
          feature: 'tight_feature',
        })
      ).rejects.toThrow(AIQuotaExceededError);
    });
  });

  describe('Audit Logging', () => {
    it('persists AIResponseAuditLog records with cost and promptHash', async () => {
      vi.spyOn(AIProviderAdapter, 'generateResponse').mockResolvedValue({
        content: 'Audited AI completion response',
        model: 'gemini-1.5-flash',
        provider: 'gemini',
        tokensUsed: 1000,
        latency: 150,
        cached: false,
        fallbackTriggered: false,
      });

      const res = await llmGateway.generateCompletion({
        userId,
        prompt: 'Generate system architecture audit',
        feature: 'roadmap',
      });

      expect(res.cost).toBeGreaterThan(0);

      // Verify MongoDB document
      const auditLog = await AIResponseAuditLog.findOne({ userId, promptHash: res.promptHash });
      expect(auditLog).not.toBeNull();
      expect(auditLog?.provider).toBe('gemini');
      expect(auditLog?.model).toBe('gemini-1.5-flash');
      expect(auditLog?.tokensUsed).toBe(1000);
      expect(auditLog?.cost).toBe(0.00015);
      expect(auditLog?.cacheHit).toBe(false);
    });
  });
});
