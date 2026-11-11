// src/modules/resume-intelligence/replay/IntelligenceReplayEngine.ts
import { logger } from '../../../shared/logger.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { ReplayPersistenceEngine } from '../../persistence/ReplayPersistenceEngine.js';

export interface IIntelligenceSnapshot {
  userId: string;
  timestamp: Date;
  stateType: 'readiness' | 'ats' | 'ranking' | 'embeddings' | 'recommendation' | 'evidence_graph' | 'credibility';
  stateData: any;
}

/**
 * IntelligenceReplayEngine
 * 
 * Stores and replays intelligence evolution over time for debugging and calibration.
 */
export class IntelligenceReplayEngine {
  private persistence = new ReplayPersistenceEngine();

  async captureSnapshot(snapshot: IIntelligenceSnapshot): Promise<void> {
    logger.info(`[ReplayEngine] Capturing ${snapshot.stateType} snapshot for user ${snapshot.userId}`);
    await this.persistence.snapshotState(
      `intelligence:${snapshot.userId}:${snapshot.stateType}:${snapshot.timestamp.getTime()}`,
      snapshot
    );
  }

  async replayHistory(userId: string, stateType: string, fromDate: Date, toDate: Date): Promise<any[]> {
    logger.info(`[ReplayEngine] Replaying ${stateType} history for user ${userId}`);
    const query: any = {
      userId,
      'timestamps.completedAt': { $gte: fromDate, $lte: toDate },
    };

    const sessions = await ResumeSession.find(query)
      .sort({ 'timestamps.completedAt': 1 })
      .lean();

    const sessionSnapshots = sessions.flatMap((session) => {
      if (stateType === 'runtime') {
        return session.runtimeEvents || [];
      }
      if (stateType === 'evolution') {
        return session.evolutionSnapshots || [];
      }
      if (stateType === 'replay') {
        return session.replayState?.timeline || session.replayState?.snapshots || [];
      }
      return (session.replayState?.snapshots || []).filter((snapshot: any) => snapshot.stage === stateType || snapshot.stateType === stateType);
    });

    const capturedSnapshots = await this.persistence.querySnapshots({
      userId,
      stateType,
      fromDate,
      toDate,
    });

    const combined = [...sessionSnapshots, ...capturedSnapshots];
    combined.sort((a, b) => {
      const timeA = new Date(a.timestamp || a.occurredAt || 0).getTime();
      const timeB = new Date(b.timestamp || b.occurredAt || 0).getTime();
      return timeA - timeB;
    });

    return combined;
  }

  async replaySession(sessionId: string): Promise<any[]> {
    logger.info(`[ReplayEngine] Replaying real session timeline ${sessionId}`);
    const persisted = await this.persistence.restoreSessionReplay(sessionId);
    if (persisted.length > 0) return persisted;
    return this.persistence.persistSessionReplay(sessionId);
  }
}
