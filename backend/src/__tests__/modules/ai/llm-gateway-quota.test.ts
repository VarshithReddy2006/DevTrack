// LLMGateway only spends AI quota on a real provider call (issue #718): exact and semantic
// cache hits are free (even with the quota spent), a miss uses one unit, and the heuristic
// fallback gives that unit back.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import env from '../../../config/env.js';
import { AIProviderAdapter, type AIStreamEvent } from '../../../modules/ai/provider/AIProviderAdapter.js';
import { AIStreamInterruptedError } from '../../../modules/ai/provider/AIStreamInterruptedError.js';
import { LLMGateway, type LLMStreamEvent } from '../../../modules/ai/provider/LLMGateway.js';
import { AIQuotaExceededError, quotaService, type QuotaCheckResult } from '../../../modules/ai/quota.service.js';
import { semanticCacheService } from '../../../shared/ai/semanticCache.service.js';

const mocks = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('../../../shared/redis/client.js', () => ({
  getRedisClient: () => ({ get: mocks.get, set: mocks.set }),
  isRedisConfigured: () => true,
}));
// Keep the audit log off MongoDB; these tests only look at quota and cache behaviour.
vi.mock('../../../db/models/aiResponseAuditLog.model.js', () => ({
  AIResponseAuditLog: { create: vi.fn() },
}));
vi.mock('../../../modules/ai/provider/AIProviderAdapter.js', () => ({
  AIProviderAdapter: { generateResponse: vi.fn(), streamResponse: vi.fn() },
}));

const userId = '000000000000000000000718';
const feature = 'explanation';
const resetAt = new Date('2026-11-28T00:00:00.000Z');
const quota = { used: 0, limit: 3 };

const generate = vi.mocked(AIProviderAdapter.generateResponse);
const stream = vi.mocked(AIProviderAdapter.streamResponse);
const gateway = new LLMGateway();
const originalSemanticFlag = env.SEMANTIC_CACHE_ENABLED;

function providerReply(content = 'Provider answer') {
  generate.mockResolvedValue({
    content, model: 'gemini-1.5-flash', provider: 'gemini', tokensUsed: 20, latency: 5, cached: false, fallbackTriggered: false,
  });
}

function providerStream(deltas: string[], failAfter?: unknown) {
  stream.mockImplementation(async function* (): AsyncGenerator<AIStreamEvent> {
    for (const delta of deltas) yield { type: 'delta', delta };
    if (failAfter) throw failAfter;
    yield {
      type: 'done',
      response: {
        content: deltas.join(''), model: 'gemini-1.5-flash', provider: 'gemini', tokensUsed: 20,
        latency: 5, cached: false, fallbackTriggered: false,
      },
    };
  });
}

function semanticHit(completion: string) {
  vi.mocked(semanticCacheService.findSimilar).mockResolvedValueOnce({
    hit: true,
    similarity: 0.97,
    latencyMs: 1,
    entry: {
      id: 'entry-1', topicScope: feature, prompt: 'an earlier prompt', completion, embedding: [],
      model: 'gemini-1.5-flash', provider: 'gemini', tokensUsed: 20, createdAt: Date.now(), ttlSeconds: 60,
    },
  });
}

async function drain(gen: AsyncGenerator<LLMStreamEvent>) {
  const events: LLMStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events.find((e): e is Extract<LLMStreamEvent, { type: 'done' }> => e.type === 'done')?.response;
}

const complete = (prompt = 'Explain binary search') => gateway.generateCompletion({ userId, prompt, feature });
const streamed = (prompt = 'Explain binary search') => gateway.streamCompletion({ userId, prompt, feature });

describe('LLMGateway quota accounting', () => {
  let consume: MockInstance<typeof quotaService.checkAndConsumeQuota>;
  let refund: MockInstance<typeof quotaService.refundQuota>;

  beforeEach(() => {
    vi.clearAllMocks();
    generate.mockReset();
    stream.mockReset();
    mocks.cache.clear();
    mocks.get.mockImplementation(async (key: string) => mocks.cache.get(key) ?? null);
    mocks.set.mockImplementation(async (key: string, value: string) => { mocks.cache.set(key, value); return 'OK'; });
    env.SEMANTIC_CACHE_ENABLED = true;
    vi.spyOn(semanticCacheService, 'findSimilar').mockResolvedValue({ hit: false, similarity: 0, latencyMs: 1 });
    vi.spyOn(semanticCacheService, 'set').mockResolvedValue(undefined);

    // In-memory daily counter standing in for QuotaService.
    quota.used = 0;
    consume = vi.spyOn(quotaService, 'checkAndConsumeQuota').mockImplementation(async (): Promise<QuotaCheckResult> => {
      if (quota.used >= quota.limit) {
        return { allowed: false, used: quota.limit, remaining: 0, limit: quota.limit, resetAt };
      }
      quota.used += 1;
      return { allowed: true, used: quota.used, remaining: quota.limit - quota.used, limit: quota.limit, resetAt };
    });
    refund = vi.spyOn(quotaService, 'refundQuota').mockImplementation(async () => {
      quota.used = Math.max(0, quota.used - 1);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.SEMANTIC_CACHE_ENABLED = originalSemanticFlag;
  });

  describe('generateCompletion', () => {
    it('uses one unit on a miss and none when the same prompt comes back from the exact cache', async () => {
      providerReply();

      const first = await complete();
      expect(first.cacheHit).toBe(false);
      expect(quota.used).toBe(1);

      const second = await complete();

      expect(second).toMatchObject({ cacheHit: true, cacheType: 'EXACT', content: 'Provider answer' });
      expect(consume).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(quota.used).toBe(1);
    });

    it('serves a semantic hit without touching the quota', async () => {
      semanticHit('Cached semantic answer');

      const res = await complete();

      expect(res).toMatchObject({ cacheHit: true, cacheType: 'SEMANTIC', content: 'Cached semantic answer' });
      expect(consume).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(quota.used).toBe(0);
    });

    it('checks both caches before it takes the unit, and takes it before the provider call', async () => {
      providerReply();

      await complete();

      const [cacheRead] = mocks.get.mock.invocationCallOrder;
      const [semanticRead] = vi.mocked(semanticCacheService.findSimilar).mock.invocationCallOrder;
      const [quotaTaken] = consume.mock.invocationCallOrder;
      const [providerCall] = generate.mock.invocationCallOrder;
      expect(cacheRead).toBeLessThan(semanticRead);
      expect(semanticRead).toBeLessThan(quotaTaken);
      expect(quotaTaken).toBeLessThan(providerCall);
    });

    it('still serves exact and semantic hits once the daily quota is spent', async () => {
      providerReply('Answer from earlier today');
      await complete();
      quota.used = quota.limit;

      const exact = await complete();
      semanticHit('Semantic answer');
      const semantic = await complete('Explain how binary search works');

      expect(exact).toMatchObject({ cacheHit: true, cacheType: 'EXACT', content: 'Answer from earlier today' });
      expect(semantic).toMatchObject({ cacheHit: true, cacheType: 'SEMANTIC', content: 'Semantic answer' });
      expect(consume).toHaveBeenCalledTimes(1);
    });

    it('throws AIQuotaExceededError on a miss with the quota spent, without calling a provider', async () => {
      quota.used = quota.limit;
      providerReply();

      await expect(complete()).rejects.toBeInstanceOf(AIQuotaExceededError);
      expect(generate).not.toHaveBeenCalled();
    });

    it('gives the unit back when every provider fails and the heuristic answers', async () => {
      generate.mockRejectedValue(new Error('provider_not_configured'));

      const res = await gateway.generateCompletion({
        userId, prompt: 'Explain heaps', feature, heuristicFallback: () => 'offline answer',
      });

      expect(res).toMatchObject({ provider: 'heuristic', content: 'offline answer' });
      expect(consume).toHaveBeenCalledTimes(1);
      expect(refund).toHaveBeenCalledTimes(1);
      // Refunded against the same day the unit was taken from.
      const takenAt = consume.mock.calls[0][2];
      expect(takenAt).toBeInstanceOf(Date);
      expect(refund).toHaveBeenCalledWith(userId, feature, takenAt);
      expect(quota.used).toBe(0);
    });

    it('keeps the unit when a provider answered', async () => {
      providerReply();

      await complete();

      expect(refund).not.toHaveBeenCalled();
      expect(quota.used).toBe(1);
    });

    it('does not refund when the quota check failed open and took nothing', async () => {
      consume.mockResolvedValueOnce({ allowed: true, used: 0, remaining: quota.limit, limit: quota.limit, resetAt });
      generate.mockRejectedValue(new Error('provider_error'));

      await complete();

      expect(refund).not.toHaveBeenCalled();
    });
  });

  describe('streamCompletion', () => {
    it('uses one unit on a miss and none when the prompt is replayed from the exact cache', async () => {
      providerStream(['Streamed ', 'answer']);
      await drain(streamed());

      const replay = await drain(streamed());

      expect(replay).toMatchObject({ cacheHit: true, cacheType: 'EXACT', content: 'Streamed answer' });
      expect(consume).toHaveBeenCalledTimes(1);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(quota.used).toBe(1);
    });

    it('serves a semantic hit without touching the quota, even with the quota spent', async () => {
      quota.used = quota.limit;
      semanticHit('Semantic stream answer');

      const res = await drain(streamed());

      expect(res).toMatchObject({ cacheHit: true, cacheType: 'SEMANTIC', content: 'Semantic stream answer' });
      expect(consume).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
    });

    it('throws AIQuotaExceededError on a miss with the quota spent, before opening a stream', async () => {
      quota.used = quota.limit;
      providerStream(['never']);

      await expect(drain(streamed())).rejects.toBeInstanceOf(AIQuotaExceededError);
      expect(stream).not.toHaveBeenCalled();
    });

    it('gives the unit back when every provider fails before any text', async () => {
      stream.mockImplementation(async function* () { throw new Error('All AI providers failed.'); });

      const res = await drain(gateway.streamCompletion({
        userId, prompt: 'Explain tries', feature, heuristicFallback: () => 'offline answer',
      }));

      expect(res).toMatchObject({ provider: 'heuristic', content: 'offline answer' });
      expect(refund).toHaveBeenCalledTimes(1);
      expect(refund).toHaveBeenCalledWith(userId, feature, consume.mock.calls[0][2]);
      expect(quota.used).toBe(0);
    });

    it('keeps the unit when the provider dropped after sending text', async () => {
      providerStream(['Half an ans'], new AIStreamInterruptedError('gemini', 'Half an ans', new Error('reset')));

      await expect(drain(streamed())).rejects.toBeInstanceOf(AIStreamInterruptedError);

      expect(refund).not.toHaveBeenCalled();
      expect(quota.used).toBe(1);
    });
  });
});
