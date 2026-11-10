import { it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ workers: [] as { name: string; close: ReturnType<typeof vi.fn> }[] }));
vi.mock('bullmq', async () => {
  const actual = await vi.importActual<typeof import('bullmq')>('bullmq');
  const { EventEmitter } = await import('node:events');
  return { ...actual, Worker: class extends EventEmitter {
    close = vi.fn().mockResolvedValue(undefined);
    constructor(public name: string) { super(); state.workers.push({ name, close: this.close }); }
  } };
});
vi.mock('../../../shared/redis/index.js', () => ({ getRedisConnection: vi.fn() }));
vi.mock('../evidence/EvidenceGraphEngine.js', () => ({ EvidenceGraphEngine: class {} }));
vi.mock('../github/RepositoryIntelligenceEngine.js', () => ({ RepositoryIntelligenceEngine: class {} }));

import { startEvidenceGraphWorker, stopEvidenceGraphWorker, startEmbeddingWorker, stopEmbeddingWorker, startGithubAnalysisWorker, stopGithubAnalysisWorker } from './phase4-workers.js';

it.each([
  ['evidence-graph', startEvidenceGraphWorker, stopEvidenceGraphWorker],
  ['embedding-generation', startEmbeddingWorker, stopEmbeddingWorker],
  ['github-analysis', startGithubAnalysisWorker, stopGithubAnalysisWorker],
] as const)('retains, drains and can restart the %s consumer', async (name, start, stop) => {
  state.workers.length = 0;
  await stop();
  start(); start();
  expect(state.workers).toHaveLength(1);
  expect(state.workers[0].name).toBe(name);
  await stop(); await stop();
  expect(state.workers[0].close).toHaveBeenCalledOnce();
  start();
  expect(state.workers).toHaveLength(2);
  await stop();
  expect(state.workers[1].close).toHaveBeenCalledOnce();
});
