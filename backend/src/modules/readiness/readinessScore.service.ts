import { Types } from 'mongoose';
import { ReadinessDsa } from '../../db/models/readinessDsa.model.js';
import { ReadinessProjects } from '../../db/models/readinessProjects.model.js';
import { ReadinessInput } from '../../db/models/readinessInput.model.js';
import { DsaContest } from '../../db/models/dsaContest.model.js';
import { ReadinessSnapshot, readinessSnapshotId } from '../../db/models/readinessSnapshot.model.js';
import { cacheManager } from '../../shared/cache/cacheManager.js';
import { logger } from '../../shared/logger.js';
import { summarizeInputs } from './consumers/readinessInputs.js';
import {
  calculateCompositeReadiness, CONTEST_LOOKBACK_MS, INTERVIEW_LOOKBACK_MS, MAX_INTERVIEW_SAMPLES,
  READINESS_SCORING_VERSION, readinessScoreSchema, readinessWeekStart,
  type CompositeReadinessScore, type InterviewScoreInput, type ReadinessScoreInputs,
} from './readinessScore.calculation.js';

export const READINESS_SCORE_CACHE_TTL_SECONDS = 3600;
export const readinessScoreCacheKey = (userId: string, week: string) => `cache:readiness-score:${READINESS_SCORING_VERSION}:${userId}:${week}`;

/** Wire this seam to completed, owned AI reports when interview storage exists (#347/#443). */
export const readinessScoreSources = {
  async loadInterviewScores(_userId: string, _since: Date, _limit: number): Promise<InterviewScoreInput[] | null> { return null; },
};

export async function loadReadinessScoreInputs(userId: string, at: Date): Promise<ReadinessScoreInputs> {
  const owner = new Types.ObjectId(userId);
  const [dsa, projects, contests, revision, interviews] = await Promise.all([
    ReadinessDsa.findOne({ userId }).select('computedAt difficultyDistribution').lean(),
    ReadinessProjects.findOne({ userId }).select('computedAt evidenceCoverage projectCredibilityScore infrastructureSophistication deploymentEvidence complexityMetrics communicationSignals.documentationQuality').lean(),
    DsaContest.aggregate<{ platform?: string; rating: number; observedAt: Date }>([
      { $match: { userId: owner, kind: 'participated', platform: { $in: ['leetcode', 'codeforces', 'codechef', 'atcoder'] },
        participatedAt: { $gte: new Date(at.getTime() - CONTEST_LOOKBACK_MS), $lte: at }, ratingAfter: { $type: 'number', $gte: 0, $lte: 10_000 } } },
      { $sort: { participatedAt: -1, _id: -1 } },
      { $group: { _id: '$platform', rating: { $first: '$ratingAfter' }, observedAt: { $first: '$participatedAt' } } },
      { $project: { _id: 0, platform: '$_id', rating: 1, observedAt: 1 } },
    ]),
    ReadinessInput.findOne({ userId: owner }).select('revisionDays'),
    readinessScoreSources.loadInterviewScores(userId, new Date(at.getTime() - INTERVIEW_LOOKBACK_MS), MAX_INTERVIEW_SAMPLES),
  ]);
  const reviews = summarizeInputs(revision, at).revision;
  return {
    dsa: dsa ? { computedAt: dsa.computedAt, difficultyDistribution: dsa.difficultyDistribution } : null,
    projects: projects ? {
      computedAt: projects.computedAt, evidenceCoverage: projects.evidenceCoverage,
      projectCredibilityScore: projects.projectCredibilityScore, infrastructureSophistication: projects.infrastructureSophistication,
      deploymentEvidence: projects.deploymentEvidence, complexityMetrics: projects.complexityMetrics,
      communicationSignals: projects.communicationSignals,
    } : null,
    contests, revision: { reviews: reviews.cardsReviewed7d, lapses: reviews.lapses7d }, interviews,
  };
}

/** One latest observation per UTC week/version. The deterministic _id also fences first-write races. */
export async function persistWeeklyReadiness(result: CompositeReadinessScore): Promise<void> {
  result = readinessScoreSchema.parse(result);
  const _id = readinessSnapshotId(result.userId, result.weekStart, result.scoringVersion);
  const at = new Date(result.computedAt);
  try {
    await ReadinessSnapshot.updateOne({
      _id, $or: [{ computedAt: { $lte: at } }, { computedAt: { $exists: false } }],
    }, { $set: {
      userId: new Types.ObjectId(result.userId), weekStart: new Date(result.weekStart), scoringVersion: result.scoringVersion,
      computedAt: at, overallScore: result.overallScore, dsaScore: result.dsaScore,
      systemDesignScore: result.systemDesignScore, projectScore: result.projectScore, interviewScore: result.interviewScore, result,
    } }, { upsert: true, runValidators: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    // The guarded upsert can collide with a newer observation; never roll that observation back.
    const newer = await ReadinessSnapshot.findById(_id).select('computedAt').lean();
    if (!newer || newer.computedAt < at) throw error;
  }
}

function validCachedScore(value: unknown, userId: string, now: Date): CompositeReadinessScore | null {
  const parsed = readinessScoreSchema.safeParse(value);
  if (!parsed.success) return null;
  const score = parsed.data;
  const age = now.getTime() - new Date(score.computedAt).getTime();
  return score.userId === userId && age >= 0 && age < READINESS_SCORE_CACHE_TTL_SECONDS * 1000
    && score.weekStart === readinessWeekStart(now).toISOString()
    ? score : null;
}

export async function getReadinessScore(userId: string, clock: () => Date = () => new Date()): Promise<CompositeReadinessScore> {
  if (!/^[a-fA-F0-9]{24}$/.test(userId)) throw new Error('Invalid readiness user ID');
  const owner = new Types.ObjectId(userId).toHexString();
  const requestedAt = clock();
  const key = readinessScoreCacheKey(owner, readinessWeekStart(requestedAt).toISOString());
  const build = async () => {
    const input = await loadReadinessScoreInputs(owner, clock());
    const result = calculateCompositeReadiness(owner, input, clock());
    // A failed history write must not leave a cached result with no corresponding weekly record.
    await persistWeeklyReadiness(result);
    return result;
  };
  const cached = await cacheManager.getOrSet<unknown>(key, build, READINESS_SCORE_CACHE_TTL_SECONDS);
  const result = validCachedScore(cached, owner, clock());
  if (result) return result;
  // Covers corrupt/foreign/expired cached values, and a request spanning the UTC week boundary.
  logger.warn('[readiness-score] Ignoring incompatible cached result', { userId: owner });
  await cacheManager.invalidateKey(key);
  return build();
}
