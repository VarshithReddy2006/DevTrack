import { logger } from '../../shared/logger.js';
import { ResumeSession } from '../../db/models/resumeSession.model.js';
import { UnifiedRuntimeStateStore, type ISnapshotQueryFilter } from './UnifiedRuntimeStateStore.js';

export class ReplayPersistenceEngine {
  private store = new UnifiedRuntimeStateStore();

  async snapshotState(stateId: string, state: any): Promise<void> {
    logger.info(`[ReplayPersistence] Snapshotting state ${stateId}`);
    await this.store.saveState(stateId, state);
  }

  async restoreState(stateId: string): Promise<any> {
    logger.info(`[ReplayPersistence] Restoring state ${stateId}`);
    return this.store.getState(stateId);
  }

  async querySnapshots(filter: ISnapshotQueryFilter): Promise<any[]> {
    return this.store.querySnapshots(filter);
  }

  async persistSessionReplay(sessionId: string): Promise<any[]> {
    const session = await ResumeSession.findOne({ sessionId }).lean();
    if (!session) {
      throw new Error(`Resume session not found for replay persistence: ${sessionId}`);
    }

    const timeline = [
      ...((session.runtimeEvents || []) as any[]).map((event) => ({
        type: 'runtime_event',
        stage: event.emittedStage || event.stage,
        status: event.status,
        timestamp: event.timestamp,
        progress: event.progress,
        confidence: event.confidence,
        latencyMs: event.latencyMs,
        warnings: event.warnings || [],
        errors: event.errors || [],
        metadata: event.metadata || {},
      })),
      ...((session.replayState?.snapshots || []) as any[]).map((snapshot) => ({
        type: 'state_snapshot',
        ...snapshot,
      })),
      ...((session.evolutionSnapshots || []) as any[]).map((snapshot) => ({
        type: 'evolution_delta',
        ...snapshot,
      })),
    ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    await ResumeSession.updateOne(
      { sessionId },
      {
        $set: {
          'replayState.generated': true,
          'replayState.timeline': timeline,
          'replayState.generatedAt': new Date(),
          'timestamps.lastUpdated': new Date(),
        },
      }
    );

    await this.snapshotState(`resume:${sessionId}:timeline`, timeline);
    return timeline;
  }

  async restoreSessionReplay(sessionId: string): Promise<any[]> {
    const session = await ResumeSession.findOne({ sessionId }).lean();
    if (!session) {
      throw new Error(`Resume session not found for replay restore: ${sessionId}`);
    }

    if (session.replayState?.timeline?.length) {
      return session.replayState.timeline;
    }

    const restored = await this.restoreState(`resume:${sessionId}:timeline`);
    return Array.isArray(restored) ? restored : [];
  }
}
