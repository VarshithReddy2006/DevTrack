import { describe, expect, it, vi } from 'vitest';
import { AIResponseAuditLog as AuditLogModel, AI_AUDIT_RETENTION_SECONDS } from '../../db/models/aiResponseAuditLog.model.js';
import { AIProviderAdapter } from '../../modules/ai/AIProviderAdapter.js';
import { AIProviderAdapter as LiveAIProviderAdapter } from '../../modules/ai/provider/AIProviderAdapter.js';
import { AIResponseAuditLogClass } from '../../modules/ai/audit/AIResponseAuditLog.js';
import { logger } from '../../shared/logger.js';

const auditEntry = {
  userId: 'user[1]',
  requestType: 'resume',
  prompt: 'private resume',
  systemPrompt: 'private instructions',
  response: 'private generated response',
  errorMessage: 'private provider error',
  model: 'gemini-test',
  provider: 'gemini',
  latency: 100,
  tokensUsed: 20,
  cached: false,
  contextVersion: 'v1',
  responseConfidence: 0.8,
  moderationFlags: ['flag-1', 'flag-2'],
  hallucinationFlags: [],
  safetyViolations: [],
  success: true,
};

describe('AI audit persistence', () => {
  it('persists metadata for a fresh service instance and excludes raw content', async () => {
    const writer = new AIResponseAuditLogClass();
    const entry = await writer.log(auditEntry);
    expect(entry).toBeDefined();
    const reader = new AIResponseAuditLogClass();

    expect(await reader.getEntry(entry!.logId)).toMatchObject({
      userId: auditEntry.userId,
      contextVersion: 'v1',
      responseConfidence: 0.8,
      latency: 100,
      prompt: '',
      systemPrompt: '',
      response: '',
    });
    expect(await reader.getUserEntries(auditEntry.userId, 1)).toEqual([entry]);
    expect(await reader.getUserEntries('another-user')).toEqual([]);
    expect(await reader.getUserEntries(auditEntry.userId, 0)).toEqual([]);
    expect(await reader.getEntriesByType('resume')).toEqual([entry]);
    expect(await reader.search('USER[1]')).toEqual([entry]);
    expect(await reader.search('private')).toEqual([]);
    expect(await reader.getEntry('invalid-id')).toBeUndefined();

    const stored = await AuditLogModel.findById(entry!.logId).lean();
    expect(stored).not.toHaveProperty('prompt');
    expect(stored).not.toHaveProperty('systemPrompt');
    expect(stored).not.toHaveProperty('response');
    expect(stored).not.toHaveProperty('errorMessage');
  });

  it('aggregates current and legacy rows with timeframe filtering and correct totals', async () => {
    const audit = new AIResponseAuditLogClass();
    await audit.log(auditEntry);
    const failed = await audit.log({
      ...auditEntry,
      latency: 200,
      tokensUsed: 10,
      cached: true,
      success: false,
      moderationFlags: [],
      hallucinationFlags: ['claim'],
      safetyViolations: ['policy'],
    });
    await AuditLogModel.collection.insertOne({
      userId: 'legacy-user',
      prompt: 'old private prompt',
      response: 'old private response',
      provider: 'openai',
      latencyMs: 300,
      tokensUsed: 5,
      moderationFlags: [],
      hallucinationFlags: [],
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    expect(await audit.calculateStats()).toEqual({
      totalRequests: 3,
      totalTokens: 35,
      averageLatency: 200,
      cacheHitRate: 33,
      moderationFlagCount: 2,
      hallucinationFlagCount: 1,
      safetyViolationCount: 1,
      failureCount: 1,
      byProvider: {
        gemini: { requests: 2, tokens: 30, latency: 150 },
        openai: { requests: 1, tokens: 5, latency: 300 },
      },
      byModel: {
        'gemini-test': { requests: 2, tokens: 30, latency: 150 },
        unknown: { requests: 1, tokens: 5, latency: 300 },
      },
    });
    expect(await audit.calculateStats('hour')).toMatchObject({
      totalRequests: 2, totalTokens: 30, averageLatency: 150, cacheHitRate: 50,
    });
    expect(await audit.getFlaggedEntries('safety')).toEqual([failed]);
    expect(await audit.getFailedEntries()).toEqual([expect.objectContaining({ errorCode: 'provider_error' })]);
    expect(await AuditLogModel.findById(failed!.logId).lean()).not.toHaveProperty('errorMessage');
    expect(await audit.getUserEntries('legacy-user')).toMatchObject([{ success: true, model: 'unknown', prompt: '' }]);
  });

  it('returns the adapter response even when the audit write fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const create = vi.spyOn(AuditLogModel, 'create').mockRejectedValue(new Error('private DB payload'));
    try {
      expect(await AIProviderAdapter.generateResponse('user[1]', '', 'kubernetes')).toContain('orchestration');
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[AIResponseAuditLog] Failed to persist audit entry'));
      expect(warn.mock.calls.flat()).not.toContain('private DB payload');
      expect(await new AIResponseAuditLogClass().getLogSize()).toBe(0);
    } finally {
      create.mockRestore();
      warn.mockRestore();
    }
  });

  it('records live adapter success and exhausted failover using only audit metadata', async () => {
    const providerBody = 'private provider diagnostic with a credential';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: 'private generated response' } }],
        usage: { total_tokens: 12 },
      }))
      .mockImplementation(async () => new Response(providerBody, { status: 429 }));

    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('OPENAI_API_KEY', 'unit-test-key');
    vi.stubEnv('GEMINI_API_KEY', '');
    const request = {
      prompt: 'private resume',
      systemPrompt: 'private instructions',
      tenantScope: 'provider-audit-user',
      responseSchemaVersion: 'test-v1',
      cache: false,
    };

    try {
      await expect(LiveAIProviderAdapter.generateResponse({ ...request, providerPreference: 'openai' }))
        .resolves.toMatchObject({ provider: 'openai', tokensUsed: 12 });
      vi.useFakeTimers();
      const failure = expect(LiveAIProviderAdapter.generateResponse({ ...request, providerPreference: 'gemini' }))
        .rejects.toThrow('provider_rate_limited');
      await vi.advanceTimersByTimeAsync(6000);
      vi.useRealTimers();
      await failure;

      await vi.waitFor(async () => {
        const rows = await AuditLogModel.find({ userId: request.tenantScope }).lean();
        expect(rows).toHaveLength(2);
        expect(rows).toEqual(expect.arrayContaining([
          expect.objectContaining({ provider: 'openai', success: true, tokensUsed: 12, contextVersion: 'test-v1' }),
          expect.objectContaining({ provider: 'openai', success: false, errorCode: 'provider_rate_limited', tokensUsed: 0 }),
        ]));
        expect(JSON.stringify(rows)).not.toMatch(/private|unit-test-key/);
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('installs the retention and user query indexes', async () => {
    await AuditLogModel.createIndexes();
    expect(await AuditLogModel.collection.indexes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { createdAt: 1 }, expireAfterSeconds: AI_AUDIT_RETENTION_SECONDS }),
      expect.objectContaining({ key: { userId: 1, createdAt: -1, _id: -1 } }),
    ]));
  });
});
