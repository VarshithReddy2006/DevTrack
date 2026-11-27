import axiosClient from '../../../utils/axiosClient';

export type TopicTier = 'Novice' | 'Proficient' | 'Advanced' | 'Mastery';

export interface TopicDifficultyBreakdown {
  easy: number;
  medium: number;
  hard: number;
}

export interface DsaTopicAnalysisItem {
  topic: string;
  solved: number;
  mastery: number;
  tier?: TopicTier;
  difficulty?: TopicDifficultyBreakdown;
}

export interface DsaIntelligenceResponse {
  readinessScore: number;
  consistencyScore: number;
  hardProgressScore: number;
  readinessImpact: number;
  difficultyDistribution: {
    easy: number;
    medium: number;
    hard: number;
    total: number;
  };
  strongTopics: DsaTopicAnalysisItem[];
  weakTopics: DsaTopicAnalysisItem[];
  nextTopics: string[];
  confidenceScore: number;
  verificationCoverage: number;
  status: string;
  lastUpdated: string;
}

export const fetchDsaIntelligence = async (): Promise<DsaIntelligenceResponse> => {
  const response = await axiosClient.get<{ success: boolean; data: DsaIntelligenceResponse }>('/readiness/dsa');
  return response.data.data;
};

export const syncDsaIntelligence = async (): Promise<DsaIntelligenceResponse> => {
  const response = await axiosClient.post<{ success: boolean; data: DsaIntelligenceResponse }>('/readiness/dsa/sync');
  return response.data.data;
};

