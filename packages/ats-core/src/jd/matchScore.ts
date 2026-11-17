import { canonicalSkillName } from '../taxonomy/index.js';
import type { ExtractedRequirements } from './extractRequirements.js';

export type CandidateSkill = string | { skill: string; years?: number };

export interface CandidateEvidence {
  skill: string;
  verified: boolean;
}

const WEIGHTS = {
  hardRequirements: 40,
  techStack: 30,
  verifiedEvidence: 20,
  experience: 10,
} as const;

type Dimension = keyof typeof WEIGHTS;

export interface MatchScoreResult {
  source: 'taxonomy_only';
  taxonomyVersion: string;
  score: number;
  dimensions: Record<Dimension, number | null>;
}

const validYears = (years = 0) => Number.isFinite(years) && years > 0 ? years : 0;
const round = (value: number) => Math.round(value * 100) / 100;

function coverage(targets: string[], available: ReadonlySet<string>): number | null {
  return targets.length ? 100 * targets.filter(skill => available.has(skill)).length / targets.length : null;
}

export function matchScore(
  requirements: ExtractedRequirements,
  candidateSkills: readonly CandidateSkill[],
  candidateEvidence: readonly CandidateEvidence[],
  overallExperienceYears = 0,
): MatchScoreResult {
  const names = new Set<string>();
  const yearsBySkill = new Map<string, number>();
  for (const input of candidateSkills) {
    const skill = canonicalSkillName(typeof input === 'string' ? input : input.skill);
    if (!skill) continue;
    const years = typeof input === 'string' ? 0 : validYears(input.years);
    names.add(skill);
    yearsBySkill.set(skill, Math.max(yearsBySkill.get(skill) ?? 0, years));
  }

  const verified = new Set<string>();
  for (const evidence of candidateEvidence) {
    const skill = canonicalSkillName(evidence.skill);
    if (evidence.verified && skill) verified.add(skill);
  }

  // Keep the highest requested duration per skill and for overall experience.
  const requiredYears = new Map<string | null, number>();
  for (const requirement of requirements.experience) {
    if (requirement.minYears <= 0) continue;
    for (const skill of requirement.skills.length ? requirement.skills : [null]) {
      requiredYears.set(skill, Math.max(requiredYears.get(skill) ?? 0, requirement.minYears));
    }
  }

  const stack = requirements.skills.map(term => term.skill);
  const hard = requirements.skills
    .filter(term => term.contexts.some(context => context.priority === 'required'))
    .map(term => term.skill);
  let experienceMatch = 0;
  for (const [skill, years] of requiredYears) {
    const actual = skill === null ? validYears(overallExperienceYears) : yearsBySkill.get(skill) ?? 0;
    experienceMatch += Math.min(actual / years, 1);
  }

  const dimensions: MatchScoreResult['dimensions'] = {
    hardRequirements: coverage(hard, names),
    techStack: coverage(stack, names),
    verifiedEvidence: coverage(stack, verified),
    experience: requiredYears.size ? 100 * experienceMatch / requiredYears.size : null,
  };

  let weightedScore = 0;
  let applicableWeight = 0;
  for (const key of Object.keys(WEIGHTS) as Dimension[]) {
    const score = dimensions[key];
    if (score === null) continue;
    weightedScore += score * WEIGHTS[key];
    applicableWeight += WEIGHTS[key];
    dimensions[key] = round(score);
  }

  return {
    source: 'taxonomy_only',
    taxonomyVersion: requirements.taxonomyVersion,
    score: applicableWeight ? round(weightedScore / applicableWeight) : 0,
    dimensions,
  };
}
