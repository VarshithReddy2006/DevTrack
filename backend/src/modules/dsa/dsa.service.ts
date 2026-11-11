// src/modules/dsa/dsa.service.ts
import { cacheManager } from '../../shared/cache/cacheManager.js';
import { Types } from 'mongoose';
import { DsaProblem, DsaTopicProgress, DsaSubmission, DsaContest, DailyActivity, PlatformStats } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import { escapeRegExp } from '../../shared/regex.js';
import { dsaProblemIdentity } from './dsa-problem-identity.js';
import { reconcileUserDsaSummary } from './dsa-reconciliation.js';
import { isReservedPlatformTopic } from './dsa.constants.js';
import type {
  ApiDsaListResponse,
  ApiDsaProblem,
  ApiDsaStats,
  ApiDsaFilters,
  ApiDsaProblemCreatePayload,
  ApiDsaProblemUpdatePayload,
  ApiPagination,
  ApiDsaWeeklyProgress,
  ApiDsaDashboardResponse,
  ApiDsaSummaryItem,
  ApiDsaDashboardSubmission,
  ApiDsaSubmissionsListResponse,
  ApiDsaSubmissionEntry,
  ApiDsaContestsListResponse,
  ApiDsaContest,
  ApiDsaTopicsListResponse,
  ApiDsaHeatmapResponse,
} from '../../types/api.types.js';
import { parsePaginationParams, createPagination, getSkipCount, buildSortOptions } from '../../shared/pagination.js';
const ALLOWED_SORT_FIELDS = ['title', 'difficulty', 'lastSubmittedAt', 'solvedAt', 'timeTaken'];

// ---------------------------------------------------------------------------
// Rolling 365-day DSA Aggregation Service
// Combines LeetCode submission calendar + Codeforces DsaSubmission counts.
// Excludes GitHub activity from DSA heatmap and streak calculations.
// ---------------------------------------------------------------------------

/**
 * Parse a LeetCode submission calendar from PlatformStats.rawData.
 * Returns Record<YYYY-MM-DD, number>.
 */
export function parseLeetCodeCalendar(rawData: Record<string, unknown>): Record<string, number> {
  const calendar: Record<string, number> = {};
  try {
    const normalized = rawData?.submissionCalendar;
    if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
      for (const [key, value] of Object.entries(normalized as Record<string, unknown>)) {
        if (typeof value !== 'number' || value <= 0) continue;

        // Preferred normalized format: YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
          calendar[key] = (calendar[key] ?? 0) + value;
          continue;
        }

        // Legacy-but-possible format: unix timestamp seconds as string keys
        if (/^\d+$/.test(key)) {
          const d = new Date(parseInt(key, 10) * 1000);
          if (Number.isNaN(d.getTime())) continue;
          const dateStr = d.toISOString().split('T')[0];
          calendar[dateStr] = (calendar[dateStr] ?? 0) + value;
        }
      }
      return calendar;
    }

    const rawCalendarStr =
      (typeof rawData?.submissionCalendar === 'string' ? rawData.submissionCalendar : null) ||
      (typeof rawData?.matchedUser === 'object' && rawData.matchedUser && !Array.isArray(rawData.matchedUser)
        ? (rawData.matchedUser as Record<string, unknown>).submissionCalendar
        : null);

    const rawCalendarJson = typeof rawCalendarStr === 'string' ? rawCalendarStr : null;

    if (rawCalendarJson) {
      const parsed = JSON.parse(rawCalendarJson) as Record<string, unknown>;
      for (const [ts, count] of Object.entries(parsed)) {
        if (typeof count !== 'number' || count <= 0) continue;
        const d = new Date(parseInt(ts, 10) * 1000);
        if (Number.isNaN(d.getTime())) continue;
        const dateStr = d.toISOString().split('T')[0];
        calendar[dateStr] = (calendar[dateStr] ?? 0) + count;
      }
    }
  } catch (err) {
    logger.debug('[dsa] Failed to parse LeetCode submission calendar', { error: err instanceof Error ? err.message : String(err) });
  }
  return calendar;
}

/**
 * Generate a rolling 365-day heatmap (today-364 through today).
 * Per day = LeetCode calendar count + Codeforces DsaSubmission count.
 */
export async function generateRollingHeatmap(
  userId: string
): Promise<Array<{ date: string; count: number }>> {
  const userObjId = new Types.ObjectId(userId);
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  start.setHours(0, 0, 0, 0);

  // 1. Get Codeforces submissions grouped by day (from DsaSubmission)
  const t0 = Date.now();
  const cfSubmissions = await DsaSubmission.aggregate([
    {
      $match: {
        userId: userObjId,
        platform: 'codeforces',
        submittedAt: { $gte: start, $lte: today },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$submittedAt' } },
        count: { $sum: 1 },
      },
    },
  ]);
  logger.perf('cf_submissions_aggregate', Date.now() - t0, { userId, count: cfSubmissions.length });

  const cfMap = new Map<string, number>();
  for (const s of cfSubmissions) {
    cfMap.set(s._id as string, s.count as number);
  }

  // 2. Get LeetCode submission calendar from PlatformStats.rawData
  const leetcodeStats = await PlatformStats.findOne({
    userId: userObjId,
    platformName: 'leetcode',
  })
    .select({ rawData: 1 })
    .lean();

  const lcCalendar = leetcodeStats?.rawData
    ? parseLeetCodeCalendar(leetcodeStats.rawData)
    : {};

  // 3. Build rolling 365-day array
  const heatmap: Array<{ date: string; count: number }> = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const dateStr = cursor.toISOString().split('T')[0];
    const cfCount = cfMap.get(dateStr) ?? 0;
    const lcCount = lcCalendar[dateStr] ?? 0;
    heatmap.push({ date: dateStr, count: cfCount + lcCount });
    cursor.setDate(cursor.getDate() + 1);
  }

  return heatmap;
}

/**
 * Calculate current and longest streaks from a rolling heatmap array.
 */
export function calculateStreaksFromHeatmap(
  heatmap: Array<{ date: string; count: number }>
): { current: number; longest: number } {
  let longest = 0;
  let tempStreak = 0;

  // Longest streak over entire window
  for (const day of heatmap) {
    if (day.count > 0) {
      tempStreak++;
      if (tempStreak > longest) longest = tempStreak;
    } else {
      tempStreak = 0;
    }
  }

  // Current streak — walk backwards from today (or yesterday)
  const todayStr = new Date().toISOString().split('T')[0];
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  let current = 0;
  const todayIdx = heatmap.findIndex(h => h.date === todayStr);
  const yesterdayIdx = heatmap.findIndex(h => h.date === yesterdayStr);

  if (todayIdx >= 0 && heatmap[todayIdx].count > 0) {
    for (let i = todayIdx; i >= 0; i--) {
      if (heatmap[i].count > 0) current++;
      else break;
    }
  } else if (yesterdayIdx >= 0 && heatmap[yesterdayIdx].count > 0) {
    for (let i = yesterdayIdx; i >= 0; i--) {
      if (heatmap[i].count > 0) current++;
      else break;
    }
  }

  return { current, longest };
}

export async function getDashboard(userId: string): Promise<ApiDsaDashboardResponse> {
  const userObjId = new Types.ObjectId(userId);

  // Rolling 365-day DSA-only heatmap (LeetCode + Codeforces)
  const t0 = Date.now();
  const [summary, recentSubmissions, heatmapData] = await Promise.all([
    reconcileUserDsaSummary(userId),
    DsaSubmission.find({ userId: userObjId })
      .sort({ submittedAt: -1 })
      .limit(20)
      .populate('problemId', 'title category difficulty')
      .lean(),
    generateRollingHeatmap(userId),
  ]);
  logger.perf('getDashboard_parallel_queries', Date.now() - t0, { userId });

  // Streaks derived from the DSA-only rolling heatmap
  const streaks = calculateStreaksFromHeatmap(heatmapData);

  // Build heatmap count array (rolling 365 days)
  const heatmap: number[] = heatmapData.map((day) => day.count);

  const currentStreak = streaks.current;
  const maxStreak = streaks.longest;

  const totalSolved = summary.totals.solved;
  const bestRating = summary.platformOverview.reduce((max, platform) => Math.max(max, platform.rating ?? 0), 0);

  const stats: ApiDsaSummaryItem[] = [
    { label: 'Problems Solved', value: String(totalSolved), icon: 'check-circle' },
    { label: 'Current Rating', value: bestRating > 0 ? String(bestRating) : '—', icon: 'chart-bar' },
    { label: 'Current Streak', value: `${currentStreak} days`, icon: 'fire' },
    { label: 'Max Streak', value: `${maxStreak} days`, icon: 'trophy' },
  ];

  const topics = summary.topics.map(topic => ({ name: topic.topicName, progress: topic.solveRate }));

  type PopulatedProblem = { title?: string; category?: string; difficulty?: string } | null;

  const submissions: ApiDsaDashboardSubmission[] = recentSubmissions.map((s: any) => {
    const problem = s.problemId as unknown as PopulatedProblem;
    return {
      id: (s._id as Types.ObjectId).toString(),
      status: s.status === 'accepted' ? 'accepted' : 'wrong',
      problem: problem?.title ?? 'Unknown Problem',
      topic: problem?.category ?? 'General',
      platform: s.platform,
      language: s.language,
      date: new Date(s.submittedAt).toLocaleDateString('en-US', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
      }),
      difficulty: (problem?.difficulty ?? 'medium') as 'easy' | 'medium' | 'hard',
    };
  });

  return {
    stats, heatmap, submissions, contests: [], topics,
    platformOverview: summary.platformOverview,
    solvedByDifficulty: summary.solvedByDifficulty,
    provenance: summary.provenance,
  };
}

export async function getProblems(userId: string, filters: ApiDsaFilters): Promise<ApiDsaListResponse> {
  const { page, pageSize } = parsePaginationParams({
    page: filters.page?.toString(),
    pageSize: filters.pageSize?.toString(),
  });

  // Build query
  const query: Record<string, unknown> = { userId: new Types.ObjectId(userId) };

  if (filters.difficulty) query.difficulty = filters.difficulty;
  if (filters.status) query.status = filters.status;
  if (filters.category) query.category = filters.category;
  if (filters.platform) query.platform = filters.platform;
  if (filters.isFavorite !== undefined) query.isFavorite = filters.isFavorite;
  if (filters.search) {
    const searchRegex = new RegExp(escapeRegExp(filters.search), 'i');
    query.$or = [
      { title: searchRegex },
      { tags: searchRegex },
    ];
  }

  // Execute query
  const skip = getSkipCount({ page, pageSize });
  const sort = buildSortOptions(filters.sortBy, filters.sortOrder, ALLOWED_SORT_FIELDS);

  const [problems, totalCount] = await Promise.all([
    DsaProblem.find(query).sort(sort).skip(skip).limit(pageSize).lean(),
    DsaProblem.countDocuments(query),
  ]);

  // Get stats
  const stats = await getStats(userId);

  const pagination: ApiPagination = createPagination(totalCount, { page, pageSize });

  return {
    problems: problems.map(mapProblemToApi),
    pagination,
    stats,
  };
}

export async function getProblemById(userId: string, problemId: string): Promise<ApiDsaProblem | null> {
  const problem = await DsaProblem.findOne({
    _id: new Types.ObjectId(problemId),
    userId: new Types.ObjectId(userId),
  }).lean();

  return problem ? mapProblemToApi(problem) : null;
}

export async function createProblem(userId: string, payload: ApiDsaProblemCreatePayload): Promise<ApiDsaProblem> {
  const problemId = new Types.ObjectId();
  const problem = await DsaProblem.create({
    userId: new Types.ObjectId(userId),
    ...payload,
    _id: problemId,
    // Manual entries share the index with imported problems but have no provider ID.
    externalId: 'manual:' + problemId.toHexString(),
    problemKey: dsaProblemIdentity(payload).key,
    status: 'unsolved',
    submissionCount: 0,
    isFavorite: false,
  });

  await cacheManager.invalidateDashboard(userId);

  // Update topic progress
  await updateTopicProgress(userId, payload.category, payload.difficulty);

  return mapProblemToApi(problem.toObject() as unknown as Record<string, unknown> & { _id: { toString(): string } });
}

export async function updateProblem(
  userId: string,
  problemId: string,
  payload: ApiDsaProblemUpdatePayload
): Promise<ApiDsaProblem | null> {
  const update: Record<string, unknown> = { ...payload };

  // If status changed to solved, set solvedAt
  if (payload.status === 'solved') {
    update.solvedAt = new Date();
    update.lastSubmittedAt = new Date();
  } else if (payload.status) {
    update.lastSubmittedAt = new Date();
  }

  const problem = await DsaProblem.findOneAndUpdate(
    { _id: new Types.ObjectId(problemId), userId: new Types.ObjectId(userId) },
    {
      $set: update,
      ...(payload.status ? { $inc: { submissionCount: 1 } } : {}),
    },
    { new: true }
  ).lean();

  if (problem) await cacheManager.invalidateDashboard(userId);
  return problem ? mapProblemToApi(problem) : null;
}

export async function deleteProblem(userId: string, problemId: string): Promise<boolean> {
  const result = await DsaProblem.deleteOne({
    _id: new Types.ObjectId(problemId),
    userId: new Types.ObjectId(userId),
  });
  if (result.deletedCount > 0) await cacheManager.invalidateDashboard(userId);
  return result.deletedCount > 0;
}

export async function toggleFavorite(userId: string, problemId: string): Promise<ApiDsaProblem | null> {
  const problem = await DsaProblem.findOne({
    _id: new Types.ObjectId(problemId),
    userId: new Types.ObjectId(userId),
  });

  if (!problem) return null;

  problem.isFavorite = !problem.isFavorite;
  await problem.save();

  return mapProblemToApi(problem.toObject() as unknown as Record<string, unknown> & { _id: { toString(): string } });
}

export async function bulkUpdateStatus(
  userId: string,
  problemIds: string[],
  status: ApiDsaProblem['status']
): Promise<number> {
  const userObjId = new Types.ObjectId(userId);
  const objectIds = problemIds.map((id) => new Types.ObjectId(id));
  const categories = await DsaProblem.distinct('category', {
    _id: { $in: objectIds }, userId: userObjId,
  });
  const update: Record<string, unknown> = { status };

  if (status === 'solved') {
    update.solvedAt = new Date();
  }

  const result = await DsaProblem.updateMany(
    {
      _id: { $in: objectIds },
      userId: userObjId,
    },
    update
  );

  if (result.modifiedCount > 0) await cacheManager.invalidateDashboard(userId);

  // Legacy reserved-category problems still accept status changes. Their
  // platform summaries are exclusively owned by platform-sync.
  for (const category of categories) {
    if (!isReservedPlatformTopic(category)) {
      await reconcileBulkTopicProgress(userObjId, category);
    }
  }
  return result.modifiedCount;
}

async function reconcileBulkTopicProgress(userId: Types.ObjectId, topicName: string): Promise<void> {
  // Read the existing revision BEFORE aggregating. Concurrent bulk requests
  // must re-aggregate if another request has published newer counts.
  for (let attempt = 0; attempt < 8; attempt++) {
    const topic = await DsaTopicProgress.findOne({ userId, topicName }).select('_id __v').lean();
    if (!topic) {
      try {
        await DsaTopicProgress.create({ userId, topicName });
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
      }
      continue;
    }
    const [counts] = await DsaProblem.aggregate([
      { $match: { userId, category: topicName } },
      {
        $group: {
          _id: null,
          totalProblems: { $sum: 1 },
          solvedCount: { $sum: { $cond: [{ $eq: ['$status', 'solved'] }, 1, 0] } },
          easyCount: { $sum: { $cond: [{ $eq: ['$difficulty', 'easy'] }, 1, 0] } },
          easySolved: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'solved'] }, { $eq: ['$difficulty', 'easy'] }] }, 1, 0] } },
          mediumCount: { $sum: { $cond: [{ $eq: ['$difficulty', 'medium'] }, 1, 0] } },
          mediumSolved: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'solved'] }, { $eq: ['$difficulty', 'medium'] }] }, 1, 0] } },
          hardCount: { $sum: { $cond: [{ $eq: ['$difficulty', 'hard'] }, 1, 0] } },
          hardSolved: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'solved'] }, { $eq: ['$difficulty', 'hard'] }] }, 1, 0] } },
        },
      },
      { $project: { _id: 0 } },
    ]);
    const version = (topic as { __v?: number }).__v;
    const result = await DsaTopicProgress.updateOne(
      { _id: topic._id, userId, __v: version === undefined ? { $exists: false } : version },
      {
        $set: counts ?? { totalProblems: 0, solvedCount: 0, easyCount: 0, easySolved: 0, mediumCount: 0, mediumSolved: 0, hardCount: 0, hardSolved: 0 },
        $inc: { __v: 1 },
      }
    );
    if (result.matchedCount) return;
  }
  // This is not a transaction. Surface failures so the caller can repeat the
  // bulk request; reconciliation runs even when problem.modifiedCount is zero.
  throw new Error('Topic progress changed concurrently; retry the bulk status update');
}

export async function getStats(userId: string): Promise<ApiDsaStats> {
  const [summary, weeklyProgress] = await Promise.all([reconcileUserDsaSummary(userId), getWeeklyProgress(userId)]);
  return {
    totalProblems: summary.totalProblems,
    totalSolved: summary.totals.solved,
    totalAttempted: summary.totals.attempted,
    totalUnsolved: summary.totals.unsolved,
    totalRevisit: summary.totals.revisit,
    easySolved: summary.solvedByDifficulty.easy,
    easyTotal: summary.totalByDifficulty.easy,
    mediumSolved: summary.solvedByDifficulty.medium,
    mediumTotal: summary.totalByDifficulty.medium,
    hardSolved: summary.solvedByDifficulty.hard,
    hardTotal: summary.totalByDifficulty.hard,
    unknownSolved: summary.solvedByDifficulty.unknown,
    unknownTotal: summary.totalByDifficulty.unknown,
    provenance: summary.provenance,
    averageTime: summary.averageTime,
    fastestSolve: summary.fastestSolve,
    categories: summary.topics.map(({ topicName, solveRate: _solveRate, ...counts }) => ({
      ...counts, name: topicName, slug: topicName.toLowerCase().replace(/\s+/g, '-'),
    })),
    weeklyProgress,
  };
}

async function getWeeklyProgress(userId: string): Promise<ApiDsaWeeklyProgress[]> {
  const now = new Date();
  const twelveWeeksAgo = new Date(now);
  twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84); // 12 weeks = 84 days

  // Get daily activities for the last 12 weeks
  const activities = await DailyActivity.find({
    userId: new Types.ObjectId(userId),
    date: { $gte: twelveWeeksAgo, $lte: now },
    count: { $gt: 0 },
  }).sort({ date: 1 });

  // Group activities by week
  const weeklyMap = new Map<string, { easy: number; medium: number; hard: number; total: number }>();

  for (const activity of activities) {
    const date = new Date(activity.date);
    const weekStart = getStartOfWeek(date);
    const weekKey = weekStart.toISOString().split('T')[0];

    if (!weeklyMap.has(weekKey)) {
      weeklyMap.set(weekKey, { easy: 0, medium: 0, hard: 0, total: 0 });
    }

    const week = weeklyMap.get(weekKey)!;

    // Count by problem difficulty from activity types
    for (const act of activity.activities) {
      if (act.type.startsWith('dsa_solved_')) {
        const difficulty = act.type.replace('dsa_solved_', '') as 'easy' | 'medium' | 'hard';
        if (difficulty === 'easy') week.easy += act.count;
        else if (difficulty === 'medium') week.medium += act.count;
        else if (difficulty === 'hard') week.hard += act.count;
        week.total += act.count;
      } else if (act.type === 'dsa_solved') {
        week.total += act.count;
      }
    }
  }

  // Convert to array and sort by week
  const weeks: ApiDsaWeeklyProgress[] = [];
  for (let i = 11; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - i * 7);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Start of week (Sunday)

    const weekKey = weekStart.toISOString().split('T')[0];
    const weekData = weeklyMap.get(weekKey) || { easy: 0, medium: 0, hard: 0, total: 0 };

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    weeks.push({
      weekStart: weekKey,
      weekEnd: weekEnd.toISOString().split('T')[0],
      easySolved: weekData.easy,
      mediumSolved: weekData.medium,
      hardSolved: weekData.hard,
      totalSolved: weekData.total,
    });
  }

  return weeks;
}

function getStartOfWeek(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - result.getDay()); // Sunday as week start
  return result;
}

// ---------------------------------------------------------------------------
// SUBMISSIONS LIST
// ---------------------------------------------------------------------------

export async function getSubmissions(
  userId: string,
  filters: { platform?: string; status?: string; page?: number; pageSize?: number }
): Promise<ApiDsaSubmissionsListResponse> {
  const { page, pageSize } = parsePaginationParams({
    page: filters.page?.toString(),
    pageSize: filters.pageSize?.toString(),
  });

  const query: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
  if (filters.platform) query.platform = filters.platform;
  if (filters.status) query.status = filters.status;

  const skip = getSkipCount({ page, pageSize });

  const t0 = Date.now();
  const [submissions, totalCount] = await Promise.all([
    DsaSubmission.find(query)
      .sort({ submittedAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('problemId', 'title difficulty category')
      .lean(),
    DsaSubmission.countDocuments(query),
  ]);
  logger.perf('getSubmissions_query', Date.now() - t0, { userId, page, pageSize, totalCount });

  type PopulatedProblem = { title?: string; difficulty?: string; category?: string } | null;

  const mapped: ApiDsaSubmissionEntry[] = submissions.map((s) => {
    const problem = s.problemId as unknown as PopulatedProblem;
    return {
      id: (s._id as Types.ObjectId).toString(),
      platform: s.platform,
      problemName: problem?.title ?? 'Unknown Problem',
      problemDifficulty: problem?.difficulty ?? null,
      problemCategory: problem?.category ?? null,
      status: s.status,
      language: s.language,
      executionTime: s.executionTime,
      memoryUsed: s.memoryUsed,
      submittedAt: s.submittedAt.toISOString(),
    };
  });

  const pagination: ApiPagination = createPagination(totalCount, { page, pageSize });

  return { submissions: mapped, pagination };
}

// ---------------------------------------------------------------------------
// CONTESTS LIST
// ---------------------------------------------------------------------------

export async function getContests(
  userId: string,
  filters: { platform?: string; page?: number; pageSize?: number }
): Promise<ApiDsaContestsListResponse> {
  const { page, pageSize } = parsePaginationParams({
    page: filters.page?.toString(),
    pageSize: filters.pageSize?.toString(),
  });

  const query: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
  if (filters.platform) query.platform = filters.platform;

  const skip = getSkipCount({ page, pageSize });

  const [contests, totalCount] = await Promise.all([
    DsaContest.find(query).sort({ participatedAt: -1 }).skip(skip).limit(pageSize).lean(),
    DsaContest.countDocuments(query),
  ]);

  const mapped: ApiDsaContest[] = contests.map((c) => ({
    id: (c._id as Types.ObjectId).toString(),
    platform: c.platform,
    contestName: c.contestName,
    rank: c.rank,
    totalParticipants: c.totalParticipants,
    problemsSolved: c.problemsSolved,
    ratingBefore: c.ratingBefore,
    ratingAfter: c.ratingAfter,
    ratingChange: c.ratingChange,
    participatedAt: c.participatedAt.toISOString(),
  }));

  const pagination: ApiPagination = createPagination(totalCount, { page, pageSize });

  return { contests: mapped, pagination };
}

// ---------------------------------------------------------------------------
// TOPICS ANALYTICS
// ---------------------------------------------------------------------------

export interface DsaDistributionResult {
  totalProblems: number;
  totalSolved: number;
  favoriteCount: number;
  difficultyDistribution: {
    easy: number;
    medium: number;
    hard: number;
  };
  statusDistribution: {
    unsolved: number;
    attempted: number;
    solved: number;
    revisit: number;
  };
  platformDistribution: Record<
    string,
    {
      total: number;
      solved: number;
      easy: number;
      medium: number;
      hard: number;
    }
  >;
  tagFrequency: Array<{ tag: string; count: number }>;
}

export async function getProblemDistribution(userId: string): Promise<DsaDistributionResult> {
  const userObjId = new Types.ObjectId(userId);
  const problems = await DsaProblem.find({ userId: userObjId }).lean();

  let totalSolved = 0;
  let favoriteCount = 0;
  const difficultyDistribution = { easy: 0, medium: 0, hard: 0 };
  const statusDistribution = { unsolved: 0, attempted: 0, solved: 0, revisit: 0 };
  const platformDistribution: Record<
    string,
    { total: number; solved: number; easy: number; medium: number; hard: number }
  > = {};
  const tagCounts: Record<string, number> = {};

  for (const p of problems) {
    if (p.isFavorite) favoriteCount++;

    const diff = p.difficulty as 'easy' | 'medium' | 'hard';
    if (diff in difficultyDistribution) {
      difficultyDistribution[diff]++;
    }

    const st = p.status as 'unsolved' | 'attempted' | 'solved' | 'revisit';
    if (st in statusDistribution) {
      statusDistribution[st]++;
    }
    if (st === 'solved') {
      totalSolved++;
    }

    const platform = p.platform || 'custom';
    if (!platformDistribution[platform]) {
      platformDistribution[platform] = { total: 0, solved: 0, easy: 0, medium: 0, hard: 0 };
    }
    platformDistribution[platform].total++;
    if (st === 'solved') {
      platformDistribution[platform].solved++;
    }
    if (diff in platformDistribution[platform]) {
      platformDistribution[platform][diff]++;
    }

    if (Array.isArray(p.tags)) {
      for (const t of p.tags) {
        if (t && typeof t === 'string') {
          const tag = t.trim();
          if (tag) {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
        }
      }
    }
  }

  const tagFrequency = Object.entries(tagCounts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalProblems: problems.length,
    totalSolved,
    favoriteCount,
    difficultyDistribution,
    statusDistribution,
    platformDistribution,
    tagFrequency,
  };
}

export async function getTopicAnalytics(userId: string): Promise<ApiDsaTopicsListResponse> {
  const { topics, totals, totalProblems } = await reconcileUserDsaSummary(userId);
  return { topics, summary: { totalTopics: topics.length, totalSolved: totals.solved, totalProblems } };
}

async function updateTopicProgress(userId: string, topicName: string, difficulty: string): Promise<void> {
  const incrementField = `${difficulty}Count` as const;

  await DsaTopicProgress.findOneAndUpdate(
    { userId: new Types.ObjectId(userId), topicName },
    {
      $inc: { totalProblems: 1, [incrementField]: 1 },
      $setOnInsert: { topicName },
    },
    { upsert: true, new: true }
  );
}

function mapProblemToApi(problem: Record<string, unknown> & { _id: { toString(): string } }): ApiDsaProblem {
  return {
    id: (problem._id as Types.ObjectId).toString(),
    externalId: (problem.externalId as string) || '',
    title: problem.title as string,
    platform: problem.platform as ApiDsaProblem['platform'],
    difficulty: problem.difficulty as ApiDsaProblem['difficulty'],
    url: problem.url as string,
    tags: (problem.tags as string[]) || [],
    category: problem.category as string,
    status: problem.status as ApiDsaProblem['status'],
    notes: (problem.notes as string) || null,
    timeTaken: (problem.timeTaken as number) || null,
    submissionCount: (problem.submissionCount as number) || 0,
    lastSubmittedAt: problem.lastSubmittedAt ? (problem.lastSubmittedAt as Date).toISOString() : null,
    solvedAt: problem.solvedAt ? (problem.solvedAt as Date).toISOString() : null,
    isFavorite: (problem.isFavorite as boolean) || false,
    createdAt: (problem.createdAt as Date).toISOString(),
    updatedAt: (problem.updatedAt as Date).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// HEATMAP - Rolling 365-day DSA-only heatmap (LeetCode + Codeforces)
// ---------------------------------------------------------------------------

export async function getHeatmap(userId: string, _year?: number): Promise<ApiDsaHeatmapResponse> {
  // Always use rolling 365-day window regardless of year param
  const heatmapData = await generateRollingHeatmap(userId);
  const streaks = calculateStreaksFromHeatmap(heatmapData);

  const totalSubmissions = heatmapData.reduce((sum: number, day: { count: number }) => sum + day.count, 0);
  const activeDays = heatmapData.filter((day: { count: number }) => day.count > 0).length;

  return {
    heatmap: heatmapData,
    totalSubmissions,
    activeDays,
    currentStreak: streaks.current,
    longestStreak: streaks.longest,
  };
}
