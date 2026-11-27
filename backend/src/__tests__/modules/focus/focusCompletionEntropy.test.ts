import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { FocusSession, ProfileAuditLog } from '../../../db/models/index.js';
import { FocusEngine } from '../../../modules/activity/focusEngine.service.js';
import { auditRowsFor, decryptChainedAuditEvent } from '../../../modules/audit/auditLedger.service.js';

vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitRuntimeStatePatch: vi.fn() } }));

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function humanGaps(n: number, seed = 7): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => (r() < 0.12 ? 1000 + r() * 3000 : 80 + r() * 170));
}

/** Seed a qualifying 25-minute session so a genuine completion earns 50 XP. */
async function seedQualifyingSession(engine: FocusEngine, owner: string): Promise<string> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
  const { sessionId } = await engine.startSession(owner, 'deep_work', 25);
  await FocusSession.findByIdAndUpdate(sessionId, {
    activeDurationMs: 1_500_000,
    activeSec: 1500,
    coveredHeartbeatIntervals: 25,
    heartbeatCount: 25,
    lastResumedAt: new Date('2026-11-02T10:00:00Z'),
  });
  return sessionId;
}

async function completeWith(engine: FocusEngine, sessionId: string, owner: string, gaps: number[], keys: string[]) {
  vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
  return engine.completeSession(sessionId, owner, { gaps, keys });
}

describe('focus completion entropy gating', () => {
  let owner: string;
  let engine: FocusEngine;

  beforeEach(() => {
    owner = new Types.ObjectId().toString();
    engine = new FocusEngine();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('denies XP and audits a uniform 2000 ms script', async () => {
    const sessionId = await seedQualifyingSession(engine, owner);
    const gaps = Array(60).fill(2000);
    const keys = Array.from({ length: 61 }, (_, i) => 'abcd'[i % 4]);

    const result = await completeWith(engine, sessionId, owner, gaps, keys);

    expect(result).not.toBeNull();
    expect(result!.session.xp!.amount).toBe(0);
    expect(result!.session.xp!.reason).toBe('anti_gaming');
    expect(result!.session.xp!.capApplied).toBe(false);

    const logs = await ProfileAuditLog.find({ ...await auditRowsFor(new Types.ObjectId(owner)), eventType: 'anti_gaming_check' }).lean();
    expect(logs.length).toBeGreaterThan(0);
    expect(await decryptChainedAuditEvent(logs[0], owner)).toMatchObject({ reason: 'periodic intervals' });
    expect(logs[0].triggeredBy).toBe('system');
  });

  it('denies XP and audits a stuck key with identical repeat rate', async () => {
    const sessionId = await seedQualifyingSession(engine, owner);
    const gaps = humanGaps(60);
    const keys = Array(61).fill(' ');

    const result = await completeWith(engine, sessionId, owner, gaps, keys);

    expect(result!.session.xp!.amount).toBe(0);
    expect(result!.session.xp!.reason).toBe('anti_gaming');

    const logs = await ProfileAuditLog.find({ ...await auditRowsFor(new Types.ObjectId(owner)), eventType: 'anti_gaming_check' }).lean();
    expect(logs.length).toBeGreaterThan(0);
    expect(await decryptChainedAuditEvent(logs[0], owner)).toMatchObject({ repeatRate: 1 });
  });

  it('awards full XP for natural bursty human typing', async () => {
    const sessionId = await seedQualifyingSession(engine, owner);
    const gaps = humanGaps(200);
    const keys = gaps.map((_, i) => 'abcdefghij'[i % 10]);

    const result = await completeWith(engine, sessionId, owner, gaps, keys);

    expect(result!.session.xp!.amount).toBe(50);
    expect(result!.session.xp!.reason).toBe('qualified');
    expect(await ProfileAuditLog.countDocuments({ ...await auditRowsFor(new Types.ObjectId(owner)), eventType: 'anti_gaming_check' })).toBe(0);
  });

  it('keeps XP when no interaction telemetry is submitted', async () => {
    const sessionId = await seedQualifyingSession(engine, owner);
    const result = await completeWith(engine, sessionId, owner, [], []);
    expect(result!.session.xp!.amount).toBe(50);
    expect(result!.session.xp!.reason).toBe('qualified');
  });
});
