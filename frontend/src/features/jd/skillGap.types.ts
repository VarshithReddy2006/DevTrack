export const SKILL_CATEGORIES = ['Languages', 'Frameworks', 'Cloud & DevOps', 'System Design', 'Databases', 'Other'] as const;
export type SkillCategory = typeof SKILL_CATEGORIES[number];
export type SkillRequirement = 'required' | 'preferred' | 'unknown';

interface JobSkill {
  /** Unique within a report and stable across refreshes. */
  id: string;
  name: string;
  category: string;
  requirement: SkillRequirement;
}
export interface MatchedSkill extends JobSkill {
  status: 'matched';
  /** Only explicit upstream verification may set verified=true. A keyword match is not verification. */
  evidence: readonly { source: 'resume' | 'github' | 'dsa'; verified: boolean }[];
}
export interface MissingSkill extends JobSkill {
  status: 'missing';
  inStudyPlan?: boolean;
}
export type ComparedSkill = MatchedSkill | MissingSkill;
export interface StudyPlanSkillAction {
  jobTargetId: string;
  skill: MissingSkill;
}

const categories: Record<string, SkillCategory> = {
  language: 'Languages', languages: 'Languages', 'programming languages': 'Languages',
  framework: 'Frameworks', frameworks: 'Frameworks', libraries: 'Frameworks',
  cloud: 'Cloud & DevOps', devops: 'Cloud & DevOps', 'cloud devops': 'Cloud & DevOps',
  'system design': 'System Design', architecture: 'System Design',
  database: 'Databases', databases: 'Databases',
};
export function skillCategory(category: string): SkillCategory {
  const key = category.trim().toLowerCase().replace(/[\s_&/-]+/g, ' ');
  return Object.hasOwn(categories, key) ? categories[key] : 'Other';
}

export const requirementLabels: Record<SkillRequirement, string> = {
  required: 'Required', preferred: 'Preferred', unknown: 'Priority not provided',
};
export const evidenceSourceLabels = { resume: 'Resume', github: 'GitHub', dsa: 'DSA' } as const;
