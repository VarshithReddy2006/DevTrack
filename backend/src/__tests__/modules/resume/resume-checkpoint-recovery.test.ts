import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResumeProcessingOrchestrator } from '../../../modules/resume/orchestration/ResumeProcessingOrchestrator.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';

vi.mock('../../../db/models/resumeSession.model.js', () => ({
  ResumeSession: { findOne: vi.fn() },
}));
vi.mock('../../../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe('ResumeProcessingOrchestrator checkpoint recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('restores the last committed state and resumes at the next stage', async () => {
    const session = {
      sessionId: 'resume-1',
      currentStage: 'FAILED',
      failureState: { failed: true, retryCount: 1 },
      checkpointState: {
        stage: 'PARSING',
        savedAt: new Date(),
        snapshot: {
          parsedContent: { text: 'restored resume', parsingDiagnostics: { warnings: [], errors: [] } },
          atsState: { analyzed: false },
        },
      },
      timestamps: { lastUpdated: new Date() },
      save: vi.fn().mockResolvedValue(undefined),
    } as any;
    vi.mocked(ResumeSession.findOne).mockResolvedValue(session);

    const orchestrator = new ResumeProcessingOrchestrator() as any;
    const transition = vi.spyOn(orchestrator, 'transitionToNextStage').mockResolvedValue(undefined);

    await orchestrator.resumeFromCheckpoint('resume-1');

    expect(session.parsedContent.text).toBe('restored resume');
    expect(session.currentStage).toBe('EXTRACTING');
    expect(session.failureState).toEqual({ failed: false, retryCount: 1 });
    expect(session.save).toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith('resume-1');
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
