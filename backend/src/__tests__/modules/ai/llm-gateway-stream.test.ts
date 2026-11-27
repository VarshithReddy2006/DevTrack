// Streaming path of the LLMGateway, driven by a fake provider adapter.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIResponseAuditLog } from '../../../db/models/aiResponseAuditLog.model.js';
import { llmGateway, type LLMStreamEvent } from '../../../modules/ai/provider/LLMGateway.js';
import { AIProviderAdapter, type AIStreamEvent } from '../../../modules/ai/provider/AIProviderAdapter.js';
import { AIStreamInterruptedError } from '../../../modules/ai/provider/AIStreamInterruptedError.js';
import { AIQuotaExceededError, QuotaService, quotaService } from '../../../modules/ai/quota.service.js';
import { semanticCacheService } from '../../../shared/ai/semanticCache.service.js';
import { quotaEval } from '../../fixtures/quotaRedis.js';

const redisStore = new Map<string, string>();
const mockRedis = {
  status: 'ready',
  get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  set: vi.fn(async (key: string, val: string) => { redisStore.set(key, String(val)); return 'OK'; }),
  incr: vi.fn(async (key: string) => {
    const next = parseInt(redisStore.get(key) || '0', 10) + 1;
    redisStore.set(key, String(next));
    return next;
  }),
  expire: vi.fn(async () => 1),
  eval: vi.fn(quotaEval(redisStore)),
};

vi.mock('../../../shared/redis/client.js', () => ({
  getRedisClient: () => mockRedis,
  isRedisConfigured: () => true,
  getRedisHealth: () => ({ status: 'connected' }),
}));

// The global test setup replaces the adapter with a stub that has no streaming method.
vi.mock('../../../modules/ai/provider/AIProviderAdapter.js', () => ({
  AIProviderAdapter: { streamResponse: vi.fn() },
}));

const userId = '000000000000000000000077';
const stream = vi.mocked(AIProviderAdapter.streamResponse);

function providerStream(deltas: string[], overrides: Partial<Extract<AIStreamEvent, { type: 'done' }>['response']> = {}, failAfter?: unknown) {
  stream.mockImplementation(async function* () {
    for (const delta of deltas) yield { type: 'delta', delta } as const;
    if (failAfter) throw failAfter;
    yield {
      type: 'done',
      response: {
        content: deltas.join(''), model: 'gemini-1.5-flash', provider: 'gemini', tokensUsed: 1000,
        latency: 5, cached: false, fallbackTriggered: false, ...overrides,
      },
    } as const;
  });
}

async function drain(gen: AsyncGenerator<LLMStreamEvent>) {
  const events: LLMStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return {
    events,
    deltas: events.flatMap(e => (e.type === 'delta' ? [e.delta] : [])),
    done: events.find((e): e is Extract<LLMStreamEvent, { type: 'done' }> => e.type === 'done')?.response,
  };
}

const call = (extra: Record<string, unknown> = {}) =>
  llmGateway.streamCompletion({ userId, prompt: 'Give feedback on this answer', feature: 'interview', ...extra });

describe('LLMGateway.streamCompletion', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    semanticCacheService.clearMemoryCache();
    await AIResponseAuditLog.deleteMany({});
  });

  it('yields provider deltas in order, then a completion summary with cost and prompt hash', async () => {
    providerStream(['Good ', 'start. ', 'Mention retries.']);

    const { events, deltas, done } = await drain(call());

    expect(deltas).toEqual(['Good ', 'start. ', 'Mention retries.']);
    expect(events.map(e => e.type)).toEqual(['delta', 'delta', 'delta', 'done']);
    expect(done).toMatchObject({
      content: 'Good start. Mention retries.', provider: 'gemini', model: 'gemini-1.5-flash',
      cached: false, cacheHit: false, fallbackTriggered: false, cost: 0.00015,
    });
    expect(done?.promptHash).toHaveLength(64);
  });

  it('forwards tenant scope, model, provider preference and the abort signal, and skips the adapter cache', async () => {
    providerStream(['ok']);
    const controller = new AbortController();

    await drain(llmGateway.streamCompletion(
      { userId, prompt: 'p', systemPrompt: 's', temperature: 0.2, maxTokens: 300, model: 'gpt-4o', preferredProvider: 'openai' },
      { signal: controller.signal },
    ));

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'p', systemPrompt: 's', temperature: 0.2, maxTokens: 300, model: 'gpt-4o',
        providerPreference: 'openai', tenantScope: userId, cache: false,
      }),
      { signal: controller.signal },
    );
  });

  it('replays an identical prompt from the prompt cache as one delta without calling a provider', async () => {
    providerStream(['Cached ', 'text']);
    await drain(call());
    expect(stream).toHaveBeenCalledTimes(1);

    const second = await drain(call());

    expect(stream).toHaveBeenCalledTimes(1);
    expect(second.deltas).toEqual(['Cached text']);
    expect(second.done).toMatchObject({ content: 'Cached text', cached: true, cacheHit: true, cost: 0 });
  });

  it('bypasses the cache when asked', async () => {
    providerStream(['fresh']);
    await drain(call());
    await drain(call({ bypassCache: true }));
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it('uses the heuristic fallback (G8) when every provider fails before producing text', async () => {
    stream.mockImplementation(async function* () { throw new Error('All AI providers failed.'); });

    const { deltas, done } = await drain(call({ heuristicFallback: () => 'rule based reply' }));

    expect(deltas).toEqual(['rule based reply']);
    expect(done).toMatchObject({
      content: 'rule based reply', provider: 'heuristic', model: 'heuristic-rule-engine', fallbackTriggered: true, cost: 0,
    });
    // Heuristic output must not be served from cache later as if a model wrote it.
    expect([...redisStore.keys()].some(k => k.includes('prompt_cache'))).toBe(false);
  });

  it('emits no delta for an empty heuristic fallback so callers can detect "no AI" from the summary', async () => {
    stream.mockImplementation(async function* () { throw new Error('no keys'); });

    const { deltas, done } = await drain(call({ heuristicFallback: () => '' }));

    expect(deltas).toEqual([]);
    expect(done).toMatchObject({ content: '', provider: 'heuristic' });
  });

  it('rethrows the interruption instead of faking a heuristic answer once text was delivered', async () => {
    providerStream(['Half an ans'], {}, new AIStreamInterruptedError('gemini', 'Half an ans', new Error('reset')));
    const received: string[] = [];

    await expect((async () => {
      for await (const event of call({ heuristicFallback: () => 'rule based reply' })) {
        if (event.type === 'delta') received.push(event.delta);
      }
    })()).rejects.toBeInstanceOf(AIStreamInterruptedError);

    expect(received).toEqual(['Half an ans']);
    const audit = await AIResponseAuditLog.findOne({ userId });
    expect(audit).toMatchObject({ success: false, provider: 'gemini' });
  });

  it('throws AIQuotaExceededError before opening a provider stream when the daily quota is spent', async () => {
    const tight = new QuotaService({ stream_tight: 1 });
    vi.spyOn(quotaService, 'checkAndConsumeQuota').mockImplementation((uid, feature) => tight.checkAndConsumeQuota(uid, feature));
    providerStream(['one']);

    await drain(call({ feature: 'stream_tight' }));
    await expect(drain(call({ feature: 'stream_tight', prompt: 'a different prompt' }))).rejects.toBeInstanceOf(AIQuotaExceededError);

    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('consumes exactly one quota unit per streamed call', async () => {
    providerStream(['x']);
    const spy = vi.spyOn(quotaService, 'checkAndConsumeQuota');

    await drain(call());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(userId, 'interview');
  });

  it('writes an audit log with the cost and prompt hash', async () => {
    providerStream(['audited']);

    const { done } = await drain(call());

    const audit = await AIResponseAuditLog.findOne({ userId, promptHash: done?.promptHash });
    expect(audit).toMatchObject({ provider: 'gemini', requestType: 'interview', tokensUsed: 1000, cost: 0.00015, success: true, cacheHit: false });
  });
});
