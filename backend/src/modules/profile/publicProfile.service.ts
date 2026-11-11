import { PublicProfile } from '../../db/models/publicProfile.model.js';
import { User } from '../../db/models/user.model.js';
import { PlatformStats } from '../../db/models/platformStats.model.js';
import { ActivityEvent } from '../../db/models/activityEvent.model.js';
import { DailyActivity } from '../../db/models/dailyActivity.model.js';
import { DsaProblem } from '../../db/models/dsaProblem.model.js';
import { DsaContest } from '../../db/models/dsaContest.model.js';
import { DsaTopicProgress } from '../../db/models/dsaTopicProgress.model.js';
import { XpTransaction } from '../../db/models/xpTransaction.model.js';
import { VerifiedProject } from '../../db/models/verifiedProject.model.js';
import { UserXp } from '../../db/models/userXp.model.js';
import { ProfileView } from '../../db/models/profileView.model.js';
import { VerificationEngine } from './verification.engine.js';
import mongoose from 'mongoose';
import { calculateStreaks, formatISODate, getStartOfDay, getStartOfYear, subtractDays } from '../../shared/date.js';
import { getAchievements } from '../dashboard/dashboard.service.js';
import { escapeRegExp } from '../../shared/regex.js';

const SNAPSHOT_VERSION = 2;

function numericStat(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export class PublicProfileService {
  /**
   * Recompute the public profile snapshot for a user based on verified signals.
   */
  static async computeProfile(userId: mongoose.Types.ObjectId | string) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    const ownerId = new mongoose.Types.ObjectId(userId);
    const now = new Date();
    const today = getStartOfDay(now);
    const yearStart = getStartOfYear(today.getFullYear());
    const yearWindow = subtractDays(today, 364);
    const recentStart = subtractDays(today, 29);
    const previousStart = subtractDays(today, 59);

    const [verificationScore, platforms, projects, xp, topics, contests, daily, githubEvents, recentSolves, recentXp, achievementResult, prior] =
      await Promise.all([
        VerificationEngine.evaluateTrustScore(userId),
        PlatformStats.find({ userId, platformName: { $in: ['github', 'leetcode', 'codeforces', 'codechef'] } }).lean(),
        VerifiedProject.find({ userId, 'verification.status': 'verified', 'provenance.source': { $exists: false } }),
        UserXp.findOne({ userId }).lean(),
        DsaTopicProgress.find({ userId, solvedCount: { $gt: 0 } }).distinct('topicName'),
        DsaContest.aggregate<{ count: number; bestRating: number | null }>([
          { $match: { userId: ownerId } },
          { $group: { _id: null, count: { $sum: 1 }, bestRating: { $max: '$ratingAfter' } } },
        ]),
        DailyActivity.find({ userId, date: { $gte: yearStart < yearWindow ? yearStart : yearWindow, $lte: today }, count: { $gt: 0 } })
          .sort({ date: 1 }).select('date count').lean(),
        ActivityEvent.aggregate<{ _id: string; total: number; last365: number; last30: number }>([
          { $match: { userId: ownerId, platform: 'github', type: { $in: ['commit_pushed', 'pr_merged'] }, occurredAt: { $lte: now } } },
          { $group: {
            _id: '$type',
            total: { $sum: 1 },
            last365: { $sum: { $cond: [{ $gte: ['$occurredAt', yearWindow] }, 1, 0] } },
            last30: { $sum: { $cond: [{ $gte: ['$occurredAt', recentStart] }, 1, 0] } },
          } },
        ]),
        DsaProblem.countDocuments({ userId, solvedAt: { $gte: recentStart, $lte: now } }),
        XpTransaction.aggregate<{ total: number }>([
          { $match: { userId: ownerId, createdAt: { $gte: recentStart, $lte: now } } },
          { $group: { _id: null, total: { $sum: '$xpAwarded' } } },
        ]),
        getAchievements(String(userId)),
        PublicProfile.findOne({ userId }).select('snapshot.achievements').lean(),
      ]);

    const githubStats = platforms.find(({ platformName }) => platformName === 'github');
    const githubData = githubStats?.rawData;
    const dsaPlatforms = platforms.filter(({ platformName }) => platformName !== 'github').map(stats => ({
      platformName: stats.platformName,
      totalSolved: numericStat(stats.totalSolved, numericStat(stats.rawData?.totalSolved)),
      easySolved: numericStat(stats.easySolved, numericStat(stats.rawData?.easySolved)),
      mediumSolved: numericStat(stats.mediumSolved, numericStat(stats.rawData?.mediumSolved)),
      hardSolved: numericStat(stats.hardSolved, numericStat(stats.rawData?.hardSolved)),
      totalContests: numericStat(stats.totalContests),
      rating: stats.rating ?? null,
    }));
    const totalSolved = dsaPlatforms.reduce((sum, stats) => sum + stats.totalSolved, 0);
    const hardSolved = dsaPlatforms.reduce((sum, stats) => sum + stats.hardSolved, 0);
    const commits = githubEvents.find(({ _id }) => _id === 'commit_pushed');
    const pullRequests = githubEvents.find(({ _id }) => _id === 'pr_merged');
    const activeDays = (days: number) => daily.filter(({ date }) => date >= subtractDays(today, days - 1)).length;
    const activeDaysLast30 = activeDays(30);
    const streak = calculateStreaks(daily.map(({ date }) => date));
    const recentActivity = daily.filter(({ date }) => date >= recentStart);
    const recentCount = recentActivity.reduce((sum, day) => sum + day.count, 0);
    const previousCount = daily.filter(({ date }) => date >= previousStart && date < recentStart)
      .reduce((sum, day) => sum + day.count, 0);
    const trend = recentCount === 0 && previousCount === 0 ? 'inactive'
      : recentCount > previousCount ? 'accelerating'
      : recentCount < previousCount ? 'decelerating' : 'steady';

    const achievements = achievementResult.achievements.flatMap(achievement => {
      if (!achievement.isUnlocked) return [];
      const old = prior?.snapshot?.achievements?.find(({ id }) => id === achievement.id);
      const rarity = achievement.id.includes('30') || achievement.id.includes('500') ? 'legendary'
        : achievement.id.includes('100') ? 'epic' : achievement.id.includes('50') ? 'rare' : 'common';
      return [{
        id: achievement.id,
        name: achievement.title,
        icon: achievement.icon,
        rarity,
        category: achievement.category,
        unlockedAt: old?.unlockedAt ?? now,
      }];
    });

    const computedSnapshot = {
      computedAt: now,
      version: SNAPSHOT_VERSION,
      identity: {
        displayName: user.displayName || user.username,
        avatarUrl: null,
        joinedAt: user.joinedAt,
        timezone: user.timezone || 'UTC',
        level: xp?.currentLevel || 1,
        levelName: 'Engineer',
        totalXp: xp?.totalXp || 0,
      },
      consistency: {
        currentStreak: streak.currentStreak,
        longestStreak: Math.max(streak.longestStreak, xp?.lifetimeStats?.longestStreak ?? 0),
        activeDaysLast30,
        activeDaysLast90: activeDays(90),
        activeDaysLast365: activeDays(365),
        weeklyConsistencyScore: Math.round(activeDays(7) / 7 * 100),
        monthlyConsistencyScore: Math.round(activeDaysLast30 / 30 * 100),
      },
      dsa: {
        totalSolved,
        easySolved: dsaPlatforms.reduce((sum, stats) => sum + stats.easySolved, 0),
        mediumSolved: dsaPlatforms.reduce((sum, stats) => sum + stats.mediumSolved, 0),
        hardSolved,
        difficultyRatio: totalSolved ? hardSolved / totalSolved : 0,
        topicsCovered: topics.sort(),
        contestsParticipated: contests[0]?.count ?? dsaPlatforms.reduce((sum, stats) => sum + stats.totalContests, 0),
        bestContestRating: contests[0]?.bestRating ?? null,
        platformBreakdown: dsaPlatforms.map(stats => ({
          platform: stats.platformName,
          solved: stats.totalSolved,
          rating: stats.rating,
        })),
      },
      github: {
        isVerified: !!githubStats,
        totalContributions: numericStat(githubData?.total_contributions, (commits?.total ?? 0) + (pullRequests?.total ?? 0)),
        contributionsLast365: (commits?.last365 ?? 0) + (pullRequests?.last365 ?? 0),
        longestContribStreak: numericStat(githubData?.longest_contrib_streak),
        verifiedProjectCount: projects.length,
        primaryLanguages: Array.isArray(githubData?.top_languages)
          ? githubData.top_languages.filter((language): language is string => typeof language === 'string')
          : [],
        totalCommits: numericStat(githubData?.total_commits, commits?.total),
        totalPRs: numericStat(githubData?.total_prs, pullRequests?.total),
      },
      projects: projects.map(project => ({
        name: project.name,
        description: project.description,
        techStack: project.techStack,
        repoFullName: project.repoFullName,
        repoUrl: project.repoUrl,
        verification: { status: project.verification.status, verifiedAt: project.verification.verifiedAt },
        metrics: { primaryLanguage: project.metrics.primaryLanguage, stars: project.metrics.stars },
      })),
      achievements,
      activityHeatmap: {
        year: today.getFullYear(),
        weeks: daily.filter(({ date }) => date >= yearStart).map(({ date, count }) => ({
          date: formatISODate(date),
          count,
          level: count > 20 ? 4 : count > 10 ? 3 : count > 5 ? 2 : 1,
        })),
      },
      velocityIndicators: {
        solveVelocity30d: recentSolves,
        commitVelocity30d: commits?.last30 ?? 0,
        xpVelocity30d: recentXp[0]?.total ?? 0,
        trend,
      },
    };

    const profileData = {
      userId,
      username: user.username,
      slug: user.username.toLowerCase(),
      snapshot: computedSnapshot,
      'antiGaming.suspicionScore': verificationScore.suspicionScore,
      'antiGaming.flags': verificationScore.flags,
      'antiGaming.isFlagged': verificationScore.suspicionScore > 70,
      seo: {
        ogTitle: `${user.username} | Verified Engineering Profile`,
        ogDescription: `View ${user.username}'s verified engineering metrics, projects, and proof of work on DevTrack.`,
        ogImageUrl: null,
        canonicalUrl: `https://devtrack.io/u/${user.username.toLowerCase()}`,
      },
    };

    await PublicProfile.findOneAndUpdate(
      { userId },
      { $set: profileData },
      { upsert: true, new: true }
    );
    return verificationScore;
  }

  /**
   * Get a public profile by username
   */
  static async getPublicProfileByUsername(username: string, viewerIp: string, viewerType: 'public' | 'recruiter' | 'authenticated', viewerUserId?: mongoose.Types.ObjectId) {
    let profile = await PublicProfile.findOne({ slug: username.toLowerCase() });
    
    if (profile && profile.snapshot.version < SNAPSHOT_VERSION) {
      await this.computeProfile(profile.userId);
      profile = await PublicProfile.findOne({ userId: profile.userId });
    } else if (!profile) {
      const user = await User.findOne({ username: new RegExp(`^${escapeRegExp(username)}$`, 'i') });
      if (!user) throw new Error('Profile not found');
      
      await this.computeProfile(user._id as mongoose.Types.ObjectId);
      profile = await PublicProfile.findOne({ slug: user.username.toLowerCase() });
    }

    if (profile) {
      // Track view asynchronously
      ProfileView.create({
        profileUserId: profile.userId,
        viewerType,
        viewerUserId: viewerUserId || null,
        viewerIp,
      }).catch(err => console.error('Error tracking profile view:', err));

      // Update stats on profile (can be debounced in prod)
      await PublicProfile.updateOne(
        { _id: profile._id },
        { 
          $inc: { 
            'stats.profileViews': viewerType === 'public' ? 1 : 0,
            'stats.recruiterViews': viewerType === 'recruiter' ? 1 : 0,
          },
          $set: { 'stats.lastViewedAt': new Date() }
        }
      );
    }

    return profile;
  }
}
