import { Types, type FilterQuery } from 'mongoose';
import {
  IntelligenceRecommendation,
  type IIntelligenceRecommendation,
  type RecommendationState,
} from '../../../db/models/intelligenceRecommendation.model.js';

export type RecommendationAction = 'view' | 'accept' | 'complete' | 'dismiss';
const transitions = {
  accept: { from: ['active'], state: 'accepted', timestamp: 'acceptedAt' },
  complete: { from: ['active', 'accepted'], state: 'completed', timestamp: 'completedAt' },
  dismiss: { from: ['active', 'accepted'], state: 'ignored', timestamp: 'ignoredAt' },
  decay: { from: ['active'], state: 'decayed', timestamp: 'decayedAt' },
  retire: { from: ['active', 'decayed'], state: 'retired', timestamp: 'retiredAt' },
} as const;
const hour = 60 * 60 * 1000;
const historyLimit = 50;

function eventUpdate(eventType: string, timestamp: Date) {
  return { lifecycleEvents: { $each: [{ eventType, timestamp }], $slice: -historyLimit } };
}

export class RecommendationLifecycleEngineClass {
  async recordAction(recommendationId: string, userId: string, action: RecommendationAction) {
    const owned = { _id: recommendationId, userId };
    const now = new Date();
    const updated = action === 'view'
      ? await IntelligenceRecommendation.findOneAndUpdate(
        { ...owned, state: { $in: ['active', 'accepted'] } },
        { $inc: { viewCount: 1 }, $set: { lastViewedAt: now }, $push: eventUpdate('viewed', now) },
        { new: true },
      )
      : await this.transition(owned, action, now);

    if (updated) return updated;

    const current = await IntelligenceRecommendation.findOne(owned);
    if (!current) throw Object.assign(new Error('Recommendation not found'), { statusCode: 404 });
    if (action !== 'view' && current.state === transitions[action].state) return current;
    throw Object.assign(new Error('Recommendation state does not allow this action'), { statusCode: 409 });
  }

  private transition(
    filter: FilterQuery<IIntelligenceRecommendation>,
    action: keyof typeof transitions,
    now: Date,
    currentDecay?: number,
  ) {
    const { from, state, timestamp } = transitions[action];
    return IntelligenceRecommendation.findOneAndUpdate(
      { ...filter, state: { $in: from } },
      {
        $set: { state, [timestamp]: now, ...(currentDecay === undefined ? {} : { currentDecay }) },
        $push: eventUpdate(state, now),
      },
      { new: true },
    );
  }

  async updateDecay(scope: Pick<FilterQuery<IIntelligenceRecommendation>, 'userId' | 'resumeProfileId'>, now = new Date()) {
    const candidates = IntelligenceRecommendation.find({
      ...scope, state: { $in: ['active', 'decayed'] },
      createdAt: { $lte: new Date(now.getTime() - 7 * 24 * hour * 0.7) },
    }).select('_id userId state createdAt viewCount currentDecay').lean().cursor();

    for await (const row of candidates) {
      const ageHours = (now.getTime() - row.createdAt.getTime()) / hour;
      const viewCount = row.viewCount ?? 0;
      const filter = {
        ...scope, _id: row._id, userId: row.userId,
        viewCount: viewCount === 0 ? { $in: [null, 0] } : viewCount,
      };
      const decay = Math.max(0, Math.min(1, ageHours / (7 * 24)) - Math.min(0.5, viewCount * 0.1));
      if (ageHours >= 30 * 24) {
        await this.transition(filter, 'retire', now, decay);
      } else if (row.state === 'active' && decay >= 0.7) {
        await this.transition(filter, 'decay', now, decay);
      } else if (row.state === 'active' && decay !== row.currentDecay) {
        await IntelligenceRecommendation.updateOne({ ...filter, state: 'active' }, { $set: { currentDecay: decay } });
      }
    }
  }

  getLifecycle(recommendationId: string, userId: string) {
    return IntelligenceRecommendation.findOne({ _id: recommendationId, userId }).lean();
  }

  setEffectivenessScore(recommendationId: string, userId: string, score: number) {
    return IntelligenceRecommendation.updateOne(
      { _id: recommendationId, userId },
      { $set: { effectivenessScore: Math.min(100, Math.max(0, score)) } },
      { runValidators: true },
    );
  }

  async getMetrics(userId?: string) {
    const count = (states: RecommendationState[]) => ({ $sum: { $cond: [{ $in: ['$state', states] }, 1, 0] } });
    const rollup = {
      total: { $sum: 1 },
      accepted: { $sum: { $cond: [{
        $or: [
          { $in: ['$state', ['accepted', 'completed']] },
          { $ne: [{ $ifNull: ['$acceptedAt', null] }, null] },
        ],
      }, 1, 0] } },
      completed: count(['completed']),
      decayed: { $sum: { $cond: [{
        $or: [
          { $eq: ['$state', 'decayed'] },
          { $ne: [{ $ifNull: ['$decayedAt', null] }, null] },
        ],
      }, 1, 0] } },
      retired: count(['retired']),
      activeDecayed: count(['decayed']),
      effectiveness: { $avg: '$effectivenessScore' },
      timeToAccept: { $avg: { $divide: [{ $subtract: ['$acceptedAt', '$createdAt'] }, hour] } },
      timeToComplete: { $avg: { $divide: [
        { $subtract: ['$completedAt', { $ifNull: ['$acceptedAt', '$createdAt'] }] }, hour,
      ] } },
    };
    type Summary = {
      total: number; accepted: number; completed: number; decayed: number; retired: number; activeDecayed: number;
      effectiveness: number | null; timeToAccept: number | null; timeToComplete: number | null;
    };
    const [metrics] = await IntelligenceRecommendation.aggregate<{
      overall: Summary[];
      byCategory: Array<Summary & { _id: string }>;
    }>([
      ...(userId ? [{ $match: { userId: new Types.ObjectId(userId) } }] : []),
      { $facet: {
        overall: [{ $group: { _id: null, ...rollup } }],
        byCategory: [{ $group: { _id: '$category', ...rollup } }],
      } },
    ]);
    const overall = metrics?.overall[0];
    const rate = (numerator: number, denominator: number) => denominator ? Math.round(numerator / denominator * 100) : 0;
    return {
      totalRecommendations: overall?.total ?? 0,
      acceptanceRate: rate(overall?.accepted ?? 0, overall?.total ?? 0),
      completionRate: rate(overall?.completed ?? 0, overall?.accepted ?? 0),
      decayRate: rate(overall?.decayed ?? 0, overall?.total ?? 0),
      averageTimeToAccept: Math.round(overall?.timeToAccept ?? 0),
      averageTimeToComplete: Math.round(overall?.timeToComplete ?? 0),
      averageEffectiveness: Math.round(overall?.effectiveness ?? 0),
      decayedCount: overall?.decayed ?? 0,
      activeDecayedCount: overall?.activeDecayed ?? 0,
      retiredCount: overall?.retired ?? 0,
      byType: Object.fromEntries((metrics?.byCategory ?? []).map(row => [row._id, {
        total: row.total, accepted: row.accepted, completed: row.completed, effectiveness: row.effectiveness ?? 0,
      }])),
    };
  }
}

export const RecommendationLifecycleEngine = new RecommendationLifecycleEngineClass();
