import mongoose, { Types, type ClientSession } from 'mongoose';
import { DsaProblem, DsaSubmission, DsaContest, DsaTopicProgress } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import { createActivity } from '../activity/activity.service.js';
import { cacheManager } from '../../shared/cache/cacheManager.js';
import { projectSubmission } from './submission-projections.js';
import { dsaProblemIdentity } from '../dsa/dsa-problem-identity.js';
import type { PlatformSubmission, PlatformContest, FetchedPlatformStats } from './adapters/types.js';
import { enqueueSubmissionEvaluation } from '../revision/cardGenerator.service.js';

async function admissionTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await mongoose.connection.transaction(work);
    } catch (error) {
      // Concurrent first imports can race on the source/problem unique indexes.
      // Start a fresh transaction; never continue inside an aborted session.
      if ((error as { code?: number }).code !== 11000 || attempt >= 2) throw error;
    }
  }
}

export async function persistSubmissions(userId: string, submissions: PlatformSubmission[]): Promise<number> {
  const userObjId = new Types.ObjectId(userId);
  let ingested = 0;
  const evaluations = new Set<string>();
  for (const sub of submissions) {
    if (!sub.problemExternalId || !Number.isFinite(sub.submittedAt.getTime())) continue;
    if (sub.runtimePercentile != null && (typeof sub.runtimePercentile !== 'number' || !Number.isFinite(sub.runtimePercentile) || sub.runtimePercentile < 0 || sub.runtimePercentile > 100)) {
      throw new Error('Invalid submission runtime percentile');
    }
    const key = { userId: userObjId, platform: sub.platform, externalId: sub.externalId };
    // Source admission, problem projection and daily bucket commit together.
    // Absolute reconciliation also heals legacy partial writes on duplicate sync.
    const outcome = await admissionTransaction(async session => {
      const existingSubmission = await DsaSubmission.findOne(key).session(session).lean();
      if (existingSubmission) {
        await projectSubmission(
          userObjId, new Types.ObjectId(existingSubmission.problemId.toString()),
          existingSubmission.submittedAt, session,
        );
        return { id: existingSubmission._id.toString(), created: false, queue: !existingSubmission.revisionEvaluationQueued };
      }
      const problemKey = { userId: userObjId, platform: sub.platform, externalId: sub.problemExternalId };
      const problem = await DsaProblem.findOneAndUpdate(problemKey, { $setOnInsert: {
        ...problemKey, title: sub.title, difficulty: sub.difficulty === 'unknown' ? 'medium' : sub.difficulty,
        problemKey: sub.platform === 'github' ? undefined : dsaProblemIdentity({
          platform: sub.platform, externalId: sub.problemExternalId, url: sub.problemUrl,
        }).key,
        difficultyKnown: sub.difficulty !== 'unknown',
        url: sub.problemUrl ?? '', tags: sub.tags ?? [], category: sub.category ?? 'General',
        status: sub.status === 'accepted' ? 'solved' : 'attempted', isFavorite: false, submissionCount: 0,
      } }, { upsert: true, new: true, session });
      if (!problem) throw new Error('Failed to persist synced problem');
      const [savedSubmission] = await DsaSubmission.create([{ ...key, problemId: problem._id,
        status: sub.status === 'accepted' ? 'accepted' : sub.status === 'time_limit' ? 'time_limit_exceeded'
          : sub.status === 'runtime_error' ? 'runtime_error' : sub.status === 'compilation_error' ? 'compilation_error' : 'wrong',
        language: sub.language ?? 'unknown', codeSnippet: null, submittedAt: sub.submittedAt,
        executionTime: sub.runtimeMs ?? null, memoryUsed: sub.memoryKb ?? null, runtimePercentile: sub.runtimePercentile ?? null,
        topicTags: sub.tags ?? [] }], { session });
      await projectSubmission(userObjId, new Types.ObjectId(problem._id.toString()), sub.submittedAt, session);
      if (sub.difficulty !== 'unknown' || sub.tags?.length) {
        const updateDoc: Record<string, unknown> = {};
        if (sub.difficulty !== 'unknown') {
          updateDoc.$set = { difficulty: sub.difficulty, difficultyKnown: true };
        }
        if (sub.tags?.length) {
          updateDoc.$addToSet = { tags: { $each: sub.tags } };
        }
        await DsaProblem.updateOne({ _id: problem._id, userId: userObjId }, updateDoc, { session });
      }
      return { id: savedSubmission._id.toString(), created: true, queue: true };
    });
    if (outcome.created) ingested++;
    if (outcome.queue) evaluations.add(outcome.id);
    if (outcome.created && sub.status === 'accepted') {
      const { checkChallengeCompletion } = await import('../daily-challenge/daily-challenge.service.js');
      void checkChallengeCompletion(userId, sub.platform, sub.problemExternalId, sub.submittedAt)
        .catch(error => logger.warn('[sync] Challenge completion check failed', { userId, error }));
    }
  }
  // Providers commonly return newest first. Publish only after admitting the
  // whole batch so a fast consumer can see earlier failures before acceptance.
  for (const submissionId of evaluations) await enqueueSubmissionEvaluation(userId, submissionId);
  if (submissions.length) await cacheManager.invalidateDashboard(userId);
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
    if (contest.url && contest.participatedAt.getTime() >= Date.now() - 7 * 86_400_000) {
      try {
        const { ActivityEvent } = await import('../../db/models/index.js');
        const existingActivity = await ActivityEvent.findOne({
          userId: new Types.ObjectId(userId),
          type: 'contest_participated',
          platform,
          'metadata.contestName': contest.title,
        }).lean();

        if (!existingActivity) {
          await createActivity(userId, {
            type: 'contest_participated',
            title: `Participated in ${contest.title}`,
            description: `Rating changed by ${contest.ratingChange ?? 0}`,
            platform,
            url: contest.url,
            tags: ['contest', platform],
            metadata: { contestName: contest.title, ratingChange: contest.ratingChange ?? 0 },
            occurredAt: contest.participatedAt,
          });
        }
      } catch (err) {
        logger.warn('[sync] Failed to record contest activity event', {
          userId,
          contest: contest.title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
