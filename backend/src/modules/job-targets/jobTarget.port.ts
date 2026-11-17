// What the jd-parse and jd-score workers need from storage. The JobTarget model and service
// (#339) are not on main yet, so the workers talk to this port instead of to Mongoose.
//
// Plug-in point for #339: implement JobTargetPort over the real model and call
// setJobTargetPort() once at worker start-up. completeScore() must write the score result and
// the outbox row in one transaction (runInTransaction + writeOutboxEvent, see
// src/shared/events/outbox.ts), which is why it takes the ready-made outbox input.

import type { CandidateEvidence, CandidateSkill, ExtractedRequirements, MatchScoreResult } from '@devtrack/ats-core';
import { NonRetryableError } from '../../infrastructure/queues/ErrorClassifier.js';
import type { JobTargetParsedPayload } from '../../shared/events/eventContract.js';
import type { OutboxEventInput } from '../../shared/events/outbox.js';
import type { JdStructureOutput } from './prompts/jdStructure.prompt.js';
import type { StarRewrite } from './prompts/starRewrite.prompt.js';

export type AnalysisMode = 'ai' | 'taxonomy_only';

/** Why a result is taxonomy_only. Stored with the result so a degraded run is never silent. */
export type DegradedReason =
  | 'ai_unconfigured'
  | 'llm_failed'
  | 'invalid_output'
  | 'output_rejected'
  | 'no_candidate_bullets';

export interface JdParseResult {
  analysisMode: AnalysisMode;
  degradedReason?: DegradedReason;
  taxonomyVersion: string;
  requirements: ExtractedRequirements;
  company?: string;
  role?: string;
  seniority?: JdStructureOutput['seniority'];
  requiredSkills: string[];
  preferredSkills: string[];
  responsibilities: string[];
  /** Skills the model named that the posting does not contain. They are dropped and counted here. */
  ungroundedSkillsDropped: number;
  parsedAt: string;
}

export interface JdScoreResult {
  analysisMode: AnalysisMode;
  degradedReason?: DegradedReason;
  taxonomyVersion: string;
  /** Always the deterministic score. A model score never replaces it. */
  score: number;
  dimensions: MatchScoreResult['dimensions'];
  /** The model's advisory fit estimate, present only when it passed the evidence checks. */
  aiFit?: { score: number; rationale: string };
  starRewrites: Array<Omit<StarRewrite, 'bulletRef'> & { bulletId: string }>;
  scoredAt: string;
}

export interface JobTargetRecord {
  jobTargetId: string;
  userId: string;
  /** Posting text, already fetched. Fetching a URL (SSRF-safe) belongs to the service that creates the target. */
  jdText: string;
  /** Entered by the user, so they win over what the model reads from the posting. */
  targetRole?: string;
  company?: string;
  parse?: JdParseResult;
}

export interface CandidateBullet {
  id: string;
  text: string;
}

export interface CandidateInput {
  skills: CandidateSkill[];
  evidence: CandidateEvidence[];
  experienceYears: number;
  bullets: CandidateBullet[];
}

export interface JobTargetPort {
  loadTarget(userId: string, jobTargetId: string): Promise<JobTargetRecord | null>;
  loadCandidateInput(userId: string): Promise<CandidateInput>;
  saveParseResult(userId: string, jobTargetId: string, result: JdParseResult): Promise<void>;
  /** Persist the score result and the outbox row together. Retried jobs call it again, so it must overwrite. */
  completeScore(userId: string, jobTargetId: string, result: JdScoreResult, event: JobTargetParsedOutboxInput): Promise<void>;
}

export type JobTargetParsedOutboxInput = Omit<OutboxEventInput, 'payload' | 'type'> & {
  type: 'jobtarget.parsed';
  payload: JobTargetParsedPayload;
};

/** Default until #339 lands. Fails loudly instead of pretending to store anything. */
const unwired: JobTargetPort = {
  async loadTarget() { throw unwiredError(); },
  async loadCandidateInput() { throw unwiredError(); },
  async saveParseResult() { throw unwiredError(); },
  async completeScore() { throw unwiredError(); },
};

function unwiredError(): NonRetryableError {
  return new NonRetryableError('JobTargetPort is not wired: the job target storage adapter has not been registered');
}

let port: JobTargetPort = unwired;

export function setJobTargetPort(next: JobTargetPort | null): void {
  port = next ?? unwired;
}

export function getJobTargetPort(): JobTargetPort {
  return port;
}
