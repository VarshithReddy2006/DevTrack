import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import express from 'express';
import * as webPush from 'web-push';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushSubscriptionRecord } from '../../../db/models/pushSubscription.model.js';
import { NotificationPreference, NotificationRecord } from '../../../db/models/notification.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import notificationRoutes from '../../../modules/notifications/notification.routes.js';
import { errorHandler } from '../../../middleware/error.js';
import { mountApiRoutes } from '../../../routes/mount.js';
import { buildContestPushPayload, getPushPublicKey, sendContestPush, subscribePush, unsubscribePush } from '../../../modules/notifications/pushNotification.service.js';
import { pushSubscriptionSchema } from '../../../modules/notifications/pushNotification.validation.js';
import { handleContestStartingSoon } from '../../../modules/notifications/consumers/contestStartingSoon.consumer.js';

vi.mock('../../../shared/redis/client.js', () => ({ isRedisConfigured: () => false, getRedisClient: () => null }));
vi.mock('web-push', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const mod = actual.default ?? actual;
  const sendNotification = vi.fn();
  return {
    ...mod,
    ...actual,
    default: { ...mod, sendNotification },
    sendNotification,
  };
});
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitNotificationCreated: vi.fn() } }));
vi.mock('../../../shared/sse/eventBus.js', () => ({ eventBus: { publish: vi.fn() } }));
vi.mock('../../../shared/jobs/index.js', () => ({ getNotificationQueue: vi.fn() }));
vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({ unifiedRuntimeStateService: {} }));
vi.mock('../../../middleware/index.js', async () => {
  const { validateBody } = await import('../../../middleware/validation.js');
  const { asyncHandler } = await import('../../../middleware/error.js');
  return {
    validateBody, asyncHandler,
    authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = req.get('authorization');
      if (!token) { res.sendStatus(401); return; }
      Object.assign(req, { user: { id: token === 'Bearer other' ? other : owner } });
      next();
    },
  };
});

const owner = '000000000000000000000001';
const other = '000000000000000000000002';
const endpoint = 'https://fcm.googleapis.com/fcm/send/test-subscription';
const event = () => ({
  eventId: 'contest:alert:123', contestId: '123', contestName: 'Round 1000',
  platform: 'codeforces' as const, startTime: new Date(Date.now() + 30 * 60_000).toISOString(),
  url: 'https://codeforces.com/contest/1000',
});

describe('Web Push contest notifications', () => {
  let server: Server;
  let baseUrl: string;
  let vapid: ReturnType<typeof webPush.generateVAPIDKeys>;
  let browser: ReturnType<typeof createECDH>;
  let auth: Buffer;
  let input: { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string }; vapidPublicKey: string };

  beforeAll(async () => {
    await PushSubscriptionRecord.init();
    const app = express();
    app.use(express.json());
    const routes = express.Router();
    routes.use('/notifications', notificationRoutes);
    mountApiRoutes(app, routes);
    app.use(errorHandler);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/notifications`;
  });

  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    vapid = webPush.generateVAPIDKeys();
    vi.stubEnv('VAPID_SUBJECT', 'mailto:admin@example.com');
    vi.stubEnv('VAPID_PUBLIC_KEY', vapid.publicKey);
    vi.stubEnv('VAPID_PRIVATE_KEY', vapid.privateKey);
    vi.stubEnv('VAPID_PREVIOUS_PUBLIC_KEY', '');
    vi.stubEnv('VAPID_PREVIOUS_PRIVATE_KEY', '');
    browser = createECDH('prime256v1');
    browser.generateKeys();
    auth = randomBytes(16);
    input = { endpoint, expirationTime: null, keys: {
      p256dh: browser.getPublicKey().toString('base64url'), auth: auth.toString('base64url'),
    }, vapidPublicKey: vapid.publicKey };
    await NotificationPreference.create({ userId: owner, preferences: { enablePush: true } });
    vi.mocked(webPush.sendNotification).mockReset().mockResolvedValue({ statusCode: 201, headers: {}, body: '' });
  });

  const post = (path: string, body: unknown, token = 'owner') => fetch(`${baseUrl}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  it('authenticates subscription, unsubscribe, and public-key routes', async () => {
    for (const [path, method] of [['subscribe', 'POST'], ['unsubscribe', 'POST'], ['push-key', 'GET']]) {
      expect((await fetch(`${baseUrl}/${path}`, { method })).status).toBe(401);
    }
  });

  it('returns only the public key and stores browser JSON idempotently with server-side ownership', async () => {
    const key = await fetch(`${baseUrl}/push-key`, { headers: { Authorization: 'Bearer owner' } });
    expect(await key.json()).toEqual({ publicKey: vapid.publicKey });
    const { vapidPublicKey: _, ...browserJson } = input;
    expect((await post('subscribe', { ...browserJson, userId: other })).status).toBe(201);
    expect((await post('subscribe', input)).status).toBe(201);
    expect(await PushSubscriptionRecord.countDocuments()).toBe(1);
    const stored = await PushSubscriptionRecord.findOne({ endpoint }).lean();
    expect(stored).toMatchObject({ userId: owner, keys: input.keys, vapidPublicKey: vapid.publicKey });
    expect(stored?.createdAt).toBeInstanceOf(Date);
  });

  it('mounts push APIs on v2, v1, and legacy paths without exposing unrelated v2 routes', async () => {
    for (const prefix of ['/api/v2', '/api/v1', '/api']) {
      const url = baseUrl.replace('/api/v2', prefix);
      expect((await fetch(`${url}/push-key`, { headers: { Authorization: 'Bearer owner' } })).status).toBe(200);
    }
    expect((await fetch(`${baseUrl}/preferences`, { headers: { Authorization: 'Bearer owner' } })).status).toBe(404);
    expect((await post('unsubscribe', { endpoint })).status).toBe(200);
  });

  it('does not transfer an endpoint between accounts or let another account unsubscribe it', async () => {
    await subscribePush(owner, input);
    expect((await post('subscribe', input, 'other')).status).toBe(409);
    expect((await post('unsubscribe', { endpoint }, 'other')).status).toBe(200);
    expect(await PushSubscriptionRecord.countDocuments({ userId: owner })).toBe(1);
    await unsubscribePush(owner, endpoint);
    await unsubscribePush(owner, endpoint);
    expect(await PushSubscriptionRecord.countDocuments()).toBe(0);
  });

  it.each([
    'http://fcm.googleapis.com/send/token', 'https://127.0.0.1/token',
    'https://fcm.googleapis.com.evil.example/token', 'https://example.com/token',
    'https://user:pass@fcm.googleapis.com/token', 'https://fcm.googleapis.com:8443/token',
    'https://fcm.googleapis.com/token#fragment', 'https://localhost/token',
  ])('rejects unsafe outbound endpoint %s before persistence', async (unsafeEndpoint) => {
    expect((await post('subscribe', { ...input, endpoint: unsafeEndpoint })).status).toBe(400);
    expect(await PushSubscriptionRecord.countDocuments()).toBe(0);
  });

  it.each([
    'https://updates.push.services.mozilla.com/wpush/v2/token',
    'https://web.push.apple.com/token', 'https://wns2-db5p.notify.windows.com/w/?token=test',
  ])('accepts browser push provider %s', (safeEndpoint) => {
    expect(pushSubscriptionSchema.safeParse({ ...input, endpoint: safeEndpoint }).success).toBe(true);
  });

  it('rejects malformed encryption keys, expired subscriptions, and stale VAPID keys', async () => {
    expect((await post('subscribe', { ...input, keys: { ...input.keys, auth: 'bad' } })).status).toBe(400);
    expect((await post('subscribe', { ...input, keys: { ...input.keys, p256dh: 'A'.repeat(87) } })).status).toBe(400);
    expect((await post('subscribe', { ...input, expirationTime: 1 })).status).toBe(400);
    expect((await post('subscribe', { ...input, vapidPublicKey: webPush.generateVAPIDKeys().publicKey })).status).toBe(409);
  });

  it('disables subscription APIs and dispatch when VAPID credentials are missing or mismatched', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    expect((await post('subscribe', input)).status).toBe(503);
    expect((await fetch(`${baseUrl}/push-key`, { headers: { Authorization: 'Bearer owner' } })).status).toBe(503);
    await sendContestPush(owner, event());
    expect(webPush.sendNotification).not.toHaveBeenCalled();
    vi.stubEnv('VAPID_PRIVATE_KEY', webPush.generateVAPIDKeys().privateKey);
    expect(getPushPublicKey()).toBeNull();
  });

  it('generates a verifiable VAPID signature and an AES128GCM payload decryptable by the browser', async () => {
    await subscribePush(owner, input);
    const contest = event();
    await sendContestPush(owner, contest);
    const [subscription, payload, options] = vi.mocked(webPush.sendNotification).mock.calls[0];
    expect(options).toMatchObject({ vapidDetails: { subject: 'mailto:admin@example.com', ...vapid }, TTL: 1800, timeout: 10_000, contentEncoding: 'aes128gcm' });
    const details = webPush.generateRequestDetails(subscription, payload as string, options);
    const authorization = String(details.headers.Authorization);
    const token = authorization.match(/t=([^,]+)/)![1];
    const [header, claims, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:admin@example.com' });
    const publicBytes = Buffer.from(vapid.publicKey, 'base64url');
    const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: publicBytes.subarray(1, 33).toString('base64url'), y: publicBytes.subarray(33).toString('base64url') } });
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
    const body = details.body!;
    const salt = body.subarray(0, 16);
    const serverPublic = body.subarray(21, 21 + body[20]);
    const encrypted = body.subarray(21 + body[20]);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), browser.getPublicKey(), serverPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', browser.computeSecret(serverPublic), auth, info, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(encrypted.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    expect(plaintext.at(-1)).toBe(2);
    expect(JSON.parse(plaintext.subarray(0, -1).toString())).toMatchObject({ contestName: contest.contestName, minutesRemaining: 30, url: contest.url, actions: [{ action: 'open-contest', title: 'View contest' }] });
  });

  it.each([404, 410])('removes a stale endpoint after HTTP %s', async (statusCode) => {
    await subscribePush(owner, input);
    vi.mocked(webPush.sendNotification).mockRejectedValue({ statusCode });
    await sendContestPush(owner, event());
    expect(await PushSubscriptionRecord.countDocuments()).toBe(0);
  });

  it('preserves a subscription refreshed during an expired-endpoint response', async () => {
    await subscribePush(owner, input);
    vi.mocked(webPush.sendNotification).mockImplementation(async () => {
      await PushSubscriptionRecord.updateOne({ endpoint }, { $set: { 'keys.auth': randomBytes(16).toString('base64url') } });
      throw { statusCode: 410 };
    });
    await sendContestPush(owner, event());
    expect(await PushSubscriptionRecord.countDocuments()).toBe(1);
  });

  it.each([429, 500, 503, undefined])('retains subscriptions on transient/provider failure %s and continues delivery', async (statusCode) => {
    await subscribePush(owner, input);
    await subscribePush(owner, { ...input, endpoint: `${endpoint}-second` });
    vi.mocked(webPush.sendNotification).mockRejectedValueOnce({ statusCode });
    await sendContestPush(owner, event());
    expect(webPush.sendNotification).toHaveBeenCalledTimes(2);
    expect(await PushSubscriptionRecord.countDocuments()).toBe(2);
  });

  it('uses the previous signing key during rotation and rejects unknown key bindings', async () => {
    await subscribePush(owner, input);
    const next = webPush.generateVAPIDKeys();
    vi.stubEnv('VAPID_PUBLIC_KEY', next.publicKey);
    vi.stubEnv('VAPID_PRIVATE_KEY', next.privateKey);
    vi.stubEnv('VAPID_PREVIOUS_PUBLIC_KEY', vapid.publicKey);
    vi.stubEnv('VAPID_PREVIOUS_PRIVATE_KEY', vapid.privateKey);
    await sendContestPush(owner, event());
    expect(vi.mocked(webPush.sendNotification).mock.calls[0][2]?.vapidDetails).toMatchObject(vapid);
    vi.mocked(webPush.sendNotification).mockClear();
    vi.stubEnv('VAPID_PREVIOUS_PRIVATE_KEY', '');
    await sendContestPush(owner, event());
    expect(webPush.sendNotification).not.toHaveBeenCalled();
  });

  it('requires push opt-in and skips started contests', async () => {
    await subscribePush(owner, input);
    await sendContestPush(owner, { ...event(), startTime: new Date(Date.now() - 1000).toISOString() });
    await NotificationPreference.deleteMany({});
    await sendContestPush(owner, event());
    await NotificationPreference.create({ userId: owner, preferences: { enablePush: false } });
    await sendContestPush(owner, event());
    expect(webPush.sendNotification).not.toHaveBeenCalled();
  });

  it('dispatches once through the existing consumer and respects contest/platform settings', async () => {
    await subscribePush(owner, input);
    await subscribePush(other, { ...input, endpoint: `${endpoint}-other` });
    await NotificationPreference.create({ userId: other, preferences: { enablePush: true } });
    await UserSettings.create({ userId: owner, notifications: { contestAlerts: true }, platforms: { codeforces: { handle: 'tester' } } });
    await UserSettings.create({ userId: other, notifications: { contestAlerts: false } });
    const contest = event();
    await handleContestStartingSoon(contest);
    await handleContestStartingSoon(contest);
    expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
    expect(await NotificationRecord.countDocuments()).toBe(1);
    await UserSettings.updateOne({ userId: owner }, { $set: { 'platforms.codeforces.handle': '', 'platforms.leetcode.username': 'tester' } });
    await handleContestStartingSoon({ ...contest, contestId: '456', eventId: 'contest:alert:456' });
    expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('keeps in-app notifications working after push failures', async () => {
    await subscribePush(owner, input);
    await UserSettings.create({ userId: owner, notifications: { contestAlerts: true } });
    vi.spyOn(PushSubscriptionRecord, 'find').mockImplementationOnce(() => { throw new Error('database unavailable'); });
    expect((await handleContestStartingSoon(event())).notificationsCreated).toBe(1);
    expect(await NotificationRecord.countDocuments()).toBe(1);
  });

  it('respects the settings page push toggle while preserving the in-app contest alert', async () => {
    await subscribePush(owner, input);
    await UserSettings.create({ userId: owner, notifications: { contestAlerts: true, pushNotifications: false } });
    expect((await handleContestStartingSoon(event())).notificationsCreated).toBe(1);
    expect(webPush.sendNotification).not.toHaveBeenCalled();
  });

  it('passes platform icons, contest links, and actions through the service worker', async () => {
    const handlers: Record<string, (event: unknown) => void> = {};
    const showNotification = vi.fn().mockResolvedValue(undefined);
    runInNewContext(readFileSync(new URL('../../../../../frontend/public/sw.js', import.meta.url), 'utf8'), {
      self: { addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; }, registration: { showNotification } }, console,
    });
    const payload = buildContestPushPayload(event());
    let completion: Promise<unknown> | undefined;
    handlers.push({ data: { json: () => payload }, waitUntil: (promise: Promise<unknown>) => { completion = promise; } });
    await completion;
    expect(showNotification).toHaveBeenCalledWith(payload.title, expect.objectContaining({ icon: payload.icon, actions: payload.actions, data: { url: payload.url, contestId: payload.contestId } }));
    expect(buildContestPushPayload({ ...event(), url: 'javascript:alert(1)' }).url).toBe('/contests');
  });
});
