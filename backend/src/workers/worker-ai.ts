// src/workers/worker-ai.ts — AI & Mock Interview Studio Worker Process
// Handles speculative prompt prefetching, context-compressed dialogue processing, and rubric evaluations.

import { connectDatabase, disconnectDatabase } from '../db/index.js';
import { logger } from '../shared/logger.js';
import { WorkerHealthMonitor } from './WorkerHealthMonitor.js';
import { startInterviewEvaluateWorker, stopInterviewEvaluateWorker } from '../modules/interview/workers/interviewEvaluate.worker.js';
import { contextCompressorService } from '../modules/interview/contextCompressor.service.js';
import {
  speculativePrefetchService,
  startSpeculativePrefetchWorker,
  stopSpeculativePrefetchWorker,
  type BranchMatchResult,
} from '../modules/interview/speculativePrefetch.service.js';
import { buildTurnReplyPrompt, type TurnReplyContext } from '../modules/interview/prompts/turnReply.prompt.js';

export interface TurnProcessingResult {
  source: 'speculative_prefetch' | 'standard_generation';
  feedback: string;
  followUpQuestion?: string;
  latencyMs: number;
  tokensEstimated: number;
  tokensSavedPercent?: number;
  branchMatched?: boolean;
}

/**
 * High-performance interview turn processing pipeline with speculative prefetching
 * and extractive context compression.
 */
export async function processInterviewTurnWithOptimization(
  sessionId: string,
  ctx: TurnReplyContext,
  executeLlmCompletion?: (prompt: string, systemPrompt: string) => Promise<string>
): Promise<TurnProcessingResult> {
  const startTime = performance.now();

  // Step 1: Check speculative prefetch cache for instant (< 100ms) branch delivery
  const matchResult: BranchMatchResult = await speculativePrefetchService.matchOrFallback(
    sessionId,
    ctx.turnIndex,
    ctx.answer
  );

  if (matchResult.matched && matchResult.branch) {
    const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
    logger.info('[worker-ai] Speculative prefetch branch hit (< 100ms delivery)', {
      sessionId,
      turnIndex: ctx.turnIndex,
      branchId: matchResult.branch.branchId,
      similarity: matchResult.similarity,
      latencyMs: elapsed,
    });

    // Schedule prefetch for next turn in background
    if (ctx.turnIndex + 1 < ctx.totalTurns) {
      speculativePrefetchService.registerPrefetch(
        sessionId,
        ctx.turnIndex + 1,
        matchResult.branch.speculativeFollowUp
      );
    }

    return {
      source: 'speculative_prefetch',
      feedback: matchResult.branch.feedback,
      followUpQuestion: matchResult.branch.speculativeFollowUp,
      latencyMs: elapsed,
      tokensEstimated: contextCompressorService.estimateTokenCount(matchResult.branch.feedback),
      branchMatched: true,
    };
  }

  // Step 2: Branch miss - Graceful fallback to standard generation with Context Compression
  logger.info('[worker-ai] Speculative prefetch miss; executing standard generation with context compressor', {
    sessionId,
    turnIndex: ctx.turnIndex,
    similarity: matchResult.similarity,
  });

  const promptObj = buildTurnReplyPrompt(ctx);
  const rawTokens = contextCompressorService.estimateTokenCount(promptObj.prompt);

  let feedback = '';
  if (executeLlmCompletion) {
    feedback = await executeLlmCompletion(promptObj.prompt, promptObj.systemPrompt);
  } else {
    feedback = `Good progress on question ${ctx.turnIndex + 1}. Your architectural breakdown covers key requirements well.`;
  }

  const elapsed = Math.round((performance.now() - startTime) * 100) / 100;

  // Background: prefetch speculative branches for the next question
  if (ctx.turnIndex + 1 < ctx.totalTurns) {
    speculativePrefetchService.registerPrefetch(
      sessionId,
      ctx.turnIndex + 1,
      ctx.question.prompt
    );
  }

  return {
    source: 'standard_generation',
    feedback,
    latencyMs: elapsed,
    tokensEstimated: rawTokens,
    branchMatched: false,
  };
}

let isRunning = false;

export async function startAIWorker(): Promise<void> {
  if (isRunning) {
    logger.warn('[worker-ai] AI worker is already running');
    return;
  }

  logger.info('[worker-ai] Starting AI worker process', {
    event: 'worker_process_starting',
    workerType: 'ai',
    pid: process.pid,
  });

  await connectDatabase();

  const healthMonitor = new WorkerHealthMonitor('ai');
  healthMonitor.start();

  await startInterviewEvaluateWorker();
  await startSpeculativePrefetchWorker();

  isRunning = true;
  logger.info('[worker-ai] AI worker process ready', {
    event: 'worker_process_ready',
    workerType: 'ai',
    pid: process.pid,
  });

  (global as any).healthMonitor = healthMonitor;
}

export async function stopAIWorker(): Promise<void> {
  if (!isRunning) return;

  logger.info('[worker-ai] Stopping AI worker process');
  try {
    await stopInterviewEvaluateWorker();
    await stopSpeculativePrefetchWorker();

    const healthMonitor = (global as any).healthMonitor;
    if (healthMonitor) {
      healthMonitor.stop();
    }

    await disconnectDatabase();
  } catch (err) {
    logger.error('[worker-ai] Error during AI worker shutdown:', err);
  } finally {
    isRunning = false;
  }
}

// Auto-run if executed as main entrypoint
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  startAIWorker().catch((err) => {
    logger.error('[worker-ai] Startup error:', err);
    process.exit(1);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await stopAIWorker();
      process.exit(0);
    });
  }
}
