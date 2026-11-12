import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SemanticIntelligenceLayer } from '../../../modules/resume/ai/SemanticIntelligenceLayer.js';
import { AIProviderAdapter } from '../../../modules/ai/provider/AIProviderAdapter.js';

describe('Issue #133: Semantic Intelligence Layer & Failover Diagnostics', () => {
  const semanticLayer = new SemanticIntelligenceLayer();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('analyzeResume', () => {
    it('returns validated structured analysis and provenance when AI provider succeeds', async () => {
      const mockResponse = {
        content: JSON.stringify({
          extractedSkills: {
            languages: ['TypeScript', 'Python'],
            frameworks: ['React', 'Express'],
            databases: ['MongoDB', 'PostgreSQL'],
            cloudTools: ['AWS'],
            devOpsTools: ['Docker'],
            aiMlTools: [],
          },
          experienceSignals: {
            yearsOfExperience: 3,
            engineeringDepth: 7,
            projectComplexity: 8,
            leadershipIndicators: 5,
            productionExposure: 6,
          },
          roleAlignment: {
            backend: 85,
            frontend: 70,
            fullstack: 80,
            ml: 20,
            devops: 65,
          },
          weaknesses: ['Add quantifiable business metrics'],
          strengths: ['Strong fullstack engineering experience'],
          semanticSummary: 'Experienced software engineer specializing in web systems.',
          confidenceScore: 88,
        }),
        provider: 'openai' as const,
        model: 'gpt-4o-mini',
        tokensUsed: 450,
        latency: 120,
        cached: false,
        fallbackTriggered: false,
      };

      vi.spyOn(AIProviderAdapter, 'generateResponse').mockResolvedValueOnce(mockResponse);

      const result = await semanticLayer.analyzeResume('Resume text for candidate', 'tenant-123');

      expect(result.degradedReason).toBeUndefined();
      expect(result.analysis).toBeDefined();
      expect(result.analysis?.confidenceScore).toBe(88);
      expect(result.analysis?.extractedSkills.languages).toEqual(['TypeScript', 'Python']);
      expect(result.provenance).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    });

    it('returns explicit degradedReason when provider response fails Zod schema validation', async () => {
      // Malformed schema (e.g., confidenceScore > 100 or missing required fields)
      const invalidResponse = {
        content: JSON.stringify({
          extractedSkills: { languages: ['TypeScript'] },
          confidenceScore: 999, // Exceeds max 100
        }),
        provider: 'openai' as const,
        model: 'gpt-4o-mini',
        tokensUsed: 100,
        latency: 80,
        cached: false,
        fallbackTriggered: false,
      };

      vi.spyOn(AIProviderAdapter, 'generateResponse').mockResolvedValueOnce(invalidResponse);

      const result = await semanticLayer.analyzeResume('Resume text', 'tenant-123');

      expect(result.analysis).toBeUndefined();
      expect(result.degradedReason).toBe('Semantic provider returned invalid structured analysis');
    });

    it('returns explicit degradedReason when provider throws an error', async () => {
      vi.spyOn(AIProviderAdapter, 'generateResponse').mockRejectedValueOnce(new Error('Rate limit exceeded'));

      const result = await semanticLayer.analyzeResume('Resume text', 'tenant-123');

      expect(result.analysis).toBeUndefined();
      expect(result.degradedReason).toBe('Semantic analysis providers unavailable');
    });
  });

  describe('extractResumeSkills', () => {
    it('returns extracted skills and provenance on valid structured AI output', async () => {
      vi.spyOn(AIProviderAdapter, 'generateResponse').mockResolvedValueOnce({
        content: JSON.stringify({ skills: ['Node.js', 'Redis', 'Docker'] }),
        provider: 'gemini' as const,
        model: 'gemini-1.5-flash',
        tokensUsed: 150,
        latency: 90,
        cached: false,
        fallbackTriggered: false,
      });

      const result = await semanticLayer.extractResumeSkills('Candidate with Node.js and Redis');

      expect(result.skills).toEqual(['Node.js', 'Redis', 'Docker']);
      expect(result.provenance).toEqual({ provider: 'gemini', model: 'gemini-1.5-flash' });
      expect(result.degradedReason).toBeUndefined();
    });

    it('falls back to regex text parsing and flags degradedReason when provider fails', async () => {
      vi.spyOn(AIProviderAdapter, 'generateResponse').mockRejectedValueOnce(new Error('AI unavailable'));

      const resumeText = 'Education: BS CS\nTechnical Skills: TypeScript, Go, Kubernetes\nExperience: Software Engineer';
      const result = await semanticLayer.extractResumeSkills(resumeText);

      expect(result.skills).toContain('TypeScript');
      expect(result.skills).toContain('Go');
      expect(result.skills).toContain('Kubernetes');
      expect(result.provenance).toEqual({ provider: 'resume-text' });
      expect(result.degradedReason).toBe('Skill extraction providers unavailable');
    });
  });
});
