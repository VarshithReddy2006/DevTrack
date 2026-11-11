// src/modules/activity/activity.service.ts
import { cacheManager } from '../../shared/cache/cacheManager.js';
import { Types } from 'mongoose';
import { ActivityEvent, DailyActivity } from '../../db/models/index.js';
import type { ApiActivityHeatmapResponse, ApiActivityFeedResponse, ApiActivityFilters, ApiActivityEntry, ApiActivitySummary } from '../../types/api.types.js';
import { getDateRangeForYear, formatISODate, getStartOfDay, getLast365Days, calculateStreaks } from '../../shared/date.js';
import { parsePaginationParams, createPagination, getSkipCount } from '../../shared/pagination.js';
import { logger } from '../../shared/logger.js';

export async function getHeatmap(userId: string, year: number): Promise<ApiActivityHeatmapResponse> {
  const { start, end } = getDateRangeForYear(year);

  const activities = await DailyActivity.find({
    userId: new Types.ObjectId(userId),
    date: { $gte: start, $lte: end },
  }).lean();

  const activityMap = new Map(activities.map((a) => [formatISODate(a.date), a]));

  const days = [];
  let totalActivities = 0;
  let totalActiveDays = 0;
  const byPlatform: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const dayOfWeekCount: Record<string, number> = {};

  const currentDate = new Date(start);
  while (currentDate <= end) {
    const dateStr = formatISODate(currentDate);
    const activity = activityMap.get(dateStr);

    const count = activity?.count || 0;
    let level: 0 | 1 | 2 | 3 | 4 = 0;
    if (count > 20) level = 4;
    else if (count > 10) level = 3;
    else if (count > 5) level = 2;
    else if (count > 0) level = 1;

    const dayActivities: ApiActivityEntry[] = [];
    if (activity?.activities) {
      for (const act of activity.activities) {
        dayActivities.push({
          id: '',
          type: act.type as ApiActivityEntry['type'],
          title: '',
          description: '',
          platform: '',
          url: null,
          tags: [],
          metadata: {},
          occurredAt: dateStr,
        });

        byType[act.type] = (byType[act.type] || 0) + act.count;
      }
    }

    days.push({
      date: dateStr,
      count,
      level,
      activities: dayActivities,
    });

    if (count > 0) {
      totalActivities += count;
      totalActiveDays++;
    }

    const dayName = currentDate.toLocaleDateString('en-US', { weekday: 'long' });
    dayOfWeekCount[dayName] = (dayOfWeekCount[dayName] || 0) + count;

    currentDate.setDate(currentDate.getDate() + 1);
  }

  const mostActiveDay = Object.entries(dayOfWeekCount)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'Monday';

  // Calculate streaks from active days
  const activeDates = days.filter((d) => d.count > 0).map((d) => new Date(d.date));
  const { currentStreak, longestStreak } = calculateStreaks(activeDates);

  const summary: ApiActivitySummary = {
    totalActivities,
    totalActiveDays,
    currentStreak,
    longestStreak,
    mostActiveDay,
    avgPerDay: totalActiveDays > 0 ? Math.round(totalActivities / totalActiveDays) : 0,
    byPlatform,
    byType,
  };

  return { year, days, summary };
}

export async function getFeed(userId: string, filters: ApiActivityFilters): Promise<ApiActivityFeedResponse> {
  const { page, pageSize } = parsePaginationParams({
    page: filters.page?.toString(),
    pageSize: filters.pageSize?.toString(),
  });

  const query: Record<string, unknown> = { userId: new Types.ObjectId(userId) };

  if (filters.platform) query.platform = filters.platform;
  if (filters.type) query.type = filters.type;
  if (filters.startDate || filters.endDate) {
    query.occurredAt = {};
    if (filters.startDate) (query.occurredAt as Record<string, Date>).$gte = new Date(filters.startDate);
    if (filters.endDate) (query.occurredAt as Record<string, Date>).$lte = new Date(filters.endDate);
  }
  if (filters.tags?.length) {
    query.tags = { $in: filters.tags };
  }

  const skip = getSkipCount({ page, pageSize });

  const [activities, totalCount] = await Promise.all([
    ActivityEvent.find(query).sort({ occurredAt: -1 }).skip(skip).limit(pageSize).lean(),
    ActivityEvent.countDocuments(query),
  ]);

  const pagination = createPagination(totalCount, { page, pageSize });

  return {
    activities: activities.map((a) => ({
      id: a._id.toString(),
      type: a.type,
      title: a.title,
      description: a.description,
      platform: a.platform,
      url: a.url,
      tags: a.tags || [],
      metadata: a.metadata || {},
      occurredAt: a.occurredAt.toISOString(),
    })),
    pagination,
  };
}

export async function getActivitiesByDate(userId: string, date: string): Promise<ApiActivityEntry[]> {
  const startOfDay = getStartOfDay(new Date(date));
  const endOfDay = new Date(startOfDay);
  endOfDay.setHours(23, 59, 59, 999);

  const activities = await ActivityEvent.find({
    userId: new Types.ObjectId(userId),
    occurredAt: { $gte: startOfDay, $lte: endOfDay },
  }).sort({ occurredAt: -1 });

  return activities.map((a) => ({
    id: a._id.toString(),
    type: a.type,
    title: a.title,
    description: a.description,
    platform: a.platform,
    url: a.url,
    tags: a.tags || [],
    metadata: a.metadata || {},
    occurredAt: a.occurredAt.toISOString(),
  }));
}

export async function createActivity(
  userId: string,
  payload: Omit<ApiActivityEntry, 'id' | 'occurredAt'> & { occurredAt?: string | Date }
): Promise<ApiActivityEntry> {
  const occurredAt = payload.occurredAt ? new Date(payload.occurredAt) : new Date();

  const activity = await ActivityEvent.create({
    userId: new Types.ObjectId(userId),
    ...payload,
    occurredAt,
  });

  // Update daily activity
  const dateKey = getStartOfDay(occurredAt);
  try {
    await DailyActivity.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), date: dateKey },
      {
        $inc: { count: 1 },
        $push: { activities: { type: payload.type, count: 1 } },
      },
      { upsert: true, new: true }
    );
  } finally {
    // The activity event already exists even if updating the daily count fails.
    await cacheManager.invalidateDashboard(userId);
  }

  // Removed retention hook

  return {
    id: activity._id.toString(),
    type: activity.type,
    title: activity.title,
    description: activity.description,
    platform: activity.platform,
    url: activity.url,
    tags: activity.tags || [],
    metadata: activity.metadata || {},
    occurredAt: activity.occurredAt.toISOString(),
  };
}

/**
 * Increments the activity count for a specific date without creating an ActivityEvent.
 * Useful for bulk ingestion (e.g. sync) where individual events might be too noisy.
 */
export async function incrementDailyActivity(
  userId: string,
  date: Date,
  type: string = 'submission'
): Promise<void> {
  const dateKey = getStartOfDay(date);
  await DailyActivity.findOneAndUpdate(
    { userId: new Types.ObjectId(userId), date: dateKey },
    {
      $inc: { count: 1 },
      $push: { activities: { type, count: 1 } },
    },
    { upsert: true, new: true }
  );
  await cacheManager.invalidateDashboard(userId);
}

export async function deleteActivity(userId: string, activityId: string): Promise<boolean> {
  const result = await ActivityEvent.deleteOne({
    _id: new Types.ObjectId(activityId),
    userId: new Types.ObjectId(userId),
  });
  if (result.deletedCount > 0) await cacheManager.invalidateDashboard(userId);
  return result.deletedCount > 0;
}