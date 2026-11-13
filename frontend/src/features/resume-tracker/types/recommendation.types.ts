// src/features/resume-tracker/types/recommendation.types.ts

export type RecommendationCategory = 'ats' | 'semantic' | 'credibility' | 'infrastructure' | 'role_alignment';
export type RecommendationState = 'active' | 'accepted' | 'ignored' | 'completed' | 'decayed' | 'retired';

export interface IIntelligenceRecommendation {
  id: string;
  userId: string;
  resumeProfileId: string;
  
  category: RecommendationCategory;
  title: string;
  content: string;
  
  confidence: number;
  impact: {
    scoreImprovement: number;
    type: 'ats' | 'semantic' | 'credibility';
  };
  
  evidenceReferences: string[];
  dependencies: string[] | IIntelligenceRecommendation[];
  
  state: RecommendationState;
  
  createdAt: string;
  updatedAt: string;
}
