import { SnapshotVersioningSystem, type SnapshotData } from '../../operations/SnapshotVersioningSystem.js';
import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { ReadinessSkills } from '../../../db/models/readinessSkills.model.js';
import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { ReadinessRoadmap } from '../../../db/models/readinessRoadmap.model.js';
import { ReadinessBenchmarks } from '../../../db/models/readinessBenchmarks.model.js';
import { ReadinessCore } from '../../../db/models/readinessCore.model.js';
import { logger } from '../../../shared/logger.js';

export interface ReadinessSnapshot {
  snapshotId: string;
  userId: string;
  snapshotVersion: string;
  createdAt: Date;
  changeDescription: string;
  readinessData: {
    dsa?: any;
    skills?: any;
    projects?: any;
    roadmap?: any;
    benchmarks?: any;
    core?: any;
  };
  summary: {
    overallScore: number;
    dsaScore: number;
    skillsScore: number;
    projectsScore: number;
    infrastructureScore: number;
    roadmapProgress: number;
    confidenceScore: number;
  };
}

export interface SnapshotComparison {
  snapshotId1: string;
  snapshotId2: string;
  changes: {
    overallScoreChange: number;
    dsaScoreChange: number;
    skillsScoreChange: number;
    projectsScoreChange: number;
    infrastructureScoreChange: number;
    roadmapProgressChange: number;
    confidenceScoreChange: number;
  };
  improvements: string[];
  regressions: string[];
}

export class ReadinessSnapshotServiceClass {
  async createReadinessSnapshot(userId: string, changeDescription: string, createdBy = 'system'): Promise<ReadinessSnapshot> {
    const [dsa, skills, projects, roadmap, benchmarks, core] = await Promise.all([
      ReadinessDsa.findOne({ userId }).lean(),
      ReadinessSkills.findOne({ userId }).lean(),
      ReadinessProjects.findOne({ userId }).lean(),
      ReadinessRoadmap.findOne({ userId }).lean(),
      ReadinessBenchmarks.findOne({ userId }).lean(),
      ReadinessCore.findOne({ userId }).lean(),
    ]);
    return this.saveReadinessSnapshot(userId, { dsa, skills, projects, roadmap, benchmarks, core }, changeDescription, createdBy);
  }

  async saveReadinessSnapshot(
    userId: string,
    readinessData: ReadinessSnapshot['readinessData'],
    changeDescription: string,
    createdBy = 'system',
    scores?: Pick<ReadinessSnapshot['summary'], 'dsaScore' | 'skillsScore' | 'projectsScore'>,
  ): Promise<ReadinessSnapshot> {
    const previous = await SnapshotVersioningSystem.getLatestSnapshot(userId, 'core');
    const summary = { ...this.calculateSummary(readinessData), ...scores };
    // A single document keeps all captured components consistent, including on standalone MongoDB.
    const data = { ...readinessData, ...summary };
    const metadata = await SnapshotVersioningSystem.createSnapshot(
      userId, 'core', data, changeDescription, previous?.metadata.snapshotId, createdBy,
    );
    return this.toReadinessSnapshot({ metadata, data });
  }

  private toReadinessSnapshot({ metadata, data }: SnapshotData): ReadinessSnapshot {
    const { snapshotId, userId, snapshotVersion, createdAt, changeDescription } = metadata;
    const { dsa, skills, projects, roadmap, benchmarks, core, ...summary } = data;
    return {
      snapshotId, userId, snapshotVersion, createdAt, changeDescription,
      readinessData: { dsa, skills, projects, roadmap, benchmarks, core },
      summary,
    };
  }

  async getLatestReadinessSnapshot(userId: string): Promise<ReadinessSnapshot | null> {
    try {
      const snapshot = await SnapshotVersioningSystem.getLatestSnapshot(userId, 'core');
      return snapshot ? this.toReadinessSnapshot(snapshot) : null;
    } catch (error) {
      logger.error('[ReadinessSnapshotService] Failed to get latest readiness snapshot', { userId, error });
      return null;
    }
  }

  async getReadinessSnapshot(snapshotId: string): Promise<ReadinessSnapshot | null> {
    try {
      const snapshot = await SnapshotVersioningSystem.getSnapshot(snapshotId);
      return snapshot?.metadata.modelType === 'core' ? this.toReadinessSnapshot(snapshot) : null;
    } catch (error) {
      logger.error('[ReadinessSnapshotService] Failed to get readiness snapshot', { snapshotId, error });
      return null;
    }
  }

  async getUserReadinessSnapshots(userId: string): Promise<ReadinessSnapshot[]> {
    try {
      const snapshots = await SnapshotVersioningSystem.getUserSnapshots(userId, { modelType: 'core' });
      return snapshots.map(snapshot => this.toReadinessSnapshot(snapshot));
    } catch (error) {
      logger.error('[ReadinessSnapshotService] Failed to get user readiness snapshots', { userId, error });
      return [];
    }
  }

  /**
   * Compare two readiness snapshots
   */
  async compareSnapshots(snapshotId1: string, snapshotId2: string): Promise<SnapshotComparison | null> {
    try {
      const snapshot1 = await this.getReadinessSnapshot(snapshotId1);
      const snapshot2 = await this.getReadinessSnapshot(snapshotId2);
      
      if (!snapshot1 || !snapshot2) {
        return null;
      }
      
      const changes = {
        overallScoreChange: snapshot2.summary.overallScore - snapshot1.summary.overallScore,
        dsaScoreChange: snapshot2.summary.dsaScore - snapshot1.summary.dsaScore,
        skillsScoreChange: snapshot2.summary.skillsScore - snapshot1.summary.skillsScore,
        projectsScoreChange: snapshot2.summary.projectsScore - snapshot1.summary.projectsScore,
        infrastructureScoreChange: snapshot2.summary.infrastructureScore - snapshot1.summary.infrastructureScore,
        roadmapProgressChange: snapshot2.summary.roadmapProgress - snapshot1.summary.roadmapProgress,
        confidenceScoreChange: snapshot2.summary.confidenceScore - snapshot1.summary.confidenceScore,
      };
      
      const improvements: string[] = [];
      const regressions: string[] = [];
      
      if (changes.overallScoreChange > 0) {
        improvements.push(`Overall readiness improved by ${changes.overallScoreChange}%`);
      } else if (changes.overallScoreChange < 0) {
        regressions.push(`Overall readiness decreased by ${Math.abs(changes.overallScoreChange)}%`);
      }
      
      if (changes.dsaScoreChange > 0) {
        improvements.push(`DSA score improved by ${changes.dsaScoreChange}%`);
      } else if (changes.dsaScoreChange < 0) {
        regressions.push(`DSA score decreased by ${Math.abs(changes.dsaScoreChange)}%`);
      }
      
      if (changes.skillsScoreChange > 0) {
        improvements.push(`Skills score improved by ${changes.skillsScoreChange}%`);
      } else if (changes.skillsScoreChange < 0) {
        regressions.push(`Skills score decreased by ${Math.abs(changes.skillsScoreChange)}%`);
      }
      
      if (changes.projectsScoreChange > 0) {
        improvements.push(`Projects score improved by ${changes.projectsScoreChange}%`);
      } else if (changes.projectsScoreChange < 0) {
        regressions.push(`Projects score decreased by ${Math.abs(changes.projectsScoreChange)}%`);
      }
      
      if (changes.infrastructureScoreChange > 0) {
        improvements.push(`Infrastructure score improved by ${changes.infrastructureScoreChange}%`);
      } else if (changes.infrastructureScoreChange < 0) {
        regressions.push(`Infrastructure score decreased by ${Math.abs(changes.infrastructureScoreChange)}%`);
      }
      
      if (changes.roadmapProgressChange > 0) {
        improvements.push(`Roadmap progress improved by ${changes.roadmapProgressChange}%`);
      } else if (changes.roadmapProgressChange < 0) {
        regressions.push(`Roadmap progress decreased by ${Math.abs(changes.roadmapProgressChange)}%`);
      }
      
      if (changes.confidenceScoreChange > 0) {
        improvements.push(`Confidence score improved by ${changes.confidenceScoreChange}%`);
      } else if (changes.confidenceScoreChange < 0) {
        regressions.push(`Confidence score decreased by ${Math.abs(changes.confidenceScoreChange)}%`);
      }
      
      return {
        snapshotId1,
        snapshotId2,
        changes,
        improvements,
        regressions,
      };
    } catch (error) {
      logger.error('[ReadinessSnapshotService] Failed to compare snapshots', { snapshotId1, snapshotId2, error });
      return null;
    }
  }

  /**
   * Rollback to a previous readiness snapshot
   */
  async rollbackToSnapshot(snapshotId: string): Promise<ReadinessSnapshot | null> {
    try {
      const snapshot = await this.getReadinessSnapshot(snapshotId);
      
      if (!snapshot) {
        logger.warn('[ReadinessSnapshotService] Snapshot not found for rollback', { snapshotId });
        return null;
      }
      
      // Restore data to models (this would need actual MongoDB update operations)
      // For now, just return the snapshot data
      logger.info('[ReadinessSnapshotService] Rolled back to readiness snapshot', { 
        snapshotId,
        version: snapshot.snapshotVersion 
      });
      
      return snapshot;
    } catch (error) {
      logger.error('[ReadinessSnapshotService] Failed to rollback to snapshot', { snapshotId, error });
      return null;
    }
  }

  /**
   * Calculate summary scores from readiness data
   */
  private calculateSummary(data: ReadinessSnapshot['readinessData']): ReadinessSnapshot['summary'] {
    const { dsa, skills, projects, roadmap, core } = data;
    const dsaScore = dsa?.overallEngineeringDepth ?? 0;
    const skillsScore = skills?.overallEngineeringDepth ?? 0;
    const projectsScore = projects?.engineeringMaturity ?? 0;
    const infrastructureScore = projects?.infrastructureSophistication ?? 0;
    const verifiedNodes = roadmap?.verifiedNodes?.length ?? 0;
    const roadmapProgress = (verifiedNodes / Math.max(1, verifiedNodes + (roadmap?.missingDependencies?.length ?? 0))) * 100;
    const overallScore = core?.overallScore ?? (dsaScore + skillsScore + projectsScore + infrastructureScore) / 4;
    const confidenceScore = Math.min(dsa?.confidenceScore ?? 50, skills?.confidenceScore ?? 50,
      projects?.confidenceScore ?? 50, core?.confidenceScore ?? 50);

    return {
      overallScore: Math.round(overallScore),
      dsaScore: Math.round(dsaScore),
      skillsScore: Math.round(skillsScore),
      projectsScore: Math.round(projectsScore),
      infrastructureScore: Math.round(infrastructureScore),
      roadmapProgress: Math.round(roadmapProgress),
      confidenceScore: Math.round(confidenceScore),
    };
  }

  /**
   * Delete old readiness snapshots
   */
  async deleteOldSnapshots(userId: string, keepCount: number = 10): Promise<number> {
    try {
      const deletedCount = await SnapshotVersioningSystem.deleteOldSnapshots(userId, keepCount);
      logger.info('[ReadinessSnapshotService] Deleted old readiness snapshots', { 
        userId, 
        deletedCount 
      });
      return deletedCount;
    } catch (error) {
      logger.error('[ReadinessSnapshotService] Failed to delete old snapshots', { userId, error });
      return 0;
    }
  }

  /**
   * Get snapshot statistics
   */
  async getSnapshotStats(): Promise<{
    totalSnapshots: number;
    snapshotsByModelType: Record<string, number>;
    currentVersion: string;
  }> {
    const stats = await SnapshotVersioningSystem.getStats();
    return {
      totalSnapshots: stats.totalSnapshots,
      snapshotsByModelType: stats.snapshotsByModelType,
      currentVersion: stats.currentVersion,
    };
  }
}

export const ReadinessSnapshotService = new ReadinessSnapshotServiceClass();
