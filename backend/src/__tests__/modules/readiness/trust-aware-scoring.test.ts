import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { ReadinessCore } from '../../../db/models/readinessCore.model.js';
import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { ReadinessSkills } from '../../../db/models/readinessSkills.model.js';
import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { ReadinessRoadmap } from '../../../db/models/readinessRoadmap.model.js';
import { ReadinessOrchestratorService } from '../../../modules/readiness/engine/ReadinessOrchestratorService.js';
import { TrustAwareReadinessScoringEngine } from '../../../modules/readiness/scoring/TrustAwareReadinessScoringEngine.js';

describe('trust-aware readiness scoring', () => {
  it('preserves healthy pillars and persists coverage when a read fails and a pillar is stale', async () => {
    const userId = new Types.ObjectId().toString();
    await ReadinessDsa.create({
      userId, totalSolves: 100, hardProblemProgression: 80, solveConsistency: 100,
      confidenceScore: 80, evidenceCoverage: 100,
    });
    await ReadinessSkills.create({ userId, overallEngineeringDepth: 50, confidenceScore: 80, evidenceCoverage: 80 });
    await ReadinessRoadmap.create({ userId, computedAt: new Date(0) });
    const projectRead = vi.spyOn(ReadinessProjects, 'findOne').mockImplementationOnce(() => {
      return ReadinessProjects.findOne({ userId }).transform(() => { throw new Error('Projects unavailable'); });
    });

    try {
      const score = await TrustAwareReadinessScoringEngine.calculateReadinessScore({ userId });
      expect(score).toMatchObject({
        dsaScore: 92, skillsScore: 60, overallScore: 73, completeness: 56, confidenceLevel: 44,
        isDegraded: true, missingPillars: ['Projects', 'Benchmarks'], staleProviders: ['Roadmap'],
      });
      expect(await ReadinessCore.findOne({ userId }).lean()).toMatchObject({
        overallScore: 73, confidence: 44, completeness: 56,
        missingPillars: ['Projects', 'Benchmarks'], staleProviders: ['Roadmap'],
      });
    } finally {
      projectRead.mockRestore();
    }
  });

  it('computes a partial snapshot from healthy data before any core score exists', async () => {
    const userId = new Types.ObjectId().toString();
    await ReadinessDsa.create({ userId, totalSolves: 100, confidenceScore: 90 });
    const snapshot = await ReadinessOrchestratorService.computeDynamicSnapshot(userId);
    expect(snapshot.dynamicState).toMatchObject({
      overallScore: 44,
      confidence: 20,
      completeness: 22,
      isDegraded: true,
      missingPillars: ['Skills', 'Projects', 'Roadmap', 'Benchmarks'],
    });
  });

  it('keeps full coverage when all four evidence pillars are present and zeros an empty account', async () => {
    const userId = new Types.ObjectId().toString();
    await Promise.all([
      ReadinessDsa.create({ userId, confidenceScore: 90 }),
      ReadinessSkills.create({ userId, confidenceScore: 90 }),
      ReadinessProjects.create({ userId, evidenceCoverage: 70, confidenceScore: 90 }),
      ReadinessRoadmap.create({ userId, confidenceScore: 90 }),
    ]);
    expect(await TrustAwareReadinessScoringEngine.calculateReadinessScore({ userId })).toMatchObject({
      completeness: 100, confidenceLevel: 90, missingPillars: ['Benchmarks'],
    });
    expect(await TrustAwareReadinessScoringEngine.calculateReadinessScore({
      userId: new Types.ObjectId().toString(),
    })).toMatchObject({ overallScore: 0, completeness: 0, confidenceLevel: 0, readinessTier: 'not_ready' });
  });
});
