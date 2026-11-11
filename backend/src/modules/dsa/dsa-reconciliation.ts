import { Types } from 'mongoose';
import { DsaProblem, DsaSubmission, PlatformStats } from '../../db/models/index.js';
import { DSAProfile } from '../../db/models/dsaProfile.model.js';
import type { DsaProblemPlatform } from '../../shared/dsa-platforms.js';
import type { ApiDsaTopicAnalytics } from '../../types/api.types.js';
import { dsaProblemIdentity, isManualProblem } from './dsa-problem-identity.js';

const platforms = ['leetcode', 'codeforces', 'codechef'] as const;
const knownDifficulties = ['easy', 'medium', 'hard'] as const;
const difficulties = [...knownDifficulties, 'unknown'] as const;
const statusRank = { unsolved: 0, attempted: 1, revisit: 2, solved: 3 };
const aggregateTopics = {
  leetcode: 'LeetCode (topic unavailable)',
  codeforces: 'Codeforces (topic unavailable)',
  codechef: 'CodeChef (topic unavailable)',
};
type Difficulty = typeof difficulties[number];
type Status = keyof typeof statusRank;

interface ProblemEvidence {
  _id: { toString(): string };
  platform: DsaProblemPlatform;
  externalId?: string;
  url?: string;
  problemKey?: string;
  difficulty: Difficulty;
  difficultyKnown?: boolean;
  category: string;
  status: Status;
  timeTaken?: number | null;
}

interface PlatformReport {
  platformName: string;
  totalSolved: number;
  easySolved: number;
  mediumSolved: number;
  hardSolved: number;
  rating?: number | null;
  rank?: string | null;
}

interface ProblemGroup {
  platform: DsaProblemPlatform;
  status: Status;
  manualSolved: boolean;
  syncedSolved: boolean;
  metadata: { category: string; difficulty: Difficulty; priority: number };
  timeTaken: number | null;
}

type Counts = Record<Difficulty, number>;
const emptyCounts = (): Counts => ({ easy: 0, medium: 0, hard: 0, unknown: 0 });
const nonnegativeCount = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export function reconcileDsaEvidence(
  problems: readonly ProblemEvidence[],
  acceptedProblemIds: ReadonlySet<string>,
  reports: readonly PlatformReport[]
) {
  const groups = new Map<string, ProblemGroup>();
  for (const problem of problems) {
    const id = problem._id.toString();
    const identity = problem.problemKey
      ? { platform: problem.problemKey.split(':', 1)[0] as DsaProblemPlatform, key: problem.problemKey }
      : dsaProblemIdentity(problem);
    const key = identity.key ?? `row:${id}`;
    const accepted = acceptedProblemIds.has(id);
    const status = accepted ? 'solved' : problem.status;
    const manual = isManualProblem(problem.externalId);
    const difficulty = problem.difficultyKnown === false ? 'unknown' : problem.difficulty;
    const category = problem.category || 'Uncategorized';
    const priority = (difficulty !== 'unknown' ? 4 : 0) + (manual ? 2 : 0) + (status === 'solved' ? 1 : 0);
    const metadata = { category, difficulty, priority };
    const timeTaken = problem.timeTaken ?? null;
    const group = groups.get(key);
    const manualSolved = manual && problem.status === 'solved';
    const syncedSolved = accepted || (!manual && status === 'solved');
    if (!group) {
      groups.set(key, { platform: identity.platform, status, metadata, manualSolved, syncedSolved, timeTaken });
      continue;
    }
    if (statusRank[status] > statusRank[group.status]) group.status = status;
    if (priority > group.metadata.priority) group.metadata = metadata;
    group.manualSolved ||= manualSolved;
    group.syncedSolved ||= syncedSolved;
    if (timeTaken !== null && (group.timeTaken === null || timeTaken < group.timeTaken)) group.timeTaken = timeTaken;
  }

  const totals = { solved: 0, attempted: 0, unsolved: 0, revisit: 0 };
  const solvedByDifficulty = emptyCounts();
  const totalByDifficulty = emptyCounts();
  const topics = new Map<string, { solved: Counts; total: Counts }>();
  const solvedByPlatform = new Map<DsaProblemPlatform, { observed: number; synced: number; difficulty: Counts }>();
  let manualSolved = 0;
  let timeSum = 0;
  let timeCount = 0;
  let fastestSolve = Infinity;

  function count(category: string, difficulty: Difficulty, status: Status, amount: number): void {
    if (!amount) return;
    const topic = topics.get(category) ?? { solved: emptyCounts(), total: emptyCounts() };
    topics.set(category, topic);
    totals[status] += amount;
    totalByDifficulty[difficulty] += amount;
    topic.total[difficulty] += amount;
    if (status === 'solved') {
      solvedByDifficulty[difficulty] += amount;
      topic.solved[difficulty] += amount;
    }
  }

  for (const group of groups.values()) {
    const { category, difficulty } = group.metadata;
    count(category, difficulty, group.status, 1);
    if (group.timeTaken !== null) {
      timeSum += group.timeTaken;
      timeCount++;
      fastestSolve = Math.min(fastestSolve, group.timeTaken);
    }
    const platform = solvedByPlatform.get(group.platform) ?? { observed: 0, synced: 0, difficulty: emptyCounts() };
    solvedByPlatform.set(group.platform, platform);
    if (group.status === 'solved') {
      manualSolved += Number(group.manualSolved);
      platform.observed++;
      platform.synced += Number(group.syncedSolved);
      platform.difficulty[difficulty]++;
    }
  }

  let syncedSolved = 0;
  const platformOverview = platforms.flatMap(platform => {
    const report = reports.find(row => row.platformName === platform);
    const identified = solvedByPlatform.get(platform);
    if (!report && !identified) return [];
    const observed = identified?.observed ?? 0;
    const reported = nonnegativeCount(report?.totalSolved);
    const totalSolved = Math.max(observed, reported);
    syncedSolved += Math.max(identified?.synced ?? 0, reported);

    // Aggregate reports lack identities. Add only coverage beyond observed solves.
    let remaining = totalSolved - observed;
    for (const difficulty of knownDifficulties) {
      const reportedAtDifficulty = nonnegativeCount(report?.[`${difficulty}Solved`]);
      const additional = Math.min(remaining, Math.max(0, reportedAtDifficulty - (identified?.difficulty[difficulty] ?? 0)));
      count(aggregateTopics[platform], difficulty, 'solved', additional);
      remaining -= additional;
    }
    count(aggregateTopics[platform], 'unknown', 'solved', remaining);
    return [{
      platform, totalSolved, rating: report?.rating ?? null, rank: report?.rank ?? null,
      stat: report?.rating ? `Rating ${report.rating}` : `Solved ${totalSolved}`,
    }];
  });

  const analytics: ApiDsaTopicAnalytics[] = [...topics].map(([topicName, { solved, total }]) => {
    const solvedCount = difficulties.reduce((sum, difficulty) => sum + solved[difficulty], 0);
    const totalProblems = difficulties.reduce((sum, difficulty) => sum + total[difficulty], 0);
    return {
      topicName, totalProblems, solvedCount, solveRate: Math.round(solvedCount / totalProblems * 100),
      easyCount: total.easy, easySolved: solved.easy, mediumCount: total.medium, mediumSolved: solved.medium,
      hardCount: total.hard, hardSolved: solved.hard, unknownCount: total.unknown, unknownSolved: solved.unknown,
    };
  }).sort((a, b) => b.solvedCount - a.solvedCount || a.topicName.localeCompare(b.topicName));

  return {
    totals,
    totalProblems: Object.values(totals).reduce((sum, count) => sum + count, 0),
    solvedByDifficulty,
    totalByDifficulty,
    averageTime: timeCount ? Math.round(timeSum / timeCount) : 0,
    fastestSolve: timeCount ? fastestSolve : 0,
    topics: analytics,
    platformOverview,
    provenance: { manualSolved, syncedSolved, dedupedTotalSolved: totals.solved },
  };
}

export async function reconcileUserDsaSummary(userId: string) {
  const owner = new Types.ObjectId(userId);
  const [problems, accepted, stats, profiles] = await Promise.all([
    DsaProblem.find({ userId: owner })
      .select('platform externalId url problemKey difficulty difficultyKnown category status timeTaken')
      .sort({ _id: 1 }).lean(),
    DsaSubmission.distinct('problemId', { userId: owner, status: 'accepted' }),
    PlatformStats.find({ userId: owner, platformName: { $in: platforms } })
      .select('platformName totalSolved easySolved mediumSolved hardSolved rating rank').lean(),
    DSAProfile.find({ userId, platform: { $in: platforms }, isVerified: true })
      .select('platform totalSolved easySolved mediumSolved hardSolved').lean(),
  ]);
  const reports: PlatformReport[] = [...stats];
  for (const profile of profiles) {
    if (!reports.some(report => report.platformName === profile.platform)) {
      reports.push({ ...profile, platformName: profile.platform });
    }
  }
  return reconcileDsaEvidence(problems, new Set(accepted.map(id => id.toString())), reports);
}
