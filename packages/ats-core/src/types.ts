export interface ParserWarning {
  severity: 'critical' | 'warning' | 'info';
  message: string;
  section: string;
  suggestion: string;
}

export interface FormattingWarning {
  type: string;
  message: string;
  location: string;
  impact: 'high' | 'medium' | 'low';
}

export interface KeywordCoverage {
  keyword: string;
  found: boolean;
  frequency: number;
  context: string[];
}

export interface SectionIntegrity {
  sectionName: string;
  detected: boolean;
  confidence: number;
  matchedHeading?: string;
  issues: string[];
}
