import { logger } from '../../shared/logger.js';
import { AIResponseAuditLog } from './audit/AIResponseAuditLog.js';

export const AIProviderAdapter = {
  /**
   * Abstraction layer for AI. Handles failover and auditing.
   */
  async generateResponse(userId: string, systemPrompt: string, userPrompt: string): Promise<string> {
    const start = Date.now();
    let provider = 'gemini';
    let response = '';
    let flags: string[] = [];

    try {
      // Mocking actual LLM call to ensure sub-2s response in degraded states
      // In reality, this would use google.generativeai or openai SDKs
      
      // Simulating a response for demonstration
      if (systemPrompt.includes('Extract a comprehensive list of all technical skills')) {
        const mockSkills = ['JavaScript', 'TypeScript', 'Node.js', 'React', 'MongoDB'];
        if (userPrompt.toLowerCase().includes('python')) mockSkills.push('Python');
        if (userPrompt.toLowerCase().includes('docker')) mockSkills.push('Docker');
        if (userPrompt.toLowerCase().includes('aws')) mockSkills.push('AWS');
        response = JSON.stringify(mockSkills);
      } else if (userPrompt.toLowerCase().includes('kubernetes')) {
        response = "You currently lack containerization and deployment maturity. Build confidence in Docker and queue systems before distributed orchestration.";
      } else {
        response = "Your backend projects already show strong API construction. Focus on infrastructure sophistication like Redis and BullMQ.";
      }

    } catch (error) {
      provider = 'fallback';
      response = "AI guidance is currently degraded. Please rely on the deterministic readiness dashboards.";
      flags.push('provider_failure');
      logger.error('[AIProviderAdapter] Provider failed', { error });
    }

    const latencyMs = Date.now() - start;

    void AIResponseAuditLog.log({
      userId,
      requestType: 'legacy-generation',
      provider,
      model: 'legacy-mock',
      latency: latencyMs,
      tokensUsed: 150, // mock
      cached: false,
      contextVersion: '',
      responseConfidence: 0,
      moderationFlags: flags,
      hallucinationFlags: [],
      safetyViolations: [],
      success: provider !== 'fallback',
    });

    return response;
  }
};
