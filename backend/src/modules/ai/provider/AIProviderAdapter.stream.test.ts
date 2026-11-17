import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIProviderAdapter, type AIStreamEvent } from './AIProviderAdapter.js';
import { AIStreamInterruptedError } from './AIStreamInterruptedError.js';

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  generateContentStream: vi.fn(),
  generateContent: vi.fn(),
  getGenerativeModel: vi.fn(),
}));

vi.unmock('./AIProviderAdapter.js');
vi.mock('../audit/AIResponseAuditLog.js', () => ({ AIResponseAuditLog: { log: mocks.audit } }));
vi.mock('../../../shared/redis/index.js', () => ({
  getRedisClient: () => ({ status: 'ready', get: vi.fn(), set: vi.fn(), keys: vi.fn().mockResolvedValue([]) }),
}));
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel = mocks.getGenerativeModel;
  },
}));

const openai = vi.fn<typeof fetch>();
const request = { prompt: 'Explain idempotency keys', tenantScope: 'tenant-one', providerPreference: 'openai' as const };

const encoder = new TextEncoder();
const dataLine = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const textDelta = (content: string) => dataLine({ choices: [{ delta: { content } }] });

/** An OpenAI-style SSE response whose body arrives in the given raw pieces. */
function sseResponse(pieces: string[], failAfter?: Error): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < pieces.length) {
        controller.enqueue(encoder.encode(pieces[index++]));
      } else if (failAfter) {
        controller.error(failAfter);
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function geminiStream(chunks: string[], totalTokenCount?: number, failAfter?: Error) {
  return {
    stream: (async function* () {
      for (const text of chunks) yield { text: () => text };
      if (failAfter) throw failAfter;
    })(),
    response: Promise.resolve({ usageMetadata: totalTokenCount ? { totalTokenCount } : undefined }),
  };
}

async function collect(stream: AsyncGenerator<AIStreamEvent>) {
  const deltas: string[] = [];
  let done: Extract<AIStreamEvent, { type: 'done' }>['response'] | undefined;
  for await (const event of stream) {
    if (event.type === 'delta') deltas.push(event.delta);
    else done = event.response;
  }
  return { deltas, done };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubEnv('OPENAI_API_KEY', 'unit-test-key');
  vi.stubEnv('GEMINI_API_KEY', 'unit-test-key');
  vi.stubGlobal('fetch', openai);
  mocks.getGenerativeModel.mockReturnValue({
    generateContent: mocks.generateContent,
    generateContentStream: mocks.generateContentStream,
  });
  mocks.generateContentStream.mockImplementation(async () => geminiStream(['Gemini ', 'reply'], 12));
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

describe('AIProviderAdapter.streamResponse', () => {
  it('relays OpenAI deltas in order, even when SSE events are split across network chunks', async () => {
    const whole = textDelta('Hello') + textDelta(', ') + textDelta('world');
    const usage = dataLine({ choices: [], usage: { total_tokens: 21 } });
    // Cut the payload in the middle of an event and in the middle of a JSON string.
    const cut = whole.indexOf('world') - 4;
    openai.mockResolvedValue(sseResponse([
      ': keep-alive\n\n', whole.slice(0, cut), whole.slice(cut), usage, 'data: [DONE]\n\n',
    ]));

    const { deltas, done } = await collect(AIProviderAdapter.streamResponse(request));

    expect(deltas).toEqual(['Hello', ', ', 'world']);
    expect(done).toMatchObject({
      content: 'Hello, world', provider: 'openai', model: 'gpt-4o-mini', tokensUsed: 21,
      cached: false, fallbackTriggered: false,
    });
    const [url, init] = openai.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: request.prompt }],
    });
  });

  it('reads a final event that has no trailing newline and estimates tokens without usage', async () => {
    openai.mockResolvedValue(sseResponse([textDelta('abcd'), `data: ${JSON.stringify({ choices: [{ delta: { content: 'efgh' } }] })}`]));

    const { deltas, done } = await collect(AIProviderAdapter.streamResponse(request));

    expect(deltas).toEqual(['abcd', 'efgh']);
    expect(done?.tokensUsed).toBe(Math.ceil((request.prompt.length + 8) / 4));
  });

  it('streams Gemini through generateContentStream as plain text', async () => {
    const { deltas, done } = await collect(AIProviderAdapter.streamResponse({ ...request, providerPreference: 'gemini' }));

    expect(deltas).toEqual(['Gemini ', 'reply']);
    expect(done).toMatchObject({ content: 'Gemini reply', provider: 'gemini', model: 'gemini-1.5-flash', tokensUsed: 12 });
    expect(mocks.generateContentStream.mock.calls[0]![0].generationConfig).not.toHaveProperty('responseMimeType');
    expect(openai).not.toHaveBeenCalled();
  });

  it('fails over to the secondary provider when the primary dies before any text', async () => {
    openai.mockImplementation(async () => new Response('down', { status: 503 }));

    const pending = collect(AIProviderAdapter.streamResponse(request));
    await vi.advanceTimersByTimeAsync(3000);
    const { deltas, done } = await pending;

    expect(openai).toHaveBeenCalledTimes(3);
    expect(deltas).toEqual(['Gemini ', 'reply']);
    expect(done).toMatchObject({ provider: 'gemini', model: 'gemini-1.5-flash', fallbackTriggered: true });
  });

  it('retries the connection once more after a transient error and then streams normally', async () => {
    openai.mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(sseResponse([textDelta('ok')]));

    const pending = collect(AIProviderAdapter.streamResponse(request));
    await vi.advanceTimersByTimeAsync(1000);
    const { deltas, done } = await pending;

    expect(openai).toHaveBeenCalledTimes(2);
    expect(deltas).toEqual(['ok']);
    expect(done?.fallbackTriggered).toBe(false);
  });

  it('does not retry an unconfigured provider or a 4xx, it goes straight to the next provider', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const unconfigured = await collect(AIProviderAdapter.streamResponse(request));
    expect(openai).not.toHaveBeenCalled();
    expect(unconfigured.done).toMatchObject({ provider: 'gemini', fallbackTriggered: true });

    vi.stubEnv('OPENAI_API_KEY', 'unit-test-key');
    openai.mockImplementation(async () => new Response('bad key', { status: 401 }));
    const rejected = await collect(AIProviderAdapter.streamResponse(request));
    expect(openai).toHaveBeenCalledTimes(1);
    expect(rejected.done).toMatchObject({ provider: 'gemini', fallbackTriggered: true });
  });

  it('stops with AIStreamInterruptedError instead of failing over once text was delivered', async () => {
    openai.mockResolvedValue(sseResponse([textDelta('Partial '), textDelta('answer')], new Error('socket hang up')));
    const received: string[] = [];

    const failure = await (async () => {
      try {
        for await (const event of AIProviderAdapter.streamResponse(request)) {
          if (event.type === 'delta') received.push(event.delta);
        }
      } catch (error) {
        return error;
      }
    })();

    expect(received).toEqual(['Partial ', 'answer']);
    expect(failure).toBeInstanceOf(AIStreamInterruptedError);
    expect(failure).toMatchObject({ provider: 'openai', partialContent: 'Partial answer' });
    expect(mocks.generateContentStream).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', success: false }));
  });

  it('throws when every provider fails before producing text', async () => {
    openai.mockImplementation(async () => new Response('down', { status: 500 }));
    mocks.generateContentStream.mockRejectedValue(new Error('Gemini unavailable'));

    const pending = collect(AIProviderAdapter.streamResponse(request)).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toMatchObject({ message: 'All AI providers failed. Last error: provider_error' });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ success: false, provider: 'gemini' }));
  });

  it('treats a stream that ends without any content as a failure of that provider', async () => {
    openai.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));

    const pending = collect(AIProviderAdapter.streamResponse(request));
    await vi.advanceTimersByTimeAsync(3000);

    expect((await pending).done).toMatchObject({ provider: 'gemini', fallbackTriggered: true });
  });

  it('honours an abort signal and does not fall back to another provider', async () => {
    const controller = new AbortController();
    controller.abort();
    openai.mockImplementation(async (_url, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return sseResponse([textDelta('never')]);
    });

    await expect(collect(AIProviderAdapter.streamResponse(request, { signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(openai).toHaveBeenCalledTimes(1);
    expect(mocks.generateContentStream).not.toHaveBeenCalled();
  });

  it('records a provider-stream audit entry scoped to the tenant', async () => {
    openai.mockResolvedValue(sseResponse([textDelta('hi'), dataLine({ choices: [], usage: { total_tokens: 7 } })]));

    await collect(AIProviderAdapter.streamResponse(request));

    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'tenant-one', requestType: 'provider-stream', provider: 'openai', tokensUsed: 7, success: true, cached: false,
    }));
  });

  it('opens the shared circuit breaker after repeated stream failures so later calls skip the provider', async () => {
    openai.mockImplementation(async () => new Response('down', { status: 500 }));
    for (let i = 0; i < 2; i++) {
      const pending = collect(AIProviderAdapter.streamResponse(request));
      await vi.advanceTimersByTimeAsync(3000);
      expect((await pending).done?.provider).toBe('gemini');
    }
    expect(AIProviderAdapter.getProviderHealth('openai')).toMatchObject({ status: 'down' });

    const callsBefore = openai.mock.calls.length;
    const { done } = await collect(AIProviderAdapter.streamResponse(request));
    expect(openai.mock.calls.length).toBe(callsBefore);
    expect(done).toMatchObject({ provider: 'gemini', fallbackTriggered: true });
  });
});
