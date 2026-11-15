import type { SectionIntegrity } from './types.js';

const defaultSectionHeadings = {
  summary: /^(summary|professional summary|career summary|profile|professional profile|about|about me|objective|career objective)$/i,
  experience: /^(experience|professional experience|work experience|relevant experience|work history|employment|employment history|career history)$/i,
  projects: /^(projects|portfolio|personal projects|selected projects|key projects|open source contributions)$/i,
  skills: /^(skills|technologies|technical skills|technical stack|tech stack|core competencies|technologies & tools|technologies and tools|technical proficiencies)$/i,
  education: /^(education|academic|academic background|education & credentials|education and credentials)$/i,
  certifications: /^(certifications|certificates|professional certifications|licenses & certifications|licenses and certifications)$/i,
};

export function validateSections(content: string, sectionHeadings: Readonly<Record<string, RegExp>> = defaultSectionHeadings): SectionIntegrity[] {
  const headings = content.split(/\r\n?|\n/).map(line => line.trim())
    .filter(line => line.length > 0 && line.length < 50)
    .map(line => ({
      line,
      title: line.replace(/^#{1,6}\s+/, '').replace(/\s*:\s*$/, '').replace(/\s+/g, ' '),
    }));

  return Object.entries(sectionHeadings).map(([sectionName, pattern]) => {
    // Copy stateful custom expressions so repeat calls leave the caller's pattern untouched.
    const matcher = new RegExp(pattern);
    const heading = headings.find(candidate => {
      matcher.lastIndex = 0;
      return matcher.test(candidate.title);
    });
    if (!heading) {
      return { sectionName, detected: false, confidence: 0, issues: [`Section "${sectionName}" not found`] };
    }

    const hasHeadingFormatting = heading.line.startsWith('#') || heading.line.endsWith(':')
      || heading.title === heading.title.toUpperCase();
    return {
      sectionName,
      detected: true,
      confidence: hasHeadingFormatting ? 100 : 90,
      matchedHeading: heading.line,
      issues: [],
    };
  });
}
