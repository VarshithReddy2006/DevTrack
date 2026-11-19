// jd-score: scores a parsed job target against the candidate and asks the model for STAR rewrites.
// The score is always the deterministic taxonomy score. The model only adds rewrites and an
// advisory fit estimate, and only when its reply passes the schema and the evidence checks.
// Runs under WORKER_TYPE=ai.

import type { Job, Worker } from 'bullmq';
import { NonRetryableError, RetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';
import { WorkerFactory } from '../../../infrastructure/queues/WorkerFactory.js';
import { logger } from '../../../shared/logger.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { JobRetryConfig, QueueNames, type JdScoreJobData } from '../../../shared/jobs/types.js';
import type { JobTargetParsedPayload } from '../../../shared/events/eventContract.js';
import { checkStarEvidence } from '../analysis/starEvidenceChecks.js';
import { MAX_EVENT_SKILLS, missingTaxonomySkills, scoreTaxonomy } from '../analysis/taxonomyFallback.js';
import { createGatewayJdLlm, type JdLlm } from '../jdLlm.js';
import { parseJobTargetJobData } from '../jobData.js';
import {
  getJobTargetPort,
  type AnalysisMode,
  type CandidateInput,
  type DegradedReason,
  type JdScoreResult,
  type JobTargetParsedOutboxInput,
  type JobTargetScoredOutboxInput,
  type JobTargetPort,
  type JobTargetRecord,
} from '../jobTarget.port.js';
import { MAX_JD_CHARS } from '../prompts/jdStructure.prompt.js';
import { sanitizeUntrustedText } from '../prompts/untrustedText.js';
import {
  buildStarRewritePrompt,
  MAX_BULLET_CHARS,
  MAX_REWRITE_BULLETS,
  parseStarRewriteOutput,
  STAR_REWRITE_MAX_TOKENS,
} from '../prompts/starRewrite.prompt.js';

/** Concurrency of the ai pool: model calls are slow and mostly waiting. */
export const AI_WORKER_CONCURRENCY = 4;

export interface JdScoreDeps {
  port: JobTargetPort;
  llm: JdLlm;
  now?: () => Date;
}

export async function enqueueJdScore(data: JdScoreJobData, parsedAt: string): Promise<void> {
  await getOrCreateQueue(QueueNames.JD_SCORE).add('jd-score', data, {
    // One score per parse: a retried parse job does not queue the same score twice.
    jobId: `jd-score-${data.jobTargetId}-${new Date(parsedAt).getTime()}`,
    ...JobRetryConfig.standard,
    removeOnComplete: true,
    removeOnFail: { count: 500 },
  });
}

export function buildJobTargetParsedEvent(userId: string, jobTargetId: string, payload: Omit<JobTargetParsedPayload, 'jobTargetId'>): JobTargetParsedOutboxInput {
  return {
    type: 'jobtarget.parsed',
    aggregateType: 'job_target',
    aggregateId: jobTargetId,
    userId,
    // Absent fields are omitted rather than sent as undefined: the consumer treats them as optional.
    payload: { jobTargetId, ...Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)) },
  };
}

interface AiScoreOutcome {
  aiFit?: JdScoreResult['aiFit'];
  starRewrites: JdScoreResult['starRewrites'];
  degradedReason?: DegradedReason;
}

async function tryStarRewrites(
  userId: string,
  target: JobTargetRecord,
  candidate: CandidateInput,
  deterministicScore: number,
  llm: JdLlm,
): Promise<AiScoreOutcome> {
  const bullets = candidate.bullets
    .map(bullet => ({ id: bullet.id, text: sanitizeUntrustedText(bullet.text, MAX_BULLET_CHARS).text }))
    .filter(bullet => bullet.text.trim())
    .slice(0, MAX_REWRITE_BULLETS)
    .map((bullet, index) => ({ ...bullet, ref: `b${index + 1}` }));
  if (!bullets.length) return { starRewrites: [], degradedReason: 'no_candidate_bullets' };
  if (!llm.isConfigured()) return { starRewrites: [], degradedReason: 'ai_unconfigured' };

  const jdText = sanitizeUntrustedText(target.jdText, MAX_JD_CHARS).text;
  const { systemPrompt, prompt } = buildStarRewritePrompt(jdText, bullets);

  let reply: string;
  try {
    reply = await llm.complete({ userId, systemPrompt, prompt, maxTokens: STAR_REWRITE_MAX_TOKENS });
  } catch (error) {
    logger.warn('[jd-score] Model call failed, using taxonomy result', { event: 'jd_score_llm_failed', jobTargetId: target.jobTargetId, error: error instanceof Error ? error.message : String(error) });
    return { starRewrites: [], degradedReason: 'llm_failed' };
  }

  const parsed = parseStarRewriteOutput(reply);
  if (!parsed.ok) {
    logger.warn('[jd-score] Model reply rejected by schema', { event: 'jd_score_invalid_output', jobTargetId: target.jobTargetId, reason: parsed.reason, issues: parsed.issues });
    return { starRewrites: [], degradedReason: 'invalid_output' };
  }

  const refs = new Map(bullets.map(bullet => [bullet.ref, bullet]));
  const reasons = checkStarEvidence(parsed.data, {
    bullets: new Map(bullets.map(bullet => [bullet.ref, bullet.text])),
    candidateSkillText: candidate.skills.map(skill => typeof skill === 'string' ? skill : skill.skill).join(', '),
    deterministicScore,
  });
  if (reasons.length) {
    logger.warn('[jd-score] Model reply rejected by evidence checks', { event: 'jd_score_output_rejected', jobTargetId: target.jobTargetId, reasons });
    return { starRewrites: [], degradedReason: 'output_rejected' };
  }

  return {
    aiFit: parsed.data.fitAssessment,
    starRewrites: parsed.data.rewrites.map(({ bulletRef, ...rewrite }) => ({ bulletId: refs.get(bulletRef)!.id, ...rewrite })),
  };
}

export async function processJdScore(rawData: unknown, deps: JdScoreDeps): Promise<JdScoreResult> {
  const { userId, jobTargetId } = parseJobTargetJobData(rawData);
  const target = await deps.port.loadTarget(userId, jobTargetId);
  if (!target) throw new NonRetryableError(`Job target ${jobTargetId} not found`);
  const parse = target.parse;
  // jd-parse saves before it queues this job, so a missing parse means a lagging read: try again.
  if (!parse) throw new RetryableError(`Job target ${jobTargetId} has no parse result yet`);

  const candidate = await deps.port.loadCandidateInput(userId);
  const deterministic = scoreTaxonomy(parse.requirements, candidate);
  const ai = await tryStarRewrites(userId, target, candidate, deterministic.score, deps.llm);
  const scoreMode: AnalysisMode = ai.aiFit ? 'ai' : 'taxonomy_only';

  const result: JdScoreResult = {
    analysisMode: scoreMode,
    degradedReason: ai.degradedReason,
    taxonomyVersion: deterministic.taxonomyVersion,
    score: deterministic.score,
    dimensions: deterministic.dimensions,
    aiFit: ai.aiFit,
    starRewrites: ai.starRewrites,
    scoredAt: (deps.now?.() ?? new Date()).toISOString(),
  };

  // The target counts as AI-analysed only when both steps used the model.
  const analysisMode: AnalysisMode = parse.analysisMode === 'ai' && scoreMode === 'ai' ? 'ai' : 'taxonomy_only';
  const event = buildJobTargetParsedEvent(userId, jobTargetId, {
    targetRole: target.targetRole ?? parse.role,
    company: target.company ?? parse.company,
    requiredSkills: parse.requiredSkills.slice(0, MAX_EVENT_SKILLS),
    analysisMode,
  });
  const scoredEvent: JobTargetScoredOutboxInput = {
    type: 'jobtarget.scored', aggregateType: 'job_target', aggregateId: jobTargetId, userId,
    payload: {
      jobTargetId, matchScore: deterministic.score,
      missingSkills: missingTaxonomySkills(parse.requirements, candidate), scoredAt: result.scoredAt,
    },
  };
  await deps.port.completeScore(userId, jobTargetId, result, event, scoredEvent);
  logger.info('[jd-score] Scored job target', { event: 'jd_score_done', jobTargetId, analysisMode, degradedReason: ai.degradedReason });
  return result;
}

let worker: Worker<JdScoreJobData> | null = null;

export function startJdScoreWorker(): Worker<JdScoreJobData> {
  if (worker) return worker;
  worker = WorkerFactory.createWorker<JdScoreJobData>(
    QueueNames.JD_SCORE,
    (job: Job<JdScoreJobData>) => processJdScore(job.data, { port: getJobTargetPort(), llm: createGatewayJdLlm() }),
    { concurrency: AI_WORKER_CONCURRENCY },
  );
  return worker;
}

export async function stopJdScoreWorker(): Promise<void> {
  if (!worker) return;
  const closing = worker;
  worker = null;
  await closing.close();
}
