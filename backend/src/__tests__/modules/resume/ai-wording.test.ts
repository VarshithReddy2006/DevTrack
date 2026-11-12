// src/__tests__/modules/resume/ai-wording.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResumeWordingService } from '../../../modules/resume/ai/ResumeWordingService.js';
import { AIProviderAdapter } from '../../../modules/ai/AIProviderAdapter.js';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { Project } from '../../../db/models/project.model.js';
import { ATSAnalysis } from '../../../db/models/atsAnalysis.model.js';
import { Types } from 'mongoose';

vi.mock('../../../modules/ai/AIProviderAdapter.js', () => ({
  AIProviderAdapter: { generateResponse: vi.fn() },
}));
vi.mock('../../../db/models/resumeProfile.model.js', () => ({
  ResumeProfile: { findOne: vi.fn() },
}));
vi.mock('../../../db/models/project.model.js', () => ({
  Project: { find: vi.fn() },
}));
vi.mock('../../../db/models/atsAnalysis.model.js', () => ({
  ATSAnalysis: { findOne: vi.fn() },
}));
vi.mock('../../../shared/logger.js');

describe('ResumeWordingService', () => {
  let service: ResumeWordingService;
  const userId = new Types.ObjectId();

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ResumeWordingService();
    
    // Default mocks for Mongoose queries
    (ATSAnalysis.findOne as any).mockReturnValue({
      sort: vi.fn().mockResolvedValue(null)
    });
  });

  it('should optimize wording using bounded AI context', async () => {
    (ResumeProfile.findOne as any).mockResolvedValue({
      targetRole: 'Backend Engineer',
      selectedSkills: ['Node.js', 'Docker'],
      infraSignals: { dockerUsage: true, cicdPipeline: true, cloudDeployment: true },
      selectedProjects: []
    });
    (Project.find as any).mockResolvedValue([]);
    (AIProviderAdapter.generateResponse as any).mockResolvedValue('Optimized Version 1');

    const result = await service.optimizeWording(userId, 'summary', 'I build backends.');

    expect(AIProviderAdapter.generateResponse).toHaveBeenCalled();
    expect(result).toBe('Optimized Version 1');
    
    const calls = (AIProviderAdapter.generateResponse as any).mock.calls;
    const systemPrompt = calls[0][1];
    expect(systemPrompt).toContain('DO NOT hallucinate');
  });

  it('should fallback to original text if AI provider fails', async () => {
    (AIProviderAdapter.generateResponse as any).mockRejectedValue(new Error('AI Failed'));
    
    (ResumeProfile.findOne as any).mockResolvedValue({
      selectedSkills: [],
      infraSignals: {},
      selectedProjects: []
    });
    (Project.find as any).mockResolvedValue([]);

    const originalText = 'Original weak claim.';
    const result = await service.optimizeWording(userId, 'experience', originalText);

    expect(result).toBe(originalText);
  });
});
