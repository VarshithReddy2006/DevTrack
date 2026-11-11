import type { Types } from 'mongoose';
import { DSACredibilityEngine } from './DSACredibilityEngine.js';
import { ProjectCredibilityEngine } from './ProjectCredibilityEngine.js';
import { ResumeCredibility } from '../../../db/models/resumeCredibility.model.js';
import { AIProviderAdapter } from '../../ai/provider/AIProviderAdapter.js';
import { CredibilityOutput, credibilityOutputSchema, CredibilitySignal } from './credibility.schema.js';
import { SemanticAnalysis } from '../../../db/models/semanticAnalysis.model.js';
import { logger } from '../../../shared/logger.js';

export class EngineeringSignalAggregator {
  private dsaEngine: DSACredibilityEngine;
  private projectEngine: ProjectCredibilityEngine;

  constructor() {
    this.dsaEngine = new DSACredibilityEngine();
    this.projectEngine = new ProjectCredibilityEngine();
  }

  async aggregateAndVerify(userId: Types.ObjectId | undefined, sessionId?: string): Promise<CredibilityOutput> {
    logger.info(`[EngineeringSignalAggregator] Starting verification for user ${userId} / session ${sessionId}`);

    // 1. Deterministic Platform Data Verification
    const dsaResult = await this.dsaEngine.evaluate(userId);
    const projectResult = await this.projectEngine.evaluate(userId);

    // 2. Fetch Semantic Resume Claims
    let semanticAnalysis = null;
    if (sessionId) {
      semanticAnalysis = await SemanticAnalysis.findOne({ sessionId }).lean();
    } else if (userId) {
      // Fetch the latest semantic analysis for the user
      // Note: semanticAnalysis might not have userId directly if it only has sessionId,
      // but we will try to find it via ResumeSession
      const latestSession = await import('../../../db/models/resumeSession.model.js').then(m => m.ResumeSession.findOne({ userId }).sort({ createdAt: -1 }));
      if (latestSession) {
        semanticAnalysis = await SemanticAnalysis.findOne({ sessionId: latestSession.sessionId }).lean();
      }
    }
    
    // 3. Synthesis using Gemini 1.5 Flash (ONLY for textual reasoning, NOT numeric math)
    const systemPrompt = `You are an elite DevTrack Credibility Auditor.
Your job is to compare the deterministic platform signals (LeetCode/GitHub) against the candidate's parsed resume claims.
DO NOT recalculate the DSA or Project scores. Use the exact scores provided.
Calculate a 'consistencyScore' (0-100) based on how well the resume claims match the platform evidence.
Identify any 'verifiedClaims' (claims strongly backed by evidence).
Identify any 'suspiciousClaims' (inflated claims lacking evidence).
Generate a professional, non-accusatory 'summary'.

You MUST return STRICT JSON exactly matching:
{
  "consistencyScore": number,
  "verifiedClaims": ["string"],
  "suspiciousClaims": ["string"],
  "summary": "string"
}`;

    const userPrompt = `
Deterministic Platform Scores (DO NOT MODIFY THESE):
- DSA Credibility: ${dsaResult.score}
- Project Credibility: ${projectResult.score}

Platform Signals Found:
${JSON.stringify([...dsaResult.signals, ...projectResult.signals], null, 2)}

Resume Claims (Semantic Analysis):
${JSON.stringify(semanticAnalysis?.experienceSignals || {}, null, 2)}
Skills: ${JSON.stringify(semanticAnalysis?.extractedSkills || {}, null, 2)}
`;

    let consistencyScore = 50;
    let verifiedClaims: string[] = [];
    let suspiciousClaims: string[] = [];
    let summary = "Credibility evaluation completed.";

    try {
      const aiResponse = await AIProviderAdapter.generateResponse({
        prompt: userPrompt,
        tenantScope: userId?.toString() ?? (sessionId ? `session:${sessionId}` : undefined),
        cache: Boolean(userId || sessionId),
        systemPrompt,
        model: 'gemini-1.5-flash',
        providerPreference: 'gemini',
        temperature: 0.1,
        maxTokens: 2000
      });

      let cleanContent = aiResponse.content.trim();
      if (cleanContent.startsWith('```json')) cleanContent = cleanContent.slice(7);
      if (cleanContent.endsWith('```')) cleanContent = cleanContent.slice(0, -3);
      
      const parsed = JSON.parse(cleanContent.trim());
      consistencyScore = parsed.consistencyScore || 50;
      verifiedClaims = parsed.verifiedClaims || [];
      suspiciousClaims = parsed.suspiciousClaims || [];
      summary = parsed.summary || summary;
    } catch (e) {
      logger.error(`[EngineeringSignalAggregator] AI Synthesis failed, falling back to safe defaults`, e);
      // We gracefully fallback because factual deterministic scores are already computed!
    }

    // 4. Calculate final overall credibility deterministically
    // Formula: 40% Project + 40% DSA + 20% Consistency
    const overallCredibility = Math.floor(
      (projectResult.score * 0.4) + 
      (dsaResult.score * 0.4) + 
      (consistencyScore * 0.2)
    );

    const allSignals: CredibilitySignal[] = [...dsaResult.signals, ...projectResult.signals];
    if (suspiciousClaims.length > 0) {
      allSignals.push({
        type: 'suspicious',
        title: 'Mismatched Claims Detected',
        description: 'Some resume claims lack supporting platform evidence.',
        evidence: `Found ${suspiciousClaims.length} unsupported claims.`,
        impact: -10
      });
    }

    const output: CredibilityOutput = {
      overallCredibility,
      dsaCredibility: dsaResult.score,
      projectCredibility: projectResult.score,
      consistencyScore,
      verifiedClaims,
      suspiciousClaims,
      signals: allSignals,
      summary
    };

    // 5. Persist to MongoDB (only if sessionId exists)
    if (sessionId) {
      await ResumeCredibility.findOneAndUpdate(
        { sessionId },
        { ...output, sessionId, verifiedAt: new Date() },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    return output;
  }
}
