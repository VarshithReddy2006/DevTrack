import { expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { ActivityEvent } from '../../../db/models/activityEvent.model.js';
import { DailyActivity } from '../../../db/models/dailyActivity.model.js';
import { DsaProblem } from '../../../db/models/dsaProblem.model.js';
import { DsaContest } from '../../../db/models/dsaContest.model.js';
import { DsaTopicProgress } from '../../../db/models/dsaTopicProgress.model.js';
import { ConnectedPlatform } from '../../../db/models/connectedPlatform.model.js';
import { PlatformStats } from '../../../db/models/platformStats.model.js';
import { ProfileAuditLog } from '../../../db/models/profileAuditLog.model.js';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { User } from '../../../db/models/user.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { XpTransaction } from '../../../db/models/xpTransaction.model.js';
import { AntiGamingWorker } from '../../../modules/profile/antiGaming.worker.js';
import { getPublicProfile } from '../../../modules/profile/profile.controller.js';
import { PublicProfileService } from '../../../modules/profile/publicProfile.service.js';
import { VerificationEngine } from '../../../modules/profile/verification.engine.js';
import { getStartOfDay } from '../../../shared/date.js';

function userFixture() {
  const _id = new Types.ObjectId();
  return { _id, displayName: 'Profile test user', clerkId: String(_id), username: 'u' + _id, email: _id + '@example.test' };
}

it('serves canonical metrics and immediately applies changes to public visibility', async () => {
  const owner = await User.create(userFixture());
  const other = await User.create(userFixture());
  const userId = owner._id;
  const now = new Date();
  await Promise.all([
    PlatformStats.insertMany([
      { userId, platformName: 'github', username: 'octocat', rawData: { top_languages: ['TypeScript'] } },
      { userId, platformName: 'leetcode', username: 'solver', totalSolved: 20, hardSolved: 5, rating: 1500 },
      { userId: other._id, platformName: 'leetcode', username: 'other', totalSolved: 900 },
    ]),
    ConnectedPlatform.create({ userId, platformName: 'leetcode', username: 'solver', profileUrl: 'https://example.test' }),
    DsaTopicProgress.insertMany([
      { userId, topicName: 'Graphs', solvedCount: 2 },
      { userId, topicName: 'Trees', solvedCount: 0 },
      { userId: other._id, topicName: 'Other user', solvedCount: 3 },
    ]),
    DsaContest.insertMany([
      { userId, platform: 'leetcode', contestName: 'Weekly', ratingAfter: 1550, participatedAt: now },
      { userId, platform: 'leetcode', contestName: 'Biweekly', ratingAfter: null, participatedAt: now },
    ]),
    DsaProblem.insertMany(['Graphs', 'Trees'].map(category => ({
      userId, platform: 'leetcode', title: category, category, difficulty: 'easy', status: 'solved',
      url: `https://example.test/${category}`, solvedAt: now,
    }))),
    DailyActivity.create({ userId, date: getStartOfDay(now), count: 6, activities: [{ type: 'problem_solved', count: 2 }] }),
    ActivityEvent.insertMany([
      { userId, platform: 'github', type: 'commit_pushed', title: 'Commit', occurredAt: now },
      { userId, platform: 'github', type: 'pr_merged', title: 'PR', occurredAt: now },
      { userId, platform: 'github', type: 'github_sync_completed', title: 'Sync', occurredAt: now },
      { userId: other._id, platform: 'github', type: 'commit_pushed', title: 'Other commit', occurredAt: now },
    ]),
    VerifiedProject.create({
      userId, githubRepoId: '42', repoFullName: 'octocat/project', repoUrl: 'https://example.test/project',
      name: 'Project', verification: { status: 'verified', rejectionReason: 'Internal-only detail' },
    }),
    XpTransaction.create({
      userId, sourceType: 'dsa_accepted', sourceId: '1', xpAwarded: 15, previousTotalXp: 0,
      newTotalXp: 15, levelBefore: 1, levelAfter: 1,
    }),
  ]);

  // A persisted v1 snapshot should be recomputed on the next read.
  await PublicProfile.create({ userId, username: owner.username, slug: owner.username, snapshot: { version: 1 } });
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const request = { params: { username: owner.username }, ip: '127.0.0.1' } as unknown as Parameters<typeof getPublicProfile>[0];
  const response = { status, json } as unknown as Parameters<typeof getPublicProfile>[1];
  await getPublicProfile(request, response);

  const dto = json.mock.lastCall?.[0].data;
  expect(dto).toMatchObject({
    dsa: { totalSolved: 20, difficultyRatio: 0.25, topicsCovered: ['Graphs'], contestsParticipated: 2, bestContestRating: 1550 },
    github: { isVerified: true, contributionsLast365: 2, totalContributions: 2, primaryLanguages: ['TypeScript'] },
    consistency: { activeDaysLast30: 1, activeDaysLast90: 1, activeDaysLast365: 1 },
    activityHeatmap: { weeks: [{ count: 6, level: 2 }] },
    velocityIndicators: { solveVelocity30d: 2, commitVelocity30d: 1, xpVelocity30d: 15, trend: 'accelerating' },
  });
  expect(dto.achievements.length).toBeGreaterThan(0);
  expect(dto.projects[0].verification.rejectionReason).toBeUndefined();

  await UserSettings.create({
    userId, privacy: { showGithub: false, showDsaProgress: false, showStreak: false, showActivity: false, showProjects: false },
  });
  await getPublicProfile(request, response);
  expect(json.mock.lastCall?.[0].data).toMatchObject({
    dsa: undefined, github: undefined, activityHeatmap: undefined, consistency: undefined,
    velocityIndicators: undefined, projects: [], achievements: [],
  });

  await UserSettings.updateOne({ userId }, { 'privacy.profileVisibility': 'private' });
  await getPublicProfile(request, response);
  expect(status).toHaveBeenLastCalledWith(404);
  expect(await ProfileAuditLog.countDocuments({ userId })).toBe(0);
});

it('uses root LeetCode counts, supports legacy rows, and leaves repeated evaluations read-only', async () => {
  const current = await User.create(userFixture());
  const legacy = await User.create(userFixture());
  await PlatformStats.create({
    userId: current._id, platformName: 'leetcode', username: 'current', totalSolved: 600, hardSolved: 501,
    rawData: { totalSolved: 1, hardSolved: 0 },
  });
  await PlatformStats.collection.insertOne({
    userId: legacy._id, platformName: 'leetcode', username: 'legacy', rawData: { totalSolved: 600, hardSolved: 501 },
  });
  for (const { _id } of [current, current, legacy]) {
    expect(await VerificationEngine.evaluateTrustScore(_id)).toMatchObject({
      suspicionScore: 120, flags: ['impossible_solve_velocity', 'suspicious_difficulty_ratio'],
    });
  }
  await PublicProfileService.computeProfile(legacy._id);
  expect(await PublicProfile.findOne({ userId: legacy._id })).toMatchObject({
    snapshot: { dsa: { totalSolved: 600, hardSolved: 501 } },
  });
  expect(await ProfileAuditLog.countDocuments()).toBe(0);
});

it('paginates beyond 50 users, retries failures, and writes one audit per user and UTC day', async () => {
  const scheduledAt = new Date();
  const users = await User.insertMany(Array.from({ length: 52 }, userFixture));
  const inactive = await User.create(userFixture());
  await User.updateOne({ _id: inactive._id }, { lastActiveAt: new Date(0) }, { timestamps: false });

  const failedId = users[0]._id;
  const recompute = vi.spyOn(PublicProfileService, 'computeProfile')
    .mockRejectedValueOnce(new Error('Transient test failure'))
    .mockResolvedValue({ trustScore: 100, suspicionScore: 0, flags: [] });
  try {
    await expect(AntiGamingWorker.startAuditJob(scheduledAt)).rejects.toThrow('1 profiles');
    expect(await ProfileAuditLog.countDocuments()).toBe(51);
    expect(await ProfileAuditLog.exists({ userId: failedId })).toBeNull();

    await AntiGamingWorker.startAuditJob(scheduledAt);
    await AntiGamingWorker.startAuditJob(scheduledAt);
    expect(recompute).toHaveBeenCalledTimes(53);
    expect(await ProfileAuditLog.countDocuments()).toBe(52);
    expect(await ProfileAuditLog.exists({ userId: inactive._id })).toBeNull();

    await AntiGamingWorker.startAuditJob(new Date(scheduledAt.getTime() + 86_400_000));
    expect(await ProfileAuditLog.countDocuments()).toBe(104);
  } finally {
    recompute.mockRestore();
  }
});
