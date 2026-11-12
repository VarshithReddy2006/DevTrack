import { CareerIntent } from '../../../db/models/careerIntent.model.js';
import { ReadinessBenchmarks } from '../../../db/models/readinessBenchmarks.model.js';
import { ReadinessCore } from '../../../db/models/readinessCore.model.js';
import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { ReadinessSkills } from '../../../db/models/readinessSkills.model.js';
import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { cohortCriteria, getCohortDistribution, minCohortSize } from './cohortDistribution.js';

const metrics = {
  totalSolves: 'Total DSA Solves',
  hardProblemProgression: 'Hard Problem Progression',
  solveConsistency: 'Solve Consistency',
  overallEngineeringDepth: 'Overall Engineering Depth',
  projectCredibilityScore: 'Project Credibility',
  infrastructureSophistication: 'Infrastructure Sophistication',
  engineeringMaturity: 'Engineering Maturity',
} as const;

function percentileRank(value: number, sorted: number[]): number {
  // Upper bound gives all tied observations the same percentile.
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return sorted.length ? Math.round(100 * low / sorted.length) : 0;
}

function summarize(metric: string, value: number, sorted: number[]) {
  const quantile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
  const middle = Math.floor(sorted.length / 2);
  return {
    metric,
    value,
    percentile: percentileRank(value, sorted),
    cohortAverage: Math.round(sorted.reduce((sum, observation) => sum + observation, 0) / sorted.length),
    cohortMedian: sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2),
    cohortP90: quantile(0.90),
    cohortP75: quantile(0.75),
    cohortP25: quantile(0.25),
    cohortP10: quantile(0.10),
  };
}

export const BenchmarkEngine = {
  async generateBenchmarks({ userId }: { userId: string }): Promise<void> {
    const [intent, core, dsa, skills, projects] = await Promise.all([
      CareerIntent.findOne({ userId }).select('dreamRole targetCompanyTier experienceLevel').lean(),
      ReadinessCore.findOne({ userId }).select('overallScore').lean(),
      ReadinessDsa.findOne({ userId }).select('totalSolves hardProblemProgression solveConsistency').lean(),
      ReadinessSkills.findOne({ userId }).select('overallEngineeringDepth').lean(),
      ReadinessProjects.findOne({ userId }).select('projectCredibilityScore infrastructureSophistication engineeringMaturity').lean(),
    ]);
    if (!core) return;

    const criteria = intent?.dreamRole ? cohortCriteria(intent) : undefined;
    const segment = criteria ? await getCohortDistribution(criteria) : undefined;
    const useSegment = segment !== undefined && segment.data.sampleSize >= minCohortSize;
    // A sparse career segment uses the shared global distribution and is labeled as such.
    const { cohortId, data } = useSegment ? segment : await getCohortDistribution();
    const cohortName = useSegment && criteria
      ? [criteria.dreamRole, criteria.targetCompanyTier, criteria.experienceLevel].filter(Boolean).join(' · ')
      : 'All readiness users';

    const userValues = {
      totalSolves: dsa?.totalSolves,
      hardProblemProgression: dsa?.hardProblemProgression,
      solveConsistency: dsa?.solveConsistency,
      overallEngineeringDepth: skills?.overallEngineeringDepth,
      projectCredibilityScore: projects?.projectCredibilityScore,
      infrastructureSophistication: projects?.infrastructureSophistication,
      engineeringMaturity: projects?.engineeringMaturity,
    };
    const percentileRankings = (Object.keys(metrics) as Array<keyof typeof metrics>).flatMap(key => {
      const value = userValues[key];
      return typeof value === 'number' && Number.isFinite(value) && data[key].length
        ? [summarize(metrics[key], value, data[key])]
        : [];
    });
    const relativeComparisons = percentileRankings.map(ranking => {
      const { metric, value, percentile, cohortAverage, cohortP90 } = ranking;
      const interpretation = percentile >= 70 ? 'above_average' : percentile >= 30 ? 'average' : 'below_average';
      return {
        metric, userValue: value, cohortPercentile: percentile, interpretation,
        gapToAverage: value - cohortAverage,
        gapToP90: value - cohortP90,
      };
    });
    const confidenceLevel = data.sampleSize >= 300 ? 'high' : data.sampleSize >= minCohortSize ? 'medium' : 'low';
    const confidenceScore = data.sampleSize < minCohortSize ? 50 : data.sampleSize < 100 ? 70 : data.sampleSize < 300 ? 85 : 95;
    const hasOverall = Number.isFinite(core.overallScore) && data.overallScore.length > 0;
    const cohortSegments = hasOverall ? [{
      cohortId,
      cohortName,
      percentileRanking: percentileRank(core.overallScore, data.overallScore),
      sampleSize: data.sampleSize,
      confidenceLevel,
      freshnessTimestamp: new Date(data.sampledAt),
      relativeComparisons: percentileRankings.map(({ metric, value, cohortAverage, percentile }) => ({
        metricName: metric,
        userValue: value,
        cohortAverage,
        status: percentile >= 70 ? 'above' : percentile >= 30 ? 'average' : 'below',
      })),
    }] : [];

    await ReadinessBenchmarks.findOneAndUpdate(
      { userId },
      { cohortSegments, percentileRankings, relativeComparisons, confidenceScore: hasOverall ? confidenceScore : 0, computedAt: new Date() },
      { upsert: true },
    );
  },
};
