// tests/chaos/llmOutage.test.ts — Chaos: LLM provider outage (503s and timeouts).
//
// Real code under test: AIProviderAdapter (retry, per-provider circuit breaker, failover),
// the real @google/generative-ai SDK, and LLMGateway (provider chain -> heuristic fallback).
// Only the network edge is fake: global fetch answers for generativelanguage.googleapis.com
// and api.openai.com, and Redis is FakeRedis. Time is driven by fake timers, so the 15s
// provider timeouts, retry backoff and the 60s breaker cooldown cost no wall-clock time.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from './helpers/fakeRedis.js';

const redis = vi.hoisted(() => ({ current: null as unknown as FakeRedis }));
const audit = vi.hoisted(() => ({ adapterLog: vi.fn(), gatewayCreate: vi.fn() }));

vi.mock('../../src/shared/redis/client.js', async () => {
  const { FakeRedis: Fake } = await import('./helpers/fakeRedis.js');
  redis.current = new Fake();
  return {
    getRedisClient: () => redis.current,
    getRedisHealth: () => ({ status: redis.current.health }),
    isRedisConfigured: () => true,
  };
});
vi.mock('../../src/shared/redis/index.js', async () => {
  const client = await import('../../src/shared/redis/client.js');
  return { getRedisClient: client.getRedisClient, getRedisHealth: client.getRedisHealth, isRedisConfigured: client.isRedisConfigured };
});
vi.mock('../../src/modules/ai/audit/AIResponseAuditLog.js', () => ({ AIResponseAuditLog: { log: audit.adapterLog } }));
vi.mock('../../src/db/models/aiResponseAuditLog.model.js', () => ({ AIResponseAuditLog: { create: audit.gatewayCreate } }));

import { AIProviderAdapter } from '../../src/modules/ai/provider/AIProviderAdapter.js';
import { LLMGateway } from '../../src/modules/ai/provider/LLMGateway.js';

type Mode = 'ok' | 'unavailable' | 'timeout';
const providers: Record<'gemini' | 'openai', Mode> = { gemini: 'ok', openai: 'ok' };
const calls = { gemini: 0, openai: 0 };

const geminiOk = () =>
  Response.json({
    candidates: [{ content: { role: 'model', parts: [{ text: 'gemini says hi' }] }, finishReason: 'STOP' }],
    usageMetadata: { totalTokenCount: 42 },
  });
const openaiOk = () => Response.json({ choices: [{ message: { content: 'openai says hi' } }], usage: { total_tokens: 21 } });
const unavailable = () =>
  new Response(JSON.stringify({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }), {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'application/json' },
  });
const hang = () =>
  new Promise<Response>((_, reject) => {
    setTimeout(() => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), 15_000);
  });

const fetchStub = vi.fn(async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const provider = url.includes('generativelanguage.googleapis.com') ? 'gemini' : url.includes('api.openai.com') ? 'openai' : null;
  if (!provider) throw new Error(`Unexpected network call in chaos test: ${url}`);
  calls[provider]++;
  const mode = providers[provider];
  if (mode === 'timeout') return hang();
  if (mode === 'unavailable') return unavailable();
  return provider === 'gemini' ? geminiOk() : openaiOk();
});

const gateway = new LLMGateway();
const request = (prompt: string, extra: Record<string, unknown> = {}) => ({
  userId: 'user-1',
  prompt,
  feature: 'interview',
  heuristicFallback: () => 'heuristic: keep practising system design',
  ...extra,
});

/**
 * Run an async call while fake time advances one second at a time until it settles.
 * Stepping (instead of one big jump) keeps the clock from running past the breaker's
 * 60s cooldown before the test wants it to.
 */
async function run<T>(promise: Promise<T>, maxMs = 200_000): Promise<T> {
  let done = false;
  const settled = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  ).finally(() => {
    done = true;
  });
  for (let elapsed = 0; !done && elapsed < maxMs; elapsed += 1000) await vi.advanceTimersByTimeAsync(1000);
  const outcome = await settled;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // pin the breaker's reset jitter
  vi.stubEnv('GEMINI_API_KEY', 'chaos-test-key');
  vi.stubEnv('OPENAI_API_KEY', 'chaos-test-key');
  vi.stubGlobal('fetch', fetchStub);
  redis.current.restart({ persist: false });
  providers.gemini = 'ok';
  providers.openai = 'ok';
  calls.gemini = 0;
  calls.openai = 0;
  fetchStub.mockClear();
  audit.adapterLog.mockClear();
  audit.gatewayCreate.mockClear();
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  AIProviderAdapter.setCurrentProvider('openai');
  await AIProviderAdapter.clear();
});

afterEach(async () => {
  process.off('unhandledRejection', onUnhandled);
  await vi.advanceTimersByTimeAsync(0);
  expect(unhandled).toEqual([]);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Chaos: Gemini 503 outage', () => {
  it('serves the heuristic answer when every provider answers 503', async () => {
    providers.gemini = 'unavailable';
    providers.openai = 'unavailable';

    const res = await run(gateway.generateCompletion(request('Evaluate my answer about caching')));

    expect(res).toMatchObject({
      content: 'heuristic: keep practising system design',
      provider: 'heuristic',
      model: 'heuristic-rule-engine',
      fallbackTriggered: true,
      tokensUsed: 0,
      cost: 0,
    });
    expect(calls.gemini).toBeGreaterThan(0); // the real SDK really made the 503 round trip
    expect(audit.gatewayCreate).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'heuristic', fallbackTriggered: true, success: true }),
    );
  });

  it('uses the built-in descriptive heuristic text when the caller supplies none', async () => {
    providers.gemini = 'unavailable';
    providers.openai = 'unavailable';

    const res = await run(gateway.generateCompletion(request('Evaluate my answer', { heuristicFallback: undefined })));

    expect(res.provider).toBe('heuristic');
    expect(res.content).toMatch(/^\[Heuristic Fallback\]: Analysis completed using offline rules/);
  });

  it('trips the circuit breakers, then answers without touching the network', async () => {
    providers.gemini = 'unavailable';
    providers.openai = 'unavailable';
    await run(gateway.generateCompletion(request('first request')));

    expect(AIProviderAdapter.getProviderHealth('gemini')).toMatchObject({ status: 'down' });
    expect(AIProviderAdapter.getProviderHealth('openai')).toMatchObject({ status: 'down' });

    fetchStub.mockClear();
    const res = await gateway.generateCompletion(request('second request')); // no timers needed: nothing to wait for

    expect(res).toMatchObject({ provider: 'heuristic', fallbackTriggered: true });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects direct adapter callers with a descriptive error and an audited error code', async () => {
    providers.gemini = 'unavailable';
    providers.openai = 'unavailable';

    await expect(run(AIProviderAdapter.generateResponse({ prompt: 'x', tenantScope: 'user-1', cache: false }))).rejects.toThrow(
      'All AI providers failed. Last error: provider_error',
    );
    expect(audit.adapterLog).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorCode: 'provider_error', userId: 'user-1' }),
    );

    // A second failing call reaches the 5-failure threshold on both providers and opens the breakers.
    await expect(run(AIProviderAdapter.generateResponse({ prompt: 'y', tenantScope: 'user-1', cache: false }))).rejects.toThrow(
      'All AI providers failed',
    );

    // With the breakers open the next failure is classified as a circuit rejection, instantly
    await expect(AIProviderAdapter.generateResponse({ prompt: 'z', tenantScope: 'user-1', cache: false })).rejects.toThrow(
      'Last error: provider_circuit_open',
    );
  });

  it('fails over to OpenAI when only Gemini is down', async () => {
    providers.gemini = 'unavailable';

    const res = await run(gateway.generateCompletion(request('Summarise my portfolio')));

    expect(res).toMatchObject({ provider: 'openai', content: 'openai says hi', fallbackTriggered: true });
    expect(audit.gatewayCreate).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', fallbackTriggered: true }));
  });

  it('recovers: after the cooldown a probe call closes the breaker and real answers resume', async () => {
    providers.gemini = 'unavailable';
    providers.openai = 'unavailable';
    await run(gateway.generateCompletion(request('during outage', { bypassCache: true })));
    expect(AIProviderAdapter.getProviderHealth('gemini')?.status).toBe('down');

    providers.gemini = 'ok';
    providers.openai = 'ok';
    await vi.advanceTimersByTimeAsync(70_000); // 60s cooldown + 2.5s pinned jitter

    const res = await run(gateway.generateCompletion(request('after outage', { bypassCache: true })));

    expect(res).toMatchObject({ provider: 'gemini', content: 'gemini says hi', fallbackTriggered: false });
    expect(AIProviderAdapter.getProviderHealth('gemini')?.status).toBe('healthy');
  });

  // KNOWN GAP (reported in the PR): LLMGateway writes every non-empty result into the
  // 24h prompt cache, including the offline heuristic text. When the outage ends, the same
  // prompt keeps returning the degraded answer (as a "cache hit") for up to a day.
  it.fails('does not keep serving a cached heuristic answer after the provider recovers', async () => {
    providers.gemini = 'unavailable';
    providers.openai = 'unavailable';
    const prompt = 'Evaluate my answer about caching';
    await run(gateway.generateCompletion(request(prompt)));

    providers.gemini = 'ok';
    providers.openai = 'ok';
    await vi.advanceTimersByTimeAsync(70_000);
    const res = await run(gateway.generateCompletion(request(prompt)));

    expect(res.provider).not.toBe('heuristic');
  });
});

describe('Chaos: provider timeouts', () => {
  it('degrades to the heuristic answer when both providers hang until the 15s timeout', async () => {
    providers.gemini = 'timeout';
    providers.openai = 'timeout';

    const res = await run(gateway.generateCompletion(request('Generate my portfolio summary')), 600_000);

    expect(res).toMatchObject({ provider: 'heuristic', fallbackTriggered: true });
    expect(AIProviderAdapter.getProviderHealth('gemini')?.status).toBe('down');
  });

  it('audits timeouts as provider_timeout for direct adapter callers', async () => {
    providers.gemini = 'timeout';
    providers.openai = 'timeout';

    await expect(
      run(AIProviderAdapter.generateResponse({ prompt: 'x', tenantScope: 'user-2', cache: false, providerPreference: 'gemini' }), 600_000),
    ).rejects.toThrow('All AI providers failed');
    expect(audit.adapterLog).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorCode: 'provider_timeout' }));
  });
});
