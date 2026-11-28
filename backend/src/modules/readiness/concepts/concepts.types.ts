import type { ConceptConfidence, ConceptDomain } from '../../../db/models/userConceptProgress.model.js';

export type ConceptLevel = 'beginner' | 'intermediate' | 'advanced' | 'case-study';
export type CsSubTrack = 'os' | 'dbms' | 'networks' | 'distributed-systems';

export interface ConceptQA {
  id: string;
  question: string;
  answer: string;
}

export interface TradeOffComparison {
  topic: string;
  whenToUse: string;
  whenToAvoid: string;
  alternative?: string;
}

export interface ScaleBenchmark {
  label: string;
  value: string;
  note?: string;
}

export interface ConceptDefinition {
  id: string;
  domain: ConceptDomain;
  title: string;
  subtitle: string;
  level: ConceptLevel;
  track: 'system-design' | 'core-cs' | 'distributed-systems';
  subTrack?: CsSubTrack;
  isOptional: boolean;
  isHighFrequencyCrashCourse: boolean;
  estimatedMinutes: number;
  summary: string;
  architectureFlow: string[];
  tradeOffs: TradeOffComparison[];
  scaleBenchmarks: ScaleBenchmark[];
  rapidQA: ConceptQA[];
  practicePrompt: string;
}

export interface ConceptWithProgress extends ConceptDefinition {
  completed: boolean;
  confidence: ConceptConfidence | null;
  updatedAt: string | null;
}

export interface ConceptWorkspaceSummary {
  totalConcepts: number;
  completedConcepts: number;
  progressPercent: number;
  coreTotal: number;
  coreCompleted: number;
  coreProgressPercent: number;
  optionalTotal: number;
  optionalCompleted: number;
  optionalProgressPercent: number;
  gotItCount: number;
  reviseAgainCount: number;
  lastUpdatedAt: string | null;
}

export interface ConceptWorkspaceResponse {
  domain: ConceptDomain;
  summary: ConceptWorkspaceSummary;
  concepts: ConceptWithProgress[];
}
