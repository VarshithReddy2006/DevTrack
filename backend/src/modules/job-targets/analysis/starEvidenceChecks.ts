// Deterministic checks a model's STAR output must pass before any of it is kept.
// A reply can be valid JSON and still be a hijack or an invention, so the schema alone is not enough.

import { extractRequirements } from '@devtrack/ats-core';
import type { StarRewriteOutput } from '../prompts/starRewrite.prompt.js';

/** The model's fit estimate may differ from the deterministic score by at most this much. */
export const MAX_FIT_DEVIATION = 25;

export interface EvidenceCheckInput {
  /** ref -> the candidate's original bullet text */
  bullets: ReadonlyMap<string, string>;
  /** Names of the skills the candidate lists, as plain text */
  candidateSkillText: string;
  deterministicScore: number;
}

const NUMBER = /\d+(?:[.,]\d+)*/g;

const numbersIn = (text: string) => new Set(text.match(NUMBER) ?? []);
const skillsIn = (text: string) => new Set(extractRequirements(text).skills.map(term => term.skill));

/** Returns the reasons the output must be rejected. An empty list means it passed. */
export function checkStarEvidence(output: StarRewriteOutput, input: EvidenceCheckInput): string[] {
  const reasons: string[] = [];

  if (Math.abs(output.fitAssessment.score - input.deterministicScore) > MAX_FIT_DEVIATION) {
    reasons.push('fit score is too far from the deterministic score');
  }

  const candidateSkills = skillsIn(input.candidateSkillText);
  const seen = new Set<string>();
  for (const rewrite of output.rewrites) {
    const original = input.bullets.get(rewrite.bulletRef);
    if (original === undefined) {
      reasons.push(`unknown bullet ref ${rewrite.bulletRef}`);
      continue;
    }
    if (seen.has(rewrite.bulletRef)) reasons.push(`duplicate rewrite for ${rewrite.bulletRef}`);
    seen.add(rewrite.bulletRef);

    const rewritten = [rewrite.situation, rewrite.task, rewrite.action, rewrite.result, rewrite.rewritten].join('\n');
    const knownNumbers = numbersIn(original);
    if ([...numbersIn(rewritten)].some(number => !knownNumbers.has(number))) {
      reasons.push(`${rewrite.bulletRef} adds a number that is not in the original bullet`);
    }
    const knownSkills = skillsIn(original);
    if ([...skillsIn(rewritten)].some(skill => !knownSkills.has(skill) && !candidateSkills.has(skill))) {
      reasons.push(`${rewrite.bulletRef} names a skill the candidate does not have`);
    }
  }
  return reasons;
}
