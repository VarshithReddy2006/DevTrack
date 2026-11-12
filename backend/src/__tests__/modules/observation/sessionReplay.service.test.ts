import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  sessionReplay,
  SessionNotFoundError,
  SessionForbiddenError,
} from '../../../modules/observation/sessionReplay.service.js';
import { SessionReplay } from '../../../db/models/sessionReplay.model.js';

describe('SessionReplay Service - Ownership and Atomic Batching', () => {
  const userAId = new mongoose.Types.ObjectId();
  const userBId = new mongoose.Types.ObjectId();
  const sessionId = 'test-session-12345';

  beforeEach(async () => {
    await SessionReplay.deleteMany({});
  });

  it('enforces ownership on session creation and rejects another user hijacking session ID', async () => {
    await sessionReplay.startSession({
      sessionId,
      userId: userAId,
      startTime: new Date(),
      deviceInfo: {
        userAgent: 'test-agent',
        viewport: { width: 1920, height: 1080 },
        deviceType: 'desktop',
      },
    });

    const session = await SessionReplay.findOne({ sessionId });
    expect(session).toBeTruthy();
    expect(session?.userId.toString()).toBe(userAId.toString());

    // User B trying to start with same sessionId should throw SessionForbiddenError
    await expect(
      sessionReplay.startSession({
        sessionId,
        userId: userBId,
        startTime: new Date(),
        deviceInfo: {
          userAgent: 'hacker-agent',
          viewport: { width: 1000, height: 800 },
        },
      })
    ).rejects.toThrow(SessionForbiddenError);
  });

  it('throws SessionNotFoundError if ending a non-existent session', async () => {
    await expect(
      sessionReplay.endSession('non-existent-session', userAId)
    ).rejects.toThrow(SessionNotFoundError);
  });

  it('rejects cross-user session termination with SessionForbiddenError', async () => {
    await sessionReplay.startSession({
      sessionId,
      userId: userAId,
      startTime: new Date(),
      deviceInfo: {
        userAgent: 'test-agent',
        viewport: { width: 1920, height: 1080 },
      },
    });

    await expect(
      sessionReplay.endSession(sessionId, userBId)
    ).rejects.toThrow(SessionForbiddenError);

    // User A can successfully end it
    await sessionReplay.endSession(sessionId, userAId);
    const updated = await SessionReplay.findOne({ sessionId });
    expect(updated?.endTime).toBeTruthy();
    expect(updated?.duration).toBeGreaterThanOrEqual(0);
  });

  it('rejects cross-user telemetry batch ingestion and reads', async () => {
    await sessionReplay.startSession({
      sessionId,
      userId: userAId,
      startTime: new Date(),
      deviceInfo: {
        userAgent: 'test-agent',
        viewport: { width: 1920, height: 1080 },
      },
    });

    // Cross-user batch append
    await expect(
      sessionReplay.recordEventsBatch(sessionId, userBId, [
        { event: 'click', properties: { element: 'button#submit' } },
      ])
    ).rejects.toThrow(SessionForbiddenError);

    // Cross-user read
    await expect(
      sessionReplay.getSessionReplay(sessionId, userBId)
    ).rejects.toThrow(SessionForbiddenError);

    // Non-existent session batch append throws 404
    await expect(
      sessionReplay.recordEventsBatch('invalid-session', userAId, [
        { event: 'click' },
      ])
    ).rejects.toThrow(SessionNotFoundError);
  });

  it('preserves all events atomically under concurrent batch flushes', async () => {
    await sessionReplay.startSession({
      sessionId,
      userId: userAId,
      startTime: new Date(),
      deviceInfo: {
        userAgent: 'test-agent',
        viewport: { width: 1920, height: 1080 },
      },
    });

    const batch1 = [
      { event: 'page_view', properties: { page: '/dashboard' } },
      { event: 'click', properties: { element: 'nav-link' } },
      { event: 'hesitation', properties: { element: 'submit-btn', severity: 'medium' } },
    ];

    const batch2 = [
      { event: 'page_view', properties: { page: '/problems' } },
      { event: 'scroll', properties: { element: 'problem-table' } },
      { event: 'confusion', properties: { element: 'filter-dropdown', severity: 'low' } },
    ];

    const batch3 = [
      { event: 'network_request', properties: { url: '/api/dsa/problems', method: 'GET', status: 200, duration: 45 } },
      { event: 'click', properties: { element: 'solve-btn' } },
    ];

    // Fire all batches concurrently to test race-condition safety
    await Promise.all([
      sessionReplay.recordEventsBatch(sessionId, userAId, batch1),
      sessionReplay.recordEventsBatch(sessionId, userAId, batch2),
      sessionReplay.recordEventsBatch(sessionId, userAId, batch3),
    ]);

    const session = await sessionReplay.getSessionReplay(sessionId, userAId);
    expect(session).toBeTruthy();
    expect(session?.pages.length).toBe(2);
    expect(session?.interactions.length).toBe(3);
    expect(session?.frictionEvents.length).toBe(2);
    expect(session?.networkRequests.length).toBe(1);
  });
});
