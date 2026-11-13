// src/__tests__/modules/beta-validation.test.ts
// Unit tests for closed beta onboarding, telemetry, feedback calibration loops, and product readiness reporting.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BetaAccessInfrastructure } from '../../modules/onboarding/BetaAccessInfrastructure.js';
import { FeedbackIntelligenceLoop, FeedbackReport } from '../../modules/calibration/FeedbackIntelligenceLoop.js';
import { ProductReadinessEvaluation } from '../../modules/calibration/ProductReadinessEvaluation.js';
import { ResumeCredibility } from '../../db/models/resumeCredibility.model.js';
import { ResumeSession } from '../../db/models/resumeSession.model.js';
import { User } from '../../db/models/user.model.js';
import { getRedisClient, isRedisConfigured } from '../../shared/redis/client.js';

// Mock Redis client singleton
vi.mock('../../shared/redis/client.js', () => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    lpush: vi.fn(),
    ltrim: vi.fn(),
    hset: vi.fn(),
    incr: vi.fn(),
    eval: vi.fn(),
  };
  return {
    getRedisClient: () => mockRedis,
    isRedisConfigured: vi.fn(() => true),
    disconnectRedis: vi.fn(),
  };
});

vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('BetaAccessInfrastructure', () => {
  let mockRedis: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = getRedisClient();
  });

  describe('validateInviteCode', () => {
    it('should redeem an issued invite code through one atomic eval call', async () => {
      mockRedis.eval.mockResolvedValue([1, 'cohort-a-standard', 3, 5]);

      const result = await BetaAccessInfrastructure.validateInviteCode('Valid_Code');

      expect(result).toEqual({ valid: true, cohortId: 'cohort-a-standard' });
      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
      expect(mockRedis.eval).toHaveBeenCalledWith(expect.any(String), 1, 'beta:invite:valid_code');
      // No separate read-modify-write on the invite key
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should fail validation when invite code has reached maximum uses', async () => {
      mockRedis.eval.mockResolvedValue([2, '', 3, 3]);

      const result = await BetaAccessInfrastructure.validateInviteCode('expired_code');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invite code maximum usage reached');
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should return invalid for unknown codes', async () => {
      mockRedis.eval.mockResolvedValue([0, '', 0, 0]);

      const result = await BetaAccessInfrastructure.validateInviteCode('unknown_code');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid invite code');
    });
  });

  describe('validateInviteCode against a fake invite store', () => {
    // In-memory stand-in for Redis. get/set yield to the event loop like a network call, so a
    // read-modify-write implementation interleaves. eval runs the script's logic synchronously,
    // which is what Redis guarantees for a Lua script (no other command runs in between).
    let store: Map<string, string>;
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

    beforeEach(() => {
      store = new Map();
      mockRedis = getRedisClient();
      mockRedis.get.mockImplementation(async (key: string) => {
        await tick();
        return store.get(key) ?? null;
      });
      mockRedis.set.mockImplementation(async (key: string, value: string) => {
        await tick();
        store.set(key, value);
        return 'OK';
      });
      mockRedis.eval.mockImplementation(async (_script: string, _numKeys: number, key: string) => {
        await tick();
        const data = store.get(key);
        if (!data) return [0, '', 0, 0];
        const invite = JSON.parse(data);
        if (invite.usesCount >= invite.maxUses) return [2, '', invite.usesCount, invite.maxUses];
        invite.usesCount += 1;
        store.set(key, JSON.stringify(invite));
        return [1, invite.cohortId, invite.usesCount, invite.maxUses];
      });
    });

    afterEach(() => {
      mockRedis.get.mockReset();
      mockRedis.set.mockReset();
      mockRedis.eval.mockReset();
    });

    it('should reject an unissued code that starts with DEVTRACK_BETA_', async () => {
      const infra = await BetaAccessInfrastructure.validateInviteCode('DEVTRACK_BETA_INFRA');
      expect(infra).toEqual({ valid: false, cohortId: '', error: 'Invalid invite code' });

      const any = await BetaAccessInfrastructure.validateInviteCode('DEVTRACK_BETA_ANY');
      expect(any).toEqual({ valid: false, cohortId: '', error: 'Invalid invite code' });
    });

    it('should still accept a DEVTRACK_BETA_ code once it has actually been issued', async () => {
      await BetaAccessInfrastructure.createInviteCode('DEVTRACK_BETA_REAL', 'cohort-b-heavy-infra', 1);

      const result = await BetaAccessInfrastructure.validateInviteCode('DEVTRACK_BETA_REAL');
      expect(result).toEqual({ valid: true, cohortId: 'cohort-b-heavy-infra' });
    });

    it('should allow exactly one of 10 concurrent redemptions on a maxUses: 1 invite', async () => {
      await BetaAccessInfrastructure.createInviteCode('single_use', 'cohort-a-standard', 1);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => BetaAccessInfrastructure.validateInviteCode('single_use')),
      );

      expect(results.filter((r) => r.valid)).toHaveLength(1);
      const rejected = results.filter((r) => !r.valid);
      expect(rejected).toHaveLength(9);
      expect(rejected.every((r) => r.error === 'Invite code maximum usage reached')).toBe(true);
      expect(JSON.parse(store.get('beta:invite:single_use')!).usesCount).toBe(1);
    });

    it('should never exceed maxUses when more concurrent redemptions arrive than uses remain', async () => {
      await BetaAccessInfrastructure.createInviteCode('three_use', 'cohort-a-standard', 3);

      const results = await Promise.all(
        Array.from({ length: 12 }, () => BetaAccessInfrastructure.validateInviteCode('three_use')),
      );

      expect(results.filter((r) => r.valid)).toHaveLength(3);
      expect(JSON.parse(store.get('beta:invite:three_use')!).usesCount).toBe(3);
    });
  });

  describe('isFeatureEnabled', () => {
    it('should enable specific features based on cohort rules', () => {
      // live-semantic-search: active for cohort-b or based on user charCode % 2
      expect(BetaAccessInfrastructure.isFeatureEnabled('user1', 'live-semantic-search', 'cohort-b-heavy-infra')).toBe(true);
      
      // user1 charCode('u') is 117 (odd), user2 charCode('u') is 117, wait, charCode(0) of 'A' is 65 (odd), 'B' is 66 (even)
      expect(BetaAccessInfrastructure.isFeatureEnabled('B', 'live-semantic-search', 'cohort-a-standard')).toBe(true);
      expect(BetaAccessInfrastructure.isFeatureEnabled('A', 'live-semantic-search', 'cohort-a-standard')).toBe(false);

      // ats-realism-heatmap is fully rolled out
      expect(BetaAccessInfrastructure.isFeatureEnabled('any', 'ats-realism-heatmap')).toBe(true);

      // evolution-replay-scrubber is infra cohort only
      expect(BetaAccessInfrastructure.isFeatureEnabled('any', 'evolution-replay-scrubber', 'cohort-b-heavy-infra')).toBe(true);
      expect(BetaAccessInfrastructure.isFeatureEnabled('any', 'evolution-replay-scrubber', 'cohort-a-standard')).toBe(false);
    });
  });

  describe('trackTelemetry', () => {
    it('should log telemetry events to Redis lists and update user progression hashes', async () => {
      const eventDate = new Date();
      await BetaAccessInfrastructure.trackTelemetry({
        userId: 'dev_user_123',
        eventType: 'github_connected',
        timestamp: eventDate,
        metadata: { repoCount: 5 },
      });

      expect(mockRedis.lpush).toHaveBeenCalledWith('beta:telemetry:events', expect.any(String));
      expect(mockRedis.ltrim).toHaveBeenCalledWith('beta:telemetry:events', 0, 9999);
      expect(mockRedis.hset).toHaveBeenCalledWith('beta:telemetry:user:dev_user_123', {
        [`last_event:github_connected`]: eventDate.toISOString(),
        current_state: 'github_connected',
      });
    });
  });

  describe('createInviteCode', () => {
    it('should create invite code with a known cohort', async () => {
      await BetaAccessInfrastructure.createInviteCode('new_invite', 'cohort-b-heavy-infra', 20);
      expect(mockRedis.set).toHaveBeenCalled();
      const setCallArgs = mockRedis.set.mock.calls[0];
      expect(setCallArgs[0]).toBe('beta:invite:new_invite');
      expect(JSON.parse(setCallArgs[1])).toMatchObject({
        code: 'new_invite',
        cohortId: 'cohort-b-heavy-infra',
        maxUses: 20,
      });
    });

    it('should throw error for unknown cohortId', async () => {
      await expect(
        BetaAccessInfrastructure.createInviteCode('invalid_cohort_invite', 'unknown-cohort')
      ).rejects.toThrow('Unknown cohortId: unknown-cohort');
    });
  });
});

describe('FeedbackIntelligenceLoop', () => {
  let mockRedis: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = getRedisClient();
  });

  describe('submitFeedback', () => {
    it('should save feedback report and increment category mismatch logs counter', async () => {
      const mockReport: FeedbackReport = {
        reportId: 'rep_001',
        userId: 'usr_002',
        source: 'recruiter',
        category: 'semantic_mismatch',
        mismatchDetails: {
          expectedValue: 'infra engineer',
          systemValue: 'web designer',
          reasoning: 'Missing docker signal indexing',
        },
        timestamp: new Date(),
      };

      mockRedis.get.mockResolvedValue('3'); // Current mismatch counter is 3

      await FeedbackIntelligenceLoop.submitFeedback(mockReport);

      expect(mockRedis.lpush).toHaveBeenCalledWith('calibration:feedback:list', expect.any(String));
      expect(mockRedis.incr).toHaveBeenCalledWith('calibration:mismatches:semantic_mismatch');
    });

    it('should trigger dynamic weights recalibration when threshold matches multiplier of 10', async () => {
      const mockReport: FeedbackReport = {
        reportId: 'rep_002',
        userId: 'usr_003',
        source: 'developer',
        category: 'ats',
        mismatchDetails: {
          expectedValue: 'ATS formatted parser parseable text',
          systemValue: 'broken JSON text',
          reasoning: 'broken columns',
        },
        timestamp: new Date(),
      };

      // Set mock counters to 10 to trigger calibration check
      mockRedis.get.mockImplementation((key: string) => {
        if (key === 'calibration:mismatches:ats') return Promise.resolve('10');
        if (key === 'calibration:weights:ats') return Promise.resolve('1.0');
        return Promise.resolve(null);
      });

      await FeedbackIntelligenceLoop.submitFeedback(mockReport);

      // Calibration triggered!
      expect(mockRedis.set).toHaveBeenCalledWith('calibration:weights:ats', '1.05');
    });

    it('should calibrate semantic match threshold down when recruiter semantic mismatches occur', async () => {
      const mockReport: FeedbackReport = {
        reportId: 'rep_003',
        userId: 'usr_004',
        source: 'recruiter',
        category: 'semantic_mismatch',
        mismatchDetails: { expectedValue: 'A', systemValue: 'B', reasoning: 'C' },
        timestamp: new Date(),
      };

      mockRedis.get.mockImplementation((key: string) => {
        if (key === 'calibration:mismatches:semantic_mismatch') return Promise.resolve('20');
        if (key === 'calibration:weights:semantic_mismatch') return Promise.resolve('0.85');
        return Promise.resolve(null);
      });

      await FeedbackIntelligenceLoop.submitFeedback(mockReport);

      // Semantic matching threshold calibration reduces score threshold by 0.05
      expect(mockRedis.set).toHaveBeenCalledWith('calibration:weights:semantic_mismatch', '0.8');
    });
  });

  describe('getFeedbackStats', () => {
    it('should compile stats for all active feedback categories', async () => {
      mockRedis.get.mockImplementation((key: string) => {
        if (key === 'calibration:mismatches:onboarding') return Promise.resolve('5');
        if (key === 'calibration:mismatches:recommendation') return Promise.resolve('12');
        if (key === 'calibration:mismatches:ats') return Promise.resolve('2');
        return Promise.resolve(null);
      });

      const stats = await FeedbackIntelligenceLoop.getFeedbackStats();

      expect(stats).toEqual({
        onboarding: 5,
        recommendation: 12,
        ats: 2,
        semantic_mismatch: 0,
        credibility: 0,
      });
    });
  });
});

describe('ProductReadinessEvaluation', () => {
  const redisGet = vi.mocked(getRedisClient().get);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(isRedisConfigured).mockReturnValue(true);
    redisGet.mockReset().mockResolvedValue(null);
  });

  it('reports a cold start when telemetry and database records are absent', async () => {
    const result = await ProductReadinessEvaluation.executeDiagnosticSuite();

    expect(Object.values(result.scorecard)).toEqual(Array(7).fill(0));
    expect(result.overallScore).toBe(0);
    expect(result.report.match(/Telemetry Awaiting Data/g)).toHaveLength(8);
    expect(result.report).not.toContain('BETA READY');
  });

  it('falls back to MongoDB as a pair and reports only domains with data', async () => {
    const users = await User.insertMany(['first', 'second', 'third'].map((name) => ({
      clerkId: name,
      email: `${name}@example.test`,
      username: name,
      displayName: name,
    })));
    const userId = users[0]._id;
    await ResumeSession.collection.insertMany([
      {
        sessionId: 'replayed',
        userId,
        currentStage: 'COMPLETED',
        replayState: { generated: true, timeline: [{ type: 'runtime_event' }] },
        semanticState: { analyzed: true, retrievalResults: [{ id: 'match', score: 0.8 }] },
        recommendationState: { generated: true },
        atsState: { analyzed: true },
      },
      { sessionId: 'duplicate-user', userId, currentStage: 'COMPLETED' },
      { sessionId: 'failed', userId: users[1]._id, currentStage: 'FAILED' },
      { sessionId: 'anonymous', currentStage: 'UPLOADED' },
    ]);
    await ResumeCredibility.create({ sessionId: 'replayed', overallCredibility: 80, summary: 'Credibility reviewed' });

    redisGet.mockImplementation(async (key) => {
      if (key === 'beta:telemetry:onboard_starts') return '200';
      if (key === 'calibration:mismatches:semantic_mismatch') return '1';
      return null;
    });

    const result = await ProductReadinessEvaluation.executeDiagnosticSuite();

    expect(result.scorecard).toEqual({
      onboardingMaturity: 33,
      operationalMaturity: 0,
      semanticMaturity: 0,
      recommendationMaturity: 100,
      atsMaturity: 100,
      replayMaturity: 50,
      recruiterMaturity: 80,
    });
    expect(result.overallScore).toBe(61);
    expect(result.report).toContain('6 of 7 domains measured');
    expect(result.report).toContain('MongoDB registered users');
    expect(result.report).toContain('1 completions / 3 starts or registrations');
  });

  it('uses recorded volume and bounds high-volume mismatch spikes and conversion overcounts', async () => {
    const readings: Record<string, string> = {
      'beta:telemetry:onboard_starts': '1000000',
      'beta:telemetry:onboard_completes': '1100000',
      'observability:latency:p95': '140',
      'calibration:mismatches:semantic_mismatch': '1100000',
      'calibration:mismatches:recommendation': '100000',
      'calibration:mismatches:ats': '0',
    };
    redisGet.mockImplementation(async (key) => readings[String(key)] ?? null);
    vi.spyOn(ResumeSession, 'countDocuments').mockImplementation((filter) => Promise.resolve(
      filter && 'currentStage' in filter ? 0 : 1_000_000,
    ) as ReturnType<typeof ResumeSession.countDocuments>);

    const result = await ProductReadinessEvaluation.executeDiagnosticSuite();

    expect(result.scorecard).toEqual({
      onboardingMaturity: 100,
      operationalMaturity: 95,
      semanticMaturity: 0,
      recommendationMaturity: 90,
      atsMaturity: 100,
      replayMaturity: 0,
      recruiterMaturity: 0,
    });
    expect(result.overallScore).toBe(77);
    expect(result.report).toContain('Semantic retrieval:** 0%');
    expect(result.report).toContain('Redis P95 latency (140ms)');
  });

  it('uses MongoDB telemetry when Redis is disabled', async () => {
    vi.mocked(isRedisConfigured).mockReturnValue(false);

    const result = await ProductReadinessEvaluation.executeDiagnosticSuite();

    expect(redisGet).not.toHaveBeenCalled();
    expect(result.report).toContain('Redis mismatch reports (unavailable)');
    expect(result.report).toContain('Telemetry Awaiting Data');
  });
});
