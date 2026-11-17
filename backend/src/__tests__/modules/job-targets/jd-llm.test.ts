import { afterEach, describe, expect, it, vi } from 'vitest';

const generateCompletion = vi.hoisted(() => vi.fn());
vi.mock('../../../modules/ai/provider/LLMGateway.js', () => ({ llmGateway: { generateCompletion } }));

const { createGatewayJdLlm, JD_LLM_FEATURE } = await import('../../../modules/job-targets/jdLlm.js');

const request = { userId: 'u1', systemPrompt: 'sys', prompt: 'p', maxTokens: 100 };
const reply = (overrides = {}) => ({ content: '{"ok":true}', provider: 'gemini', ...overrides });

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); generateCompletion.mockReset(); });

describe('gateway adapter', () => {
  it('is configured only when a provider key is set', () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(createGatewayJdLlm().isConfigured()).toBe(false);
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    expect(createGatewayJdLlm().isConfigured()).toBe(true);
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', 'g-test');
    expect(createGatewayJdLlm().isConfigured()).toBe(true);
  });

  it('calls the gateway with a low temperature and its own quota feature', async () => {
    generateCompletion.mockResolvedValue(reply());
    await expect(createGatewayJdLlm().complete(request)).resolves.toBe('{"ok":true}');
    expect(generateCompletion).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', systemPrompt: 'sys', prompt: 'p', maxTokens: 100, temperature: 0.1, feature: JD_LLM_FEATURE }));
  });

  it('turns the gateway heuristic reply into a failure instead of passing it on as model output', async () => {
    generateCompletion.mockResolvedValue(reply({ provider: 'heuristic', content: '' }));
    await expect(createGatewayJdLlm().complete(request)).rejects.toThrow('No AI provider answered');
    generateCompletion.mockImplementation(async (input: { heuristicFallback: () => string }) => reply({ provider: 'heuristic', content: input.heuristicFallback() }));
    await expect(createGatewayJdLlm().complete(request)).rejects.toThrow('No AI provider answered');
  });

  it('propagates gateway errors such as an exhausted quota', async () => {
    generateCompletion.mockRejectedValue(new Error('quota'));
    await expect(createGatewayJdLlm().complete(request)).rejects.toThrow('quota');
  });

  it('gives up on a call that never returns', async () => {
    vi.useFakeTimers();
    generateCompletion.mockReturnValue(new Promise(() => {}));
    const pending = createGatewayJdLlm(1000).complete(request);
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
  });
});
