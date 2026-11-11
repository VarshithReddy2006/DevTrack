import { Job, Worker } from 'bullmq';
import { WorkerFactory } from '../infrastructure/queues/WorkerFactory.js';
import { getRedisClient } from '../shared/redis/index.js';
import { logger } from '../shared/logger.js';
import { QueueNames, type ResumeSemanticJobData } from '../shared/jobs/types.js';
import { ResumeSession } from '../db/models/resumeSession.model.js';
import { AIProviderAdapter } from '../modules/ai/provider/AIProviderAdapter.js';
import { SemanticAnalysis } from '../db/models/semanticAnalysis.model.js';
import { semanticAnalysisZodSchema } from '../modules/resume/ai/semanticAnalysis.schema.js';

let worker: Worker | null = null;

export async function startResumeSemanticWorker(): Promise<Worker> {
  if (worker) {
    logger.warn('[ResumeSemanticWorker] Worker already running');
    return worker;
  }

  logger.info('[ResumeSemanticWorker] Starting resume semantic worker');

  worker = WorkerFactory.createWorker<ResumeSemanticJobData>(
    QueueNames.RESUME_SEMANTIC,
    async (job: Job<ResumeSemanticJobData>) => {
      const { sessionId } = job.data;

      logger.info(`[ResumeSemanticWorker] Processing semantic job: ${sessionId}`);

      try {
        const session = await ResumeSession.findOne({ sessionId });
        if (!session || !session.parsedContent?.text) {
          throw new Error('Session not found or text not parsed yet');
        }

        const text = session.parsedContent.text;

        const systemPrompt = `You are an expert technical recruiter and senior engineering manager analyzing a software engineering resume.
You MUST output your analysis in strict JSON format that matches EXACTLY the required schema.
Do NOT wrap the JSON in markdown code blocks (e.g., \`\`\`json). Just output raw JSON.

Schema requirements:
{
  "extractedSkills": {
    "languages": ["string"],
    "frameworks": ["string"],
    "databases": ["string"],
    "cloudTools": ["string"],
    "devOpsTools": ["string"],
    "aiMlTools": ["string"]
  },
  "experienceSignals": {
    "yearsOfExperience": number,
    "engineeringDepth": number (0-10),
    "projectComplexity": number (0-10),
    "leadershipIndicators": number (0-10),
    "productionExposure": number (0-10)
  },
  "roleAlignment": {
    "backend": number (0-100),
    "frontend": number (0-100),
    "fullstack": number (0-100),
    "ml": number (0-100),
    "devops": number (0-100)
  },
  "weaknesses": ["string" (vague wording, missing metrics, weak impact, etc)],
  "strengths": ["string"],
  "semanticSummary": "string",
  "confidenceScore": number (0-100)
}`;

        const userPrompt = `Please analyze the following resume and extract the required structured intelligence.

Resume Text:
${text}`;

        // Generate response using existing AI Provider Adapter, prioritizing Gemini 1.5 Flash
        const response = await AIProviderAdapter.generateResponse({
          prompt: userPrompt,
          systemPrompt,
          model: 'gemini-1.5-flash',
          providerPreference: 'gemini',
          temperature: 0.1, // Deterministic, analytical
          maxTokens: 4000
        });

        // Clean up markdown block if the AI hallucinated it
        let cleanContent = response.content.trim();
        if (cleanContent.startsWith('```json')) {
          cleanContent = cleanContent.slice(7);
        }
        if (cleanContent.endsWith('```')) {
          cleanContent = cleanContent.slice(0, -3);
        }
        cleanContent = cleanContent.trim();

        let parsedJson;
        try {
          parsedJson = JSON.parse(cleanContent);
        } catch (parseError) {
          logger.error(`[ResumeSemanticWorker] AI JSON Parse Error for session ${sessionId}. Output was: ${cleanContent.substring(0, 500)}`);
          throw new Error(`AI generated malformed JSON: ${(parseError as Error).message}`);
        }

        // Strictly validate with Zod
        const validatedData = semanticAnalysisZodSchema.parse(parsedJson);

        // Persist to MongoDB
        await SemanticAnalysis.findOneAndUpdate(
          { sessionId },
          { ...validatedData, sessionId },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // Update Session State
        session.semanticState = {
          analyzed: true,
          semanticSimilarity: validatedData.confidenceScore, // Mapping confidenceScore to the existing semanticSimilarity numerical anchor
          analyzedAt: new Date()
        };
        session.currentStage = 'RECOMMENDING'; // Advance the pipeline
        await session.save();

        logger.info(`[ResumeSemanticWorker] Semantic job completed: ${sessionId}. AI confidence: ${validatedData.confidenceScore}`);
      } catch (error) {
        logger.error(`[ResumeSemanticWorker] Semantic job failed: ${sessionId}`, error);
        
        // Safe fallback error handling: Do not crash the queue, mark the session as failed
        const session = await ResumeSession.findOne({ sessionId });
        if (session) {
          session.failureState = {
            failed: true,
            failureStage: 'SEMANTIC_ANALYZING',
            failureReason: error instanceof Error ? error.message : 'Unknown semantic analysis error',
            failedAt: new Date(),
            retryCount: (session.failureState?.retryCount || 0) + 1
          };
          session.currentStage = 'FAILED';
          await session.save();
        }

        throw error; // Re-throw so BullMQ can attempt standard exponential retries
      }
    },
    { concurrency: 3 }
  );

  worker.on('completed', (job) => {
    logger.info(`[ResumeSemanticWorker] Job completed: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[ResumeSemanticWorker] Job failed: ${job?.id}`, err);
  });

  logger.info('[ResumeSemanticWorker] Resume semantic worker started');
  return worker;
}

export async function stopResumeSemanticWorker(): Promise<void> {
  if (!worker) {
    logger.warn('[ResumeSemanticWorker] Worker not running');
    return;
  }

  logger.info('[ResumeSemanticWorker] Stopping resume semantic worker');
  await worker.close();
  worker = null;
  logger.info('[ResumeSemanticWorker] Resume semantic worker stopped');
}

export function getResumeSemanticWorkerStatus(): { running: boolean } {
  return { running: worker !== null };
}
