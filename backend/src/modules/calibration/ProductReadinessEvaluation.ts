import { ResumeCredibility } from '../../db/models/resumeCredibility.model.js';
import { ResumeSession } from '../../db/models/resumeSession.model.js';
import { User } from '../../db/models/user.model.js';
import { logger } from '../../shared/logger.js';
import { getRedisClient, isRedisConfigured } from '../../shared/redis/client.js';
import { FeedbackIntelligenceLoop } from './FeedbackIntelligenceLoop.js';

export interface ReadinessScorecard {
  onboardingMaturity: number;
  operationalMaturity: number;
  semanticMaturity: number;
  recommendationMaturity: number;
  atsMaturity: number;
  replayMaturity: number;
  recruiterMaturity: number;
}

const awaitingData = 'Telemetry Awaiting Data';

function readNonnegativeNumber(value: string | null): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function clampScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator > 0 ? clampScore((numerator / denominator) * 100) : null;
}

function feedbackScore(total: number, reports: number): number | null {
  return Number.isFinite(reports) && reports >= 0 ? percentage(total - reports, total) : null;
}

export class ProductReadinessEvaluation {
  static async executeDiagnosticSuite(): Promise<{ scorecard: ReadinessScorecard; overallScore: number; report: string }> {
    logger.info('[ProductReadiness] Initiating active diagnostic suite...');

    const redis = isRedisConfigured() ? getRedisClient() : null;
    const [redisStarts, redisCompletions, p95Latency, feedbackStats] = redis
      ? await Promise.all([
          redis.get('beta:telemetry:onboard_starts').then(readNonnegativeNumber),
          redis.get('beta:telemetry:onboard_completes').then(readNonnegativeNumber),
          redis.get('observability:latency:p95').then(readNonnegativeNumber),
          FeedbackIntelligenceLoop.getFeedbackStats(),
        ] as const)
      : [null, null, null, null] as const;

    // Keep both sides of the conversion ratio on the same source.
    const useOnboardingCounters = redisStarts !== null && redisStarts > 0 && redisCompletions !== null;
    const [onboarding, searches, recommendations, atsAnalyses, completedSessions, replaySessions, credibility] =
      await Promise.all([
        useOnboardingCounters
          ? { starts: redisStarts, completions: redisCompletions, source: 'Redis onboarding counters' }
          : Promise.all([
              User.countDocuments(),
              ResumeSession.aggregate<{ count: number }>([
                { $match: { currentStage: 'COMPLETED', userId: { $type: 'objectId' } } },
                { $group: { _id: '$userId' } },
                { $count: 'count' },
              ]),
            ]).then(([starts, completed]) => ({
              starts,
              completions: completed[0]?.count ?? 0,
              source: 'MongoDB registered users and distinct users with a completed resume session',
            })),
        ResumeSession.countDocuments({ 'semanticState.retrievalResults.0': { $exists: true } }),
        ResumeSession.countDocuments({ 'recommendationState.generated': true }),
        ResumeSession.countDocuments({ 'atsState.analyzed': true }),
        ResumeSession.countDocuments({ currentStage: 'COMPLETED' }),
        ResumeSession.countDocuments({
          currentStage: 'COMPLETED',
          'replayState.generated': true,
          'replayState.timeline.0': { $exists: true },
        }),
        ResumeCredibility.aggregate<{ count: number; average: number }>([
          { $match: { overallCredibility: { $type: 'number', $gte: 0, $lte: 100 } } },
          { $group: { _id: null, count: { $sum: 1 }, average: { $avg: '$overallCredibility' } } },
        ]),
      ]);

    const semanticReports = feedbackStats?.semantic_mismatch ?? 0;
    const recommendationReports = feedbackStats?.recommendation ?? 0;
    const atsReports = feedbackStats?.ats ?? 0;
    const diagnostics = {
      onboardingMaturity: {
        label: 'Onboarding',
        score: percentage(onboarding.completions, onboarding.starts),
        source: `${onboarding.source} (${onboarding.completions} completions / ${onboarding.starts} starts or registrations)`,
      },
      operationalMaturity: {
        label: 'Operational latency',
        score: p95Latency === null ? null : p95Latency < 200 ? 95 : p95Latency < 500 ? 80 : 60,
        source: p95Latency === null ? 'Redis P95 latency' : `Redis P95 latency (${p95Latency}ms)`,
      },
      semanticMaturity: {
        label: 'Semantic retrieval',
        score: feedbackStats === null ? null : feedbackScore(searches, semanticReports),
        source: `MongoDB resume sessions with saved retrieval results (${searches}) and Redis mismatch reports (${feedbackStats === null ? 'unavailable' : semanticReports})`,
      },
      recommendationMaturity: {
        label: 'Recommendations',
        score: feedbackStats === null ? null : feedbackScore(recommendations, recommendationReports),
        source: `MongoDB resume sessions with generated recommendations (${recommendations}) and Redis mismatch reports (${feedbackStats === null ? 'unavailable' : recommendationReports})`,
      },
      atsMaturity: {
        label: 'ATS analysis',
        score: feedbackStats === null ? null : feedbackScore(atsAnalyses, atsReports),
        source: `MongoDB resume sessions with ATS analysis (${atsAnalyses}) and Redis mismatch reports (${feedbackStats === null ? 'unavailable' : atsReports})`,
      },
      replayMaturity: {
        label: 'Timeline replay',
        score: percentage(replaySessions, completedSessions),
        source: `MongoDB completed resume sessions with a stored replay timeline (${replaySessions} / ${completedSessions})`,
      },
      recruiterMaturity: {
        label: 'Recruiter realism',
        score: credibility[0] ? clampScore(credibility[0].average) : null,
        source: `Mean stored resume credibility score from MongoDB (${credibility[0]?.count ?? 0} records)`,
      },
    } satisfies Record<keyof ReadinessScorecard, { label: string; score: number | null; source: string }>;

    const entries = Object.values(diagnostics);
    const measuredScores = entries.flatMap(({ score }) => score === null ? [] : [score]);
    const overallScore = measuredScores.length
      ? Math.round(measuredScores.reduce((sum, score) => sum + score, 0) / measuredScores.length)
      : 0;
    const scorecard = Object.fromEntries(
      Object.entries(diagnostics).map(([key, { score }]) => [key, score ?? 0]),
    ) as unknown as ReadinessScorecard;

    const report = [
      '# Product Maturity & Readiness Report',
      '',
      `**Overall Product Maturity Score:** ${measuredScores.length ? `${overallScore} / 100 (${measuredScores.length} of ${entries.length} domains measured)` : awaitingData}`,
      '',
      ...entries.map(({ label, score, source }) =>
        `- **${label}:** ${score === null ? awaitingData : `${score}%`} — ${source}`),
    ].join('\n');

    logger.info('[ProductReadiness] Diagnostic suite completed successfully', { overallScore });
    return { scorecard, overallScore, report };
  }
}
