import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { AIProviderAdapter } from '../../../modules/ai/provider/AIProviderAdapter.js';
import { ResumeAIContextBuilder } from '../../../modules/resume/ai/ResumeAIContextBuilder.js';
import { ResumeWordingService } from '../../../modules/resume/ai/ResumeWordingService.js';

vi.unmock('../../../modules/ai/provider/AIProviderAdapter.js');

describe('ResumeWordingService', () => {
  const service = new ResumeWordingService();
  const userId = new Types.ObjectId();
  const originalText = 'I build backends.';
  const context = 'Verified skills: Node.js';
  const variants = ['Built backends.', 'Developed backends.', 'Implemented backend services.'];
  const fetchMock = vi.fn<typeof fetch>();

  function respondWith(content: string): void {
    fetchMock.mockResolvedValueOnce(Response.json({ choices: [{ message: { content } }] }));
  }

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('OPENAI_API_KEY', 'unit-test-key');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.spyOn(ResumeAIContextBuilder.prototype, 'buildWordingContext').mockResolvedValue(context);
    AIProviderAdapter.setCurrentProvider('openai');
    await AIProviderAdapter.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends tenant-scoped wording context through the provider and returns three parsed variants', async () => {
    const generate = vi.spyOn(AIProviderAdapter, 'generateResponse');
    respondWith(JSON.stringify({ variants }));

    await expect(service.optimizeWording(userId, 'summary', originalText)).resolves.toEqual({ variants });

    expect(ResumeAIContextBuilder.prototype.buildWordingContext).toHaveBeenCalledWith(userId, 'summary');
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      tenantScope: userId.toString(),
      cache: false,
    }));
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(request?.body)).messages).toEqual([
      { role: 'system', content: expect.stringContaining('DO NOT invent metrics') },
      { role: 'user', content: JSON.stringify({ context, originalText }) },
    ]);
  });

  it.each([
    'Unstructured output',
    JSON.stringify({ variants: variants.slice(0, 2) }),
    JSON.stringify({ variants: [...variants, 'Fourth variant'] }),
    JSON.stringify({ variants: [variants[0], variants[1], '  '] }),
    JSON.stringify({ variants: [variants[0], variants[1], 'Guaranteed to get hired.'] }),
  ])('returns the original text for unusable output (%s)', async (content) => {
    respondWith(content);
    await expect(service.optimizeWording(userId, 'summary', originalText)).resolves.toBe(originalText);
  });

  it('rejects the same blocked prompt on successive calls without contacting a provider', async () => {
    const blockedText = 'Guaranteed to get hired.';
    await expect(service.optimizeWording(userId, 'summary', blockedText)).resolves.toBe(blockedText);
    await expect(service.optimizeWording(userId, 'summary', blockedText)).resolves.toBe(blockedText);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the original text if providers are unavailable', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('OpenAI unavailable'));
    const result = service.optimizeWording(userId, 'summary', originalText);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe(originalText);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
