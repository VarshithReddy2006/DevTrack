import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { DifficultyDistributionSchema, DSAIntelligenceResponseSchema } from './dto/dsa.dto.js';
import { dsaController } from './controller/dsa.controller.js';
import { dsaService } from './service/dsa.service.js';

vi.mock('./service/dsa.service.js', () => ({
  dsaService: { generateDSAIntelligence: vi.fn() },
}));

const difficulties = ['easy', 'medium', 'hard'] as const;
const scores = ['readinessScore', 'consistencyScore', 'hardProgressScore', 'readinessImpact', 'confidenceScore', 'verificationCoverage'] as const;

function intelligence() {
  return {
    readinessScore: 50, consistencyScore: 50, hardProgressScore: 50,
    readinessImpact: 10, confidenceScore: 50, verificationCoverage: 100,
    difficultyDistribution: { easy: 0, medium: 0, hard: 0, total: 0 },
    strongTopics: [] as { topic: string; solved: number; mastery: number }[],
    weakTopics: [] as { topic: string; solved: number; mastery: number }[],
    nextTopics: [] as string[], status: 'stable' as const,
    lastUpdated: new Date('2026-10-30T00:00:00Z'),
  };
}

describe.each(difficulties)('%s solved counts', (difficulty) => {
  it.each([0, 100, 101, 1000])('accepts the integer count %s without converting it to a percentage', (value) => {
    const distribution = { easy: 0, medium: 0, hard: 0, total: value, [difficulty]: value };
    expect(DifficultyDistributionSchema.parse(distribution)).toEqual(distribution);
    const output = intelligence();
    output.difficultyDistribution = distribution;
    expect(DSAIntelligenceResponseSchema.parse(output).difficultyDistribution).toEqual(distribution);
  });

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid count %s', (value) => {
    const result = DifficultyDistributionSchema.safeParse({ easy: 0, medium: 0, hard: 0, total: 0, [difficulty]: value });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(issue => issue.path[0] === difficulty)).toBe(true);
  });
});

describe('actual percentages retain their bounds', () => {
  it.each(scores)('%s accepts 0/100 and rejects -1/101', (score) => {
    for (const value of [0, 100]) {
      expect(DSAIntelligenceResponseSchema.safeParse({ ...intelligence(), [score]: value }).success).toBe(true);
    }
    for (const value of [-1, 101]) {
      const result = DSAIntelligenceResponseSchema.safeParse({ ...intelligence(), [score]: value });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.some(issue => issue.path[0] === score)).toBe(true);
    }
  });

  it.each(['strongTopics', 'weakTopics'] as const)('%s mastery stays bounded while solved counts exceed 100', (topics) => {
    for (const mastery of [0, 100, -1, 101]) {
      const result = DSAIntelligenceResponseSchema.safeParse({ ...intelligence(), [topics]: [{ topic: 'arrays', solved: 1000, mastery }] });
      expect(result.success).toBe(mastery >= 0 && mastery <= 100);
    }
  });
});

describe('DSA intelligence controller response validation', () => {
  beforeEach(() => vi.resetAllMocks());

  async function request(output: ReturnType<typeof intelligence>) {
    vi.mocked(dsaService.generateDSAIntelligence).mockResolvedValue(output);
    const json = vi.fn();
    const next = vi.fn();
    await dsaController.getDSAIntelligence(
      { user: { id: 'synthetic-user' }, query: { platform: 'manual' } } as unknown as Request,
      { json } as unknown as Response,
      next as NextFunction,
    );
    return { json, next };
  }

  for (const difficulty of difficulties) {
    it.each([101, 1000])(`returns ${difficulty} count %s from the service`, async (value) => {
      const output = intelligence();
      output.difficultyDistribution = { easy: 0, medium: 0, hard: 0, total: value, [difficulty]: value };
      const { json, next } = await request(output);
      expect(dsaService.generateDSAIntelligence).toHaveBeenCalledWith({ userId: 'synthetic-user', platform: 'manual' });
      expect(next).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledExactlyOnceWith({ success: true, data: output });
    });

    it.each([-1, 0.5])(`forwards a validation error for ${difficulty} count %s`, async (value) => {
      const output = intelligence();
      output.difficultyDistribution[difficulty] = value;
      const { json, next } = await request(output);
      expect(json).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
      expect(next.mock.calls[0][0].issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['difficultyDistribution', difficulty] }),
      ]));
    });
  }

  it('preserves mixed difficulty counts and their total', async () => {
    const output = intelligence();
    output.difficultyDistribution = { easy: 1000, medium: 101, hard: 1000, total: 2101 };
    const { json, next } = await request(output);
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledExactlyOnceWith({ success: true, data: output });
  });

  it('still rejects an out-of-range percentage alongside valid large counts', async () => {
    const output = intelligence();
    output.difficultyDistribution = { easy: 101, medium: 0, hard: 0, total: 101 };
    output.readinessScore = 101;
    const { json, next } = await request(output);
    expect(json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['readinessScore'] }),
    ]));
  });

  it('forwards service failures without writing a success response', async () => {
    const failure = new Error('synthetic service failure');
    vi.mocked(dsaService.generateDSAIntelligence).mockRejectedValue(failure);
    const json = vi.fn();
    const next = vi.fn();
    await dsaController.getDSAIntelligence(
      { user: { id: 'synthetic-user' }, query: {} } as unknown as Request,
      { json } as unknown as Response,
      next as NextFunction,
    );
    expect(next).toHaveBeenCalledExactlyOnceWith(failure);
    expect(json).not.toHaveBeenCalled();
  });
});
