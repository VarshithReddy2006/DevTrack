import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { UnifiedRuntimeStateStore, RuntimeSnapshot } from '../../../modules/persistence/UnifiedRuntimeStateStore.js';
import { ReplayPersistenceEngine } from '../../../modules/persistence/ReplayPersistenceEngine.js';
import { IntelligenceReplayEngine, type IIntelligenceSnapshot } from '../../../modules/resume/replay/IntelligenceReplayEngine.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';

const redis = vi.hoisted(() => ({ status: 'ready', get: vi.fn(), set: vi.fn() }));
vi.mock('../../../shared/redis/index.js', () => ({ getRedisClient: () => redis }));

describe('Replay Persistence & Cross-Instance Durability', () => {
  beforeEach(async () => {
    const cache = new Map<string, string>();
    redis.get.mockReset().mockImplementation(async (key: string) => cache.get(key) ?? null);
    redis.set.mockReset().mockImplementation(async (key: string, value: string) => { cache.set(key, value); });
    await RuntimeSnapshot.deleteMany({});
    await ResumeSession.deleteMany({});
  });

  it('rejects a failed durable capture and keeps it out of the cache', async () => {
    const engine = new IntelligenceReplayEngine();
    const update = vi.spyOn(RuntimeSnapshot, 'updateOne').mockRejectedValueOnce(new Error('Mongo write failed'));
    try {
      await expect(engine.captureSnapshot({
        userId: 'test-user', stateType: 'readiness', timestamp: new Date(), stateData: { score: 75 },
      })).rejects.toThrow('Mongo write failed');
      expect(redis.set).not.toHaveBeenCalled();
      expect(await RuntimeSnapshot.countDocuments()).toBe(0);
    } finally {
      update.mockRestore();
    }
  });

  it('never serves the old Redis revision after a durable overwrite', async () => {
    const writer = new UnifiedRuntimeStateStore();
    const reader = new UnifiedRuntimeStateStore();
    await writer.saveState('replay', { value: 'old' });
    expect(await reader.getState('replay')).toEqual({ value: 'old' });
    const oldKey = redis.set.mock.calls[0][0];

    await writer.saveState('replay', { value: 'new' });
    redis.set.mockRejectedValueOnce(new Error('Redis write failed'));
    expect(await reader.getState('replay')).toEqual({ value: 'new' });
    expect(redis.get.mock.lastCall?.[0]).not.toBe(oldKey);
    expect(await redis.get(oldKey)).toBe('{"value":"old"}');
  });

  it('returns durable state when Redis commands never settle', async () => {
    const store = new UnifiedRuntimeStateStore();
    redis.get.mockReturnValueOnce(new Promise(() => {}));
    redis.set.mockReturnValueOnce(new Promise(() => {}));

    await store.saveState('redis-outage', { ready: true });
    expect(redis.set).not.toHaveBeenCalled();
    await expect(store.getState('redis-outage')).resolves.toEqual({ ready: true });
    expect(redis.get).toHaveBeenCalledOnce();
    expect(redis.set).toHaveBeenCalledOnce();
  }, 3000);

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
