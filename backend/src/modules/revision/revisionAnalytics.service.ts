import { Types } from 'mongoose';
import { RevisionCard } from '../../db/models/revisionCard.model.js';
import { cacheManager } from '../../shared/cache/cacheManager.js';
import { DAY_IN_MS } from './sm2.js';

export interface RevisionAnalytics {
  asOf: string;
  totalCards: number;
  cardsDueToday: number;
  retentionPercentage: number;
  mastery: { learning: number; reviewing: number; mastered: number };
  patterns: Array<{ pattern: string; totalCards: number; retentionPercentage: number; struggleRate: number }>;
  forecast: Array<{ date: string; dueCards: number }>;
}

interface AggregatedAnalytics {
  summary: Array<{
    totalCards: number; cardsDueToday: number; retentionPercentage: number;
    learning: number; reviewing: number; mastered: number;
  }>;
  patterns: RevisionAnalytics['patterns'];
  forecast: Array<{ date: string; dueCards: number }>;
}

export class RevisionAnalyticsService {
  static async getAnalytics(userId: string, now = new Date()): Promise<RevisionAnalytics> {
    const owner = new Types.ObjectId(userId);
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + DAY_IN_MS);
    const forecastEnd = new Date(today.getTime() + 14 * DAY_IN_MS);
    // Date-scoped keys prevent yesterday's forecast being served after UTC midnight.
    const key = `cache:revision:analytics:v1:${owner.toHexString()}:${today.toISOString().slice(0, 10)}`;

    return cacheManager.getOrSet(key, async () => {
      const [result] = await RevisionCard.aggregate<AggregatedAnalytics>([
        { $match: { userId: owner } },
        { $project: {
          intervalDays: 1,
          repetitions: 1,
          reviewed: { $ne: [{ $ifNull: ['$lastReviewedAt', null] }, null] },
          // SM-2 interval is the available stability proxy; new cards decay from creation.
          retention: { $multiply: [100, { $exp: { $divide: [
            { $multiply: [-1, { $max: [0, { $divide: [
              { $subtract: [now, { $ifNull: ['$lastReviewedAt', '$createdAt'] }] }, DAY_IN_MS,
            ] }] }] },
            { $max: [1, '$intervalDays'] },
          ] } }] },
          effectiveDueAt: { $max: ['$dueAt', { $ifNull: ['$snoozedUntil', '$dueAt'] }] },
          tags: { $setUnion: [{ $filter: {
            input: { $map: { input: { $ifNull: ['$tags', []] }, as: 'tag', in: { $trim: { input: '$$tag' } } } },
            as: 'tag', cond: { $ne: ['$$tag', ''] },
          } }, []] },
        } },
        { $facet: {
          summary: [{ $group: {
            _id: null,
            totalCards: { $sum: 1 },
            cardsDueToday: { $sum: { $cond: [{ $lt: ['$effectiveDueAt', tomorrow] }, 1, 0] } },
            retentionPercentage: { $avg: '$retention' },
            mastered: { $sum: { $cond: [{ $gt: ['$intervalDays', 21] }, 1, 0] } },
            learning: { $sum: { $cond: [{ $and: [
              { $lte: ['$intervalDays', 21] }, { $eq: ['$repetitions', 0] },
            ] }, 1, 0] } },
            reviewing: { $sum: { $cond: [{ $and: [
              { $lte: ['$intervalDays', 21] }, { $gt: ['$repetitions', 0] },
            ] }, 1, 0] } },
          } }],
          patterns: [
            { $set: { tags: { $cond: [{ $eq: [{ $size: '$tags' }, 0] }, ['untagged'], '$tags'] } } },
            { $unwind: '$tags' },
            { $group: {
              _id: '$tags', totalCards: { $sum: 1 }, retentionPercentage: { $avg: '$retention' },
              struggleRate: { $avg: { $cond: [{ $and: ['$reviewed', { $eq: ['$repetitions', 0] }] }, 100, 0] } },
            } },
            { $sort: { _id: 1 } },
            { $project: { _id: 0, pattern: '$_id', totalCards: 1, retentionPercentage: 1, struggleRate: 1 } },
          ],
          forecast: [
            { $match: { effectiveDueAt: { $lt: forecastEnd } } },
            { $group: {
              _id: { $dateToString: { date: { $max: ['$effectiveDueAt', today] }, format: '%Y-%m-%d', timezone: 'UTC' } },
              dueCards: { $sum: 1 },
            } },
            { $project: { _id: 0, date: '$_id', dueCards: 1 } },
          ],
        } },
      ]).exec();

      const summary = result?.summary[0];
      const forecast = new Map(result?.forecast.map(day => [day.date, day.dueCards]));
      return {
        asOf: now.toISOString(),
        totalCards: summary?.totalCards ?? 0,
        cardsDueToday: summary?.cardsDueToday ?? 0,
        retentionPercentage: summary?.retentionPercentage ?? 0,
        mastery: {
          learning: summary?.learning ?? 0,
          reviewing: summary?.reviewing ?? 0,
          mastered: summary?.mastered ?? 0,
        },
        patterns: result?.patterns ?? [],
        forecast: Array.from({ length: 14 }, (_, index) => {
          const date = new Date(today.getTime() + index * DAY_IN_MS).toISOString().slice(0, 10);
          return { date, dueCards: forecast.get(date) ?? 0 };
        }),
      };
    }, 600);
  }
}
