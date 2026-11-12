import { isObjectIdOrHexString, Types } from 'mongoose';
import { CareerIntent } from '../../../../db/models/careerIntent.model.js';
import { DsaProblem } from '../../../../db/models/dsaProblem.model.js';
import { DSAProfile, IDSAProfile } from '../../../../db/models/dsaProfile.model.js';
import { DsaSubmission } from '../../../../db/models/dsaSubmission.model.js';
import { UserProfile } from '../../../../db/models/userProfile.model.js';
import { Platform, TopicBreakdown } from '../types/dsa.types';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;

interface DSAHistory {
  recentActivity: number[];
  hardGrowthTrend: number;
}

export interface IDSARepository {
  findByUserId(userId: string, platform?: Platform): Promise<any[]>;
  findByUserIdAndPlatform(userId: string, platform: Platform): Promise<any | null>;
  create(data: Partial<IDSAProfile>): Promise<IDSAProfile>;
  update(userId: string, platform: Platform, data: Partial<IDSAProfile>): Promise<any | null>;
  delete(userId: string, platform: Platform): Promise<boolean>;
  aggregateByUserId(userId: string): Promise<AggregatedDSAData>;
  getSolveHistory(userId: string, now?: Date): Promise<DSAHistory>;
  getTargetRole(userId: string): Promise<string | undefined>;
}

export interface AggregatedDSAData {
  totalSolved: number;
  easySolved: number;
  mediumSolved: number;
  hardSolved: number;
  currentStreak: number;
  longestStreak: number;
  lastSolvedDate: Date | null;
  topicBreakdown: TopicBreakdown;
  isVerified: boolean;
  lastSyncedAt: Date | null;
  platforms: Platform[];
}

export class DSARepository implements IDSARepository {
  async getSolveHistory(userId: string, now = new Date()): Promise<DSAHistory> {
    const recentActivity = new Array<number>(2 * WINDOW_DAYS).fill(0);
    if (!isObjectIdOrHexString(userId)) return { recentActivity, hardGrowthTrend: 0 };

    const owner = new Types.ObjectId(userId);
    const start = new Date(now.getTime() - recentActivity.length * DAY_MS);
    const days = await DsaSubmission.aggregate<{ _id: number; solves: number; hard: number }>([
      { $match: { userId: owner, status: 'accepted', submittedAt: { $gte: start, $lt: now } } },
      // Count each problem once, on its first accepted submission in the comparison period.
      { $group: { _id: '$problemId', solvedAt: { $min: '$submittedAt' } } },
      {
        $lookup: {
          from: DsaProblem.collection.name,
          localField: '_id',
          foreignField: '_id',
          pipeline: [{ $match: { userId: owner, difficulty: 'hard', difficultyKnown: { $ne: false } } }],
          as: 'hardProblem',
        },
      },
      {
        $group: {
          _id: { $floor: { $divide: [{ $subtract: ['$solvedAt', start] }, DAY_MS] } },
          solves: { $sum: 1 },
          hard: { $sum: { $size: '$hardProblem' } },
        },
      },
    ]);

    let previousHard = 0;
    let recentHard = 0;
    for (const { _id: day, solves, hard } of days) {
      recentActivity[day] = solves;
      if (day < WINDOW_DAYS) previousHard += hard;
      else recentHard += hard;
    }
    const hardGrowthTrend = (recentHard - previousHard) / Math.max(1, recentHard, previousHard);
    return { recentActivity, hardGrowthTrend };
  }

  async getTargetRole(userId: string): Promise<string | undefined> {
    const intent = await CareerIntent.findOne({ userId }).select('dreamRole').lean();
    const dreamRole = intent?.dreamRole?.trim();
    if (dreamRole) return dreamRole;
    if (!isObjectIdOrHexString(userId)) return undefined;

    const profile = await UserProfile.findOne({ userId }).select('targetRole').lean();
    return profile?.targetRole?.trim() || undefined;
  }

  async findByUserId(userId: string, platform?: Platform): Promise<any[]> {
    const query: any = { userId };
    if (platform) {
      query.platform = platform;
    }
    return await DSAProfile.find(query).lean() as any[];
  }

  async findByUserIdAndPlatform(userId: string, platform: Platform): Promise<any | null> {
    return await DSAProfile.findOne({ userId, platform }).lean() as any;
  }

  async create(data: Partial<IDSAProfile>): Promise<IDSAProfile> {
    const profile = new DSAProfile(data);
    return await profile.save();
  }

  async update(userId: string, platform: Platform, data: Partial<IDSAProfile>): Promise<any | null> {
    return await DSAProfile.findOneAndUpdate(
      { userId, platform },
      { $set: data },
      { new: true, upsert: false }
    ).lean() as any;
  }

  async delete(userId: string, platform: Platform): Promise<boolean> {
    const result = await DSAProfile.deleteOne({ userId, platform });
    return result.deletedCount > 0;
  }

  async aggregateByUserId(userId: string): Promise<AggregatedDSAData> {
    const profiles = await DSAProfile.find({ userId }).lean() as any[];

    if (profiles.length === 0) {
      return {
        totalSolved: 0,
        easySolved: 0,
        mediumSolved: 0,
        hardSolved: 0,
        currentStreak: 0,
        longestStreak: 0,
        lastSolvedDate: null,
        topicBreakdown: {
          arrays: 0,
          hashing: 0,
          strings: 0,
          linkedList: 0,
          stack: 0,
          queue: 0,
          trees: 0,
          graphs: 0,
          heaps: 0,
          recursion: 0,
          backtracking: 0,
          dp: 0,
          greedy: 0,
          binarySearch: 0,
        },
        isVerified: false,
        lastSyncedAt: null,
        platforms: [],
      };
    }

    // Aggregate across all platforms
    const aggregated: AggregatedDSAData = {
      totalSolved: 0,
      easySolved: 0,
      mediumSolved: 0,
      hardSolved: 0,
      currentStreak: 0,
      longestStreak: 0,
      lastSolvedDate: null,
      topicBreakdown: {
        arrays: 0,
        hashing: 0,
        strings: 0,
        linkedList: 0,
        stack: 0,
        queue: 0,
        trees: 0,
        graphs: 0,
        heaps: 0,
        recursion: 0,
        backtracking: 0,
        dp: 0,
        greedy: 0,
        binarySearch: 0,
      },
      isVerified: false,
      lastSyncedAt: null,
      platforms: [],
    };

    profiles.forEach((profile) => {
      aggregated.totalSolved += profile.totalSolved;
      aggregated.easySolved += profile.easySolved;
      aggregated.mediumSolved += profile.mediumSolved;
      aggregated.hardSolved += profile.hardSolved;
      aggregated.currentStreak = Math.max(aggregated.currentStreak, profile.currentStreak);
      aggregated.longestStreak = Math.max(aggregated.longestStreak, profile.longestStreak);
      
      if (profile.lastSolvedDate) {
        if (!aggregated.lastSolvedDate || profile.lastSolvedDate > aggregated.lastSolvedDate) {
          aggregated.lastSolvedDate = profile.lastSolvedDate;
        }
      }

      if (profile.lastSyncedAt) {
        if (!aggregated.lastSyncedAt || profile.lastSyncedAt > aggregated.lastSyncedAt) {
          aggregated.lastSyncedAt = profile.lastSyncedAt;
        }
      }

      aggregated.isVerified = aggregated.isVerified || profile.isVerified;
      aggregated.platforms.push(profile.platform);

      // Aggregate topic breakdown
      Object.entries(profile.topicBreakdown).forEach(([topic, count]) => {
        const topicKey = topic as keyof TopicBreakdown;
        if (topicKey in aggregated.topicBreakdown) {
          aggregated.topicBreakdown[topicKey] += (count as number);
        }
      });
    });

    return aggregated;
  }
}

export const dsaRepository = new DSARepository();
