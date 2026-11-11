import axiosClient from '../../../utils/axiosClient';

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
  strongTopics: Array<{ topic: string; solved: number; mastery: number }>;
  weakTopics: Array<{ topic: string; solved: number; mastery: number }>;
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

