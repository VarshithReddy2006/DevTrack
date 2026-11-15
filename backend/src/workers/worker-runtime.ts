/** Validate before loading any service modules. */
export const WORKER_TYPES = ['sync', 'xp', 'readiness', 'maintenance', 'resume-intelligence', 'dataset', 'all'] as const;
export type WorkerType = typeof WORKER_TYPES[number];
type Role = Exclude<WorkerType, 'all'>;

export function parseWorkerType(value: string | undefined): WorkerType {
  // Preserve the existing local-development fallback, including an empty env value.
  if (value === undefined || value === '') return 'all';
  if ((WORKER_TYPES as readonly string[]).includes(value)) return value as WorkerType;
  throw new Error(`Unsupported WORKER_TYPE ${JSON.stringify(value)}. Supported values: ${WORKER_TYPES.join(', ')}`);
}

export interface WorkerLifecycle {
  start(): unknown | Promise<unknown>;
  stop(): Promise<unknown>;
}

/** Lazy consumer loaders; register cleanup before invoking each start function. */
export const workerDefinitions: { role: Role; queueName?: string; load(): Promise<WorkerLifecycle> }[] = [
  { role: 'sync', queueName: 'platform-sync', load: async () => {
    const m = await import('../shared/jobs/platformSyncWorker.js');
    return { start: m.startPlatformSyncWorker, stop: m.stopPlatformSyncWorker };
  } },
  { role: 'xp', queueName: 'xp-processing', load: async () => {
    const m = await import('../shared/jobs/xpWorker.js');
    return { start: m.startXpWorker, stop: m.stopXpWorker };
  } },
  { role: 'maintenance', queueName: 'system-maintenance', load: async () => {
    const m = await import('../shared/jobs/maintenanceWorker.js');
    return { start: async () => { m.startMaintenanceWorker(); await m.scheduleMaintenanceTasks(); }, stop: m.stopMaintenanceWorker };
  } },
  { role: 'resume-intelligence', queueName: 'resume-generation', load: async () => {
    const m = await import('../modules/resume/workers/resume-generation.worker.js');
    return { start: m.startResumeGenerationWorker, stop: m.stopResumeGenerationWorker };
  } },
  { role: 'resume-intelligence', queueName: 'ats-analysis', load: async () => {
    const m = await import('../modules/resume/workers/ats-analysis.worker.js');
    return { start: m.startATSAnalysisWorker, stop: m.stopATSAnalysisWorker };
  } },
  { role: 'resume-intelligence', queueName: 'resume-export', load: async () => {
    const m = await import('../modules/resume/workers/resume-export.worker.js');
    return { start: m.startResumeExportWorker, stop: m.stopResumeExportWorker };
  } },
  { role: 'resume-intelligence', queueName: 'credibility-recalculation', load: async () => {
    const m = await import('../modules/resume/workers/credibility-recalculation.worker.js');
    return { start: m.startCredibilityWorker, stop: m.stopCredibilityWorker };
  } },
  { role: 'resume-intelligence', queueName: 'variant-generation', load: async () => {
    const m = await import('../modules/resume/workers/variant-generation.worker.js');
    return { start: m.startVariantGenerationWorker, stop: m.stopVariantGenerationWorker };
  } },
  { role: 'resume-intelligence', queueName: 'evidence-graph', load: async () => {
    const m = await import('../modules/resume/workers/phase4-workers.js');
    return { start: m.startEvidenceGraphWorker, stop: m.stopEvidenceGraphWorker };
  } },
  { role: 'resume-intelligence', queueName: 'embedding-generation', load: async () => {
    const m = await import('../modules/resume/workers/phase4-workers.js');
    return { start: m.startEmbeddingWorker, stop: m.stopEmbeddingWorker };
  } },
  { role: 'resume-intelligence', queueName: 'github-analysis', load: async () => {
    const m = await import('../modules/resume/workers/phase4-workers.js');
    return { start: m.startGithubAnalysisWorker, stop: m.stopGithubAnalysisWorker };
  } },
  { role: 'resume-intelligence', queueName: 'resume-upload', load: async () => {
    const m = await import('./worker-resume-upload.js');
    return { start: m.startResumeUploadWorker, stop: m.stopResumeUploadWorker };
  } },
  { role: 'resume-intelligence', queueName: 'profile-rebuild', load: async () => {
    const m = await import('../shared/jobs/profileRebuildWorker.js');
    return { start: m.startProfileRebuildWorker, stop: async () => {
      try { await m.stopProfileRebuildWorker(); } finally { await m.profileRebuildQueue.close(); }
    } };
  } },
  { role: 'dataset', queueName: 'dataset-ingestion', load: async () => {
    const m = await import('./worker-dataset-ingestion.js');
    return { start: m.startDatasetIngestionWorker, stop: m.stopDatasetIngestionWorker };
  } },
  { role: 'xp', queueName: 'streak-recalc', load: async () => {
    const m = await import('../shared/jobs/streakRecalcWorker.js');
    return { start: m.startStreakRecalcWorker, stop: m.stopStreakRecalcWorker };
  } },
  { role: 'xp', queueName: 'notifications', load: async () => {
    const m = await import('../shared/jobs/notificationWorker.js');
    return { start: m.startNotificationWorker, stop: m.stopNotificationWorker };
  } },
  { role: 'resume-intelligence', queueName: 'resume-ats', load: async () => {
    const m = await import('./worker-resume-ats.js');
    return { start: m.startResumeATSWorker, stop: m.stopResumeATSWorker };
  } },
  { role: 'resume-intelligence', queueName: 'resume-embedding', load: async () => {
    const m = await import('./worker-resume-embedding.js');
    return { start: m.startResumeEmbeddingWorker, stop: m.stopResumeEmbeddingWorker };
  } },
  { role: 'resume-intelligence', queueName: 'resume-semantic', load: async () => {
    const m = await import('./worker-resume-semantic.js');
    return { start: m.startResumeSemanticWorker, stop: m.stopResumeSemanticWorker };
  } },
  { role: 'resume-intelligence', queueName: 'resume-recommendation', load: async () => {
    const m = await import('./worker-resume-recommendation.js');
    return { start: m.startResumeRecommendationWorker, stop: m.stopResumeRecommendationWorker };
  } },
  { role: 'readiness', queueName: 'readiness-dsa', load: async () => {
    const m = await import('../shared/jobs/workers/dsaAnalyticsWorker.js');
    let worker: ReturnType<typeof m.startDsaAnalyticsWorker> | undefined;
    return { start: () => (worker = m.startDsaAnalyticsWorker()), stop: async () => { await worker?.close(); worker = undefined; } };
  } },
  { role: 'readiness', queueName: 'readiness-projects', load: async () => {
    const m = await import('../shared/jobs/workers/projectIntelligenceWorker.js');
    let worker: ReturnType<typeof m.startProjectIntelligenceWorker> | undefined;
    return { start: () => (worker = m.startProjectIntelligenceWorker()), stop: async () => { await worker?.close(); worker = undefined; } };
  } },
  { role: 'readiness', queueName: 'readiness-skills', load: async () => {
    const m = await import('../shared/jobs/workers/skillIntelligenceWorker.js');
    let worker: ReturnType<typeof m.startSkillIntelligenceWorker> | undefined;
    return { start: () => (worker = m.startSkillIntelligenceWorker()), stop: async () => { await worker?.close(); worker = undefined; } };
  } },
  { role: 'readiness', queueName: 'readiness-benchmarks', load: async () => {
    const m = await import('../shared/jobs/workers/benchmarkWorker.js');
    let worker: ReturnType<typeof m.startBenchmarkWorker> | undefined;
    return { start: () => (worker = m.startBenchmarkWorker()), stop: async () => { await worker?.close(); worker = undefined; } };
  } },
  { role: 'readiness', queueName: 'readiness-roadmap', load: async () => {
    const m = await import('../shared/jobs/workers/roadmapRecommendationWorker.js');
    let worker: ReturnType<typeof m.startRoadmapRecommendationWorker> | undefined;
    return { start: () => (worker = m.startRoadmapRecommendationWorker()), stop: async () => { await worker?.close(); worker = undefined; } };
  } },
  { role: 'readiness', queueName: 'readiness-aggregation', load: async () => {
    const m = await import('../shared/jobs/workers/readinessAggregationWorker.js');
    let worker: ReturnType<typeof m.startReadinessAggregationWorker> | undefined;
    return { start: () => (worker = m.startReadinessAggregationWorker()), stop: async () => { await worker?.close(); worker = undefined; } };
  } },
];

export interface RuntimeServices {
  validate(): Promise<unknown>;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export function createWorkerRuntime(selector: string | undefined, services: RuntimeServices, definitions = workerDefinitions) {
  const type = parseWorkerType(selector);
  const stops: WorkerLifecycle['stop'][] = [];
  let startup: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let stopping = false;
  let servicesTouched = false;

  function assertRunning() {
    if (stopping) throw new Error('Worker startup interrupted by shutdown');
  }

  return {
    type,
    start(): Promise<void> {
      startup ??= (async () => {
        assertRunning();
        servicesTouched = true;
        await services.validate();
        assertRunning();
        await services.connect();
        assertRunning();
        for (const definition of definitions) {
          if (type !== 'all' && definition.role !== type) continue;
          assertRunning();
          const worker = await definition.load();
          stops.push(worker.stop);
          assertRunning();
          const consumer = await worker.start();
          if (consumer && typeof (consumer as { waitUntilReady?: unknown }).waitUntilReady === 'function') {
            await (consumer as { waitUntilReady(): Promise<unknown> }).waitUntilReady();
          }
          assertRunning();
        }
      })();
      return startup;
    },
    stop(timeoutMs = 9000): Promise<void> {
      stopping = true;
      cleanup ??= withShutdownDeadline((async () => {
        // A signal during startup must not race a consumer being constructed.
        await startup?.catch(() => undefined);
        const errors: unknown[] = [];
        const drained = await Promise.allSettled(stops.reverse().map(stop => Promise.resolve().then(stop)));
        for (const result of drained) if (result.status === 'rejected') errors.push(result.reason);
        if (servicesTouched) {
          try { await services.disconnect(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Worker cleanup failed');
      })(), timeoutMs);
      return cleanup;
    },
  };
}

/** A stuck start, consumer drain or disconnect must not prevent process exit. */
async function withShutdownDeadline(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Worker shutdown exceeded ${timeoutMs}ms; unfinished jobs require stalled-job recovery`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
