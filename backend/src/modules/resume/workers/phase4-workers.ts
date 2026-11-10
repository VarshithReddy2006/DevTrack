// src/modules/resume-intelligence/workers/evidence-graph.worker.ts
import { Worker, type Job } from 'bullmq';
import { getRedisConnection } from '../../../shared/redis/index.js';
import { EvidenceGraphEngine } from '../evidence/EvidenceGraphEngine.js';
import { logger } from '../../../shared/logger.js';
import type { Types } from 'mongoose';

export const EVIDENCE_GRAPH_QUEUE = 'evidence-graph';

let evidenceGraphWorker: Worker | undefined;
let embeddingWorker: Worker | undefined;
let githubAnalysisWorker: Worker | undefined;

export function startEvidenceGraphWorker(): Worker {
  if (evidenceGraphWorker) return evidenceGraphWorker;
  const engine = new EvidenceGraphEngine();

  evidenceGraphWorker = new Worker(
    EVIDENCE_GRAPH_QUEUE,
    async (job: Job) => {
      logger.info(`[EvidenceGraphWorker] Processing job ${job.id}`);
      await engine.buildGraphForUser(job.data.userId as unknown as Types.ObjectId);
    },
    { connection: getRedisConnection() }
  );

  return evidenceGraphWorker;
}

// src/modules/resume-intelligence/workers/embedding-generation.worker.ts
export const EMBEDDING_GENERATION_QUEUE = 'embedding-generation';
export function startEmbeddingWorker(): Worker {
  if (embeddingWorker) return embeddingWorker;
  embeddingWorker = new Worker(
    EMBEDDING_GENERATION_QUEUE,
    async (job: Job) => {
      logger.info(`[EmbeddingWorker] Generating embeddings for ${job.id}`);
    },
    { connection: getRedisConnection() }
  );

  return embeddingWorker;
}

// src/modules/resume-intelligence/workers/github-analysis.worker.ts
import { RepositoryIntelligenceEngine } from '../github/RepositoryIntelligenceEngine.js';
export const GITHUB_ANALYSIS_QUEUE = 'github-analysis';
export function startGithubAnalysisWorker(): Worker {
  if (githubAnalysisWorker) return githubAnalysisWorker;
  const engine = new RepositoryIntelligenceEngine();
  githubAnalysisWorker = new Worker(
    GITHUB_ANALYSIS_QUEUE,
    async (job: Job) => {
      logger.info(`[GithubAnalysisWorker] Analyzing repo ${job.data.repoUrl}`);
      await engine.analyzeRepository(job.data.repoUrl);
    },
    { connection: getRedisConnection() }
  );

  return githubAnalysisWorker;
}

export async function stopEvidenceGraphWorker(): Promise<void> {
  await evidenceGraphWorker?.close();
  evidenceGraphWorker = undefined;
}

export async function stopEmbeddingWorker(): Promise<void> {
  await embeddingWorker?.close();
  embeddingWorker = undefined;
}

export async function stopGithubAnalysisWorker(): Promise<void> {
  await githubAnalysisWorker?.close();
  githubAnalysisWorker = undefined;
}
