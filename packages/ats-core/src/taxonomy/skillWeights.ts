import taxonomy from './v1.json' with { type: 'json' };
import { canonicalSkillName } from './index.js';

export type SkillTier = 'mandatory' | 'preferred' | 'soft';
export type SkillWeights = Record<SkillTier, number>;

export const DEFAULT_SKILL_WEIGHTS: Readonly<SkillWeights> = Object.freeze({
  mandatory: 60,
  preferred: 25,
  soft: 15,
});

const coreCategories = new Set(['language', 'database', 'architecture']);
const categories = new Map(taxonomy.skills.map(skill => [skill.name, skill.category]));
const softSkills = new Set(['agile', 'scrum', 'code review', 'mentorship', 'leadership', 'communication', 'teamwork']);

/** Preserve unknown terms for explicit caller-supplied requirements. */
export function normalizeWeightedSkill(skill: string): string {
  return canonicalSkillName(skill) ?? skill.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Defaults are heuristics; callers can override a requirement's tier. */
export function skillTier(skill: string): SkillTier {
  const name = normalizeWeightedSkill(skill);
  if (softSkills.has(name.toLowerCase())) return 'soft';
  return coreCategories.has(categories.get(name) ?? '') ? 'mandatory' : 'preferred';
}
