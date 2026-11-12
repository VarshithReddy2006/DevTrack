import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { EvidenceChainRecord } from '../../../db/models/evidenceChainRecord.model.js';
import { ReadinessSnapshotRecord, ReadinessSnapshotVersion } from '../../../db/models/readinessSnapshotRecord.model.js';
import { ReadinessCore } from '../../../db/models/readinessCore.model.js';
import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { EvidenceChainSystemClass } from '../../../modules/operations/EvidenceChainSystem.js';
import { SnapshotVersioningSystemClass } from '../../../modules/operations/SnapshotVersioningSystem.js';
import { DomainIntelligenceService } from '../../../modules/readiness/engine/ReadinessOrchestratorService.js';
import { EngineeringEvolutionTimelineClass } from '../../../modules/readiness/evolution/EngineeringEvolutionTimeline.js';
import { TrustAwareReadinessScoringEngine } from '../../../modules/readiness/scoring/TrustAwareReadinessScoringEngine.js';
import { ReadinessSnapshotServiceClass } from '../../../modules/readiness/snapshot/ReadinessSnapshotService.js';

const newUserId = () => new Types.ObjectId().toHexString();

beforeAll(async () => {
  await Promise.all([ReadinessSnapshotRecord.init(), ReadinessSnapshotVersion.init(), EvidenceChainRecord.init()]);
});

describe('persisted readiness history', () => {
  it('loads complete historical captures, comparison, lineage and chronological evolution from fresh instances', async () => {
    const userId = newUserId();
    const writer = new ReadinessSnapshotServiceClass();
    await ReadinessCore.create({ userId, overallScore: 40 });
    await ReadinessDsa.create({ userId, topics: [{ name: 'Graphs', masteryLevel: 50 }] });
    const first = await writer.createReadinessSnapshot(userId, 'Baseline');

    await ReadinessCore.updateOne({ userId }, { overallScore: 68 });
    await ReadinessDsa.updateOne({ userId }, { 'topics.0.masteryLevel': 75 });
    await ReadinessProjects.create({ userId, systemDesignSignals: { hasRedis: true } });
    const second = await writer.createReadinessSnapshot(userId, 'Verified project');
    await writer.createReadinessSnapshot(newUserId(), 'Another account');

    const reader = new ReadinessSnapshotServiceClass();
    const versions = new SnapshotVersioningSystemClass();
    expect((await reader.getLatestReadinessSnapshot(userId))?.snapshotId).toBe(second.snapshotId);
    expect((await reader.getReadinessSnapshot(first.snapshotId))?.readinessData.dsa.topics[0].masteryLevel).toBe(50);
    expect((await reader.getReadinessSnapshot(first.snapshotId))?.readinessData.projects).toBeNull();
    expect((await reader.compareSnapshots(first.snapshotId, second.snapshotId))?.changes.overallScoreChange).toBe(28);
    expect(await versions.getVersionHistory(second.snapshotId)).toMatchObject([
      { snapshotId: second.snapshotId, parentSnapshotId: first.snapshotId },
      { snapshotId: first.snapshotId, childSnapshotIds: [second.snapshotId] },
    ]);

    await versions.createSnapshot(userId, 'dsa', { overallScore: 100 }, 'Component only');
    const expired = await versions.createSnapshot(userId, 'core', { overallScore: 1 }, 'Outside the selected timeframe');
    await ReadinessSnapshotRecord.updateOne(
      { 'metadata.snapshotId': expired.snapshotId },
      { 'metadata.createdAt': new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) },
    );
    const timeline = await new EngineeringEvolutionTimelineClass().generateTimeline({ userId });
    expect(timeline.overallTrajectory.map(point => point.overallScore)).toEqual([40, 68]);
    expect(timeline.milestones.map(milestone => milestone.title)).toEqual(
      expect.arrayContaining(['Redis caching verified', 'Graph mastery achieved']),
    );
    expect(timeline.progressionEvents).toContainEqual(expect.objectContaining({
      eventType: 'improvement', previousValue: 40, newValue: 68, component: 'overall',
    }));
    expect(await DomainIntelligenceService.computeDomainIntelligence(userId, 'evolution')).toMatchObject({
      intelligence: { snapshotTimeline: { overallTrajectory: [{ overallScore: 40 }, { overallScore: 68 }] } },
    });
  });

  it('captures durable history from persisted scoring and leaves preview scoring read-only', async () => {
    const userId = newUserId();
    await ReadinessDsa.create({ userId, totalSolves: 100, confidenceScore: 80 });
    await TrustAwareReadinessScoringEngine.calculateReadinessScore({ userId, persist: false });
    const snapshots = new ReadinessSnapshotServiceClass();
    expect(await snapshots.getLatestReadinessSnapshot(userId)).toBeNull();

    const score = await TrustAwareReadinessScoringEngine.calculateReadinessScore({ userId });
    expect(await snapshots.getLatestReadinessSnapshot(userId)).toMatchObject({
      summary: { overallScore: score.overallScore, dsaScore: score.dsaScore },
      readinessData: { dsa: { totalSolves: 100 } },
    });
  });

  it('allocates distinct versions across writers and prunes only the selected user', async () => {
    const userId = newUserId();
    const otherUser = newUserId();
    const writers = [new SnapshotVersioningSystemClass(), new SnapshotVersioningSystemClass()];
    const versions = await Promise.all(writers.map(writer => writer.createSnapshot(userId, 'core', {}, 'Concurrent')));
    expect(new Set(versions.map(version => version.snapshotVersion)).size).toBe(2);
    await writers[0].createSnapshot(otherUser, 'core', {}, 'Different user');
    expect(await writers[1].deleteOldSnapshots(userId, 1)).toBe(1);
    expect(await writers[0].getUserSnapshots(userId)).toHaveLength(1);
    expect(await writers[0].getUserSnapshots(otherUser)).toHaveLength(1);
  });

  it('preserves concurrent evidence writes, insight links and completion across instances', async () => {
    const first = new EvidenceChainSystemClass();
    const second = new EvidenceChainSystemClass();
    const userId = newUserId();
    const chain = await first.createChain(userId, 'readiness');
    const other = await first.createChain(newUserId(), 'other');
    const [submission, commit, unrelated] = await Promise.all([
      first.addEvidenceNode(chain.chainId, 'submission', 'dsa', { accepted: true }, 90),
      second.addEvidenceNode(chain.chainId, 'commit', 'project', {}, 70),
      second.addEvidenceNode(other.chainId, 'other', 'skill', {}, 10),
    ]);
    await second.linkEvidenceToInsight(
      chain.chainId, 'insight-1', 'skill-verification',
      [submission.evidenceId, commit.evidenceId, unrelated.evidenceId], 'Verified sources', 1,
    );
    await first.markChainComplete(chain.chainId);

    const reader = new EvidenceChainSystemClass();
    expect(await reader.getChain(chain.chainId)).toMatchObject({ isComplete: true, nodes: expect.arrayContaining([submission, commit]) });
    expect(await reader.explainInsight('insight-1')).toMatchObject({
      evidence: [submission, commit], reasoning: ['Verified sources'], totalConfidence: 80,
    });
    expect(await reader.getAuditTrail(userId)).toMatchObject({ totalEvidence: 2, totalLinks: 1, averageConfidence: 80 });
    expect(await reader.getStats()).toEqual({
      totalChains: 2, totalEvidenceNodes: 3, totalLinks: 1, completedChains: 1, averageChainSize: 2,
    });
  });

  it('installs the retention indexes on both collections', async () => {
    const [snapshots, chains] = await Promise.all([ReadinessSnapshotRecord.listIndexes(), EvidenceChainRecord.listIndexes()]);
    const expireAfterSeconds = 365 * 24 * 60 * 60;
    expect(snapshots).toContainEqual(expect.objectContaining({ key: { 'metadata.createdAt': 1 }, expireAfterSeconds }));
    expect(chains).toContainEqual(expect.objectContaining({ key: { createdAt: 1 }, expireAfterSeconds }));
  });
});
