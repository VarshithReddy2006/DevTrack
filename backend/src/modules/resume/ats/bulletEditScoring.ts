import {
  calculateAtsScore, calculateExtractionConfidence, checkKeywordCoverage,
  validateFormatting, validateParserSafety, validateSections,
} from '@devtrack/ats-core';
import type { AtsScoreDto, BulletEditDTO } from '../dto/index.js';

export interface BulletScoringContext {
  targetRole?: string;
  keywords?: readonly string[];
}

/**
 * Lays the edited bullets out as plain resume text: one heading per section (in the order
 * sections first appear) followed by "- bullet" lines ordered by bulletIndex.
 */
export function renderBulletEdits(edits: readonly BulletEditDTO[]): string {
  const sections = new Map<string, BulletEditDTO[]>();
  for (const edit of edits) {
    const key = edit.section.toLowerCase();
    sections.set(key, [...(sections.get(key) ?? []), edit]);
  }
  return [...sections.values()]
    .map(group => [group[0].section, ...[...group].sort((a, b) => a.bulletIndex - b.bulletIndex).map(edit => `- ${edit.editedText}`)].join('\n'))
    .join('\n\n');
}

/**
 * Scores edited bullets with the shared ATS core. This is the only score the server stores;
 * a score sent by the browser never reaches this function.
 */
export function scoreBulletEdits(edits: readonly BulletEditDTO[], context: BulletScoringContext = {}): AtsScoreDto {
  const content = renderBulletEdits(edits);
  const parserWarnings = validateParserSafety(content);
  const formattingWarnings = validateFormatting(content);
  const keywordCoverage = checkKeywordCoverage(content, [...(context.keywords ?? [])]);
  const sectionIntegrity = validateSections(content);
  const extractionConfidence = calculateExtractionConfidence(parserWarnings, formattingWarnings, sectionIntegrity);

  return {
    score: calculateAtsScore({
      parserWarnings, formattingWarnings, keywordCoverage, sectionIntegrity, extractionConfidence,
      targetRole: context.targetRole,
    }),
    extractionConfidence,
    parserWarningCount: parserWarnings.length,
    formattingWarningCount: formattingWarnings.length,
    keywordsMatched: keywordCoverage.filter(keyword => keyword.found).length,
    keywordsTotal: keywordCoverage.length,
    scoredAt: new Date(),
  };
}
