// Deterministic analysis from @devtrack/ats-core. It is both the fallback (analysisMode
// 'taxonomy_only') and the baseline the model output is checked against.

import {
  extractRequirements,
  matchScore,
  type ExtractedRequirements,
  type MatchScoreResult,
} from '@devtrack/ats-core';
import type { CandidateInput } from '../jobTarget.port.js';

/** Same cap the readiness consumer applies to requiredSkills. */
export const MAX_EVENT_SKILLS = 50;

export interface TaxonomyAnalysis {
  requirements: ExtractedRequirements;
  requiredSkills: string[];
  preferredSkills: string[];
}

export function analyzeTaxonomy(jdText: string): TaxonomyAnalysis {
  const requirements = extractRequirements(jdText);
  const required = requirements.skills
    .filter(term => term.contexts.some(context => context.priority === 'required'))
    .map(term => term.skill);
  const preferred = requirements.skills
    .filter(term => !required.includes(term.skill) && term.contexts.some(context => context.priority === 'preferred'))
    .map(term => term.skill);
  return {
    requirements,
    // A posting with no "required" wording still lists its stack, so use every detected skill then.
    requiredSkills: (required.length ? required : requirements.skills.map(term => term.skill)).slice(0, MAX_EVENT_SKILLS),
    preferredSkills: preferred.slice(0, MAX_EVENT_SKILLS),
  };
}

export function scoreTaxonomy(requirements: ExtractedRequirements, candidate: CandidateInput): MatchScoreResult {
  return matchScore(requirements, candidate.skills, candidate.evidence, candidate.experienceYears);
}
