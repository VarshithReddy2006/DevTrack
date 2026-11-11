import { Job, Worker } from 'bullmq';
import { WorkerFactory } from '../infrastructure/queues/WorkerFactory.js';
import { getRedisClient } from '../shared/redis/index.js';
import { logger } from '../shared/logger.js';
import { QueueNames, type ResumeRecommendationJobData } from '../shared/jobs/types.js';
import { ResumeSession } from '../db/models/resumeSession.model.js';
import { AIProviderAdapter } from '../modules/ai/provider/AIProviderAdapter.js';
import { SemanticAnalysis } from '../db/models/semanticAnalysis.model.js';
import { Recommendation } from '../db/models/recommendation.model.js';
import { recommendationOutputZodSchema } from '../modules/resume/ai/recommendation.schema.js';
import { ReadinessCore } from '../db/models/readinessCore.model.js';
import { ReadinessDsa } from '../db/models/readinessDsa.model.js';

let worker: Worker | null = null;

export async function startResumeRecommendationWorker(): Promise<Worker> {
  if (worker) {
    logger.warn('[ResumeRecommendationWorker] Worker already running');
    return worker;
  }

  logger.info('[ResumeRecommendationWorker] Starting resume recommendation worker');

  worker = WorkerFactory.createWorker<ResumeRecommendationJobData>(
    QueueNames.RESUME_RECOMMENDATION,
    async (job: Job<ResumeRecommendationJobData>) => {
      const { sessionId } = job.data;

      logger.info(`[ResumeRecommendationWorker] Processing recommendation job: ${sessionId}`);

      try {
        const session = await ResumeSession.findOne({ sessionId });
        if (!session || !session.parsedContent?.text) {
          throw new Error('Session not found or text not parsed');
        }

        // 1. Fetch Aggregated Context
        const semanticAnalysis = await SemanticAnalysis.findOne({ sessionId });
        const userId = session.userId;
        let readinessData: any = {};
        let dsaData: any = {};

        if (userId) {
          try {
            const core = await ReadinessCore.findOne({ userId });
            const dsa = await ReadinessDsa.findOne({ userId });
            if (core) readinessData = core.toObject();
            if (dsa) dsaData = dsa.toObject();
          } catch (e) {
            logger.warn(`[ResumeRecommendationWorker] Could not fetch readiness data for ${userId}`, { error: e instanceof Error ? e.message : String(e) });
          }
        }

        // Prepare the Context Dump for the LLM
        const contextPayload = {
          resumeText: session.parsedContent.text,
          atsState: session.atsState || {},
          semanticAnalysis: semanticAnalysis ? semanticAnalysis.toObject() : {},
          readinessCore: readinessData,
          readinessDsa: dsaData
        };

        const systemPrompt = `You are an elite Staff Software Engineer and Technical Recruiter.
Your goal is to generate HIGHLY ACTIONABLE, PERSONALIZED, and INTELLIGENT recommendations for a candidate based on their resume and platform readiness metrics.

You must prioritize recommendations based on:
1. Hiring Impact (Does this get them past the recruiter?)
2. ATS Impact (Does it parse correctly?)
3. Role Alignment (Are they applying for Backend but lacking DB experience?)
4. Credibility (Do they claim 10 years experience but have weak project depth?)

You MUST output your analysis in strict JSON format matching exactly this schema:
{
  "recommendations": [
    {
      "title": "string",
      "explanation": "string",
      "severity": "high" | "medium" | "low",
      "priority": number (0-100),
      "actionableSteps": ["string"],
      "estimatedImpact": "string",
      "category": "Resume Improvements" | "Skill Gaps" | "Career Alignment" | "Interview Readiness"
    }
  ],
  "priorityScore": number (0-100)
}

Do NOT output markdown wrappers (e.g. \`\`\`json). Output pure JSON.
Do NOT generate vague advice (e.g. "Network more"). Focus strictly on the resume, skills, and technical gaps.`;

        const userPrompt = `Here is the candidate's complete profile context in JSON format.
Analyze the gaps between their claimed experience, their ATS parsing results, and their actual readiness data.

Profile Context:
${JSON.stringify(contextPayload, null, 2)}`;

        // 2. Generate Recommendations via Gemini
        const aiResponse = await AIProviderAdapter.generateResponse({
          prompt: userPrompt,
          tenantScope: session.userId?.toString() ?? `session:${sessionId}`,
          systemPrompt,
          model: 'gemini-1.5-flash',
          providerPreference: 'gemini',
          temperature: 0.2, // Low temperature for high logical consistency
          maxTokens: 4000
        });

        // Clean markdown block if hallucinated
        let cleanContent = aiResponse.content.trim();
        if (cleanContent.startsWith('```json')) cleanContent = cleanContent.slice(7);
        if (cleanContent.endsWith('```')) cleanContent = cleanContent.slice(0, -3);
        cleanContent = cleanContent.trim();

        let parsedJson;
        try {
          parsedJson = JSON.parse(cleanContent);
        } catch (e) {
          logger.error(`[ResumeRecommendationWorker] JSON Parse Error: ${cleanContent.substring(0, 500)}`);
          throw new Error('AI generated malformed JSON');
        }

        // 3. Strict Validation
        const validatedOutput = recommendationOutputZodSchema.parse(parsedJson);

        // 4. Sort recommendations by priority descending
        validatedOutput.recommendations.sort((a, b) => b.priority - a.priority);

        // 5. Persist to new Recommendation Collection
        await Recommendation.findOneAndUpdate(
          { sessionId },
          { 
            sessionId,
            recommendations: validatedOutput.recommendations,
            priorityScore: validatedOutput.priorityScore,
            generatedAt: new Date()
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // 6. Update ResumeSession State
        session.recommendationState = {
          generated: true,
          recommendations: validatedOutput.recommendations.map(r => r.title),
          credibilityScore: validatedOutput.priorityScore,
          warnings: validatedOutput.recommendations.filter(r => r.severity === 'high').map(r => r.title),
          generatedAt: new Date()
        };
        
        session.currentStage = 'REPLAY_GENERATING'; // Advance pipeline
        await session.save();

        logger.info(`[ResumeRecommendationWorker] Job completed for ${sessionId}. Generated ${validatedOutput.recommendations.length} recommendations. Priority Score: ${validatedOutput.priorityScore}`);
      } catch (error) {
        logger.error(`[ResumeRecommendationWorker] Job failed: ${sessionId}`, error);
        
        // Safe fallback error handling
        const session = await ResumeSession.findOne({ sessionId });
        if (session) {
          session.failureState = {
            failed: true,
            failureStage: 'RECOMMENDING',
            failureReason: error instanceof Error ? error.message : 'Unknown recommendation error',
            failedAt: new Date(),
            retryCount: (session.failureState?.retryCount || 0) + 1
          };
          session.currentStage = 'FAILED';
          await session.save();
        }

        throw error;
      }
    },
    { concurrency: 3 }
  );

  worker.on('completed', (job) => {
    logger.info(`[ResumeRecommendationWorker] Job completed: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[ResumeRecommendationWorker] Job failed: ${job?.id}`, err);
  });

  logger.info('[ResumeRecommendationWorker] Resume recommendation worker started');
  return worker;
}

export async function stopResumeRecommendationWorker(): Promise<void> {
  if (!worker) {
    logger.warn('[ResumeRecommendationWorker] Worker not running');
    return;
  }

  logger.info('[ResumeRecommendationWorker] Stopping resume recommendation worker');
  await worker.close();
  worker = null;
  logger.info('[ResumeRecommendationWorker] Resume recommendation worker stopped');
}

export function getResumeRecommendationWorkerStatus(): { running: boolean } {
  return { running: worker !== null };
}
