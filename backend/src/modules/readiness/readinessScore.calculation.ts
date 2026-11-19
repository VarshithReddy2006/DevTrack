import { z } from 'zod';

export const READINESS_SCORING_VERSION = 'composite-v1';
export const READINESS_WEIGHTS = { dsa: 0.30, systemDesign: 0.25, projects: 0.25, interview: 0.20 } as const;
export const READINESS_EVIDENCE_MAX_AGE_MS = 7 * 86_400_000;
export const INTERVIEW_LOOKBACK_MS = 30 * 86_400_000;
export const CONTEST_LOOKBACK_MS = 180 * 86_400_000;
export const MAX_INTERVIEW_SAMPLES = 10;
const percent = z.number().finite().min(0).max(100);
const count = z.number().int().min(0).max(1_000_000_000);
const dimensionNames = ['dsa', 'systemDesign', 'projects', 'interview'] as const;
export type ReadinessDimension = typeof dimensionNames[number];
const status = z.enum(['available', 'missing', 'stale', 'unavailable', 'invalid']);
const evidenceSchema = z.object({
  status, coveragePercent: percent, observedAt: z.string().datetime().nullable(), notes: z.array(z.string().max(160)).max(10),
});
export type ScoreEvidence = z.infer<typeof evidenceSchema>;
const points = z.number().int().min(0).max(1000);
export const readinessScoreSchema = z.object({
  userId: z.string().regex(/^[a-f0-9]{24}$/), scoringVersion: z.literal(READINESS_SCORING_VERSION), scale: z.literal(1000),
  weekStart: z.string().datetime(), computedAt: z.string().datetime(),
  overallScore: points, dsaScore: points, systemDesignScore: points, projectScore: points, interviewScore: points,
  weights: z.object({ dsa: z.literal(0.30), systemDesign: z.literal(0.25), projects: z.literal(0.25), interview: z.literal(0.20) }),
  completeness: percent, isDegraded: z.boolean(), missingDimensions: z.array(z.enum(dimensionNames)),
  evidence: z.object({ dsa: evidenceSchema, systemDesign: evidenceSchema, projects: evidenceSchema, interview: evidenceSchema }),
}).superRefine((score, ctx) => {
  const add = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (score.overallScore !== Math.round(0.30 * score.dsaScore + 0.25 * score.systemDesignScore + 0.25 * score.projectScore + 0.20 * score.interviewScore)) add('Composite weights do not match');
  const coverage = Math.round(dimensionNames.reduce((sum, name) => sum + READINESS_WEIGHTS[name] * score.evidence[name].coveragePercent, 0));
  if (score.completeness !== coverage || score.isDegraded !== (coverage < 100)) add('Inconsistent evidence coverage');
  if (JSON.stringify(score.missingDimensions) !== JSON.stringify(dimensionNames.filter(name => score.evidence[name].status !== 'available'))) add('Inconsistent missing dimensions');
  const scores = { dsa: score.dsaScore, systemDesign: score.systemDesignScore, projects: score.projectScore, interview: score.interviewScore };
  for (const name of dimensionNames) {
    const source = score.evidence[name];
    if (source.status !== 'available' && (source.coveragePercent !== 0 || scores[name] !== 0)) add('Unavailable evidence must not award points');
    if (source.status === 'available' && (source.coveragePercent === 0 || !source.observedAt || new Date(source.observedAt) > new Date(score.computedAt))) add('Invalid available evidence');
  }
  const computed = new Date(score.computedAt);
  if (Number.isFinite(computed.getTime()) && score.weekStart !== readinessWeekStart(computed).toISOString()) add('Incorrect UTC week');
});
export type CompositeReadinessScore = z.infer<typeof readinessScoreSchema>;

const dsaSchema = z.object({ computedAt: z.date(), difficultyDistribution: z.object({ easy: count, medium: count, hard: count }) });
const projectSchema = z.object({
  computedAt: z.date(), evidenceCoverage: percent, projectCredibilityScore: percent,
  infrastructureSophistication: percent, deploymentEvidence: percent,
  complexityMetrics: z.object({ architectureSophistication: percent, repositoryQuality: percent, contributionConsistency: percent }),
  communicationSignals: z.object({ documentationQuality: percent }),
});
const interviewSchema = z.object({
  userId: z.string(), sessionId: z.string().min(1).max(128), completedAt: z.date(),
  mode: z.enum(['ai', 'basic_mode']), rubricScores: z.tuple([percent, percent, percent, percent]),
});
export type DsaScoreInput = z.infer<typeof dsaSchema>;
export type ProjectScoreInput = z.infer<typeof projectSchema>;
export type InterviewScoreInput = z.infer<typeof interviewSchema>;
export interface ReadinessScoreInputs {
  dsa: DsaScoreInput | null;
  projects: ProjectScoreInput | null;
  contests: Array<{ rating: number; observedAt: Date }>;
  revision: { reviews: number; lapses: number };
  /** null means the interview storage adapter is not available; [] means no recent evidence. */
  interviews: InterviewScoreInput[] | null;
}

/** UTC Monday 00:00, independent of the API process's local timezone. */
export function readinessWeekStart(now: Date): Date {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day;
}

function freshness(at: Date, now: Date): ScoreEvidence['status'] {
  if (!Number.isFinite(at.getTime()) || at > now) return 'invalid';
  return now.getTime() - at.getTime() > READINESS_EVIDENCE_MAX_AGE_MS ? 'stale' : 'available';
}
const evidence = (state: ScoreEvidence['status'], coveragePercent = 0, observedAt: string | null = null, notes: string[] = []): ScoreEvidence =>
  ({ status: state, coveragePercent, observedAt, notes });

function dsaScore(input: ReadinessScoreInputs, now: Date) {
  let difficulty = 0, rating = 0, revision = 0, coverage = 0;
  const notes: string[] = [];
  const observed: number[] = [];
  let difficultyStatus: ScoreEvidence['status'] = 'missing';
  const dsa = dsaSchema.safeParse(input.dsa);
  if (dsa.success) {
    difficultyStatus = freshness(dsa.data.computedAt, now);
    if (difficultyStatus === 'available') {
      const { easy, medium, hard } = dsa.data.difficultyDistribution;
      difficulty = Math.min(1000, (easy + 2 * medium + 3 * hard) * 2);
      coverage += 60; observed.push(dsa.data.computedAt.getTime());
    }
  } else if (input.dsa !== null) difficultyStatus = 'invalid';
  if (difficultyStatus !== 'available') notes.push(`difficulty:${difficultyStatus}`);
  const ratings = input.contests.filter(item => Number.isFinite(item.rating) && item.rating >= 0 && item.rating <= 10_000
    && item.observedAt instanceof Date && Number.isFinite(item.observedAt.getTime())
    && item.observedAt <= now && now.getTime() - item.observedAt.getTime() <= CONTEST_LOOKBACK_MS);
  if (ratings.length) {
    rating = Math.min(1000, Math.max(...ratings.map(item => item.rating)) / 3000 * 1000);
    coverage += 25; observed.push(...ratings.map(item => item.observedAt.getTime()));
  } else notes.push('contest:missing_recent_rating');
  const reviews = z.object({ reviews: count, lapses: count }).safeParse(input.revision);
  if (reviews.success && reviews.data.reviews > 0 && reviews.data.lapses <= reviews.data.reviews) {
    revision = 1000 * Math.min(1, reviews.data.reviews / 20) * (1 - reviews.data.lapses / reviews.data.reviews);
    coverage += 15; observed.push(now.getTime());
  } else notes.push('revision:no_valid_reviews_in_7_days');
  return {
    score: Math.round(0.60 * difficulty + 0.25 * rating + 0.15 * revision),
    evidence: evidence(coverage ? 'available' : difficultyStatus, coverage, observed.length ? new Date(Math.max(...observed)).toISOString() : null, notes),
  };
}

function projectScores(input: ProjectScoreInput | null, now: Date) {
  const parsed = projectSchema.safeParse(input);
  if (!parsed.success) return { design: 0, project: 0, evidence: evidence(input === null ? 'missing' : 'invalid') };
  const data = parsed.data;
  const state = freshness(data.computedAt, now);
  if (state !== 'available' || data.evidenceCoverage === 0) return {
    design: 0, project: 0, evidence: evidence(data.evidenceCoverage === 0 ? 'missing' : state, 0, data.computedAt.toISOString()),
  };
  return {
    design: Math.round(10 * (0.40 * data.complexityMetrics.architectureSophistication + 0.35 * data.infrastructureSophistication + 0.25 * data.deploymentEvidence)),
    project: Math.round(10 * (0.40 * data.projectCredibilityScore + 0.30 * data.complexityMetrics.repositoryQuality + 0.20 * data.complexityMetrics.contributionConsistency + 0.10 * data.communicationSignals.documentationQuality)),
    evidence: evidence('available', 100, data.computedAt.toISOString(), ['stored_verified_project_intelligence', 'test_presence_quality_proxy_not_measured_coverage']),
  };
}

function interviewScore(userId: string, input: InterviewScoreInput[] | null, now: Date) {
  if (input === null) return { score: 0, evidence: evidence('unavailable', 0, null, ['interview_storage_adapter_not_registered']) };
  if (!Array.isArray(input) || input.length > 100) return { score: 0, evidence: evidence('invalid') };
  const sessions = new Map<string, InterviewScoreInput>();
  for (const row of input) {
    const parsed = interviewSchema.safeParse(row);
    if (!parsed.success || parsed.data.userId.toLowerCase() !== userId || parsed.data.mode !== 'ai') continue;
    const item = parsed.data;
    if (item.completedAt > now || now.getTime() - item.completedAt.getTime() > INTERVIEW_LOOKBACK_MS) continue;
    const old = sessions.get(item.sessionId);
    if (!old || old.completedAt < item.completedAt) sessions.set(item.sessionId, item);
  }
  const recent = [...sessions.values()].sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime() || a.sessionId.localeCompare(b.sessionId)).slice(0, MAX_INTERVIEW_SAMPLES);
  if (!recent.length) return { score: 0, evidence: evidence(input.length ? 'invalid' : 'missing', 0, null, ['no_valid_recent_completed_ai_interviews']) };
  const average = recent.reduce((sum, item) => sum + item.rubricScores.reduce((s, value) => s + value, 0) / 4, 0) / recent.length;
  return { score: Math.round(average * 10), evidence: evidence('available', 100, recent[0].completedAt.toISOString(), [`recent_unique_sessions:${recent.length}`]) };
}

/** Fixed outer weights: missing evidence contributes zero; its weight is never redistributed. */
export function calculateCompositeReadiness(userId: string, input: ReadinessScoreInputs, now: Date): CompositeReadinessScore {
  const dsa = dsaScore(input, now);
  const projects = projectScores(input.projects, now);
  const interview = interviewScore(userId, input.interviews, now);
  const sources = { dsa: dsa.evidence, systemDesign: projects.evidence, projects: projects.evidence, interview: interview.evidence };
  const completeness = Math.round(dimensionNames.reduce((sum, name) => sum + READINESS_WEIGHTS[name] * sources[name].coveragePercent, 0));
  return readinessScoreSchema.parse({
    userId, scoringVersion: READINESS_SCORING_VERSION, scale: 1000, weekStart: readinessWeekStart(now).toISOString(), computedAt: now.toISOString(),
    dsaScore: dsa.score, systemDesignScore: projects.design, projectScore: projects.project, interviewScore: interview.score,
    overallScore: Math.round(0.30 * dsa.score + 0.25 * projects.design + 0.25 * projects.project + 0.20 * interview.score),
    weights: READINESS_WEIGHTS, completeness, isDegraded: completeness < 100,
    missingDimensions: dimensionNames.filter(name => sources[name].status !== 'available'), evidence: sources,
  });
}
