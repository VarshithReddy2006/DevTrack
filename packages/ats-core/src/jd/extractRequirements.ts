import { findSkillMentions, SKILL_TAXONOMY_VERSION } from '../taxonomy/index.js';

export type RequirementPriority = 'required' | 'preferred' | 'unspecified';

export interface RequirementContext {
  section: string;
  priority: RequirementPriority;
}

export interface SkillRequirement {
  skill: string;
  category: string;
  frequency: number;
  contexts: Array<RequirementContext & { frequency: number }>;
}

export interface ExperienceRequirement extends RequirementContext {
  minYears: number;
  skills: string[];
}

export interface ExtractedRequirements {
  taxonomyVersion: string;
  skills: SkillRequirement[];
  experience: ExperienceRequirement[];
}

const requiredHeading = /^(?:(?:minimum|basic|required|mandatory|essential) (?:qualifications|requirements|skills)|requirements|qualifications|must[- ]haves?)$/i;
const preferredHeading = /^(?:preferred(?: qualifications| requirements| skills)?|nice[- ]to[- ]haves?|bonus(?: points| skills)?|desirable(?: skills)?|what sets you apart)$/i;
const otherHeading = /^(?:about (?:us|the role|the company)|responsibilities|what you['\u2019]ll do|benefits|tech stack|our stack|overview|compensation|equal opportunity)$/i;
const preferredCue = /\b(?:nice[- ]to[- ]have|preferred|a plus|bonus|desirable|not required)\b/i;
const requiredCue = /\b(?:must(?: have)?|required|mandatory)\b/i;
const yearsPattern = /\b(\d+(?:\.\d+)?)\s*(?:(?:[\u2013\u2014-]|\bto\b)\s*\d+(?:\.\d+)?\s*|\+\s*)?(?:years?|yrs?)\b/gi;

function readHeading(line: string): (RequirementContext & { remainder: string }) | undefined {
  const [label, ...tail] = line.replace(/^#{1,6}\s+/, '').split(':');
  const section = label.replace(/\*\*/g, '').trim();
  const remainder = tail.join(':').replace(/^\*\*\s*/, '').trim();
  if (requiredHeading.test(section)) return { section, priority: 'required', remainder };
  if (preferredHeading.test(section)) return { section, priority: 'preferred', remainder };
  if (otherHeading.test(section) || /^#{1,6}\s+/.test(line)) {
    return { section, priority: 'unspecified', remainder };
  }
  return undefined;
}

function clausePriority(clause: string, section: RequirementPriority): RequirementPriority {
  if (preferredCue.test(clause)) return 'preferred';
  if (requiredCue.test(clause)) return 'required';
  return section;
}

function splitClauses(content: string): string[] {
  return content.split(/[;\u2022]|(?<=[.!?])\s+/).flatMap(clause => {
    const parts = clause.split(/,\s*(?:and\s+)?|\s+(?:and|but)\s+/i);
    // Keep lists together unless each part has its own, distinct priority.
    const priorities = parts.map(part => clausePriority(part, 'unspecified'));
    return priorities.includes('required') && priorities.includes('preferred')
      && !priorities.includes('unspecified') ? parts : [clause];
  });
}

export function extractRequirements(jdText: string): ExtractedRequirements {
  const skills = new Map<string, SkillRequirement>();
  const experience: ExperienceRequirement[] = [];
  let section: RequirementContext = { section: 'General', priority: 'unspecified' };

  for (const line of jdText.normalize('NFKC').split(/\r\n?|\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = readHeading(trimmed);
    if (heading) section = { section: heading.section, priority: heading.priority };
    const content = heading ? heading.remainder : trimmed;

    for (const clause of splitClauses(content)) {
      const priority = clausePriority(clause, section.priority);
      const mentions = findSkillMentions(clause);
      for (const { name, category } of mentions) {
        const term = skills.get(name) ?? { skill: name, category, frequency: 0, contexts: [] };
        skills.set(name, term);
        term.frequency++;
        const context = term.contexts.find(item => item.section === section.section && item.priority === priority);
        if (context) context.frequency++;
        else term.contexts.push({ section: section.section, priority, frequency: 1 });
      }

      const durations = [...clause.matchAll(yearsPattern)];
      for (const [index, duration] of durations.entries()) {
        const minYears = Number(duration[1]);
        if (!Number.isFinite(minYears)) continue;
        const end = durations[index + 1]?.index ?? Infinity;
        const following = mentions.filter(mention => mention.index >= duration.index && mention.index < end);
        const preceding = !index && durations.length === 1 && !following.length
          && /(?:[:(]|\bexperience)\s*$/i.test(clause.slice(0, duration.index))
          ? mentions : [];
        const related = [...new Set([...following, ...preceding].map(mention => mention.name))];
        if (priority === 'unspecified' && !related.length && !/\bexperience\b/i.test(clause)) continue;
        experience.push({ minYears, skills: related, section: section.section, priority });
      }
    }
  }

  return { taxonomyVersion: SKILL_TAXONOMY_VERSION, skills: [...skills.values()], experience };
}
