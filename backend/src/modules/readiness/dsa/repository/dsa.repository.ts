import { isObjectIdOrHexString, Types } from 'mongoose';
import { CareerIntent } from '../../../../db/models/careerIntent.model.js';
import { ConnectedPlatform } from '../../../../db/models/connectedPlatform.model.js';
import { DailyActivity } from '../../../../db/models/dailyActivity.model.js';
import { DsaProblem } from '../../../../db/models/dsaProblem.model.js';
import { DSAProfile, IDSAProfile } from '../../../../db/models/dsaProfile.model.js';
import { DsaSubmission } from '../../../../db/models/dsaSubmission.model.js';
import { PlatformStats } from '../../../../db/models/platformStats.model.js';
import { ReadinessDsa } from '../../../../db/models/readinessDsa.model.js';
import { UserProfile } from '../../../../db/models/userProfile.model.js';
import { reconcileUserDsaSummary } from '../../../dsa/dsa-reconciliation.js';
import { Platform, TopicBreakdown } from '../types/dsa.types';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;

const TOPIC_SYNONYMS: Record<string, keyof TopicBreakdown> = {
  array: 'arrays',
  arrays: 'arrays',
  'two pointers': 'arrays',
  'two-pointers': 'arrays',
  'sliding window': 'arrays',
  'sliding-window': 'arrays',
  'prefix sum': 'arrays',
  'prefix-sum': 'arrays',
  matrix: 'arrays',
  hash: 'hashing',
  hashing: 'hashing',
  'hash table': 'hashing',
  'hash-table': 'hashing',
  'hash function': 'hashing',
  'hash-function': 'hashing',
  string: 'strings',
  strings: 'strings',
  'string matching': 'strings',
  'linked list': 'linkedList',
  'linked-list': 'linkedList',
  linkedlist: 'linkedList',
  stack: 'stack',
  'monotonic stack': 'stack',
  'monotonic-stack': 'stack',
  queue: 'queue',
  'monotonic queue': 'queue',
  'monotonic-queue': 'queue',
  tree: 'trees',
  trees: 'trees',
  'binary tree': 'trees',
  'binary-tree': 'trees',
  'binary search tree': 'trees',
  'binary-search-tree': 'trees',
  trie: 'trees',
  'segment tree': 'trees',
  graph: 'graphs',
  graphs: 'graphs',
  dfs: 'graphs',
  bfs: 'graphs',
  'dfs and similar': 'graphs',
  'depth-first search': 'graphs',
  'depth-first-search': 'graphs',
  'breadth-first search': 'graphs',
  'breadth-first-search': 'graphs',
  'shortest path': 'graphs',
  'shortest-path': 'graphs',
  'shortest paths': 'graphs',
  'union find': 'graphs',
  'union-find': 'graphs',
  dsu: 'graphs',
  'topological sort': 'graphs',
  'topological-sort': 'graphs',
  heap: 'heaps',
  heaps: 'heaps',
  'heap (priority queue)': 'heaps',
  'heap-priority-queue': 'heaps',
  'priority queue': 'heaps',
  'data structures': 'heaps',
  recursion: 'recursion',
  'divide and conquer': 'recursion',
  'divide-and-conquer': 'recursion',
  backtracking: 'backtracking',
  dp: 'dp',
  'dynamic programming': 'dp',
  'dynamic-programming': 'dp',
  memoization: 'dp',
  greedy: 'greedy',
  'binary search': 'binarySearch',
  'binary-search': 'binarySearch',
  binarysearch: 'binarySearch',
};

function createEmptyTopicBreakdown(): TopicBreakdown {
  return {
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
  };
}

export function mapTagToTopicKey(tag: string): keyof TopicBreakdown | null {
  const normalized = tag.trim().toLowerCase().replace(/_/g, ' ');
  return TOPIC_SYNONYMS[normalized] ?? TOPIC_SYNONYMS[normalized.replace(/-/g, ' ')] ?? null;
}

function computeStreaksFromDateKeys(dateKeys: Set<string>, now = new Date()): {
  currentStreak: number;
  longestStreak: number;
  lastSolvedDate: Date | null;
} {
  if (dateKeys.size === 0) {
    return { currentStreak: 0, longestStreak: 0, lastSolvedDate: null };
  }
  const sortedKeys = Array.from(dateKeys).sort();
  const lastSolvedDate = new Date(`${sortedKeys[sortedKeys.length - 1]}T00:00:00.000Z`);

  let longestStreak = 0;
  let run = 0;
  let prevDayMs: number | null = null;
  for (const key of sortedKeys) {
    const dayMs = Date.parse(`${key}T00:00:00.000Z`);
    if (prevDayMs !== null && dayMs - prevDayMs === DAY_MS) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longestStreak) longestStreak = run;
    prevDayMs = dayMs;
  }

  const todayKey = now.toISOString().split('T')[0];
  const yesterdayKey = new Date(now.getTime() - DAY_MS).toISOString().split('T')[0];
  let currentStreak = 0;
  let cursorMs: number | null = dateKeys.has(todayKey)
    ? Date.parse(`${todayKey}T00:00:00.000Z`)
    : dateKeys.has(yesterdayKey)
      ? Date.parse(`${yesterdayKey}T00:00:00.000Z`)
      : null;

  while (cursorMs !== null) {
    const key = new Date(cursorMs).toISOString().split('T')[0];
    if (!dateKeys.has(key)) break;
    currentStreak += 1;
    cursorMs -= DAY_MS;
  }

  return { currentStreak, longestStreak, lastSolvedDate };
}

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
      const emptyResult: AggregatedDSAData = {
        totalSolved: 0,
        easySolved: 0,
        mediumSolved: 0,
        hardSolved: 0,
        currentStreak: 0,
        longestStreak: 0,
        lastSolvedDate: null,
        topicBreakdown: createEmptyTopicBreakdown(),
        isVerified: false,
        lastSyncedAt: null,
        platforms: [],
      };

      if (!isObjectIdOrHexString(userId)) {
        return emptyResult;
      }

      const owner = new Types.ObjectId(userId);
      const [summary, platformStats, connectedPlatforms, readinessDsa, solvedProblems, acceptedSubmissions, dailyActivities] =
        await Promise.all([
          reconcileUserDsaSummary(userId),
          PlatformStats.find({ userId: owner, platformName: { $in: ['leetcode', 'codeforces', 'codechef'] } }).lean(),
          ConnectedPlatform.find({ userId: owner, isConnected: true, platformName: { $in: ['leetcode', 'codeforces', 'codechef'] } })
            .select('platformName lastSyncedAt')
            .lean(),
          ReadinessDsa.findOne({ userId }).lean(),
          DsaProblem.find({ userId: owner, status: 'solved' }).select('tags category').lean(),
          DsaSubmission.find({ userId: owner, status: 'accepted' })
            .select('submittedAt topicTags platform')
            .sort({ submittedAt: -1 })
            .limit(500)
            .lean(),
          DailyActivity.find({ userId: owner, totalActivities: { $gt: 0 } })
            .select('date')
            .sort({ date: -1 })
            .limit(365)
            .lean(),
        ]);

      const topicBreakdown = createEmptyTopicBreakdown();

      // 1) Map problem-level tags from solved problems and accepted submissions
      const problemTopicCounts = createEmptyTopicBreakdown();
      for (const prob of solvedProblems) {
        const seenForProblem = new Set<keyof TopicBreakdown>();
        for (const tag of [...(prob.tags ?? []), ...(prob.category ? [prob.category] : [])]) {
          const mapped = mapTagToTopicKey(tag);
          if (mapped && !seenForProblem.has(mapped)) {
            seenForProblem.add(mapped);
            problemTopicCounts[mapped] += 1;
          }
        }
      }
      for (const key of Object.keys(topicBreakdown) as Array<keyof TopicBreakdown>) {
        topicBreakdown[key] = problemTopicCounts[key];
      }

      // 2) Merge LeetCode GraphQL tagProblemCounts & submissionCalendar from PlatformStats
      const dateKeys = new Set<string>();
      for (const stat of platformStats) {
        const raw = stat.rawData as Record<string, any> | undefined;
        const tagCounts = raw?.tagProblemCounts;
        if (tagCounts && typeof tagCounts === 'object') {
          const buckets = [
            ...(Array.isArray(tagCounts.fundamental) ? tagCounts.fundamental : []),
            ...(Array.isArray(tagCounts.intermediate) ? tagCounts.intermediate : []),
            ...(Array.isArray(tagCounts.advanced) ? tagCounts.advanced : []),
          ];
          const lcTopicCounts = createEmptyTopicBreakdown();
          for (const item of buckets) {
            const count = typeof item?.problemsSolved === 'number' ? item.problemsSolved : 0;
            if (count <= 0) continue;
            const mapped =
              (item.tagSlug ? mapTagToTopicKey(String(item.tagSlug)) : null) ??
              (item.tagName ? mapTagToTopicKey(String(item.tagName)) : null);
            if (mapped) {
              lcTopicCounts[mapped] = Math.max(lcTopicCounts[mapped], count);
            }
          }
          for (const key of Object.keys(topicBreakdown) as Array<keyof TopicBreakdown>) {
            topicBreakdown[key] = Math.max(topicBreakdown[key], lcTopicCounts[key]);
          }
        }

        const cal = raw?.submissionCalendar;
        if (cal && typeof cal === 'object') {
          for (const [dateStr, count] of Object.entries(cal)) {
            if (typeof count === 'number' && count > 0 && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
              dateKeys.add(dateStr);
            }
          }
        }
      }

      // 3) Supplement from ReadinessDsa computed topics if available
      if (readinessDsa?.topics?.length) {
        for (const t of readinessDsa.topics) {
          const mapped = t.name ? mapTagToTopicKey(t.name) : null;
          if (mapped && topicBreakdown[mapped] === 0 && (t.masteryLevel ?? 0) > 0) {
            topicBreakdown[mapped] = Math.max(1, Math.round((t.masteryLevel ?? 0) / 5));
          }
        }
      }

      // 4) Collect active days from accepted submissions and daily activity logs
      for (const sub of acceptedSubmissions) {
        if (sub.submittedAt instanceof Date && Number.isFinite(sub.submittedAt.getTime())) {
          dateKeys.add(sub.submittedAt.toISOString().split('T')[0]);
        }
      }
      for (const act of dailyActivities) {
        if (act.date instanceof Date && Number.isFinite(act.date.getTime())) {
          dateKeys.add(act.date.toISOString().split('T')[0]);
        }
      }

      const streakInfo = computeStreaksFromDateKeys(dateKeys);
      const lastSolvedDate =
        acceptedSubmissions[0]?.submittedAt instanceof Date
          ? acceptedSubmissions[0].submittedAt
          : streakInfo.lastSolvedDate;

      // 5) Determine latest sync timestamp
      const syncDates: Date[] = [];
      for (const cp of connectedPlatforms) {
        if (cp.lastSyncedAt instanceof Date) syncDates.push(cp.lastSyncedAt);
      }
      for (const stat of platformStats) {
        if (stat.fetchedAt instanceof Date) syncDates.push(stat.fetchedAt);
      }
      if (readinessDsa?.computedAt instanceof Date) syncDates.push(readinessDsa.computedAt);
      const lastSyncedAt = syncDates.length > 0 ? new Date(Math.max(...syncDates.map((d) => d.getTime()))) : null;

      // 6) Collect active platform identifiers compatible with ConfidenceEngine
      const platformSet = new Set<Platform>();
      for (const cp of connectedPlatforms) {
        if (cp.platformName === 'leetcode' || cp.platformName === 'codeforces') {
          platformSet.add(cp.platformName);
        }
      }
      for (const stat of platformStats) {
        if (stat.platformName === 'leetcode' || stat.platformName === 'codeforces') {
          platformSet.add(stat.platformName);
        }
      }
      if (platformSet.size === 0 && summary.totals.solved > 0) {
        platformSet.add('manual');
      }

      return {
        totalSolved: summary.totals.solved,
        easySolved: summary.solvedByDifficulty.easy,
        mediumSolved: summary.solvedByDifficulty.medium,
        hardSolved: summary.solvedByDifficulty.hard,
        currentStreak: streakInfo.currentStreak,
        longestStreak: streakInfo.longestStreak,
        lastSolvedDate,
        topicBreakdown,
        isVerified: connectedPlatforms.length > 0 || platformStats.length > 0 || acceptedSubmissions.length > 0,
        lastSyncedAt,
        platforms: Array.from(platformSet),
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
