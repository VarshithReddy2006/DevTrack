// GET /readiness/snapshot: additive `inputs` behind the readiness-v2 flag.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const mocks = vi.hoisted(() => ({
  computeDynamicSnapshot: vi.fn(),
  isFlagEnabled: vi.fn(),
}));

vi.mock('../../../modules/readiness/engine/ReadinessOrchestratorService.js', () => ({
  ReadinessOrchestratorService: { computeDynamicSnapshot: mocks.computeDynamicSnapshot },
  DomainIntelligenceService: {},
}));
vi.mock('../../../modules/flags/flags.service.js', () => ({ isFlagEnabled: mocks.isFlagEnabled }));

import { ReadinessController } from '../../../modules/readiness/readiness.controller.js';
import { ReadinessSnapshotService } from '../../../modules/readiness/snapshot/ReadinessSnapshotService.js';
import { handleFocusSessionCompleted, handleRevisionReviewed } from '../../../modules/readiness/consumers/index.js';
import { createDomainEvent } from '../../../shared/events/eventContract.js';

const userId = new Types.ObjectId().toString();
const V1_SNAPSHOT = { overallScore: 71, roadmap: { stage: 'Intermediate' }, skills: [{ name: 'node', level: 3 }] };
// What the endpoint returned before this change, captured as a literal on purpose.
const V1_GOLDEN = '{"success":true,"data":{"overallScore":71,"roadmap":{"stage":"Intermediate"},"skills":[{"name":"node","level":3}]}}';

async function callSnapshot() {
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
  await ReadinessController.getSnapshot({ user: { id: userId } } as never, res as never);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.computeDynamicSnapshot.mockResolvedValue(structuredClone(V1_SNAPSHOT));
});

describe('GET /readiness/snapshot inputs', () => {
  it('returns a byte-identical v1 payload when readiness-v2 is off', async () => {
    mocks.isFlagEnabled.mockResolvedValue(false);
    const res = await callSnapshot();
    expect(mocks.isFlagEnabled).toHaveBeenCalledWith('readiness-v2', userId);
    expect(JSON.stringify(res.json.mock.calls[0][0])).toBe(V1_GOLDEN);
  });

  it('adds inputs next to the untouched v1 fields when readiness-v2 is on', async () => {
    mocks.isFlagEnabled.mockResolvedValue(true);
    const now = new Date();
    await handleFocusSessionCompleted(createDomainEvent('focus.session.completed', {
      sessionId: 's1', plannedDurationMinutes: 30, activeDurationMs: 30 * 60_000, coveredHeartbeatIntervals: 30, completedAt: now.toISOString(),
    }, { userId }));
    await handleRevisionReviewed(createDomainEvent('revision.reviewed', {
      cardId: 'c1', reviewSeq: 1, rating: 'failed', reviewedAt: now.toISOString(),
    }, { userId }));

    const res = await callSnapshot();
    const body = res.json.mock.calls[0][0];
    const { inputs, ...v1Fields } = body.data;
    expect(JSON.stringify({ success: body.success, data: v1Fields })).toBe(V1_GOLDEN);
    expect(inputs).toMatchObject({
      windowDays: 7,
      focus: { qualifiedSessions7d: 1, focusMinutes7d: 30, activeDays7d: 1, consistencyTier: 'emerging' },
      revision: { cardsReviewed7d: 1, lapses7d: 1, retentionRate7d: 0 },
      jobTargets: { activeTargetsCount: 0, latestTarget: null },
    });
  });

  it('returns zeroed inputs for a user with no consumer data yet', async () => {
    mocks.isFlagEnabled.mockResolvedValue(true);
    const res = await callSnapshot();
    expect(res.json.mock.calls[0][0].data.inputs).toMatchObject({
      focus: { qualifiedSessions7d: 0, consistencyTier: 'none' },
      revision: { cardsReviewed7d: 0, retentionRate7d: null },
    });
  });

  it('falls back to the v1 payload when the flag lookup fails', async () => {
    mocks.isFlagEnabled.mockRejectedValue(new Error('flag cache down'));
    const res = await callSnapshot();
    expect(JSON.stringify(res.json.mock.calls[0][0])).toBe(V1_GOLDEN);
  });

  it('falls back to the v1 payload when reading inputs fails', async () => {
    mocks.isFlagEnabled.mockResolvedValue(true);
    const spy = vi.spyOn(ReadinessSnapshotService, 'getInputs').mockRejectedValueOnce(new Error('db down'));
    const res = await callSnapshot();
    expect(JSON.stringify(res.json.mock.calls[0][0])).toBe(V1_GOLDEN);
    spy.mockRestore();
  });
});

describe('ReadinessSnapshotService.getInputs', () => {
  it('lets counters decay once their day leaves the 7 day window', async () => {
    const now = new Date('2026-11-17T09:00:00.000Z');
    await handleFocusSessionCompleted(createDomainEvent('focus.session.completed', {
      sessionId: 's1', plannedDurationMinutes: 25, activeDurationMs: 25 * 60_000, coveredHeartbeatIntervals: 25, completedAt: now.toISOString(),
    }, { userId }), undefined, now);

    expect((await ReadinessSnapshotService.getInputs(userId, now)).focus.qualifiedSessions7d).toBe(1);
    expect((await ReadinessSnapshotService.getInputs(userId, new Date('2026-11-23T23:00:00.000Z'))).focus.qualifiedSessions7d).toBe(1);
    expect((await ReadinessSnapshotService.getInputs(userId, new Date('2026-11-24T00:00:00.000Z'))).focus.qualifiedSessions7d).toBe(0);
  });

  it('returns empty inputs for an id that is not an ObjectId', async () => {
    expect((await ReadinessSnapshotService.getInputs('nope')).focus.consistencyTier).toBe('none');
  });
});
