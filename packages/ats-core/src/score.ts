import type { FormattingWarning, KeywordCoverage, ParserWarning, SectionIntegrity } from './types.js';

export interface AtsSubscores {
  parserWarnings: readonly ParserWarning[];
  formattingWarnings: readonly FormattingWarning[];
  keywordCoverage: readonly KeywordCoverage[];
  sectionIntegrity: readonly SectionIntegrity[];
  extractionConfidence: number;
  targetRole?: string;
  credibilityPenalty?: number;
}

export function calculateExtractionConfidence(
  parserWarnings: ParserWarning[],
  formattingWarnings: FormattingWarning[],
  sectionIntegrity: SectionIntegrity[]
): number {
  let confidence = 100;

  // Deduct for parser warnings
  parserWarnings.forEach(warning => {
    if (warning.severity === 'critical') confidence -= 20;
    else if (warning.severity === 'warning') confidence -= 10;
    else confidence -= 5;
  });

  // Deduct for formatting warnings
  formattingWarnings.forEach(warning => {
    if (warning.impact === 'high') confidence -= 15;
    else if (warning.impact === 'medium') confidence -= 8;
    else confidence -= 3;
  });

  // Deduct for missing sections
  const missingSections = sectionIntegrity.filter(s => !s.detected).length;
  confidence -= missingSections * 5;

  return Math.max(0, Math.min(100, confidence));
}

export function calculateAtsScore({
  parserWarnings, formattingWarnings, keywordCoverage, sectionIntegrity, extractionConfidence,
  targetRole = 'Full Stack Developer', credibilityPenalty = 0,
}: AtsSubscores): number {
  let score = 100;

  const isSystemRole = /backend|devops|platform|infrastructure|systems|sre/i.test(targetRole);

  // Parser warnings impact
  const criticalWarnings = parserWarnings.filter(w => w.severity === 'critical').length;
  score -= criticalWarnings * (isSystemRole ? 20 : 15);

  const warningLevel = parserWarnings.filter(w => w.severity === 'warning').length;
  score -= warningLevel * (isSystemRole ? 10 : 8);

  // Formatting warnings impact
  const highImpactFormatting = formattingWarnings.filter(w => w.impact === 'high').length;
  score -= highImpactFormatting * (isSystemRole ? 12 : 10);

  const mediumImpactFormatting = formattingWarnings.filter(w => w.impact === 'medium').length;
  score -= mediumImpactFormatting * (isSystemRole ? 6 : 5);

  // Keyword coverage impact
  if (keywordCoverage.length > 0) {
    const foundKeywords = keywordCoverage.filter(k => k.found).length;
    const keywordScore = (foundKeywords / keywordCoverage.length) * 20;
    score += keywordScore - 20; // Adjust baseline
    // Additional penalty for highly keyword-weak resumes in system roles
    if (isSystemRole && foundKeywords / keywordCoverage.length < 0.4) {
      score -= 10;
    }
  }

  // Section integrity impact
  if (sectionIntegrity.length > 0) {
    const detectedSections = sectionIntegrity.filter(s => s.detected).length;
    const sectionScore = (detectedSections / sectionIntegrity.length) * 20;
    score += sectionScore - 20; // Adjust baseline
  }

  // Additional critical section penalties for system roles
  if (isSystemRole) {
    const missingEssential = sectionIntegrity.filter(s => !s.detected && ['experience', 'skills', 'projects'].includes(s.sectionName)).length;
    score -= missingEssential * 15;
  }

  // Extraction confidence impact
  score = (score + extractionConfidence) / 2;

  // Apply credibility validation penalty (direct integration of recruiter validation)
  score -= credibilityPenalty;

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function generateRecommendations(
  parserWarnings: ParserWarning[],
  formattingWarnings: FormattingWarning[],
  keywordCoverage: KeywordCoverage[],
  sectionIntegrity: SectionIntegrity[]
): string[] {
  const recommendations: string[] = [];

  // Parser warning recommendations
  if (parserWarnings.some(w => w.severity === 'critical')) {
    recommendations.push('Address critical parser warnings immediately');
  }

  // Formatting recommendations
  if (formattingWarnings.some(w => w.impact === 'high')) {
    recommendations.push('Simplify formatting for better ATS compatibility');
  }

  // Keyword recommendations
  const missingKeywords = keywordCoverage.filter(k => !k.found);
  if (missingKeywords.length > 0) {
    recommendations.push(`Add missing keywords: ${missingKeywords.map(k => k.keyword).join(', ')}`);
  }

  // Section recommendations
  const missingSections = sectionIntegrity.filter(s => !s.detected);
  if (missingSections.length > 0) {
    recommendations.push(`Add missing sections: ${missingSections.map(s => s.sectionName).join(', ')}`);
  }

  return recommendations;
}
