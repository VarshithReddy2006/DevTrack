import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../../../shared/circuit-breaker/circuitBreaker.js';
import { AICacheManager } from '../cache/AICacheManager.js';
import { ProviderFailoverRuntime } from '../reliability/ProviderFailoverRuntime.js';
import { AIProviderAdapter } from './AIProviderAdapter.js';

const mocks = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  keys: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  generateContent: vi.fn(),
  getGenerativeModel: vi.fn(),
}));

vi.unmock('./AIProviderAdapter.js');
vi.mock('../../../shared/redis/index.js', () => ({
  getRedisClient: () => ({ status: 'ready', get: mocks.get, set: mocks.set, keys: mocks.keys }),
}));
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel = mocks.getGenerativeModel;
  },
}));

const openai = vi.fn<typeof fetch>();
const prompt = { prompt: 'Review this resume', tenantScope: 'tenant-one' };
const openaiResponse = () => Response.json({ choices: [{ message: { content: 'OpenAI reply' } }] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubEnv('OPENAI_API_KEY', 'unit-test-key');
  vi.stubEnv('GEMINI_API_KEY', 'unit-test-key');
  vi.stubGlobal('fetch', openai);
  mocks.cache.clear();
  mocks.keys.mockResolvedValue([]);
  mocks.get.mockImplementation(async (key: string) => mocks.cache.get(key) ?? null);
  mocks.set.mockImplementation(async (key: string, value: string) => { mocks.cache.set(key, value); });
  mocks.getGenerativeModel.mockReturnValue({ generateContent: mocks.generateContent });
  mocks.generateContent.mockResolvedValue({ response: { text: () => 'Gemini reply' } });
  openai.mockImplementation(async () => openaiResponse());
  AIProviderAdapter.setCurrentProvider('openai');
  await AIProviderAdapter.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('AI provider recovery', () => {
  async function openPrimaryCircuit(): Promise<void> {
    openai.mockRejectedValue(new Error('OpenAI unavailable'));
    for (let i = 0; i < 2; i++) {
      const response = AIProviderAdapter.generateResponse(prompt);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await response).toMatchObject({ provider: 'gemini', fallbackTriggered: true });
    }
    expect(openai).toHaveBeenCalledTimes(5);
    expect(AIProviderAdapter.getProviderHealth('openai')).toMatchObject({ status: 'down', failureCount: 5 });
  }

  it('fails over during cooldown and permits only one recovery call, even with a cached fallback', async () => {
    await openPrimaryCircuit();
    expect(await AIProviderAdapter.generateResponse(prompt)).toMatchObject({
      provider: 'gemini', cached: true, fallbackTriggered: true,
    });
    expect(openai).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(60_000);
    await AIProviderAdapter.generateResponse(prompt);
    expect(openai).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(2500);
    const probe = deferred<Response>();
    const started = deferred<void>();
    openai.mockImplementationOnce(() => { started.resolve(); return probe.promise; });
    const recovering = AIProviderAdapter.generateResponse(prompt);
    await started.promise;

    try {
      const concurrent = await AIProviderAdapter.generateResponse(prompt);
      expect(concurrent).toMatchObject({ provider: 'gemini', fallbackTriggered: true });
      expect(openai).toHaveBeenCalledTimes(6);
      expect(AIProviderAdapter.getProviderHealth('openai')).toMatchObject({ status: 'degraded' });
    } finally {
      probe.resolve(openaiResponse());
      await recovering;
    }
    expect(await recovering).toMatchObject({ provider: 'openai', cached: false, fallbackTriggered: false });
    expect(AIProviderAdapter.getProviderHealth('openai')).toMatchObject({ status: 'healthy', failureCount: 0 });
  });

  it('reopens after one failed probe and uses the secondary provider default model', async () => {
    await openPrimaryCircuit();
    await vi.advanceTimersByTimeAsync(65_000);
    const response = AIProviderAdapter.generateResponse({ ...prompt, model: 'custom-openai-model' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await response).toMatchObject({ provider: 'gemini', model: 'gemini-1.5-flash', fallbackTriggered: true });
    expect(openai).toHaveBeenCalledTimes(6);
    expect(AIProviderAdapter.getProviderHealth('openai')?.status).toBe('down');
    await AIProviderAdapter.generateResponse(prompt);
    expect(openai).toHaveBeenCalledTimes(6);
  });

  it('retries a runtime operation without changing the adapter’s default provider', async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error('transient failure')).mockResolvedValue('done');
    await expect(new ProviderFailoverRuntime().executeWithFailover(operation)).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(AIProviderAdapter.getCurrentProvider()).toBe('openai');
  });
});

describe('AI cache keys', () => {
  it('separates full prompts and request parameters in Redis', async () => {
    const request = { ...prompt, prompt: 'one two three four five six seven eight nine ten initial tail' };
    const variants = [
      request,
      { ...request, prompt: request.prompt + ' changed' },
      { ...request, systemPrompt: 'different instructions' },
      { ...request, model: 'gpt-4.1-mini' },
      { ...request, temperature: 0 },
      { ...request, maxTokens: 250 },
      { ...request, responseSchemaVersion: 'v2' },
      { ...request, tenantScope: 'tenant-two' },
      { ...request, providerPreference: 'gemini' as const },
    ];
    for (const variant of variants) expect((await AIProviderAdapter.generateResponse(variant)).cached).toBe(false);
    expect(mocks.cache.size).toBe(variants.length);
    for (const key of mocks.cache.keys()) expect(key).toMatch(/^ai:cache:v2:[a-f0-9]{64}$/);
    expect((await AIProviderAdapter.generateResponse({ ...request, temperature: 0.7 })).cached).toBe(true);
    expect((await AIProviderAdapter.generateResponse({ ...request, cache: false })).cached).toBe(false);
    expect(openai).toHaveBeenCalledTimes(9);
  });

  it('uses a canonical field order and avoids collisions from prompt delimiters and response format', () => {
    const key = { provider: 'openai', model: 'model', userPrompt: 'a-b', systemPrompt: 'c' };
    expect(AICacheManager.generatePromptKey(key)).toBe(
      AICacheManager.generatePromptKey({ model: key.model, systemPrompt: 'c', provider: key.provider, userPrompt: 'a-b' })
    );
    expect(AICacheManager.generatePromptKey(key)).not.toBe(
      AICacheManager.generatePromptKey({ ...key, userPrompt: 'a', systemPrompt: 'b-c' })
    );
    expect(AICacheManager.generatePromptKey(key)).not.toBe(
      AICacheManager.generatePromptKey({ ...key, responseFormat: 'application/json' })
    );
  });
});

describe('shared CircuitBreaker', () => {
  it('ignores stale results from before a circuit opened', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1, resetTimeoutMs: 100, successThreshold: 1 });
    const late = deferred<string>();
    const oldCall = breaker.execute(() => late.promise);
    await expect(breaker.execute(async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    const blocked = vi.fn();
    await expect(breaker.execute(blocked)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(blocked).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    const probe = deferred<string>();
    const recovering = breaker.execute(() => probe.promise);
    late.resolve('old result');
    await expect(oldCall).resolves.toBe('old result');
    expect(breaker.getState()).toBe('half_open');
    await expect(breaker.execute(blocked)).rejects.toBeInstanceOf(CircuitOpenError);
    probe.resolve('recovered');
    await expect(recovering).resolves.toBe('recovered');
    expect(breaker.getState()).toBe('closed');
  });
});
