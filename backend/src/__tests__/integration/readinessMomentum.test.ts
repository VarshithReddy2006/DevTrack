import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { DsaSubmission } from '../../db/models/dsaSubmission.model.js';
import { ReadinessCore } from '../../db/models/readinessCore.model.js';
import { ReadinessDsa } from '../../db/models/readinessDsa.model.js';
import { ReadinessProjects } from '../../db/models/readinessProjects.model.js';
import { VerifiedProject } from '../../db/models/verifiedProject.model.js';
import { ReadinessOrchestratorService } from '../../modules/readiness/engine/ReadinessOrchestratorService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('readiness momentum from persisted activity', () => {
  it.each([
    { recent: 3, previous: 1, projectAge: 2, expected: 'improving' },
    { recent: 2, previous: 2, projectAge: 2, expected: 'improving' },
    { recent: 2, previous: 2, projectAge: 20, expected: 'stagnating' },
    { recent: 1, previous: 3, projectAge: 9, expected: 'declining' },
  ])('returns and persists $expected for $recent recent and $previous prior submissions', async ({
    recent, previous, projectAge, expected,
  }) => {
    const owner = new Types.ObjectId();
    const otherOwner = new Types.ObjectId();
    const userId = owner.toHexString();
    const problemId = new Types.ObjectId();
    const now = Date.now();
    const atAge = (age: number) => new Date(now - age * DAY_MS);
    const submission = (age: number, index: number, userId = owner) => ({
      userId,
      problemId,
      platform: 'leetcode',
      status: 'accepted',
      language: 'typescript',
      externalId: String(index),
      submittedAt: atAge(age),
    });
    const project = (age: number, repo: string, status = 'verified', userId = owner) => ({
      userId,
      name: repo,
      githubRepoId: repo,
      repoFullName: `owner/${repo}`,
      repoUrl: `https://github.com/owner/${repo}`,
      verification: { status },
      metrics: { lastCommitAt: atAge(age), userCommitCount: 4 },
    });

    await Promise.all([
      ReadinessDsa.create({ userId, totalSolves: 20, solveConsistency: 85 }),
      ReadinessProjects.create({ userId, complexityMetrics: { contributionConsistency: 75 } }),
      DsaSubmission.insertMany([
        ...Array.from({ length: recent }, (_, index) => submission(2, index)),
        ...Array.from({ length: previous }, (_, index) => submission(9, recent + index)),
        submission(20, 100),
        submission(-1, 101),
        submission(1, 102, otherOwner),
      ]),
      VerifiedProject.insertMany([
        project(projectAge, 'verified-repo'),
        project(1, 'pending-repo', 'pending'),
        project(1, 'other-repo', 'verified', otherOwner),
      ]),
    ]);
    await ReadinessCore.create({ userId, completeness: 100 });

    const snapshot = await ReadinessOrchestratorService.computeDynamicSnapshot(userId);
    expect(snapshot.dynamicState.momentumTrend).toBe(expected);
    expect(await ReadinessCore.findOne({ userId }).lean()).toMatchObject({ momentumTrend: expected });
  });
});
