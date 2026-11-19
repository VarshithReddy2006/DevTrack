import {
  DEFAULT_SKILL_WEIGHTS, normalizeWeightedSkill, skillTier,
  type SkillTier, type SkillWeights,
} from '../taxonomy/skillWeights.js';

export interface WeightedRequirement {
  skill: string;
  tier?: SkillTier;
}

export interface WeightedMatcherOptions {
  weights?: Partial<SkillWeights>;
}

export interface TierMatch {
  score: number | null;
  matched: string[];
  missing: string[];
}

export interface WeightedMatchResult {
  score: number;
  tiers: Record<SkillTier, TierMatch>;
  matchedSkills: string[];
  missingCriticalRequirements: string[];
}

const tierNames: readonly SkillTier[] = ['mandatory', 'preferred', 'soft'];
const round = (value: number) => Math.round(value * 100) / 100;

/** Pure tier coverage; empty tiers redistribute weight and missing core skills cap at 75. */
export function weightedMatcher(
  requirements: readonly WeightedRequirement[],
  candidateSkills: readonly string[],
  options: WeightedMatcherOptions = {},
): WeightedMatchResult {
  const weights = { ...DEFAULT_SKILL_WEIGHTS, ...options.weights };
  for (const tier of tierNames) {
    if (!Number.isFinite(weights[tier]) || weights[tier] < 0) {
      throw new RangeError('Skill weights must be finite nonnegative numbers');
    }
  }
  if (!tierNames.some(tier => weights[tier] > 0)) {
    throw new RangeError('At least one skill weight must be positive');
  }

  // Collapse aliases/duplicates into their strictest tier, independent of input order.
  const targets = new Map<string, SkillTier>();
  for (const requirement of requirements) {
    const skill = normalizeWeightedSkill(requirement.skill);
    if (!skill) continue;
    const tier = requirement.tier ?? skillTier(skill);
    if (!tierNames.includes(tier)) throw new RangeError('Unknown skill tier');
    const previous = targets.get(skill);
    if (!previous || tierNames.indexOf(tier) < tierNames.indexOf(previous)) targets.set(skill, tier);
  }
  const available = new Set(candidateSkills.map(normalizeWeightedSkill).filter(Boolean));
  const tiers: WeightedMatchResult['tiers'] = {
    mandatory: { score: null, matched: [], missing: [] },
    preferred: { score: null, matched: [], missing: [] },
    soft: { score: null, matched: [], missing: [] },
  };
  for (const skill of [...targets.keys()].sort()) {
    const result = tiers[targets.get(skill)!];
    (available.has(skill) ? result.matched : result.missing).push(skill);
  }

  const largestWeight = Math.max(...tierNames.map(tier =>
    tiers[tier].matched.length + tiers[tier].missing.length ? weights[tier] : 0));
  let total = 0;
  let applicableWeight = 0;
  for (const tier of tierNames) {
    const result = tiers[tier];
    const count = result.matched.length + result.missing.length;
    if (!count) continue;
    const coverage = 100 * result.matched.length / count;
    result.score = round(coverage);
    // Scaling avoids overflow for valid, very large custom weights.
    const weight = largestWeight ? weights[tier] / largestWeight : 0;
    total += coverage * weight;
    applicableWeight += weight;
  }
  const score = applicableWeight ? total / applicableWeight : 0;
  return {
    score: round(Math.min(tiers.mandatory.missing.length ? 75 : 100, score)),
    tiers,
    matchedSkills: tierNames.flatMap(tier => tiers[tier].matched),
    missingCriticalRequirements: [...tiers.mandatory.missing],
  };
}
