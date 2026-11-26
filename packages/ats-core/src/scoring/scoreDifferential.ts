import { validateFormatting, validateParserSafety } from '../formatting.js';
import { checkKeywordCoverage, sanitizeKeywords } from '../keywords.js';
import { calculateAtsScore, calculateExtractionConfidence } from '../score.js';

export interface ScoreDifferentialInput {
  originalBullets: readonly string[];
  revisedBullets: readonly string[];
  targetKeywords: readonly string[];
}

export interface ScoreDifferentialResult {
  originalScore: number;
  revisedScore: number;
  delta: number;
  keywordChanges: { added: string[]; removed: string[] };
  brevityScore: number;
  originalBrevityScore: number;
}

function analyze(bullets: readonly string[], keywords: readonly string[]) {
  const nonempty = bullets.map(bullet => bullet.trim()).filter(Boolean);
  const content = nonempty.join('\n');
  const coverage = checkKeywordCoverage(content, keywords, { includeContext: false });
  const brevityScore = nonempty.length === 0 ? 0 : Math.round(nonempty.reduce((sum, bullet) => {
    const words = bullet.split(/\s+/).length;
    const lengthPenalty = Math.min(70, Math.max(0, 8 - words) * 10 + Math.max(0, words - 35) * 2);
    const fluff = bullet.match(/\b(?:responsible for|worked on|helped to|in order to|very|really|various|numerous|successfully)\b/gi) ?? [];
    return sum + Math.max(0, 100 - lengthPenalty - Math.min(30, fluff.length * 10));
  }, 0) / nonempty.length);

  if (nonempty.length === 0) return { score: 0, coverage, brevityScore };
  const parserWarnings = validateParserSafety(content);
  const formattingWarnings = validateFormatting(content);
  const stuffingPenalty = Math.min(30, coverage.reduce((sum, keyword) => sum + Math.max(0, keyword.frequency - 3) * 5, 0));
  const score = calculateAtsScore({
    parserWarnings, formattingWarnings, keywordCoverage: coverage,
    // A bullet-only preview cannot infer missing resume sections or a target role.
    sectionIntegrity: [],
    extractionConfidence: calculateExtractionConfidence(parserWarnings, formattingWarnings, []),
    credibilityPenalty: (100 - brevityScore) * 0.2 + stuffingPenalty,
  });
  return { score, coverage, brevityScore };
}

/** Pure bullet preview: no persistence, clocks, I/O, or mutation of caller input. */
export function scoreDifferential(input: ScoreDifferentialInput): ScoreDifferentialResult {
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const label of sanitizeKeywords(input.targetKeywords)) {
    const key = label.toLowerCase();
    if (!seen.has(key)) { keywords.push(label); seen.add(key); }
  }
  const original = analyze(input.originalBullets, keywords);
  const revised = analyze(input.revisedBullets, keywords);
  return {
    originalScore: original.score,
    revisedScore: revised.score,
    delta: revised.score - original.score,
    keywordChanges: {
      added: keywords.filter((_, index) => !original.coverage[index].found && revised.coverage[index].found),
      removed: keywords.filter((_, index) => original.coverage[index].found && !revised.coverage[index].found),
    },
    brevityScore: revised.brevityScore,
    originalBrevityScore: original.brevityScore,
  };
}
