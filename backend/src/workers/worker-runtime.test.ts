import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createWorkerRuntime, parseWorkerType, WORKER_TYPES, workerDefinitions } from './worker-runtime.js';

const mocks = vi.hoisted(() => {
  const names = ['sync', 'xp', 'maintenance', 'generation', 'ats', 'export', 'credibility', 'variant', 'evidence', 'embedding', 'github', 'upload', 'profile', 'dataset', 'streak', 'notifications', 'sessionAts', 'sessionEmbedding', 'sessionSemantic', 'recommendation', 'dsa', 'projects', 'skills', 'benchmarks', 'roadmap', 'aggregation'];
  return {
    workers: Object.fromEntries(names.map(name => [name, { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) }])),
    schedule: vi.fn().mockResolvedValue(undefined),
    closeQueue: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../shared/jobs/platformSyncWorker.js', () => ({ startPlatformSyncWorker: mocks.workers.sync.start, stopPlatformSyncWorker: mocks.workers.sync.stop }));
vi.mock('../shared/jobs/xpWorker.js', () => ({ startXpWorker: mocks.workers.xp.start, stopXpWorker: mocks.workers.xp.stop }));
vi.mock('../shared/jobs/maintenanceWorker.js', () => ({ startMaintenanceWorker: mocks.workers.maintenance.start, stopMaintenanceWorker: mocks.workers.maintenance.stop, scheduleMaintenanceTasks: mocks.schedule }));
vi.mock('../modules/resume/workers/resume-generation.worker.js', () => ({ startResumeGenerationWorker: mocks.workers.generation.start, stopResumeGenerationWorker: mocks.workers.generation.stop }));
vi.mock('../modules/resume/workers/ats-analysis.worker.js', () => ({ startATSAnalysisWorker: mocks.workers.ats.start, stopATSAnalysisWorker: mocks.workers.ats.stop }));
vi.mock('../modules/resume/workers/resume-export.worker.js', () => ({ startResumeExportWorker: mocks.workers.export.start, stopResumeExportWorker: mocks.workers.export.stop }));
vi.mock('../modules/resume/workers/credibility-recalculation.worker.js', () => ({ startCredibilityWorker: mocks.workers.credibility.start, stopCredibilityWorker: mocks.workers.credibility.stop }));
vi.mock('../modules/resume/workers/variant-generation.worker.js', () => ({ startVariantGenerationWorker: mocks.workers.variant.start, stopVariantGenerationWorker: mocks.workers.variant.stop }));
vi.mock('../modules/resume/workers/phase4-workers.js', () => ({
  startEvidenceGraphWorker: mocks.workers.evidence.start, stopEvidenceGraphWorker: mocks.workers.evidence.stop,
  startEmbeddingWorker: mocks.workers.embedding.start, stopEmbeddingWorker: mocks.workers.embedding.stop,
  startGithubAnalysisWorker: mocks.workers.github.start, stopGithubAnalysisWorker: mocks.workers.github.stop,
}));
vi.mock('./worker-resume-upload.js', () => ({ startResumeUploadWorker: mocks.workers.upload.start, stopResumeUploadWorker: mocks.workers.upload.stop }));
vi.mock('../shared/jobs/profileRebuildWorker.js', () => ({ startProfileRebuildWorker: mocks.workers.profile.start, stopProfileRebuildWorker: mocks.workers.profile.stop, profileRebuildQueue: { close: mocks.closeQueue } }));
vi.mock('./worker-dataset-ingestion.js', () => ({ startDatasetIngestionWorker: mocks.workers.dataset.start, stopDatasetIngestionWorker: mocks.workers.dataset.stop }));

vi.mock('../shared/jobs/streakRecalcWorker.js', () => ({ startStreakRecalcWorker: mocks.workers.streak.start, stopStreakRecalcWorker: mocks.workers.streak.stop }));
vi.mock('../shared/jobs/notificationWorker.js', () => ({ startNotificationWorker: mocks.workers.notifications.start, stopNotificationWorker: mocks.workers.notifications.stop }));
vi.mock('./worker-resume-ats.js', () => ({ startResumeATSWorker: mocks.workers.sessionAts.start, stopResumeATSWorker: mocks.workers.sessionAts.stop }));
vi.mock('./worker-resume-embedding.js', () => ({ startResumeEmbeddingWorker: mocks.workers.sessionEmbedding.start, stopResumeEmbeddingWorker: mocks.workers.sessionEmbedding.stop }));
vi.mock('./worker-resume-semantic.js', () => ({ startResumeSemanticWorker: mocks.workers.sessionSemantic.start, stopResumeSemanticWorker: mocks.workers.sessionSemantic.stop }));
vi.mock('./worker-resume-recommendation.js', () => ({ startResumeRecommendationWorker: mocks.workers.recommendation.start, stopResumeRecommendationWorker: mocks.workers.recommendation.stop }));
vi.mock('../shared/jobs/workers/dsaAnalyticsWorker.js', () => ({ startDsaAnalyticsWorker: () => { mocks.workers.dsa.start(); return { close: mocks.workers.dsa.stop }; } }));
vi.mock('../shared/jobs/workers/projectIntelligenceWorker.js', () => ({ startProjectIntelligenceWorker: () => { mocks.workers.projects.start(); return { close: mocks.workers.projects.stop }; } }));
vi.mock('../shared/jobs/workers/skillIntelligenceWorker.js', () => ({ startSkillIntelligenceWorker: () => { mocks.workers.skills.start(); return { close: mocks.workers.skills.stop }; } }));
vi.mock('../shared/jobs/workers/benchmarkWorker.js', () => ({ startBenchmarkWorker: () => { mocks.workers.benchmarks.start(); return { close: mocks.workers.benchmarks.stop }; } }));
vi.mock('../shared/jobs/workers/roadmapRecommendationWorker.js', () => ({ startRoadmapRecommendationWorker: () => { mocks.workers.roadmap.start(); return { close: mocks.workers.roadmap.stop }; } }));
vi.mock('../shared/jobs/workers/readinessAggregationWorker.js', () => ({ startReadinessAggregationWorker: () => { mocks.workers.aggregation.start(); return { close: mocks.workers.aggregation.stop }; } }));

function services() {
  return { validate: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { vi.clearAllMocks(); });

describe('standalone worker selection and lifecycle', () => {
  const resume = ['generation', 'ats', 'export', 'credibility', 'variant', 'evidence', 'embedding', 'github', 'upload', 'profile', 'sessionAts', 'sessionEmbedding', 'sessionSemantic', 'recommendation'];
  const cases: [string | undefined, string[]][] = [
    ['sync', ['sync']], ['xp', ['xp', 'streak', 'notifications']], ['maintenance', ['maintenance']],
    ['readiness', ['dsa', 'projects', 'skills', 'benchmarks', 'roadmap', 'aggregation']],
    ['resume-intelligence', resume], ['dataset', ['dataset']],
    ['all', Object.keys(mocks.workers)], [undefined, Object.keys(mocks.workers)], ['', Object.keys(mocks.workers)],
  ];
  it.each(cases)('starts and drains only consumers for %s', async (selector, expected) => {
    const infra = services();
    const runtime = createWorkerRuntime(selector, infra);
    await Promise.all([runtime.start(), runtime.start()]);
    expect(infra.validate).toHaveBeenCalledOnce();
    expect(infra.connect).toHaveBeenCalledOnce();
    for (const [name, worker] of Object.entries(mocks.workers)) {
      expect(worker.start).toHaveBeenCalledTimes(expected.includes(name) ? 1 : 0);
      expect(worker.stop).not.toHaveBeenCalled();
    }
    expect(mocks.schedule).toHaveBeenCalledTimes(expected.includes('maintenance') ? 1 : 0);
    await Promise.all([runtime.stop(), runtime.stop()]);
    for (const [name, worker] of Object.entries(mocks.workers)) {
      expect(worker.stop).toHaveBeenCalledTimes(expected.includes(name) ? 1 : 0);
    }
    expect(mocks.closeQueue).toHaveBeenCalledTimes(expected.includes('profile') ? 1 : 0);
    expect(infra.disconnect).toHaveBeenCalledOnce();
    expect(infra.disconnect.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...expected.map(name => mocks.workers[name].stop.mock.invocationCallOrder[0])));
  });

  it.each(['orchestration', 'orch', 'maint', 'typo', 'SYNC', ' sync '])('rejects %j without touching services or loaders', value => {
    const infra = services();
    const load = vi.fn();
    expect(() => createWorkerRuntime(value, infra, [{ role: 'sync', load }])).toThrow(/Unsupported WORKER_TYPE.*Supported values/);
    expect(infra.validate).not.toHaveBeenCalled();
    expect(infra.connect).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it.each(['orchestration', 'orch', 'maint', 'typo'])('real process exits nonzero for %j before service configuration loads', selector => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/worker-entrypoint.ts', selector], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
      env: {
        ...process.env, NODE_ENV: 'production', WORKER_TYPE: 'all',
        MONGODB_URI: 'mongodb://invalid.invalid/dt018-no-connect', REDIS_URL: 'redis://invalid.invalid',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported WORKER_TYPE');
    expect(result.stderr).toContain(WORKER_TYPES.join(', '));
    expect(result.stdout).not.toContain('ready');
    expect(result.stderr).not.toContain('Missing required environment');
  });

  it.each(['validate', 'connect'] as const)('cleans services after %s fails without starting consumers', async stage => {
    const infra = services();
    infra[stage].mockRejectedValueOnce(new Error(stage));
    const runtime = createWorkerRuntime('all', infra);
    await expect(runtime.start()).rejects.toThrow(stage);
    await runtime.stop();
    expect(infra.disconnect).toHaveBeenCalledOnce();
    for (const worker of Object.values(mocks.workers)) expect(worker.start).not.toHaveBeenCalled();
  });

  it('awaits async starts and drains partial startup including the failed consumer', async () => {
    mocks.workers.ats.start.mockRejectedValueOnce(new Error('start failed'));
    const infra = services();
    const runtime = createWorkerRuntime('resume-intelligence', infra);
    await expect(runtime.start()).rejects.toThrow('start failed');
    await runtime.stop();
    expect(mocks.workers.generation.stop).toHaveBeenCalledOnce();
    expect(mocks.workers.ats.stop).toHaveBeenCalledOnce();
    expect(mocks.workers.export.start).not.toHaveBeenCalled();
    expect(infra.disconnect).toHaveBeenCalledOnce();
  });

  it('treats schedule failure as startup failure and closes the maintenance worker', async () => {
    mocks.schedule.mockRejectedValueOnce(new Error('schedule failed'));
    const runtime = createWorkerRuntime('maintenance', services());
    await expect(runtime.start()).rejects.toThrow('schedule failed');
    await runtime.stop();
    expect(mocks.workers.maintenance.stop).toHaveBeenCalledOnce();
  });

  it('propagates loader failures and drains earlier consumers', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('module missing'));
    const runtime = createWorkerRuntime('all', services(), [workerDefinitions[0], { role: 'xp', load }]);
    await expect(runtime.start()).rejects.toThrow('module missing');
    await runtime.stop();
    expect(mocks.workers.sync.stop).toHaveBeenCalledOnce();
  });

  it('continues draining and disconnecting when a consumer close fails', async () => {
    mocks.workers.profile.stop.mockRejectedValueOnce(new Error('close failed'));
    const infra = services();
    const runtime = createWorkerRuntime('all', infra);
    await runtime.start();
    await expect(runtime.stop()).rejects.toThrow('Worker cleanup failed');
    expect(mocks.closeQueue).toHaveBeenCalledOnce();
    for (const worker of Object.values(mocks.workers)) expect(worker.stop).toHaveBeenCalledOnce();
    expect(infra.disconnect).toHaveBeenCalledOnce();
  });

  it('waits for a pending async start before draining and prevents later consumers', async () => {
    const pending = deferred();
    mocks.workers.sync.start.mockReturnValueOnce(pending.promise);
    const infra = services();
    const runtime = createWorkerRuntime('all', infra);
    const start = runtime.start();
    const failed = expect(start).rejects.toThrow('interrupted');
    await vi.waitFor(() => expect(mocks.workers.sync.start).toHaveBeenCalledOnce());
    const stop = runtime.stop();
    expect(mocks.workers.sync.stop).not.toHaveBeenCalled();
    pending.resolve();
    await failed;
    await stop;
    expect(mocks.workers.sync.stop).toHaveBeenCalledOnce();
    expect(mocks.workers.xp.start).not.toHaveBeenCalled();
  });

  it('does not connect or load workers when stopped before startup', async () => {
    const infra = services();
    const runtime = createWorkerRuntime('all', infra);
    await runtime.stop();
    await expect(runtime.start()).rejects.toThrow('interrupted');
    expect(infra.validate).not.toHaveBeenCalled();
  });

  it('keeps production Compose, deployment tables and package commands within the supported contract', () => {
    const compose = readFileSync('../docker-compose.prod.yml', 'utf8');
    const selectors = [...compose.matchAll(/- WORKER_TYPE=([^\s]+)/g)].map(match => match[1]);
    expect(selectors.sort()).toEqual(['sync', 'xp', 'readiness', 'maintenance', 'resume-intelligence', 'dataset'].sort());
    selectors.forEach(value => expect(parseWorkerType(value)).toBe(value));
    const deployment = readFileSync('../DEPLOYMENT.md', 'utf8');
    for (const match of deployment.matchAll(/WORKER_TYPE=([^`\s]+)/g)) expect(() => parseWorkerType(match[1])).not.toThrow();
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    for (const role of WORKER_TYPES.filter(value => value !== 'all')) {
      expect(pkg.scripts[`worker:${role}`]).toBe(`tsx src/worker-entrypoint.ts ${role}`);
    }
  });
  it('waits for consumer readiness before advancing', async () => {
    const pending = deferred();
    const close = vi.fn().mockResolvedValue(undefined);
    const later = vi.fn();
    const runtime = createWorkerRuntime('all', services(), [
      { role: 'readiness', load: async () => ({ start: () => ({ waitUntilReady: () => pending.promise }), stop: close }) },
      { role: 'xp', load: async () => ({ start: later, stop: close }) },
    ]);
    const starting = runtime.start();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(later).not.toHaveBeenCalled();
    pending.resolve(); await starting;
    expect(later).toHaveBeenCalledOnce(); await runtime.stop();
  });

  it.each(['start', 'stop'] as const)('bounds shutdown even when %s never settles', async stage => {
    vi.useFakeTimers();
    try {
      const blocked = new Promise<void>(() => {});
      const entered = deferred();
      const runtime = createWorkerRuntime('all', services(), [{ role: 'sync', load: async () => ({
        start: () => { entered.resolve(); return stage === 'start' ? blocked : undefined; },
        stop: () => stage === 'stop' ? blocked : Promise.resolve(),
      }) }]);
      const starting = runtime.start();
      if (stage === 'stop') await starting;
      else { void starting.catch(() => undefined); await entered.promise; }
      const stopped = runtime.stop(100);
      const rejected = expect(stopped).rejects.toThrow('shutdown exceeded 100ms');
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally { vi.useRealTimers(); }
  });

  it('drains a consumer whose readiness check fails before loading later consumers', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const later = vi.fn();
    const runtime = createWorkerRuntime('all', services(), [
      { role: 'sync', load: async () => ({ start: () => ({ waitUntilReady: async () => { throw new Error('not ready'); } }), stop }) },
      { role: 'xp', load: later },
    ]);
    await expect(runtime.start()).rejects.toThrow('not ready');
    await runtime.stop(); expect(stop).toHaveBeenCalledOnce(); expect(later).not.toHaveBeenCalled();
  });

});
