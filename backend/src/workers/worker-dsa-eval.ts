// src/workers/worker-dsa-eval.ts — DSA Code Execution & Evaluation Worker Process
// Evaluates untrusted candidate algorithms against test suites using isolated WebAssembly (WASI)
// and containerized sandbox environments with hard 2.0s CPU limits and 256MB memory cgroups.

import { Worker, type Job } from 'bullmq';
import { QueueNames, type DsaEvaluationJobData } from '../shared/jobs/types.js';
import { QueueRegistry } from '../infrastructure/queues/QueueRegistry.js';
import { sandboxRunner, type ExecutionResult, type SupportedLanguage } from '../modules/dsa/execution/sandboxRunner.js';
import { connectDatabase, disconnectDatabase } from '../db/index.js';
import { logger } from '../shared/logger.js';
import { WorkerHealthMonitor } from './WorkerHealthMonitor.js';

export interface TestCaseResult {
  testCaseIndex: number;
  input: string;
  expectedOutput: string;
  actualOutput: string;
  passed: boolean;
  status: ExecutionResult['status'];
  executionDurationMs: number;
  peakMemoryBytes: number;
  error?: string;
}

export interface DsaEvaluationResult {
  submissionId: string;
  verdict: 'ACCEPTED' | 'WRONG_ANSWER' | 'TIME_LIMIT_EXCEEDED' | 'MEMORY_LIMIT_EXCEEDED' | 'RUNTIME_ERROR' | 'SECURITY_VIOLATION';
  passedTestCases: number;
  totalTestCases: number;
  totalDurationMs: number;
  maxMemoryBytes: number;
  results: TestCaseResult[];
  error?: string;
}

/**
 * Normalizes output strings by trimming trailing whitespace and unifying line breaks
 */
function normalizeOutput(output: string): string {
  return output
    .replace(/\r\n/g, '\n')
    .trim()
    .replace(/[ \t]+$/gm, '');
}

/**
 * Evaluates candidate code submission against a suite of input/output test cases
 */
export async function evaluateSubmission(
  payload: DsaEvaluationJobData
): Promise<DsaEvaluationResult> {
  const { submissionId, code, language, testCases = [], timeoutMs = 2000, memoryLimitMb = 256 } = payload;
  const testResults: TestCaseResult[] = [];

  let totalDurationMs = 0;
  let maxMemoryBytes = 0;
  let verdict: DsaEvaluationResult['verdict'] = 'ACCEPTED';
  let firstError: string | undefined;

  // If no test cases are provided, execute once as a dry run / syntax check
  if (testCases.length === 0) {
    const execResult = await sandboxRunner.execute(code, language as SupportedLanguage, {
      timeoutMs,
      memoryLimitMb,
      stdin: '',
    });

    totalDurationMs = execResult.executionDurationMs;
    maxMemoryBytes = execResult.peakMemoryBytes;

    if (execResult.status === 'TLE') {
      verdict = 'TIME_LIMIT_EXCEEDED';
    } else if (execResult.status === 'MLE') {
      verdict = 'MEMORY_LIMIT_EXCEEDED';
    } else if (execResult.status === 'SECURITY_VIOLATION') {
      verdict = 'SECURITY_VIOLATION';
    } else if (execResult.status === 'RTE') {
      verdict = 'RUNTIME_ERROR';
    } else {
      verdict = 'ACCEPTED';
    }

    return {
      submissionId,
      verdict,
      passedTestCases: verdict === 'ACCEPTED' ? 1 : 0,
      totalTestCases: 1,
      totalDurationMs,
      maxMemoryBytes,
      results: [
        {
          testCaseIndex: 0,
          input: '',
          expectedOutput: '',
          actualOutput: execResult.stdout,
          passed: verdict === 'ACCEPTED',
          status: execResult.status,
          executionDurationMs: execResult.executionDurationMs,
          peakMemoryBytes: execResult.peakMemoryBytes,
          error: execResult.error,
        },
      ],
      error: execResult.error,
    };
  }

  // Evaluate against test cases sequentially
  for (let idx = 0; idx < testCases.length; idx++) {
    const tc = testCases[idx];
    const execResult = await sandboxRunner.execute(code, language as SupportedLanguage, {
      timeoutMs,
      memoryLimitMb,
      stdin: tc.input,
    });

    totalDurationMs += execResult.executionDurationMs;
    maxMemoryBytes = Math.max(maxMemoryBytes, execResult.peakMemoryBytes);

    const actual = normalizeOutput(execResult.stdout);
    const expected = normalizeOutput(tc.expectedOutput);
    let passed = false;

    if (execResult.status === 'SUCCESS') {
      passed = actual === expected;
      if (!passed && verdict === 'ACCEPTED') {
        verdict = 'WRONG_ANSWER';
      }
    } else {
      passed = false;
      if (verdict === 'ACCEPTED' || verdict === 'WRONG_ANSWER') {
        if (execResult.status === 'TLE') verdict = 'TIME_LIMIT_EXCEEDED';
        else if (execResult.status === 'MLE') verdict = 'MEMORY_LIMIT_EXCEEDED';
        else if (execResult.status === 'SECURITY_VIOLATION') verdict = 'SECURITY_VIOLATION';
        else if (execResult.status === 'RTE') verdict = 'RUNTIME_ERROR';
      }
      if (!firstError) {
        firstError = execResult.error || execResult.stderr;
      }
    }

    testResults.push({
      testCaseIndex: idx,
      input: tc.input,
      expectedOutput: tc.expectedOutput,
      actualOutput: execResult.stdout,
      passed,
      status: execResult.status,
      executionDurationMs: execResult.executionDurationMs,
      peakMemoryBytes: execResult.peakMemoryBytes,
      error: execResult.error,
    });

    // Short-circuit on critical system violations or fatal timeouts
    if (execResult.status === 'SECURITY_VIOLATION' || execResult.status === 'TLE') {
      break;
    }
  }

  const passedCount = testResults.filter(r => r.passed).length;

  return {
    submissionId,
    verdict,
    passedTestCases: passedCount,
    totalTestCases: testCases.length,
    totalDurationMs: Math.round(totalDurationMs * 100) / 100,
    maxMemoryBytes,
    results: testResults,
    error: firstError,
  };
}

let dsaEvalWorker: Worker | undefined;
let isRunning = false;

/**
 * Initializes and starts the BullMQ worker for the dsa-eval queue
 */
export async function startDsaEvalWorker(): Promise<Worker | undefined> {
  if (isRunning && dsaEvalWorker) {
    logger.warn('[worker-dsa-eval] DSA Evaluation worker already running');
    return dsaEvalWorker;
  }

  logger.info('[worker-dsa-eval] Starting DSA Evaluation worker', {
    queue: QueueNames.DSA_EVAL,
  });

  const config = QueueRegistry.createQueueConfig();

  dsaEvalWorker = new Worker<DsaEvaluationJobData, DsaEvaluationResult>(
    QueueNames.DSA_EVAL,
    async (job: Job<DsaEvaluationJobData>) => {
      logger.info(`[worker-dsa-eval] Processing submission: ${job.data.submissionId}`, {
        submissionId: job.data.submissionId,
        language: job.data.language,
      });

      return evaluateSubmission(job.data);
    },
    {
      connection: config.connection,
      concurrency: 4, // Concurrent isolated sandbox executions
    }
  );

  dsaEvalWorker.on('completed', (job: Job<DsaEvaluationJobData>, result: DsaEvaluationResult) => {
    logger.info(`[worker-dsa-eval] Completed evaluation for submission ${job.data.submissionId}: ${result.verdict}`, {
      submissionId: job.data.submissionId,
      verdict: result.verdict,
      passedTests: `${result.passedTestCases}/${result.totalTestCases}`,
    });
  });

  dsaEvalWorker.on('failed', (job: Job<DsaEvaluationJobData> | undefined, error: Error) => {
    logger.error(`[worker-dsa-eval] Evaluation job failed`, {
      submissionId: job?.data?.submissionId,
      error: error.message,
    });
  });

  isRunning = true;
  return dsaEvalWorker;
}

/**
 * Gracefully shuts down the DSA Evaluation worker
 */
export async function stopDsaEvalWorker(): Promise<void> {
  if (!isRunning || !dsaEvalWorker) return;

  logger.info('[worker-dsa-eval] Stopping DSA Evaluation worker');
  try {
    await dsaEvalWorker.close();
  } catch (err) {
    logger.error('[worker-dsa-eval] Error during worker shutdown:', err);
  } finally {
    dsaEvalWorker = undefined;
    isRunning = false;
  }
}

// Standalone worker process startup when executed directly
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  (async () => {
    await connectDatabase();
    const healthMonitor = new WorkerHealthMonitor('dsa');
    healthMonitor.start();
    await startDsaEvalWorker();

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => {
        await stopDsaEvalWorker();
        healthMonitor.stop();
        await disconnectDatabase();
        process.exit(0);
      });
    }
  })().catch((err) => {
    logger.error('[worker-dsa-eval] Startup error:', err);
    process.exit(1);
  });
}
