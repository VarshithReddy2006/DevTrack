// src/modules/dashboard/dashboard.service.ts
import { Types } from 'mongoose';
import {
  DsaProblem,
  Project,
  ActivityEvent,
  DailyActivity,
  Mission,
  ConnectedPlatform,
  PlatformStats,
  UserAnalytics,
} from '../../db/models/index.js';
import { cacheManager, CACHE_KEYS } from '../../shared/cache/cacheManager.js';
import { logger } from '../../shared/logger.js';
import type {
  ApiDashboardResponse,
  ApiDashboardStats,
  ApiStreakData,
  ApiPlatformStats,
  ApiMission,
  ApiDashboardRecentActivity,
  ApiAchievement,
  ApiAchievementsResponse,
  ApiWeeklyXpDay,
} from '../../types/api.types.js';
import { getStartOfDay, formatISODate, isSameDay } from '../../shared/date.js';

// GitHub-specific dashboard stats (separate from DSA metrics)
export interface GithubDashboardStatsData {
  repos: number;
  followers: number;
  following: number;
  totalStars: number;
  topLanguages: string[];
  avatarUrl: string | null;
  name: string | null;
  bio: string | null;
  lastSyncedAt: string;
}



export async function getDashboard(userId: string): Promise<ApiDashboardResponse> {
  return cacheManager.getOrSet(CACHE_KEYS.dashboard(userId), () => loadDashboard(userId), 300);
}

async function loadDashboard(userId: string): Promise<ApiDashboardResponse> {
  const [platformStats, streak, missions, recentActivity, githubStats] = await Promise.all([
    getPlatformStats(userId),
    getStreakData(userId),
    getMissions(userId),
    getRecentActivity(userId, 10),
    getGithubDashboardStats(userId),
  ]);

  const stats = await getDashboardStats(userId, platformStats);

  return {
    stats,
    streak,
    platformStats,
    missions,
    recentActivity,
    githubStats,
  };
}

export async function getDashboardStats(userId: string, platformStats?: ApiPlatformStats[]): Promise<ApiDashboardStats> {
  const resolvedPlatformStats = platformStats || await getPlatformStats(userId);
  
  const [problemStats, projectStats, activityStats] = await Promise.all([
    DsaProblem.aggregate([
      { $match: { userId: new Types.ObjectId(userId) } },
      {
        $group: {
          _id: null,
          totalProblems: { $sum: 1 },
          totalSubmissions: { $sum: '$submissionCount' },
          currentStreak: { $sum: { $cond: [{ $eq: ['$status', 'solved'] }, 1, 0] } },
        },
      },
    ]),
    Project.aggregate([
      { $match: { userId: new Types.ObjectId(userId) } },
      {
        $group: {
          _id: null,
          totalProjects: { $sum: 1 },
          totalCommits: { $sum: '$totalCommits' },
          totalPullRequests: { $sum: '$totalPullRequests' },
        },
      },
    ]),
    DailyActivity.aggregate([
      { $match: { userId: new Types.ObjectId(userId) } },
      {
        $group: {
          _id: null,
          totalActiveDays: { $sum: { $cond: [{ $gt: ['$count', 0] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const problems = problemStats[0] || { totalProblems: 0, totalSubmissions: 0, currentStreak: 0 };
  const projects = projectStats[0] || { totalProjects: 0, totalCommits: 0, totalPullRequests: 0 };
  const activity = activityStats[0] || { totalActiveDays: 0 };

  // Calculate total problems from all platforms
  const totalPlatformProblems = resolvedPlatformStats.reduce((sum, p) => sum + p.totalSolved, 0);

  // Calculate streak
  const streakData = await calculateStreak(userId);

  // Fetch weekly XP history from UserAnalytics
  const { weeklyXPHistory, weeklyConsistencyScore } = await getWeeklyXpHistory(userId);

  return {
    totalProblems: totalPlatformProblems || problems.totalProblems,
    totalSubmissions: problems.totalSubmissions,
    totalActiveDays: activity.totalActiveDays,
    currentStreak: streakData.currentStreak,
    longestStreak: streakData.longestStreak,
    totalProjects: projects.totalProjects,
    totalCommits: projects.totalCommits,
    totalPullRequests: projects.totalPullRequests,
    totalContributions: projects.totalCommits + projects.totalPullRequests,
    weeklyXPHistory,
    weeklyConsistencyScore,
  };
}

/**
 * Build a 7-day XP history (Mon–Sun of the current week) from UserAnalytics.
 * Falls back to DailyActivity if UserAnalytics has no data yet.
 */
async function getWeeklyXpHistory(userId: string): Promise<{
  weeklyXPHistory: ApiWeeklyXpDay[];
  weeklyConsistencyScore: number;
}> {
  // Build the Mon–Sun window for the current week
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sun
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);

  const weekDays: ApiWeeklyXpDay[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return { date: formatISODate(d), xp: 0 };
  });

  // Try UserAnalytics first (pre-computed, fast)
  const analytics = await UserAnalytics.findOne({ userId: new Types.ObjectId(userId) });

  if (analytics && analytics.weeklyXPHistory && analytics.weeklyXPHistory.length > 0) {
    // weeklyXPHistory stores week-level buckets; map the current week's bucket to daily
    // For a daily breakdown we fall through to DailyActivity, but we can use the
    // consistency score directly from analytics.
    const weeklyConsistencyScore = analytics.weeklyConsistencyScore ?? 0;

    // Attempt to fill daily XP from DailyActivity for the current week
    const activities = await DailyActivity.find({
      userId: new Types.ObjectId(userId),
      date: { $gte: monday, $lte: today },
    });

    // DailyActivity tracks activity count, not XP directly.
    // Use the current week's total XP from analytics and distribute proportionally
    // by activity count per day, or just show activity count as a proxy.
    const activityMap = new Map(activities.map((a) => [formatISODate(a.date), a.count]));
    const totalActivityCount = activities.reduce((s, a) => s + a.count, 0);

    // Get current week's XP from analytics history
    const weekStart = monday;
    const weekBucket = analytics.weeklyXPHistory.find(
      (w) => Math.abs(w.weekStart.getTime() - weekStart.getTime()) < 7 * 24 * 60 * 60 * 1000
    );
    const weekTotalXp = weekBucket?.xp ?? 0;

    weekDays.forEach((day) => {
      const count = activityMap.get(day.date) ?? 0;
      // Distribute XP proportionally by activity count
      day.xp = totalActivityCount > 0
        ? Math.round((count / totalActivityCount) * weekTotalXp)
        : 0;
    });

    const activeDays = weekDays.filter((d) => d.xp > 0).length;
    const score = weeklyConsistencyScore || Math.round((activeDays / 7) * 100);

    return { weeklyXPHistory: weekDays, weeklyConsistencyScore: score };
  }

  // Fallback: use DailyActivity count as XP proxy (no analytics record yet)
  const activities = await DailyActivity.find({
    userId: new Types.ObjectId(userId),
    date: { $gte: monday, $lte: today },
  });

  const activityMap = new Map(activities.map((a) => [formatISODate(a.date), a.count]));
  weekDays.forEach((day) => {
    day.xp = activityMap.get(day.date) ?? 0;
  });

  const activeDays = weekDays.filter((d) => d.xp > 0).length;
  return {
    weeklyXPHistory: weekDays,
    weeklyConsistencyScore: Math.round((activeDays / 7) * 100),
  };
}

export async function getStreakData(userId: string): Promise<ApiStreakData> {
  const streak = await calculateStreak(userId);
  const history = await getStreakHistory(userId);

  return {
    ...streak,
    streakHistory: history,
  };
}

async function calculateStreak(userId: string): Promise<Omit<ApiStreakData, 'streakHistory'>> {
  const today = getStartOfDay();
  const activities = await DailyActivity.find({
    userId: new Types.ObjectId(userId),
    count: { $gt: 0 },
  }).sort({ date: -1 });

  let currentStreak = 0;
  let longestStreak = 0;
  let streakStartDate = '';
  let lastActiveDate = '';
  let isActiveToday = false;

  if (activities.length > 0) {
    lastActiveDate = formatISODate(activities[0].date);
    isActiveToday = isSameDay(activities[0].date, today);

    // Calculate current streak
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const isStreakAlive = isActiveToday || isSameDay(activities[0].date, yesterday);

    if (isStreakAlive) {
      let checkDate = isActiveToday ? new Date(today) : new Date(activities[0].date);

      for (const activity of activities) {
        const activityDate = getStartOfDay(activity.date);
        const expectedDate = getStartOfDay(checkDate);

        if (formatISODate(activityDate) === formatISODate(expectedDate)) {
          currentStreak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    } else {
      currentStreak = 0;
    }

    // Calculate longest streak
    let tempStreak = 0;
    let prevDate: Date | null = null;
    for (let i = activities.length - 1; i >= 0; i--) {
      const activity = activities[i];
      if (prevDate === null) {
        tempStreak = 1;
      } else {
        const dayDiff = Math.abs(activity.date.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);
        if (dayDiff === 1) {
          tempStreak++;
        } else {
          longestStreak = Math.max(longestStreak, tempStreak);
          tempStreak = 1;
        }
      }
      prevDate = activity.date;
    }
    longestStreak = Math.max(longestStreak, tempStreak, currentStreak);

    // Find streak start
    if (activities.length > 0) {
      streakStartDate = formatISODate(activities[activities.length - 1].date);
    }
  }

  return {
    currentStreak,
    longestStreak,
    lastActiveDate,
    streakStartDate,
    isActiveToday,
  };
}

async function getStreakHistory(userId: string): Promise<ApiStreakData['streakHistory']> {
  const currentYear = new Date().getFullYear();
  const yearStart = new Date(currentYear, 0, 1, 0, 0, 0, 0);
  const yearEnd = new Date(currentYear, 11, 31, 23, 59, 59, 999);

  const activities = await DailyActivity.find({
    userId: new Types.ObjectId(userId),
    date: { $gte: yearStart, $lte: yearEnd },
  }).sort({ date: 1 });

  const activityMap = new Map(activities.map((a) => [formatISODate(a.date), a.count]));

  // Build all days in the calendar year (Jan 1 – Dec 31)
  const days: Date[] = [];
  const current = new Date(yearStart);
  while (current <= yearEnd) {
    days.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }

  return days.map((day) => {
    const count = activityMap.get(formatISODate(day)) || 0;
    let level: 0 | 1 | 2 | 3 | 4 = 0;
    if (count > 20) level = 4;
    else if (count > 10) level = 3;
    else if (count > 5) level = 2;
    else if (count > 0) level = 1;

    return {
      date: formatISODate(day),
      count,
      level,
    };
  });
}

const VALID_PLATFORMS = ['leetcode', 'codeforces', 'github', 'codechef'] as const;

export async function getPlatformStats(userId: string): Promise<ApiPlatformStats[]> {
  const platforms = await ConnectedPlatform.find({
    userId: new Types.ObjectId(userId),
    isConnected: true,
    platformName: { $in: VALID_PLATFORMS },
  });

  const statsPromises = platforms.map(async (platform) => {
    const stats = await PlatformStats.findOne({
      userId: new Types.ObjectId(userId),
      platformName: platform.platformName,
    });

    // GitHub repos are counted towards totalSolved for consistency,
    // but we can distinguish them by platformId if needed.
    const isGithub = platform.platformName === 'github';

    return {
      platformId: platform.platformName,
      platformName: platform.platformName as 'leetcode' | 'codeforces' | 'github',
      username: platform.username,
      totalSolved: stats?.totalSolved || 0,
      easySolved: stats?.easySolved || 0,
      mediumSolved: stats?.mediumSolved || 0,
      hardSolved: stats?.hardSolved || 0,
      rating: stats?.rating ?? null,
      rank: stats?.rank ?? null,
      totalContests: stats?.totalContests || 0,
      lastSyncedAt: platform.lastSyncedAt?.toISOString() || new Date().toISOString(),
      profileUrl: platform.profileUrl,
      isConnected: platform.isConnected,
      rawData: stats?.rawData || {},
    };
  });

  return Promise.all(statsPromises);
}

/**
 * TASK 1: GitHub-specific dashboard stats — separate from DSA metrics.
 * Returns repos, followers, etc. from PlatformStats.rawData for GitHub.
 */
export async function getGithubDashboardStats(userId: string): Promise<GithubDashboardStatsData | null> {
  const platform = await ConnectedPlatform.findOne({
    userId: new Types.ObjectId(userId),
    platformName: 'github',
    isConnected: true,
  });

  if (!platform) return null;

  const stats = await PlatformStats.findOne({
    userId: new Types.ObjectId(userId),
    platformName: 'github',
  });

  const raw = stats?.rawData || {};

  return {
    repos: (raw.public_repos as number) ?? 0,
    followers: (raw.followers as number) ?? 0,
    following: (raw.following as number) ?? 0,
    totalStars: (raw.total_stars as number) ?? 0,
    topLanguages: (raw.top_languages as string[]) ?? [],
    avatarUrl: (raw.avatar_url as string) ?? null,
    name: (raw.name as string) ?? null,
    bio: (raw.bio as string) ?? null,
    lastSyncedAt: platform.lastSyncedAt?.toISOString() || new Date().toISOString(),
  };
}

export async function getMissions(userId: string): Promise<ApiMission[]> {
  const missions = await Mission.find({
    userId: new Types.ObjectId(userId),
    status: { $in: ['pending', 'in_progress'] },
    expiresAt: { $gt: new Date() },
  }).limit(5);

  return missions.map((mission) => ({
    id: mission._id.toString(),
    title: mission.title,
    description: mission.description,
    type: mission.type,
    status: mission.status,
    targetCount: mission.targetCount,
    currentCount: mission.currentCount,
    xpReward: mission.xpReward,
    category: mission.category,
    createdAt: mission.createdAt.toISOString(),
    expiresAt: mission.expiresAt.toISOString(),
    completedAt: mission.completedAt?.toISOString() || null,
  }));
}

export async function getRecentActivity(userId: string, limit: number): Promise<ApiDashboardRecentActivity[]> {
  const activities = await ActivityEvent.find({
    userId: new Types.ObjectId(userId),
  })
    .sort({ occurredAt: -1 })
    .limit(limit);

  return activities.map((activity) => ({
    id: activity._id.toString(),
    type: activity.type as ApiDashboardRecentActivity['type'],
    title: activity.title,
    description: activity.description,
    platform: activity.platform,
    url: activity.url,
    metadata: activity.metadata || {},
    occurredAt: activity.occurredAt.toISOString(),
  }));
}

// Achievement definitions - derived from user stats
interface AchievementDefinition {
  id: string;
  icon: string;
  title: string;
  description: string;
  category: ApiAchievement['category'];
  xpReward: number;
  targets: { threshold: number; label: string }[];
}

const ACHIEVEMENT_DEFINITIONS: AchievementDefinition[] = [
  {
    id: 'streak_3',
    icon: '🔥',
    title: 'Hot Streak',
    description: 'Maintain a 3-day coding streak',
    category: 'streak',
    xpReward: 50,
    targets: [{ threshold: 3, label: '3 days' }],
  },
  {
    id: 'streak_7',
    icon: '🔥',
    title: 'Week Warrior',
    description: 'Maintain a 7-day coding streak',
    category: 'streak',
    xpReward: 100,
    targets: [{ threshold: 7, label: '7 days' }],
  },
  {
    id: 'streak_30',
    icon: '🔥',
    title: 'Monthly Master',
    description: 'Maintain a 30-day coding streak',
    category: 'streak',
    xpReward: 500,
    targets: [{ threshold: 30, label: '30 days' }],
  },
  {
    id: 'problems_10',
    icon: '💯',
    title: 'Century',
    description: 'Solve 10 problems',
    category: 'problems',
    xpReward: 50,
    targets: [{ threshold: 10, label: '10 problems' }],
  },
  {
    id: 'problems_50',
    icon: '💯',
    title: 'Half Century',
    description: 'Solve 50 problems',
    category: 'problems',
    xpReward: 200,
    targets: [{ threshold: 50, label: '50 problems' }],
  },
  {
    id: 'problems_100',
    icon: '💯',
    title: 'Centurion',
    description: 'Solve 100 problems',
    category: 'problems',
    xpReward: 500,
    targets: [{ threshold: 100, label: '100 problems' }],
  },
  {
    id: 'problems_500',
    icon: '💯',
    title: 'Grand Master',
    description: 'Solve 500 problems',
    category: 'problems',
    xpReward: 1000,
    targets: [{ threshold: 500, label: '500 problems' }],
  },
  {
    id: 'contest_1',
    icon: '🏆',
    title: 'Contest Debut',
    description: 'Participate in your first contest',
    category: 'contest',
    xpReward: 50,
    targets: [{ threshold: 1, label: '1 contest' }],
  },
  {
    id: 'contest_10',
    icon: '🏆',
    title: 'Contest Regular',
    description: 'Participate in 10 contests',
    category: 'contest',
    xpReward: 200,
    targets: [{ threshold: 10, label: '10 contests' }],
  },
  {
    id: 'contest_50',
    icon: '🏆',
    title: 'Contest Champion',
    description: 'Participate in 50 contests',
    category: 'contest',
    xpReward: 500,
    targets: [{ threshold: 50, label: '50 contests' }],
  },
  {
    id: 'projects_1',
    icon: '🎯',
    title: 'Project Starter',
    description: 'Create your first project',
    category: 'projects',
    xpReward: 50,
    targets: [{ threshold: 1, label: '1 project' }],
  },
  {
    id: 'projects_5',
    icon: '🎯',
    title: 'Product Builder',
    description: 'Create 5 projects',
    category: 'projects',
    xpReward: 200,
    targets: [{ threshold: 5, label: '5 projects' }],
  },
  {
    id: 'projects_10',
    icon: '🎯',
    title: 'Project Architect',
    description: 'Create 10 projects',
    category: 'projects',
    xpReward: 500,
    targets: [{ threshold: 10, label: '10 projects' }],
  },
  {
    id: 'hard_10',
    icon: '⚡',
    title: 'Hardcore',
    description: 'Solve 10 hard problems',
    category: 'problems',
    xpReward: 150,
    targets: [{ threshold: 10, label: '10 hard problems' }],
  },
  {
    id: 'hard_50',
    icon: '⚡',
    title: 'Hard Master',
    description: 'Solve 50 hard problems',
    category: 'problems',
    xpReward: 500,
    targets: [{ threshold: 50, label: '50 hard problems' }],
  },
];

export async function getAchievements(userId: string): Promise<ApiAchievementsResponse> {
  // Get user stats to derive achievements statelessly
  const [dashboardStats, platformStats] = await Promise.all([
    getDashboardStats(userId),
    getPlatformStats(userId),
  ]);

  const totalProblems = platformStats.reduce((sum: number, p: ApiPlatformStats) => sum + p.totalSolved, 0);
  const totalHard = platformStats.reduce((sum: number, p: ApiPlatformStats) => sum + p.hardSolved, 0);
  const totalContests = platformStats.reduce((sum: number, p: ApiPlatformStats) => sum + p.totalContests, 0);
  const currentStreak = dashboardStats.currentStreak;
  const totalProjects = dashboardStats.totalProjects;

  // Calculate achievements based on stats
  const achievements: ApiAchievement[] = ACHIEVEMENT_DEFINITIONS.map((def) => {
    let progress = 0;
    let target = def.targets[0].threshold;
    let isUnlocked = false;

    switch (def.category) {
      case 'streak':
        progress = Math.min(currentStreak, target);
        isUnlocked = currentStreak >= target;
        break;
      case 'problems':
        if (def.id.includes('hard')) {
          progress = Math.min(totalHard, target);
          isUnlocked = totalHard >= target;
        } else {
          progress = Math.min(totalProblems, target);
          isUnlocked = totalProblems >= target;
        }
        break;
      case 'contest':
        progress = Math.min(totalContests, target);
        isUnlocked = totalContests >= target;
        break;
      case 'projects':
        progress = Math.min(totalProjects, target);
        isUnlocked = totalProjects >= target;
        break;
      default:
        break;
    }

    return {
      id: def.id,
      icon: def.icon,
      title: def.title,
      description: def.description,
      unlockedAt: isUnlocked ? new Date().toISOString() : null,
      progress,
      target,
      isUnlocked,
      category: def.category,
      xpReward: def.xpReward,
    };
  });

  const totalUnlocked = achievements.filter((a) => a.isUnlocked).length;
  const totalXp = achievements.filter((a) => a.isUnlocked).reduce((sum, a) => sum + a.xpReward, 0);

  return {
    achievements,
    totalUnlocked,
    totalAchievements: achievements.length,
    totalXp,
  };
}