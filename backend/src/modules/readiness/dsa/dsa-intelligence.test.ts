import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { CareerIntent } from '../../../db/models/careerIntent.model.js';
import { DsaProblem } from '../../../db/models/dsaProblem.model.js';
import { DSAProfile } from '../../../db/models/dsaProfile.model.js';
import { DsaSubmission } from '../../../db/models/dsaSubmission.model.js';
import { UserProfile } from '../../../db/models/userProfile.model.js';
import { dsaRepository } from './repository/dsa.repository.js';
import { dsaService } from './service/dsa.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function addProblem(userId: Types.ObjectId, difficulty: 'easy' | 'hard', difficultyKnown = true) {
  return DsaProblem.create({
    userId,
    externalId: new Types.ObjectId().toHexString(),
    platform: 'leetcode',
    title: 'Practice problem',
    category: 'algorithms',
    difficulty,
    difficultyKnown,
    url: 'https://example.test/problem',
  });
}

function submit(
  userId: Types.ObjectId,
  problemId: Types.ObjectId,
  submittedAt: Date,
  status: 'accepted' | 'wrong' = 'accepted',
) {
  return DsaSubmission.create({
    userId, problemId, submittedAt, status,
    platform: 'leetcode',
    language: 'typescript',
    externalId: new Types.ObjectId().toHexString(),
  });
}

describe('readiness DSA intelligence', () => {
  it('counts accepted solves in bounded daily buckets and deduplicates across both windows', async () => {
    const owner = new Types.ObjectId();
    const other = new Types.ObjectId();
    const now = new Date('2026-11-12T12:00:00Z');
    const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const prior = await addProblem(owner, 'hard');
    const recent = await addProblem(owner, 'hard');
    const unknown = await addProblem(owner, 'hard', false);
    const easy = await addProblem(owner, 'easy');
    const otherProblem = await addProblem(other, 'hard');

    await Promise.all([
      submit(owner, prior._id, daysAgo(28)),
      submit(owner, prior._id, daysAgo(7)),
      submit(owner, recent._id, daysAgo(14)),
      submit(owner, unknown._id, daysAgo(13)),
      submit(owner, easy._id, daysAgo(29)),
      submit(owner, easy._id, now),
      submit(owner, easy._id, daysAgo(1), 'wrong'),
      submit(other, otherProblem._id, daysAgo(1)),
    ]);

    const expected = Array<number>(28).fill(0);
    expected[0] = expected[14] = expected[15] = 1;
    expect(await dsaRepository.getSolveHistory(owner.toHexString(), now)).toEqual({
      recentActivity: expected,
      hardGrowthTrend: 0,
    });
  });

  it.each([
    { previous: 1, recent: 2, status: 'improving', score: 100 },
    { previous: 1, recent: 1, status: 'stable', score: 85 },
    { previous: 2, recent: 1, status: 'declining', score: 72 },
    { previous: 0, recent: 0, status: 'stable', score: 85 },
  ])('returns $status with $previous prior and $recent recent hard solves', async ({ previous, recent, status, score }) => {
    const owner = new Types.ObjectId();
    const userId = owner.toHexString();
    await DSAProfile.create({ userId, platform: 'leetcode', totalSolved: 10, hardSolved: 3 });
    const now = Date.now();
    for (const [count, daysAgo] of [[previous, 21], [recent, 7]]) {
      for (let index = 0; index < count; index++) {
        const problem = await addProblem(owner, 'hard');
        await submit(owner, problem._id, new Date(now - daysAgo * DAY_MS));
      }
    }

    const intelligence = await dsaService.generateDSAIntelligence({ userId });
    expect(intelligence.status).toBe(status);
    expect(intelligence.hardProgressScore).toBe(score);
  });

  it('uses topic mastery and prefers career intent over the profile target role', async () => {
    const owner = new Types.ObjectId();
    const userId = owner.toHexString();
    await DSAProfile.create({ userId, platform: 'leetcode', topicBreakdown: { arrays: 12, graphs: 4 } });
    await UserProfile.create({ userId: owner, targetRole: ' Frontend Engineer ' });

    const frontend = await dsaService.generateDSAIntelligence({ userId });
    expect(frontend.strongTopics).toContainEqual({ topic: 'arrays', solved: 12, mastery: 60 });
    expect(frontend.weakTopics).toContainEqual({ topic: 'graphs', solved: 4, mastery: 20 });
    expect(frontend.nextTopics).not.toContain('arrays');
    expect(frontend.nextTopics.slice(0, 2)).toEqual(['trees', 'strings']);

    await CareerIntent.create({ userId, dreamRole: 'Backend Engineer' });
    const backend = await dsaService.generateDSAIntelligence({ userId });
    expect(backend.nextTopics.slice(0, 3)).toEqual(['trees', 'dp', 'graphs']);
  });
});
