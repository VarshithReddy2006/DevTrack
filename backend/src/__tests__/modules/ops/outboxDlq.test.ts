import express, { Router } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxAuditLog } from '../../../db/models/outboxAuditLog.model.js';
import { OutboxEvent } from '../../../db/models/outboxEvent.model.js';
import { User } from '../../../db/models/user.model.js';
import { runInTransaction } from '../../../db/transaction.js';
import { errorHandler } from '../../../middleware/error.js';
import { opsRoutes } from '../../../modules/ops/ops.routes.js';
import { purgeArchived } from '../../../modules/ops/outboxDlq.service.js';
import { mountApiRoutes } from '../../../routes/mount.js';
import { writeOutboxEvent } from '../../../shared/events/outbox.js';
import { OutboxRelay } from '../../../shared/events/outboxRelay.js';

vi.mock('@clerk/backend', () => ({ verifyToken: async (token: string) => ({ sub: token }) }));
vi.mock('../../../shared/redis/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../shared/redis/client.js')>(),
  isRedisConfigured: () => true,
  getRedisClient: () => ({ status: 'ready', get: async () => null, set: async () => 'OK' }),
}));

const DAY = 86_400_000;
const admin = { _id: new Types.ObjectId(), clerkId: 'dlq-admin', email: 'dlq-admin@example.test', username: 'dlq-admin', displayName: 'Admin', role: 'admin' };
const member = { _id: new Types.ObjectId(), clerkId: 'dlq-member', email: 'dlq-member@example.test', username: 'dlq-member', displayName: 'Member', role: 'user' };

let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const routes = Router();
  routes.use('/ops', opsRoutes);
  mountApiRoutes(app, routes);
  app.use(errorHandler);
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1');
    listener.once('error', reject);
    listener.once('listening', () => resolve(listener));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(async () => {
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_outbox_dlq');
  await User.create([admin, member]);
});
afterEach(() => { vi.unstubAllEnvs(); });

const focusPayload = (sessionId = new Types.ObjectId().toHexString()) => ({
  sessionId, plannedDurationMinutes: 25, activeDurationMs: 1_500_000, coveredHeartbeatIntervals: 25,
  completedAt: '2026-11-20T10:00:00.000Z', mode: 'pomodoro', timezone: 'UTC', qualified: true,
});

/** Writes events through the real outbox and marks them dead like the relay does after 10 failures. */
async function deadEvents(n: number, type = 'focus.session.completed', payload: () => Record<string, unknown> = focusPayload) {
  const ids: string[] = [];
  await runInTransaction(async session => {
    for (let i = 0; i < n; i++) {
      const row = await writeOutboxEvent(session, { type, schemaVersion: 1, aggregateType: 'focus_session', aggregateId: `agg-${i}`, userId: String(member._id), payload: payload() });
      ids.push(row.eventId);
    }
  });
  await OutboxEvent.updateMany({ eventId: { $in: ids } }, {
    $set: { status: 'dead', attempts: 10, lastError: 'consumer rejected payload', lastAttemptAt: new Date('2026-11-20T11:00:00Z') },
  });
  return ids;
}

function call(method: string, path: string, body?: unknown, token = admin.clerkId) {
  return fetch(origin + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}
const DLQ = '/api/v2/ops/outbox/dlq';

describe('GET /ops/outbox/dlq', () => {
  it('pages dead events oldest first, filters by type and shows a payload snippet', async () => {
    const focus = await deadEvents(3);
    const scored = await deadEvents(1, 'jobtarget.scored', () => ({ jobTargetId: 'x'.repeat(400) }));
    await runInTransaction(session => writeOutboxEvent(session, { type: 'quest.claimed', aggregateType: 'q', aggregateId: 'q1', userId: 'u', payload: {} }));

    const first = await (await call('GET', `${DLQ}?pageSize=2`)).json();
    expect(first.pagination).toMatchObject({ page: 1, pageSize: 2, totalItems: 4, totalPages: 2, hasNextPage: true });
    expect(first.data.map((row: { eventId: string }) => row.eventId)).toEqual(focus.slice(0, 2));
    expect(first.data[0]).toMatchObject({
      type: 'focus.session.completed', status: 'dead', attempts: 10, lastError: 'consumer rejected payload',
      lastAttemptAt: '2026-11-20T11:00:00.000Z', userId: String(member._id),
    });
    expect(first.data[0].payloadSnippet).toContain('"plannedDurationMinutes":25');

    const byType = await (await call('GET', `${DLQ}?type=jobtarget.scored`)).json();
    expect(byType.data.map((row: { eventId: string }) => row.eventId)).toEqual(scored);
    expect(byType.data[0].payloadSnippet).toHaveLength(203);
    expect(byType.data[0].payloadSnippet.endsWith('...')).toBe(true);

    expect((await call('GET', `${DLQ}?status=pending`)).status).toBe(400);
  });

  it('returns one event with its full payload and change history', async () => {
    const [eventId] = await deadEvents(1);
    await call('POST', `${DLQ}/${eventId}/retry`, { note: 'consumer fixed' });
    const { data } = await (await call('GET', `${DLQ}/${eventId}`)).json();
    expect(data).toMatchObject({ eventId, status: 'pending', payload: { mode: 'pomodoro' } });
    expect(data.history).toEqual([expect.objectContaining({ action: 'retried', note: 'consumer fixed', actor: expect.objectContaining({ username: 'dlq-admin', via: 'api' }) })]);
    expect((await call('GET', `${DLQ}/missing-event`)).status).toBe(404);
  });
});

describe('retry', () => {
  it('moves a dead event back to pending so the relay publishes it right away', async () => {
    const [eventId, other] = await deadEvents(2);
    const before = Date.now();
    const response = await call('POST', `${DLQ}/${eventId}/retry`);
    expect(response.status).toBe(200);
    const row = await OutboxEvent.findOne({ eventId }).lean();
    expect(row).toMatchObject({ status: 'pending', attempts: 0, lastError: null, leaseExpiresAt: null });
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await OutboxAuditLog.findOne({ eventId }).lean()).toMatchObject({
      action: 'retried', eventType: 'focus.session.completed',
      actor: { userId: String(admin._id), username: 'dlq-admin', role: 'admin', via: 'api' },
      before: { status: 'dead', attempts: 10, lastError: 'consumer rejected payload' }, after: { status: 'pending', attempts: 0 },
    });

    const published: string[] = [];
    const relay = new OutboxRelay({ resolveQueues: () => ['q'], enqueue: async (_queue, jobId) => { published.push(jobId); } });
    expect(await relay.tick()).toBe(1);
    expect(published).toEqual([eventId]);
    expect(await OutboxEvent.findOne({ eventId }).lean()).toMatchObject({ status: 'published', lastAttemptAt: expect.any(Date) });
    expect(await OutboxEvent.findOne({ eventId: other }).lean()).toMatchObject({ status: 'dead' });
  });

  it('lets only one of several concurrent retries through', async () => {
    const [eventId] = await deadEvents(1);
    const responses = await Promise.all(Array.from({ length: 5 }, () => call('POST', `${DLQ}/${eventId}/retry`)));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(await OutboxAuditLog.countDocuments({ eventId })).toBe(1);
  });

  it('retries a batch by ids or type and reports what it skipped', async () => {
    const [a, b, c] = await deadEvents(3);
    const scored = await deadEvents(2, 'jobtarget.scored', () => ({ jobTargetId: new Types.ObjectId().toHexString(), matchScore: 50, missingSkills: [], scoredAt: '2026-11-20T10:00:00.000Z' }));
    await call('POST', `${DLQ}/${c}/retry`);

    const byIds = await (await call('POST', `${DLQ}/retry`, { eventIds: [a, b, c, 'unknown-id'], note: 'replay after fix' })).json();
    expect(byIds.data).toEqual({ retried: [a, b], skipped: [c, 'unknown-id'] });
    const byType = await (await call('POST', `${DLQ}/retry`, { type: 'jobtarget.scored' })).json();
    expect(byType.data.retried.sort()).toEqual([...scored].sort());
    expect(await OutboxEvent.countDocuments({ status: 'dead' })).toBe(0);
    expect(await OutboxAuditLog.countDocuments({ action: 'retried', note: 'replay after fix' })).toBe(2);

    expect((await call('POST', `${DLQ}/retry`, {})).status).toBe(400);
    expect((await call('POST', `${DLQ}/retry`, { all: false })).status).toBe(400);
  });

  it('never re-queues or audits an event twice when batch retries race', async () => {
    const ids = await deadEvents(12);
    const results = await Promise.all([1, 2, 3].map(() => call('POST', `${DLQ}/retry`, { all: true }).then(r => r.json())));
    const retried = results.flatMap(result => result.data.retried);
    expect(retried.sort()).toEqual([...ids].sort());
    expect(await OutboxAuditLog.countDocuments({ action: 'retried' })).toBe(12);
    expect(await OutboxEvent.countDocuments({ status: 'pending' })).toBe(12);
  });
});

describe('PATCH /ops/outbox/dlq/:eventId', () => {
  it('fixes a poisoned payload, validated against the event schema, and audits before and after', async () => {
    const [eventId] = await deadEvents(1, 'focus.session.completed', () => ({ ...focusPayload(), sessionId: 'not-an-object-id' }));

    const invalid = await call('PATCH', `${DLQ}/${eventId}`, { payload: { ...focusPayload(), sessionId: 'still-bad' } });
    expect(invalid.status).toBe(400);
    expect((await invalid.json())).toMatchObject({ code: 'INVALID_PAYLOAD', details: { 'payload.sessionId': [expect.any(String)] } });

    const fixed = focusPayload();
    const response = await call('PATCH', `${DLQ}/${eventId}`, { payload: fixed, note: 'sessionId was a slug' });
    expect(response.status).toBe(200);
    expect(await OutboxEvent.findOne({ eventId }).lean()).toMatchObject({ status: 'dead', payload: fixed });
    expect(await OutboxAuditLog.findOne({ eventId, action: 'edited' }).lean()).toMatchObject({
      note: 'sessionId was a slug', before: { payload: { sessionId: 'not-an-object-id' } }, after: { payload: fixed },
    });

    // Once it is back in the queue the payload can no longer be changed here.
    await call('POST', `${DLQ}/${eventId}/retry`);
    expect((await call('PATCH', `${DLQ}/${eventId}`, { payload: fixed })).status).toBe(409);
    expect((await call('PATCH', `${DLQ}/${eventId}`, { payload: 'text' })).status).toBe(400);
  });

  it('validates interview turn payloads, so a fix cannot break the scoring job', async () => {
    const good = { sessionId: new Types.ObjectId().toHexString(), turnIndex: 0, stateVersion: 2 };
    const [eventId] = await deadEvents(1, 'interview.turn.answered', () => good);
    const invalid = await call('PATCH', `${DLQ}/${eventId}`, { payload: { ...good, turnIndex: 9 } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_PAYLOAD', details: { 'payload.turnIndex': [expect.any(String)] } });
    expect((await call('PATCH', `${DLQ}/${eventId}`, { payload: { ...good, turnIndex: 1 } })).status).toBe(200);
  });

  it('accepts any object payload for types without a registered schema', async () => {
    const [eventId] = await deadEvents(1, 'quest.claimed', () => ({ questId: 1 }));
    expect((await call('PATCH', `${DLQ}/${eventId}`, { payload: { questId: 'q-1' } })).status).toBe(200);
    expect(await OutboxEvent.findOne({ eventId }).lean()).toMatchObject({ payload: { questId: 'q-1' } });
  });
});

describe('DELETE /ops/outbox/dlq/:eventId and purge', () => {
  it('archives a dead event, hides it from the default list and purges it later with a full copy in the audit log', async () => {
    const [eventId, other] = await deadEvents(2);
    const response = await call('DELETE', `${DLQ}/${eventId}`, { note: 'user deleted their account' });
    expect(response.status).toBe(200);
    expect(await OutboxEvent.findOne({ eventId }).lean()).toMatchObject({ status: 'archived', archivedAt: expect.any(Date) });
    expect((await (await call('GET', DLQ)).json()).data.map((row: { eventId: string }) => row.eventId)).toEqual([other]);
    expect((await (await call('GET', `${DLQ}?status=archived`)).json()).data.map((row: { eventId: string }) => row.eventId)).toEqual([eventId]);

    expect((await call('POST', `${DLQ}/${eventId}/retry`)).status).toBe(409);
    expect((await call('DELETE', `${DLQ}/${eventId}`)).status).toBe(409);

    // The relay never touches archived rows.
    const relay = new OutboxRelay({ resolveQueues: () => ['q'], enqueue: async () => undefined });
    expect(await relay.tick()).toBe(0);

    const actor = { userId: null, username: 'ops', role: null, via: 'cli' as const };
    expect(await purgeArchived(30, actor)).toBe(0);
    expect(await purgeArchived(30, actor, new Date(Date.now() + 31 * DAY))).toBe(1);
    expect(await OutboxEvent.exists({ eventId })).toBeNull();
    const purged = await OutboxAuditLog.findOne({ eventId, action: 'purged' }).lean();
    expect(purged).toMatchObject({ actor: { via: 'cli' }, before: { status: 'archived', type: 'focus.session.completed', payload: { mode: 'pomodoro' } } });
    expect(await OutboxEvent.findOne({ eventId: other }).lean()).toMatchObject({ status: 'dead' });
  });
});

describe('access', () => {
  it('is admin only and served on v1 and v2', async () => {
    const [eventId] = await deadEvents(1);
    expect((await call('GET', DLQ, undefined, '')).status).toBe(401);
    for (const [method, path, body] of [
      ['GET', DLQ], ['GET', `${DLQ}/${eventId}`], ['POST', `${DLQ}/${eventId}/retry`], ['POST', `${DLQ}/retry`, { all: true }],
      ['PATCH', `${DLQ}/${eventId}`, { payload: {} }], ['DELETE', `${DLQ}/${eventId}`],
    ] as const) {
      expect((await call(method, path, body, member.clerkId)).status).toBe(403);
    }
    expect(await OutboxEvent.findOne({ eventId }).lean()).toMatchObject({ status: 'dead' });
    expect(await OutboxAuditLog.countDocuments()).toBe(0);
    expect((await call('GET', '/api/v1/ops/outbox/dlq')).status).toBe(200);
    expect((await call('GET', '/api/v2/ops/queues')).status).toBe(404);
  });

  it('keeps audit rows append-only', async () => {
    const [eventId] = await deadEvents(1);
    await call('POST', `${DLQ}/${eventId}/retry`);
    await expect(OutboxAuditLog.updateOne({ eventId }, { $set: { note: 'edited' } })).rejects.toThrow('append-only');
    await expect(OutboxAuditLog.deleteMany({})).rejects.toThrow('append-only');
  });
});
