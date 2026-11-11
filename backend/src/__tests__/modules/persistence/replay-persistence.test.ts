import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { UnifiedRuntimeStateStore, RuntimeSnapshot } from '../../../modules/persistence/UnifiedRuntimeStateStore.js';
import { ReplayPersistenceEngine } from '../../../modules/persistence/ReplayPersistenceEngine.js';
import { IntelligenceReplayEngine, type IIntelligenceSnapshot } from '../../../modules/resume/replay/IntelligenceReplayEngine.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';

describe('Replay Persistence & Cross-Instance Durability', () => {
  beforeEach(async () => {
    await RuntimeSnapshot.deleteMany({});
    await ResumeSession.deleteMany({});
  });

  it('retrieves snapshots across separate UnifiedRuntimeStateStore instances via MongoDB backing', async () => {
    const store1 = new UnifiedRuntimeStateStore();
    const testPayload = {
      version: 1,
      metrics: { confidence: 0.92, readinessScore: 88 },
      tags: ['system-design', 'distributed-systems'],
    };

    await store1.saveState('test:state:instance-1', testPayload);

    // Instantiate a separate store instance to simulate another process or post-restart instance
    const store2 = new UnifiedRuntimeStateStore();
    const retrieved = await store2.getState('test:state:instance-1');

    expect(retrieved).not.toBeNull();
    expect(retrieved).toEqual(testPayload);
  });

  it('persists and restores state via ReplayPersistenceEngine across fresh instances', async () => {
    const engine1 = new ReplayPersistenceEngine();
    const timelineState = [
      { type: 'runtime_event', stage: 'PARSING', status: 'completed', progress: 30, timestamp: new Date() },
      { type: 'runtime_event', stage: 'ATS_ANALYZING', status: 'completed', progress: 60, timestamp: new Date() },
    ];

    await engine1.snapshotState('resume:session-abc-123:timeline', timelineState);

    // Create a fresh ReplayPersistenceEngine instance
    const engine2 = new ReplayPersistenceEngine();
    const restored = await engine2.restoreState('resume:session-abc-123:timeline');

    expect(restored).not.toBeNull();
    expect(restored).toHaveLength(2);
    expect(restored[0].stage).toBe('PARSING');
    expect(restored[1].stage).toBe('ATS_ANALYZING');
  });

  it('captures snapshots in IntelligenceReplayEngine and queries them via replayHistory', async () => {
    const engine = new IntelligenceReplayEngine();
    const userId = new mongoose.Types.ObjectId().toString();
    const baseDate = new Date('2026-11-10T12:00:00.000Z');

    const snapshot1: IIntelligenceSnapshot = {
      userId,
      timestamp: new Date(baseDate.getTime() + 1000),
      stateType: 'readiness',
      stateData: { score: 75, targetRole: 'Backend Engineer' },
    };

    const snapshot2: IIntelligenceSnapshot = {
      userId,
      timestamp: new Date(baseDate.getTime() + 5000),
      stateType: 'readiness',
      stateData: { score: 85, targetRole: 'Backend Engineer' },
    };

    await engine.captureSnapshot(snapshot1);
    await engine.captureSnapshot(snapshot2);

    // Fresh engine instance simulates query from another worker/API process
    const queryEngine = new IntelligenceReplayEngine();
    const history = await queryEngine.replayHistory(
      userId,
      'readiness',
      new Date(baseDate.getTime()),
      new Date(baseDate.getTime() + 10000)
    );

    expect(history).toHaveLength(2);
    expect(history[0].stateData.score).toBe(75);
    expect(history[1].stateData.score).toBe(85);
  });

  it('persists and restores resume session replay timeline into persistent store and ResumeSession', async () => {
    const sessionId = `test-sess-${Date.now()}`;
    const userId = new mongoose.Types.ObjectId();

    await ResumeSession.create({
      sessionId,
      userId,
      currentStage: 'COMPLETED',
      uploadMetadata: {
        originalFilename: 'resume.pdf',
        fileType: 'pdf',
        fileSize: 1024,
        mimeType: 'application/pdf',
        uploadPath: '/tmp/resume.pdf',
        uploadedAt: new Date(),
      },
      parsedContent: {
        text: 'Software Engineer',
        sections: {},
        headings: [],
        bullets: [],
        links: [],
        metadata: {},
        parsingDiagnostics: { confidence: 0.95, warnings: [], errors: [] },
      },
      runtimeEvents: [
        {
          stage: 'UPLOADED',
          status: 'completed',
          timestamp: new Date(Date.now() - 5000),
          progress: 10,
        },
        {
          stage: 'ATS_ANALYZING',
          status: 'completed',
          timestamp: new Date(Date.now() - 2000),
          progress: 80,
        },
      ],
      timestamps: {
        uploadedAt: new Date(),
        lastUpdated: new Date(),
      },
    });

    const persistence1 = new ReplayPersistenceEngine();
    const generatedTimeline = await persistence1.persistSessionReplay(sessionId);

    expect(generatedTimeline).toHaveLength(2);
    expect(generatedTimeline[0].stage).toBe('UPLOADED');

    // Fresh instance restores from persistent store
    const persistence2 = new ReplayPersistenceEngine();
    const restoredTimeline = await persistence2.restoreSessionReplay(sessionId);

    expect(restoredTimeline).toHaveLength(2);
    expect(restoredTimeline[0].stage).toBe('UPLOADED');
    expect(restoredTimeline[1].stage).toBe('ATS_ANALYZING');
  });
});
