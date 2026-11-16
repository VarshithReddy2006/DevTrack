/**
 * Helpers that turn resume-derived claims (user controlled, they come from an
 * uploaded resume) into a bounded, delimited text block that is safe to put in
 * the credibility prompt as data.
 */

export const CLAIM_ITEM_MAX_CHARS = 100;
export const CLAIM_LIST_MAX_ITEMS = 30;
export const CLAIM_SECTION_MAX_CHARS = 4000;
// Two sections plus the tags, so the whole block stays under ~8.3k chars.
export const CLAIMS_BLOCK_MAX_CHARS = 2 * CLAIM_SECTION_MAX_CHARS + 300;

const EXPERIENCE_KEYS = [
  'yearsOfExperience',
  'engineeringDepth',
  'projectComplexity',
  'leadershipIndicators',
  'productionExposure',
] as const;

const SKILL_KEYS = [
  'languages',
  'frameworks',
  'databases',
  'cloudTools',
  'devOpsTools',
  'aiMlTools',
] as const;

// C0/C1 control chars and line/paragraph separators become a space.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
// Soft hyphen, zero width and bidi formatting chars and the BOM are removed, so
// hidden characters cannot be used to split or disguise a word.
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/**
 * Strips control and invisible characters, collapses whitespace, neutralises
 * angle brackets (so text can never close or open the data tags) and caps the
 * length.
 */
export function sanitizeClaimText(value: unknown, maxChars = CLAIM_ITEM_MAX_CHARS): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(INVISIBLE_CHARS, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/</g, '\u2039')
    .replace(/>/g, '\u203A');
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}...` : cleaned;
}

function clampSection(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...[truncated]` : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export interface ClaimSource {
  experienceSignals?: unknown;
  extractedSkills?: unknown;
}

/**
 * Builds the `<candidate_claims>` block for the user prompt. Only known keys are
 * copied, numbers must be finite, every string is sanitized, every list and
 * section is capped, so the whole block is bounded by construction.
 */
export function buildCandidateClaimsBlock(source: ClaimSource | null | undefined): string {
  const experienceIn = asRecord(source?.experienceSignals);
  const experience: Record<string, number | null> = {};
  for (const key of EXPERIENCE_KEYS) {
    const v = experienceIn[key];
    experience[key] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  const skillsIn = asRecord(source?.extractedSkills);
  const skills: Record<string, string[]> = {};
  for (const key of SKILL_KEYS) {
    const list = Array.isArray(skillsIn[key]) ? (skillsIn[key] as unknown[]) : [];
    skills[key] = list
      .map(item => sanitizeClaimText(item))
      .filter(item => item.length > 0)
      .slice(0, CLAIM_LIST_MAX_ITEMS);
  }

  const experienceText = clampSection(JSON.stringify(experience, null, 2), CLAIM_SECTION_MAX_CHARS);
  const skillsText = clampSection(JSON.stringify(skills, null, 2), CLAIM_SECTION_MAX_CHARS);

  return [
    '<candidate_claims>',
    '<experience_signals>',
    experienceText,
    '</experience_signals>',
    '<extracted_skills>',
    skillsText,
    '</extracted_skills>',
    '</candidate_claims>',
  ].join('\n');
}
