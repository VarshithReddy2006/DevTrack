import { Types } from 'mongoose';
import { DsaProblem, DsaSubmission, DsaContest, DsaTopicProgress } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import { createActivity, incrementDailyActivity } from '../activity/activity.service.js';
import { dsaProblemIdentity } from '../dsa/dsa-problem-identity.js';
import type { PlatformSubmission, PlatformContest, FetchedPlatformStats } from './adapters/types.js';

export async function persistSubmissions(userId: string, submissions: PlatformSubmission[]): Promise<number> {
  const userObjId = new Types.ObjectId(userId);
  let ingested = 0;
  for (const sub of submissions) {
    if (!sub.problemExternalId || !Number.isFinite(sub.submittedAt.getTime())) continue;
    const key = { userId: userObjId, platform: sub.platform, externalId: sub.externalId };
    if (await DsaSubmission.exists(key)) continue;
    const problemKey = { userId: userObjId, platform: sub.platform, externalId: sub.problemExternalId };
    let problem;
    try {
      problem = await DsaProblem.findOneAndUpdate(problemKey, { $setOnInsert: {
        ...problemKey, title: sub.title, difficulty: sub.difficulty === 'unknown' ? 'medium' : sub.difficulty,
        problemKey: sub.platform === 'github' ? undefined : dsaProblemIdentity({
          platform: sub.platform, externalId: sub.problemExternalId, url: sub.problemUrl,
        }).key,
        difficultyKnown: sub.difficulty !== 'unknown',
        url: sub.problemUrl ?? '', tags: [], category: sub.category ?? 'General',
        status: sub.status === 'accepted' ? 'solved' : 'attempted', isFavorite: false, submissionCount: 0,
      } }, { upsert: true, new: true });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      problem = await DsaProblem.findOne(problemKey);
    }
    if (!problem) throw new Error('Failed to persist synced problem');
    try {
      await DsaSubmission.create({ ...key, problemId: problem._id,
        status: sub.status === 'accepted' ? 'accepted' : sub.status === 'time_limit' ? 'time_limit_exceeded'
          : sub.status === 'runtime_error' ? 'runtime_error' : sub.status === 'compilation_error' ? 'compilation_error' : 'wrong',
        language: sub.language ?? 'unknown', codeSnippet: null, submittedAt: sub.submittedAt,
        executionTime: sub.runtimeMs ?? null, memoryUsed: sub.memoryKb ?? null });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) continue;
      throw error;
    }
    // Count and heatmap only after the unique submission key was admitted.
    await DsaProblem.updateOne({ _id: problem._id }, [{ $set: {
      submissionCount: { $add: [{ $ifNull: ['$submissionCount', 0] }, 1] },
      lastSubmittedAt: { $max: [{ $ifNull: ['$lastSubmittedAt', sub.submittedAt] }, sub.submittedAt] },
      ...(sub.difficulty !== 'unknown' ? { difficulty: sub.difficulty, difficultyKnown: true } : {}),
      ...(sub.status === 'accepted' ? { status: 'solved',
        solvedAt: { $min: [{ $ifNull: ['$solvedAt', sub.submittedAt] }, sub.submittedAt] },
      } : {}),
    } }]);
    await incrementDailyActivity(userId, sub.submittedAt, 'submission');
    ingested++;
    if (sub.status === 'accepted') {
      const { checkChallengeCompletion } = await import('../daily-challenge/daily-challenge.service.js');
      void checkChallengeCompletion(userId, sub.platform, sub.problemExternalId, sub.submittedAt)
        .catch(error => logger.warn('[sync] Challenge completion check failed', { userId, error }));
    }
  }
  return ingested;
}

export async function persistContests(userId: string, platform: string, contests: PlatformContest[]): Promise<number> {
  let ingested = 0;
  for (const contest of contests) {
    if (!contest.title || !Number.isFinite(contest.participatedAt.getTime())) continue;
    const key = { userId: new Types.ObjectId(userId), platform, contestName: contest.title };
    const result = await DsaContest.updateOne(key, { $setOnInsert: { ...key,
      participatedAt: contest.participatedAt, rank: contest.rank, totalParticipants: contest.totalParticipants,
      problemsSolved: 0, ratingBefore: contest.ratingBefore, ratingAfter: contest.ratingAfter, ratingChange: contest.ratingChange,
    } }, { upsert: true });
    if (result.upsertedCount) ingested++;
    if (result.upsertedCount && contest.url && contest.participatedAt.getTime() >= Date.now() - 7 * 86_400_000) {
      await createActivity(userId, { type: 'contest_participated', title: `Participated in ${contest.title}`,
        description: `Rating changed by ${contest.ratingChange ?? 0}`, platform, url: contest.url,
        tags: ['contest', platform], metadata: { contestName: contest.title, ratingChange: contest.ratingChange ?? 0 } });
    }
  }
  return ingested;
}

export async function updatePlatformTopicAnalytics(
  userId: string,
  platformName: string,
  fetched: FetchedPlatformStats
): Promise<void> {
  const userObjId = new Types.ObjectId(userId);

  const topicName = platformName === 'codeforces' ? 'Competitive Programming'
    : platformName === 'leetcode' ? 'LeetCode Problems'
    : platformName === 'codechef' ? 'CodeChef Problems'
    : 'General';

  await DsaTopicProgress.findOneAndUpdate(
    { userId: userObjId, topicName },
    {
      $set: {
        totalProblems: fetched.totalSolved,
        solvedCount: fetched.totalSolved,
        easyCount: fetched.easySolved,
        easySolved: fetched.easySolved,
        mediumCount: fetched.mediumSolved,
        mediumSolved: fetched.mediumSolved,
        hardCount: fetched.hardSolved,
        hardSolved: fetched.hardSolved,
      },
    },
    { upsert: true, new: true }
  );
}

/**
 * STEP 2.5: Generate activity events for milestones and recent contests.
 */
export async function generateSyncActivityEvents(
  userId: string,
  platformName: string,
  fetched: FetchedPlatformStats
): Promise<void> {
  const { ActivityEvent } = await import('../../db/models/index.js');

  // Milestone achievements (every 50/100/200/... solved)
  const milestones = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000];
  for (const milestone of milestones) {
    if (fetched.totalSolved >= milestone) {
      const existing = await ActivityEvent.findOne({
        userId: new Types.ObjectId(userId),
        type: 'streak_milestone',
        'metadata.milestone': milestone,
        'metadata.platform': platformName,
      }).lean();

      if (!existing) {
        try {
          await createActivity(userId, {
            type: 'streak_milestone',
            title: `Reached ${milestone} solved problems`,
            description: `Solved ${milestone} problems on ${platformName}!`,
            platform: platformName,
            url: null,
            tags: ['milestone', platformName],
            metadata: { milestone, platform: platformName, totalSolved: fetched.totalSolved },
          });
        } catch (err) {
          logger.warn('[sync] Failed to create milestone activity', { userId, milestone, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

}
