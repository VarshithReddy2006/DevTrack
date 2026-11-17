// jd-parse: reads a job posting, runs the deterministic taxonomy extraction, asks the model for
// company and role metadata, stores the result and queues jd-score. When no AI key is set or the
// model fails, the taxonomy result alone is stored (analysisMode 'taxonomy_only').
// Runs under WORKER_TYPE=ai.

import type { Job, Worker } from 'bullmq';
import { NonRetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';
import { WorkerFactory } from '../../../infrastructure/queues/WorkerFactory.js';
import { logger } from '../../../shared/logger.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { JobRetryConfig, QueueNames, type JdParseJobData } from '../../../shared/jobs/types.js';
import { analyzeTaxonomy, MAX_EVENT_SKILLS, type TaxonomyAnalysis } from '../analysis/taxonomyFallback.js';
import { createGatewayJdLlm, type JdLlm } from '../jdLlm.js';
import { parseJobTargetJobData } from '../jobData.js';
import { getJobTargetPort, type DegradedReason, type JdParseResult, type JobTargetPort } from '../jobTarget.port.js';
import {
  buildJdStructurePrompt,
  JD_STRUCTURE_MAX_TOKENS,
  MAX_JD_CHARS,
  parseJdStructureOutput,
  type JdStructureOutput,
} from '../prompts/jdStructure.prompt.js';
import { sanitizeUntrustedText } from '../prompts/untrustedText.js';
import { AI_WORKER_CONCURRENCY, enqueueJdScore } from './jdScore.worker.js';

export interface JdParseDeps {
  port: JobTargetPort;
  llm: JdLlm;
  /** Queues the jd-score job once the parse result is stored. */
  enqueueScore: (data: { userId: string; jobTargetId: string; requestId?: string }, parsedAt: string) => Promise<void>;
  now?: () => Date;
}

export async function enqueueJdParse(data: JdParseJobData): Promise<void> {
  await getOrCreateQueue(QueueNames.JD_PARSE).add('jd-parse', data, {
    ...JobRetryConfig.standard,
    removeOnComplete: true,
    removeOnFail: { count: 500 },
  });
}

const normalize = (value: string) => value.normalize('NFKC').toLowerCase();

/** A model-named skill is kept only when the posting itself contains it. */
function groundedSkills(skills: readonly string[], jdText: string): { kept: string[]; dropped: number } {
  const haystack = normalize(jdText);
  const kept = skills.filter(skill => haystack.includes(normalize(skill)));
  return { kept, dropped: skills.length - kept.length };
}

const union = (first: readonly string[], second: readonly string[]) => [...new Set([...first, ...second])].slice(0, MAX_EVENT_SKILLS);

async function tryStructure(
  userId: string,
  jobTargetId: string,
  jdText: string,
  llm: JdLlm,
): Promise<{ structure?: JdStructureOutput; degradedReason?: DegradedReason }> {
  if (!llm.isConfigured()) return { degradedReason: 'ai_unconfigured' };
  const { systemPrompt, prompt } = buildJdStructurePrompt(jdText);
  let reply: string;
  try {
    reply = await llm.complete({ userId, systemPrompt, prompt, maxTokens: JD_STRUCTURE_MAX_TOKENS });
  } catch (error) {
    logger.warn('[jd-parse] Model call failed, using taxonomy result', { event: 'jd_parse_llm_failed', jobTargetId, error: error instanceof Error ? error.message : String(error) });
    return { degradedReason: 'llm_failed' };
  }
  const parsed = parseJdStructureOutput(reply);
  if (!parsed.ok) {
    logger.warn('[jd-parse] Model reply rejected by schema', { event: 'jd_parse_invalid_output', jobTargetId, reason: parsed.reason, issues: parsed.issues });
    return { degradedReason: 'invalid_output' };
  }
  return { structure: parsed.data };
}

function assemble(taxonomy: TaxonomyAnalysis, parsedAt: string, jdText: string, structure?: JdStructureOutput, degradedReason?: DegradedReason): JdParseResult {
  const base = {
    taxonomyVersion: taxonomy.requirements.taxonomyVersion,
    requirements: taxonomy.requirements,
    parsedAt,
  };
  if (!structure) {
    return {
      ...base,
      analysisMode: 'taxonomy_only',
      degradedReason,
      requiredSkills: taxonomy.requiredSkills,
      preferredSkills: taxonomy.preferredSkills,
      responsibilities: [],
      ungroundedSkillsDropped: 0,
    };
  }
  const required = groundedSkills(structure.requiredSkills, jdText);
  const preferred = groundedSkills(structure.preferredSkills, jdText);
  return {
    ...base,
    analysisMode: 'ai',
    company: structure.company ?? undefined,
    role: structure.role ?? undefined,
    seniority: structure.seniority,
    requiredSkills: union(taxonomy.requiredSkills, required.kept),
    preferredSkills: union(taxonomy.preferredSkills, preferred.kept),
    responsibilities: structure.responsibilities,
    ungroundedSkillsDropped: required.dropped + preferred.dropped,
  };
}

export async function processJdParse(rawData: unknown, deps: JdParseDeps): Promise<JdParseResult> {
  const data = parseJobTargetJobData(rawData);
  const target = await deps.port.loadTarget(data.userId, data.jobTargetId);
  if (!target) throw new NonRetryableError(`Job target ${data.jobTargetId} not found`);

  const { text: jdText } = sanitizeUntrustedText(target.jdText, MAX_JD_CHARS);
  if (!jdText.trim()) throw new NonRetryableError(`Job target ${data.jobTargetId} has no job description text`);

  const taxonomy = analyzeTaxonomy(jdText);
  const { structure, degradedReason } = await tryStructure(data.userId, data.jobTargetId, jdText, deps.llm);
  const parsedAt = (deps.now?.() ?? new Date()).toISOString();
  const result = assemble(taxonomy, parsedAt, jdText, structure, degradedReason);

  await deps.port.saveParseResult(data.userId, data.jobTargetId, result);
  await deps.enqueueScore(data, parsedAt);
  logger.info('[jd-parse] Parsed job target', { event: 'jd_parse_done', jobTargetId: data.jobTargetId, analysisMode: result.analysisMode, degradedReason });
  return result;
}

let worker: Worker<JdParseJobData> | null = null;

export function startJdParseWorker(): Worker<JdParseJobData> {
  if (worker) return worker;
  worker = WorkerFactory.createWorker<JdParseJobData>(
    QueueNames.JD_PARSE,
    (job: Job<JdParseJobData>) => processJdParse(job.data, {
      port: getJobTargetPort(),
      llm: createGatewayJdLlm(),
      enqueueScore: (data, parsedAt) => enqueueJdScore(data, parsedAt),
    }),
    { concurrency: AI_WORKER_CONCURRENCY },
  );
  return worker;
}

export async function stopJdParseWorker(): Promise<void> {
  if (!worker) return;
  const closing = worker;
  worker = null;
  await closing.close();
}
