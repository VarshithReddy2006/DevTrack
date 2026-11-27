// src/modules/calibration/__tests__/FeedbackIntelligenceLoop.test.ts

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { FeedbackIntelligenceLoop, type FeedbackReport } from '../FeedbackIntelligenceLoop.js';
import { FeedbackReportModel } from '../../../db/models/feedbackReport.model.js';

// In-memory Redis simulation for realistic list trimming, atomic counters, and distributed locking
class MockRedisClient {
  public lists = new Map<string, string[]>();
  public kv = new Map<string, string>();
  public ttls = new Map<string, number>();
  public status = 'ready';

  async mset(...pairs: string[]): Promise<'OK'> {
    for (let i = 0; i < pairs.length; i += 2) this.kv.set(pairs[i], pairs[i + 1]);
    return 'OK';
  }

  async lpush(key: string, val: string): Promise<number> {
    const list = this.lists.get(key) || [];
    list.unshift(val);
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const list = this.lists.get(key) || [];
    const trimmed = stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
    this.lists.set(key, trimmed);
    return 'OK';
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) || [];
    return stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.ttls.set(key, seconds);
    return 1;
  }

  async incr(key: string): Promise<number> {
    const current = parseInt(this.kv.get(key) || '0', 10);
    const next = current + 1;
    this.kv.set(key, next.toString());
    return next;
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async set(key: string, val: string, ...args: (string | number)[]): Promise<'OK' | null> {
    // Check for PX <ttl> NX
    if (args.includes('NX')) {
      if (this.kv.has(key)) {
        return null; // Key already exists, lock acquisition failed
      }
      this.kv.set(key, val);
      return 'OK';
    }

    this.kv.set(key, val);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const deleted = this.kv.delete(key);
    return deleted ? 1 : 0;
  }

  async eval(script: string, numKeys: number, key: string, token: string): Promise<number> {
    // Lua release lock script simulation:
    // if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end
    if (this.kv.get(key) === token) {
      this.kv.delete(key);
      return 1;
    }
    return 0;
  }

  clear() {
    this.lists.clear();
    this.kv.clear();
    this.ttls.clear();
    this.status = 'ready';
  }
}

const mockRedis = new MockRedisClient();
const redisState = { configured: true };

vi.mock('../../../shared/redis/client.js', () => ({
  getRedisClient: () => mockRedis,
  isRedisConfigured: () => redisState.configured,
}));

describe('FeedbackIntelligenceLoop - Persistence, List Bounding & Distributed Recalibration Lock', () => {
  beforeAll(async () => {
    await FeedbackReportModel.init();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    redisState.configured = true;
  });

  beforeEach(async () => {
    mockRedis.clear();
    await FeedbackReportModel.deleteMany({});
  });

  const createDummyReport = (overrides?: Partial<FeedbackReport>): FeedbackReport => ({
    reportId: `report-${Math.random().toString(36).slice(2, 9)}`,
    userId: 'user_123',
    source: 'recruiter',
    category: 'semantic_mismatch',
    mismatchDetails: {
      expectedValue: 'Senior Backend Engineer',
      systemValue: 'Junior Fullstack Engineer',
      reasoning: 'Candidate has 7 years distributed systems experience',
    },
    context: {
      jobId: 'job_abc',
      scoreBefore: 0.62,
    },
    timestamp: new Date(),
    ...overrides,
  });

  describe('MongoDB Persistence', () => {
    it('persists submitted feedback reports into MongoDB with correct fields and indexes', async () => {
      const report = createDummyReport({
        reportId: 'rep-persistent-1',
        category: 'ats',
        source: 'developer',
      });

      await FeedbackIntelligenceLoop.submitFeedback(report);

      const saved = await FeedbackReportModel.findOne({ reportId: 'rep-persistent-1' });
      expect(saved).not.toBeNull();
      expect(saved?.userId).toBe('user_123');
      expect(saved?.category).toBe('ats');
      expect(saved?.source).toBe('developer');
      expect(saved?.mismatchDetails.reasoning).toBe('Candidate has 7 years distributed systems experience');
      expect(saved?.context).toEqual({ jobId: 'job_abc', scoreBefore: 0.62 });
    });

    it('queries persisted reports via getReports helper', async () => {
      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: 'rep-query-1', category: 'onboarding' }));
      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: 'rep-query-2', category: 'ats' }));
      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: 'rep-query-3', category: 'onboarding' }));

      const onboardingReports = await FeedbackIntelligenceLoop.getReports({ category: 'onboarding' });
      expect(onboardingReports).toHaveLength(2);

      const allReports = await FeedbackIntelligenceLoop.getReports({ limit: 10 });
      expect(allReports).toHaveLength(3);
    });
  });

  describe('Redis List Retention & Bounding', () => {
    it('buffers submitted feedback into Redis list and trims to latest 500 reports', async () => {
      const listKey = 'calibration:feedback:list';

      for (let i = 0; i < 25; i++) {
        await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: `rep-trim-${i}` }));
      }

      const listItems = await mockRedis.lrange(listKey, 0, -1);
      expect(listItems.length).toBe(25);
      expect(mockRedis.ttls.get(listKey)).toBe(30 * 24 * 3600); // 30-day retention
    });

    it('enforces maximum 500 items boundary when submissions exceed limit', async () => {
      const listKey = 'calibration:feedback:list';

      // Pre-populate list with 500 items
      for (let i = 0; i < 500; i++) {
        await mockRedis.lpush(listKey, JSON.stringify({ reportId: `old-${i}` }));
      }

      // Submit one more through submitFeedback
      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: 'rep-501' }));

      const listItems = await mockRedis.lrange(listKey, 0, -1);
      expect(listItems.length).toBe(500);

      const newest = JSON.parse(listItems[0]);
      expect(newest.reportId).toBe('rep-501');
    });
  });

  describe('Atomic Recalibration & Distributed Lock', () => {
    it('recalibrates calibration weights when threshold hits a multiple of 10', async () => {
      const category = 'semantic_mismatch';
      const weightKey = `calibration:weights:${category}`;

      // Submit 9 reports: counter reaches 9, no recalibration
      for (let i = 1; i <= 9; i++) {
        await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: `rep-step-${i}`, category }));
      }
      expect(await mockRedis.get(weightKey)).toBeNull();

      // Submit 10th report: triggers recalibration
      // Default factor is 1.0; semantic_mismatch drops factor by 0.05 -> 0.95
      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: 'rep-step-10', category }));

      const weight = await mockRedis.get(weightKey);
      expect(weight).toBe('0.95');
    });

    it('correctly adjusts factors for ats and recommendation categories', async () => {
      // ats category increases strictness (+0.05 from 1.0 -> 1.05)
      for (let i = 1; i <= 10; i++) {
        await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: `rep-ats-${i}`, category: 'ats' }));
      }
      expect(await mockRedis.get('calibration:weights:ats')).toBe('1.05');

      // recommendation category reduces velocity (-0.1 from 1.0 -> 0.9)
      for (let i = 1; i <= 10; i++) {
        await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: `rep-rec-${i}`, category: 'recommendation' }));
      }
      expect(await mockRedis.get('calibration:weights:recommendation')).toBe('0.9');
    });

    it('safely handles 20 concurrent feedback submissions without race conditions or lost records', async () => {
      const category = 'semantic_mismatch';
      const reports = Array.from({ length: 20 }, (_, index) =>
        createDummyReport({
          reportId: `concurrent-${index}`,
          category,
          userId: `user-${index}`,
        })
      );

      // Submit 20 reports concurrently
      await Promise.all(reports.map((report) => FeedbackIntelligenceLoop.submitFeedback(report)));

      // 1. Verify MongoDB persisted all 20 reports
      const totalDocs = await FeedbackReportModel.countDocuments({ category });
      expect(totalDocs).toBe(20);

      // 2. Verify Redis counter reached 20
      const counterVal = await mockRedis.get(`calibration:mismatches:${category}`);
      expect(counterVal).toBe('20');

      // 3. Verify distributed lock was released after calibration runs
      const lockVal = await mockRedis.get(`calibration:lock:${category}`);
      expect(lockVal).toBeNull();

      // 4. Verify weight was recalibrated across the two threshold crossings (at 10 and 20)
      // Initial 1.0 -> 0.95 at count 10 -> 0.90 at count 20
      const weightVal = await mockRedis.get(`calibration:weights:${category}`);
      expect(weightVal).toBe('0.9');
    });

    it('skips concurrent recalibration when another worker holds the lock', async () => {
      const category = 'ats';
      const lockKey = `calibration:lock:${category}`;

      // Simulate lock already acquired by another worker
      await mockRedis.set(lockKey, 'other-worker-token', 'PX', 5000, 'NX');

      // Submit 10 reports to cross threshold
      for (let i = 1; i <= 10; i++) {
        await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: `rep-locked-${i}`, category }));
      }

      // Weight should NOT be modified because the lock was held by another worker
      expect(await mockRedis.get(`calibration:weights:${category}`)).toBeNull();

      // External lock should still be in place
      expect(await mockRedis.get(lockKey)).toBe('other-worker-token');
      await mockRedis.del(lockKey);
    });

    const submit = async (count: number, category: FeedbackReport['category'], prefix = 'rep') => {
      for (let i = 1; i <= count; i++) {
        await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: `${prefix}-${i}`, category }));
      }
    };

    it('runs the contended 10th-mismatch calibration once the lock clears, with no further feedback', async () => {
      const lockKey = 'calibration:lock:semantic_mismatch';
      await mockRedis.set(lockKey, 'other-worker-token', 'PX', 5000, 'NX');
      await submit(10, 'semantic_mismatch');
      expect(await mockRedis.get('calibration:weights:semantic_mismatch')).toBeNull();

      await mockRedis.del(lockKey);

      await vi.waitFor(async () => {
        expect(await mockRedis.get('calibration:weights:semantic_mismatch')).toBe('0.95');
      }, { timeout: 5000, interval: 100 });
      expect(await mockRedis.get('calibration:last_count:semantic_mismatch')).toBe('10');
    });

    it('picks up a skipped cycle on the next submission and applies it only once', async () => {
      const lockKey = 'calibration:lock:recommendation';
      await mockRedis.set(lockKey, 'other-worker-token', 'PX', 5000, 'NX');
      await submit(10, 'recommendation');
      await mockRedis.del(lockKey);

      await submit(2, 'recommendation', 'later');

      expect(await mockRedis.get('calibration:weights:recommendation')).toBe('0.9');
      expect(await mockRedis.get('calibration:last_count:recommendation')).toBe('10');
    });

    it('applies one step for every block of 10 that piled up behind the lock', async () => {
      const lockKey = 'calibration:lock:ats';
      await mockRedis.set(lockKey, 'other-worker-token', 'PX', 5000, 'NX');
      await submit(20, 'ats');
      await mockRedis.del(lockKey);

      await submit(1, 'ats', 'later');

      expect(await mockRedis.get('calibration:weights:ats')).toBe('1.1');
      expect(await mockRedis.get('calibration:last_count:ats')).toBe('20');
    });

    it.each([
      ['Redis is reconnecting at retry time', () => {
        mockRedis.status = 'reconnecting';
        return () => { mockRedis.status = 'ready'; };
      }],
      ['the retry itself hits a Redis error', () => {
        const spy = vi.spyOn(mockRedis, 'set').mockRejectedValue(new Error('connection lost'));
        return () => { spy.mockRestore(); };
      }],
    ])('keeps retrying when %s', async (_label, breakRedis) => {
      const lockKey = 'calibration:lock:ats';
      await mockRedis.set(lockKey, 'other-worker-token', 'PX', 5000, 'NX');
      await submit(10, 'ats');
      await mockRedis.del(lockKey);
      const restore = breakRedis();

      await new Promise((resolve) => setTimeout(resolve, 1300)); // first retry fails
      expect(await mockRedis.get('calibration:weights:ats')).toBeNull();
      restore();

      await vi.waitFor(async () => {
        expect(await mockRedis.get('calibration:weights:ats')).toBe('1.05');
      }, { timeout: 5000, interval: 100 });
    }, 15000);

    it('calibrates again after the mismatch counter is reset', async () => {
      await mockRedis.set('calibration:last_count:ats', '500');

      await submit(10, 'ats');

      expect(await mockRedis.get('calibration:weights:ats')).toBe('1.05');
      expect(await mockRedis.get('calibration:last_count:ats')).toBe('10');
    });

    it('does not replay history for a counter that predates the last calibrated count', async () => {
      await mockRedis.set('calibration:mismatches:ats', '509');
      await mockRedis.set('calibration:weights:ats', '1.0');

      await submit(1, 'ats');

      expect(await mockRedis.get('calibration:weights:ats')).toBe('1.05');
      expect(await mockRedis.get('calibration:last_count:ats')).toBe('510');
    });
  });

  describe('Degraded Redis', () => {
    it.each([
      ['unconfigured', () => { redisState.configured = false; }],
      ['not connected', () => { mockRedis.status = 'reconnecting'; }],
      ['failing commands', () => {
        vi.spyOn(mockRedis, 'lpush').mockRejectedValue(new Error('connection lost'));
        vi.spyOn(mockRedis, 'get').mockRejectedValue(new Error('connection lost'));
      }],
    ])('persists feedback and counts stats from MongoDB when Redis is %s', async (_label, breakRedis) => {
      breakRedis();

      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: 'rep-down-1', category: 'ats' }));
      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: 'rep-down-2', category: 'ats' }));

      expect(await FeedbackReportModel.countDocuments({ category: 'ats' })).toBe(2);
      expect(await FeedbackIntelligenceLoop.getFeedbackStats()).toEqual({
        onboarding: 0, recommendation: 0, ats: 2, semantic_mismatch: 0, credibility: 0,
      });
      expect(mockRedis.lists.size).toBe(0);
    });

    it('does not hang when a Redis command never settles', async () => {
      vi.spyOn(mockRedis, 'lpush').mockReturnValue(new Promise<number>(() => {}));
      vi.spyOn(mockRedis, 'get').mockReturnValue(new Promise<string | null>(() => {}));

      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: 'rep-hang', category: 'ats' }));
      const stats = await FeedbackIntelligenceLoop.getFeedbackStats();

      expect(stats.ats).toBe(1);
    }, 10000);

    it('still rejects when MongoDB persistence fails', async () => {
      redisState.configured = false;
      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: 'rep-dup' }));
      await expect(
        FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ reportId: 'rep-dup' })),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  describe('Feedback Diagnostics & Metrics', () => {
    it('returns feedback mismatch counts across categories', async () => {
      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ category: 'onboarding' }));
      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ category: 'onboarding' }));
      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ category: 'ats' }));
      await FeedbackIntelligenceLoop.submitFeedback(createDummyReport({ category: 'credibility' }));

      const stats = await FeedbackIntelligenceLoop.getFeedbackStats();
      expect(stats.onboarding).toBe(2);
      expect(stats.ats).toBe(1);
      expect(stats.credibility).toBe(1);
      expect(stats.recommendation).toBe(0);
      expect(stats.semantic_mismatch).toBe(0);
    });
  });
});
