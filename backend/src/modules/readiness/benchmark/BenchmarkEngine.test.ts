import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CareerIntent } from '../../../db/models/careerIntent.model.js';
import { ReadinessBenchmarks } from '../../../db/models/readinessBenchmarks.model.js';
import { ReadinessCore } from '../../../db/models/readinessCore.model.js';
import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { BenchmarkEngine } from './BenchmarkEngine.js';

const redis = vi.hoisted(() => ({
  status: 'ready',
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('../../../shared/redis/index.js', () => ({ getRedisClient: () => redis }));

const target = { dreamRole: 'Backend Engineer', targetCompanyTier: 'Product', experienceLevel: 'Junior' };

async function seed(userId: string, overallScore: number, criteria?: typeof target) {
  await ReadinessCore.create({ userId, overallScore });
  if (criteria) await CareerIntent.create({ userId, ...criteria });
}

describe('readiness cohort benchmarks', () => {
  const cache = new Map<string, string>();

  beforeEach(() => {
    cache.clear();
    redis.status = 'ready';
    redis.get.mockReset().mockImplementation(async (key: string) => cache.get(key) ?? null);
    redis.set.mockReset().mockImplementation(async (key: string, value: string) => { cache.set(key, value); });
  });

  it('uses the real role, tier and experience cohort and reuses its cached distribution', async () => {
    const cohort = Array.from({ length: 30 }, (_, index) => ({
      userId: `peer-${index}`,
      overallScore: Math.floor(index / 2) * 5,
    }));
    const outsiders = [
      { userId: 'frontend', ...target, dreamRole: 'Frontend Engineer' },
      { userId: 'other-tier', ...target, targetCompanyTier: 'Consulting' },
      { userId: 'senior', ...target, experienceLevel: 'Senior' },
    ];
    await ReadinessCore.insertMany([
      ...cohort,
      ...outsiders.map(({ userId }) => ({ userId, overallScore: 0 })),
    ]);
    await CareerIntent.insertMany([
      ...cohort.map(({ userId }) => ({ userId, ...target })),
      ...outsiders,
      { userId: 'intent-only', ...target },
    ]);
    await ReadinessDsa.insertMany(cohort.map(({ userId, overallScore }) => ({ userId, totalSolves: overallScore })));

    const aggregate = vi.spyOn(CareerIntent, 'aggregate');
    try {
      await BenchmarkEngine.generateBenchmarks({ userId: 'peer-14' });
      await BenchmarkEngine.generateBenchmarks({ userId: 'peer-15' });

      const first = await ReadinessBenchmarks.findOne({ userId: 'peer-14' }).lean();
      const second = await ReadinessBenchmarks.findOne({ userId: 'peer-15' }).lean();
      expect(first?.cohortSegments[0]).toMatchObject({
        sampleSize: 30,
        percentileRanking: 53,
        confidenceLevel: 'medium',
        cohortName: 'Backend Engineer · Product · Junior',
      });
      expect(first?.percentileRankings).toContainEqual(expect.objectContaining({
        metric: 'Total DSA Solves', percentile: 53, cohortAverage: 35, cohortMedian: 35, cohortP90: 65,
      }));
      expect(second?.cohortSegments[0].freshnessTimestamp).toEqual(first?.cohortSegments[0].freshnessTimestamp);
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(expect.stringMatching(/^readiness:cohort:v1:/), expect.any(String), 'EX', 1800);
      expect([...cache.values()][0]).not.toContain('peer-');
    } finally {
      aggregate.mockRestore();
    }
  });

  it('labels the global fallback and excludes missing domain measurements', async () => {
    await seed('junior', 50, target);
    await seed('senior', 100, { ...target, experienceLevel: 'Senior' });
    await seed('unsegmented', 25);
    await ReadinessDsa.create({ userId: 'junior', totalSolves: 20 });

    await BenchmarkEngine.generateBenchmarks({ userId: 'junior' });
    await BenchmarkEngine.generateBenchmarks({ userId: 'unsegmented' });
    const junior = await ReadinessBenchmarks.findOne({ userId: 'junior' }).lean();
    const unsegmented = await ReadinessBenchmarks.findOne({ userId: 'unsegmented' }).lean();
    expect(junior?.cohortSegments[0]).toMatchObject({
      cohortId: 'global', cohortName: 'All readiness users', sampleSize: 3, percentileRanking: 67,
    });
    expect(junior?.percentileRankings).toContainEqual(expect.objectContaining({ metric: 'Total DSA Solves', cohortAverage: 20 }));
    expect(unsegmented?.percentileRankings).toEqual([]);
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it('caps large cohorts and selects the same sample after cache expiry', async () => {
    await ReadinessCore.insertMany(Array.from({ length: 2001 }, (_, index) => ({
      userId: `global-${index}`,
      overallScore: index % 101,
    })));
    await BenchmarkEngine.generateBenchmarks({ userId: 'global-0' });
    const first = JSON.parse([...cache.values()][0]);
    cache.clear();
    await BenchmarkEngine.generateBenchmarks({ userId: 'global-1' });
    const second = JSON.parse([...cache.values()][0]);

    expect(first.sampleSize).toBe(2000);
    expect(first.overallScore).toHaveLength(2000);
    expect(second.overallScore).toEqual(first.overallScore);
  });

  it('computes results from MongoDB when Redis fails', async () => {
    redis.get.mockRejectedValueOnce(new Error('cache unavailable'));
    redis.set.mockRejectedValueOnce(new Error('cache unavailable'));
    await seed('global-user', 42);
    await BenchmarkEngine.generateBenchmarks({ userId: 'global-user' });
    const stored = await ReadinessBenchmarks.findOne({ userId: 'global-user' }).lean();
    expect(stored?.cohortSegments[0]).toMatchObject({ sampleSize: 1, percentileRanking: 100, confidenceLevel: 'low' });
  });
});
