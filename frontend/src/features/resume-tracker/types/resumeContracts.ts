// resumeContracts.ts
// Strict typed contracts between frontend and backend for Resume Intelligence

export type ProcessingStage = 'uploading' | 'validating' | 'parsing' | 'extracting' | 'analyzing' | 'completed' | 'failed';

export interface ResumeSession {
  sessionId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  status: ProcessingStage;
  fileInfo: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  };
  stages: {
    upload: StageResult;
    ats: StageResult;
    intelligence: StageResult;
    credibility: StageResult;
    recommendations: StageResult;
  };
  canResume?: boolean;
  atsState?: {
    atsScore?: number;
    parserWarnings?: Array<string | { message: string }>;
    formattingWarnings?: string[];
    keywordCoverage?: string[];
    sectionIntegrity?: string[];
    extractionConfidence?: number;
    recommendations?: string[];
  };
  parsedContent?: {
    text?: string;
    parsingDiagnostics: {
      confidence: number;
      warnings: string[];
      errors: string[];
    };
    sections: Record<string, string>;
  };
  semanticState?: {
    semanticSimilarity?: number;
  };
  recommendationState?: {
    credibilityScore?: number;
    warnings?: string[];
  };
  reportData?: {
    executiveSummary: any;
    atsAnalysis: any;
    roleAlignment: any;
    credibilityAnalysis: any;
    infrastructureMaturity: any;
    recommendations: any[];
    recruiterProjection: any;
    riskAnalysis: any;
    operationalReadiness: any;
    confidenceReport: any;
    evolution?: any;
    finalVerdict: string;
  };
}

export interface StageResult {
  status: 'pending' | 'processing' | 'success' | 'partial' | 'failed';
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface AtsIntelligenceData {
  parsingConfidence: number; // 0-100
  survivabilityScore: number; // 0-100
  sectionsExtracted: string[];
  missingSections: string[];
  keywordsDetected: string[];
  formattingIssues: string[];
}

export interface EngineeringSignal {
  id: string;
  category: 'frontend' | 'backend' | 'infrastructure' | 'devops' | 'testing' | 'architecture';
  strength: 'weak' | 'moderate' | 'strong';
  title: string;
  description: string;
  evidence: string[]; // Quotes from resume
}

export interface CredibilityGap {
  id: string;
  severity: 'low' | 'medium' | 'high';
  type: 'unverifiable_claim' | 'vague_wording' | 'tutorial_pattern' | 'unsupported_infra';
  description: string;
  recommendation: string;
  context: string;
}

export interface ResumeRecommendation {
  id: string;
  impact: 'low' | 'medium' | 'high';
  category: 'ats' | 'clarity' | 'engineering_depth' | 'recruiter_readability';
  suggestion: string;
  beforeSnippet?: string;
  afterSnippet?: string;
}

export interface ResumeVersion {
  versionId: string;
  timestamp: string;
  atsScore: number;
  changes: string[];
}
