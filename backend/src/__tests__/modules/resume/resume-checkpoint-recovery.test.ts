import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResumeProcessingOrchestrator } from '../../../modules/resume/orchestration/ResumeProcessingOrchestrator.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';

vi.mock('../../../db/models/resumeSession.model.js', () => ({
  ResumeSession: { findOne: vi.fn() },
}));
vi.mock('../../../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe('ResumeProcessingOrchestrator checkpoint recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    {
      checkpoint: 'PARSING',
      remaining: ['EXTRACTING', 'ATS_ANALYZING', 'EMBEDDING', 'SEMANTIC_ANALYZING', 'RECOMMENDING', 'REPLAY_GENERATING'],
    },
    {
      checkpoint: 'SEMANTIC_ANALYZING',
      remaining: ['RECOMMENDING', 'REPLAY_GENERATING'],
    },
    {
      checkpoint: 'RECOMMENDING',
      remaining: ['REPLAY_GENERATING'],
    },
  ])('retries the failed stage after $checkpoint and completes', async ({ checkpoint, remaining }) => {
    const session = {
      sessionId: 'resume-1',
      currentStage: checkpoint,
      failureState: { failed: false },
      parsedContent: { text: 'committed resume' },
      atsState: { analyzed: false },
      embeddingState: { generated: false },
      semanticState: { analyzed: false },
      recommendationState: { generated: false },
      replayState: { generated: false },
      degradedState: { degraded: false },
      processingHistory: [],
      timestamps: { lastUpdated: new Date() },
      save: vi.fn().mockResolvedValue(undefined),
    } as any;
    vi.mocked(ResumeSession.findOne).mockResolvedValue(session);

    const orchestrator = new ResumeProcessingOrchestrator() as any;
    vi.spyOn(orchestrator, 'streamProgress').mockResolvedValue(undefined);
    const executeStage = vi.spyOn(orchestrator, 'executeStage').mockImplementation(async () => {
      session.parsedContent = { text: 'partial update' };
      throw new Error('Stage failed');
    });

    vi.useFakeTimers();
    try {
      await orchestrator.saveCheckpoint(session, checkpoint);
      const processing = orchestrator.transitionToNextStage(session.sessionId);
      await vi.runAllTimersAsync();
      await processing;
    } finally {
      vi.useRealTimers();
    }

    expect(executeStage.mock.calls.map(([, stage]) => stage)).toEqual(Array(3).fill(remaining[0]));
    expect(session.currentStage).toBe('FAILED');
    expect(session.checkpointState.stage).toBe(checkpoint);

    executeStage.mockClear().mockResolvedValue(undefined);
    await orchestrator.resumeFromCheckpoint(session.sessionId);

    expect(executeStage.mock.calls.map(([, stage]) => stage)).toEqual(remaining);
    expect(session.parsedContent.text).toBe('committed resume');
    expect(session.currentStage).toBe('COMPLETED');
    expect(session.failureState).toEqual({ failed: false, retryCount: 1 });
  });

  it('persists a checkpoint with the state needed to compensate later stages', async () => {
    const session = {
      parsedContent: { text: 'resume' },
      atsState: { analyzed: true },
      embeddingState: { generated: false },
      semanticState: { analyzed: false },
      recommendationState: { generated: false },
      replayState: { generated: false },
      reportState: { generated: false },
      degradedState: { degraded: false },
      evolutionSnapshots: [],
      save: vi.fn().mockResolvedValue(undefined),
    } as any;
    const orchestrator = new ResumeProcessingOrchestrator() as any;

    await orchestrator.saveCheckpoint(session, 'ATS_ANALYZING');

    expect(session.checkpointState.stage).toBe('ATS_ANALYZING');
    expect(session.checkpointState.snapshot.atsState).toEqual({ analyzed: true });
    expect(session.checkpointState.snapshot.replayState).toEqual({ generated: false });
    expect(session.save).toHaveBeenCalledOnce();
  });
});
