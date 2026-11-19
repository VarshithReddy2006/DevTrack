import { calculateAtsScore, calculateExtractionConfidence } from './score.js';
import { validateFormatting, validateParserSafety } from './formatting.js';
import { checkKeywordCoverage } from './keywords.js';
import { validateSections } from './sections.js';

export interface BulletEdit {
  section: string;
  bulletIndex: number;
  originalText: string;
  editedText: string;
}

export interface BulletScoringContext {
  targetRole?: string;
  keywords?: readonly string[];
}

export function renderBulletEdits(edits: readonly BulletEdit[]): string {
  const sections = new Map<string, BulletEdit[]>();
  for (const edit of edits) {
    const key = edit.section.toLowerCase();
    sections.set(key, [...(sections.get(key) ?? []), edit]);
  }
  return [...sections.values()]
    .map(group => [group[0].section, ...[...group].sort((a, b) => a.bulletIndex - b.bulletIndex).map(edit => `- ${edit.editedText}`)].join('\n'))
    .join('\n\n');
}

/** The browser preview and persisted server score use the same text and signals. */
export function evaluateBulletEdits(edits: readonly BulletEdit[], context: BulletScoringContext = {}) {
  const content = renderBulletEdits(edits);
  const parserWarnings = validateParserSafety(content);
  const formattingWarnings = validateFormatting(content);
  const keywordCoverage = checkKeywordCoverage(content, [...(context.keywords ?? [])]);
  const sectionIntegrity = validateSections(content);
  const extractionConfidence = calculateExtractionConfidence(parserWarnings, formattingWarnings, sectionIntegrity);
  return {
    score: calculateAtsScore({ parserWarnings, formattingWarnings, keywordCoverage, sectionIntegrity, extractionConfidence, targetRole: context.targetRole }),
    extractionConfidence,
    parserWarningCount: parserWarnings.length,
    formattingWarningCount: formattingWarnings.length,
    keywordsMatched: keywordCoverage.filter(keyword => keyword.found).length,
    keywordsTotal: keywordCoverage.length,
  };
}
