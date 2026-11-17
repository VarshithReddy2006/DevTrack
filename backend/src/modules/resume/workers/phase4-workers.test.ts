import { it, expect, vi } from 'vitest';

type Processor = (job: { id: string; data: Record<string, string> }) => Promise<unknown>;
const state = vi.hoisted(() => ({
  workers: [] as { name: string; close: ReturnType<typeof vi.fn>; processor: Processor }[],
  buildGraph: vi.fn(),
  analyzeRepository: vi.fn(),
}));
vi.mock('bullmq', async () => {
  const actual = await vi.importActual<typeof import('bullmq')>('bullmq');
  const { EventEmitter } = await import('node:events');
  return { ...actual, Worker: class extends EventEmitter {
    close = vi.fn().mockResolvedValue(undefined);
    constructor(public name: string, processor: Processor) { super(); state.workers.push({ name, processor, close: this.close }); }
  } };
});
vi.mock('../../../shared/redis/index.js', () => ({ getRedisConnection: vi.fn() }));
vi.mock('../evidence/EvidenceGraphEngine.js', () => ({
  EvidenceGraphEngine: class { buildGraphForUser = state.buildGraph; },
}));
vi.mock('../github/RepositoryIntelligenceEngine.js', () => ({
  RepositoryIntelligenceEngine: class { analyzeRepository = state.analyzeRepository; },
}));

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

it('returns the repository analysis to BullMQ and dispatches graph rebuilds for the job owner', async () => {
  state.workers.length = 0;
  const analysis = { status: 'complete', repository: 'Example/Project' };
  state.analyzeRepository.mockResolvedValue(analysis);
  startGithubAnalysisWorker();
  startEvidenceGraphWorker();
  try {
    const repoUrl = 'https://github.com/Example/Project';
    const userId = '668000000000000000000000';
    await expect(state.workers[0].processor({ id: 'repo', data: { repoUrl } })).resolves.toBe(analysis);
    expect(state.analyzeRepository).toHaveBeenCalledWith(repoUrl);
    await state.workers[1].processor({ id: 'evidence', data: { userId } });
    expect(state.buildGraph).toHaveBeenCalledWith(userId);
  } finally {
    await stopGithubAnalysisWorker();
    await stopEvidenceGraphWorker();
  }
});
