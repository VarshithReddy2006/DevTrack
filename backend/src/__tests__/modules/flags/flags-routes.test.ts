import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlag, FeatureFlagAudit, User, type IFeatureFlag } from '../../../db/models/index.js';
import { authMiddleware } from '../../../middleware/auth.js';
import { errorHandler } from '../../../middleware/error.js';
import { flagRoutes } from '../../../modules/flags/flags.routes.js';
import { diffFlagChanges, evaluateFlag, isFlagEnabled } from '../../../modules/flags/flags.service.js';
import { requireFlag } from '../../../modules/flags/requireFlag.js';
import { opsRoutes } from '../../../modules/ops/ops.routes.js';

const fixture = vi.hoisted(() => {
  const keys = new Map<string, string>();
  return {
    keys,
    configured: true,
    redis: {
      status: 'ready',
      get: vi.fn(async (key: string) => keys.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, mode?: string, _ttl?: number) => {
        if (mode === 'NX' && keys.has(key)) return null;
        keys.set(key, value);
        return 'OK';
      }),
    },
  };
});

vi.mock('@clerk/backend', () => ({ verifyToken: async (token: string) => ({ sub: token }) }));
vi.mock('../../../shared/redis/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../shared/redis/client.js')>(),
  isRedisConfigured: () => fixture.configured,
  getRedisClient: () => fixture.redis,
}));

const member = { _id: '000000000000000000000001', clerkId: 'member', email: 'member@example.test',
  username: 'flag-member', displayName: 'Member', role: 'user' };
const admin = { _id: '000000000000000000000002', clerkId: 'admin', email: 'admin@example.test',
  username: 'flag-admin', displayName: 'Admin', role: 'admin' };
const generationKey = 'devtrack:flags:catalog-generation';

let server: Server;
let origin: string;

beforeAll(async () => {
  await FeatureFlag.init();
  await FeatureFlagAudit.init();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/flags', flagRoutes);
  app.use('/api/v1/ops', opsRoutes);
  app.get('/guarded', authMiddleware, requireFlag('revision'), (_req: Request, res: Response) => { res.sendStatus(204); });
  app.use(errorHandler);
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1');
    listener.once('error', reject);
    listener.once('listening', () => resolve(listener));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_flags');
  fixture.keys.clear();
  fixture.configured = true;
  fixture.redis.status = 'ready';
  vi.clearAllMocks();
  await User.create([member, admin]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function request(path: string, token?: string, changes?: Record<string, unknown>) {
  return fetch(origin + path, {
    method: changes ? 'PATCH' : 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(changes ? { 'Content-Type': 'application/json' } : {}),
    },
    body: changes ? JSON.stringify(changes) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
}

function patch(changes: Record<string, unknown>) {
  return request('/api/v1/ops/flags/revision', admin.clerkId, changes);
}

describe('feature flag rollout', () => {
  const baseFlag: IFeatureFlag = {
    key: 'revision', name: 'Revision', description: '', enabled: true, rolloutPercent: 30,
    allowedUserIds: [], version: 1, updatedAt: new Date(0),
  };

  it('is stable for the same user and distributes across buckets', () => {
    const users = Array.from({ length: 1000 }, (_, index) => index.toString(16).padStart(24, '0'));
    const evaluate = (user: string) => evaluateFlag(baseFlag, user);
    const decisions = users.map(evaluate);
    expect(users.map(evaluate)).toEqual(decisions);
    expect(decisions.filter(Boolean).length).toBeGreaterThan(250);
    expect(decisions.filter(Boolean).length).toBeLessThan(350);
  });

  it('honors allowlists at zero and treats disabled as a global switch', () => {
    const allowlisted = { ...baseFlag, rolloutPercent: 0, allowedUserIds: [member._id] };
    expect(evaluateFlag(allowlisted, member._id)).toBe(true);
    expect(evaluateFlag(allowlisted, admin._id)).toBe(false);
    expect(evaluateFlag({ ...allowlisted, enabled: false }, member._id)).toBe(false);
    expect(evaluateFlag({ ...allowlisted, rolloutPercent: 100 }, admin._id)).toBe(true);
  });
});

describe('flags endpoints and middleware', () => {
  it('authenticates flag reads and restricts ops writes and reads to admins', async () => {
    expect((await request('/api/v1/flags')).status).toBe(401);
    expect((await request('/api/v1/ops/flags', member.clerkId)).status).toBe(403);
    expect((await request('/api/v1/ops/flags/revision', member.clerkId, { enabled: true })).status).toBe(403);
    for (const changes of [{ version: 12 }, { rolloutPercent: 101 }, { allowedUserIds: ['bad'] }, {}]) {
      expect((await patch(changes)).status).toBe(400);
    }
    expect(await FeatureFlag.countDocuments()).toBe(0);
  });

  it('gates controllers, exposes only allowed keys, and invalidates warm decisions after a patch', async () => {
    const missing = await request('/guarded', member.clerkId);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'FEATURE_DISABLED' });
    expect((await patch({ enabled: true, allowedUserIds: [member._id] })).status).toBe(200);
    expect((await request('/guarded', member.clerkId)).status).toBe(204);
    expect(await (await request('/api/v1/flags', member.clerkId)).json()).toMatchObject({ data: ['revision'] });
    expect(await (await request('/api/v1/flags', admin.clerkId)).json()).toMatchObject({ data: [] });
    expect(fixture.redis.set).toHaveBeenCalledWith(`devtrack:flags:${member._id}:revision:v1`, '1', 'EX', 60);

    const dbReads = vi.spyOn(FeatureFlag, 'find');
    expect(await isFlagEnabled('revision', member._id)).toBe(true);
    expect(dbReads).not.toHaveBeenCalled();
    const previousGeneration = fixture.keys.get(generationKey);

    expect((await patch({ enabled: false })).status).toBe(200);
    expect(fixture.keys.get(generationKey)).not.toBe(previousGeneration);
    expect((await request('/guarded', member.clerkId)).status).toBe(404);
    expect(fixture.redis.set).toHaveBeenCalledWith(`devtrack:flags:${member._id}:revision:v2`, '0', 'EX', 60);
    expect(await (await request('/api/v1/ops/flags', admin.clerkId)).json()).toMatchObject({
      data: [{ key: 'revision', version: 2, enabled: false, allowedUserIds: [member._id] }],
    });
  });

  it('ignores an old catalog refill that finishes after an update', async () => {
    await patch({ enabled: true, rolloutPercent: 100 });
    const staleGeneration = fixture.keys.get(generationKey);
    const staleKey = `devtrack:flags:catalog:${staleGeneration}`;
    let finishRefill!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const released = new Promise<void>(resolve => { finishRefill = resolve; });
    const originalSet = fixture.redis.set.getMockImplementation()!;
    fixture.redis.set.mockImplementation(async (...args) => {
      if (args[0] === staleKey) {
        started();
        await released;
      }
      return originalSet(...args);
    });

    const inflight = isFlagEnabled('revision', member._id);
    await entered;
    try {
      expect((await patch({ enabled: false })).status).toBe(200);
    } finally {
      finishRefill();
      fixture.redis.set.mockImplementation(originalSet);
    }
    await inflight;
    expect(fixture.keys.has(staleKey)).toBe(true);
    expect(await isFlagEnabled('revision', member._id)).toBe(false);
  });

  it('keeps both settings and advances the version for concurrent admin patches', async () => {
    await patch({ enabled: true });
    await isFlagEnabled('revision', member._id);
    const [rollout, description] = await Promise.all([
      patch({ rolloutPercent: 100 }), patch({ description: 'Revision radar' }),
    ]);
    expect([rollout.status, description.status]).toEqual([200, 200]);
    expect(await FeatureFlag.findOne({ key: 'revision' }).lean()).toMatchObject({
      version: 3, rolloutPercent: 100, description: 'Revision radar',
    });
    expect(await isFlagEnabled('revision', member._id)).toBe(true);
  });

  it('reports when MongoDB saved a flag but Redis did not confirm invalidation', async () => {
    await patch({ enabled: true, rolloutPercent: 100 });
    expect(await isFlagEnabled('revision', member._id)).toBe(true);
    fixture.redis.set.mockRejectedValueOnce(new Error('Redis connection lost'));
    const response = await patch({ enabled: false });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'FLAG_CACHE_UNAVAILABLE', message: expect.stringContaining('The flag was saved'),
    });
    expect((await FeatureFlag.findOne({ key: 'revision' }))?.enabled).toBe(false);
  });

  it('returns the updated flag from a patch', async () => {
    const response = await patch({ enabled: true, rolloutPercent: 40 });
    expect(await response.json()).toMatchObject({
      data: { key: 'revision', name: 'revision', enabled: true, rolloutPercent: 40, version: 1 },
    });
  });

  it('uses MongoDB in deployments without Redis and during cache outages', async () => {
    fixture.configured = false;
    expect((await patch({ enabled: true, rolloutPercent: 100 })).status).toBe(200);
    expect((await request('/guarded', member.clerkId)).status).toBe(204);
    expect(fixture.redis.get).not.toHaveBeenCalled();

    fixture.configured = true;
    fixture.redis.status = 'reconnecting';
    expect((await request('/guarded', member.clerkId)).status).toBe(204);
    expect((await patch({ enabled: false })).status).toBe(503);
    expect((await FeatureFlag.findOne({ key: 'revision' }))?.enabled).toBe(true);
  });
});

describe('feature flag audit log', () => {
  it('records who changed which settings, from what, to what', async () => {
    await patch({ enabled: true, rolloutPercent: 20 });
    await patch({ rolloutPercent: 60, description: 'Revision radar' });

    const entries = await FeatureFlagAudit.find({ flagKey: 'revision' }).sort({ version: 1 }).lean();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      version: 1, created: true, actorId: admin._id, actorUsername: admin.username,
      changes: [{ field: 'enabled', from: false, to: true }, { field: 'rolloutPercent', from: 0, to: 20 }],
    });
    expect(entries[1]).toMatchObject({
      version: 2, created: false,
      changes: [{ field: 'description', from: '', to: 'Revision radar' }, { field: 'rolloutPercent', from: 20, to: 60 }],
    });
  });

  it('skips updates that change nothing', async () => {
    await patch({ enabled: true });
    await patch({ enabled: true });
    expect(await FeatureFlagAudit.countDocuments()).toBe(1);
  });

  it('keeps an exact history when admins patch at the same time', async () => {
    await patch({ enabled: true });
    await Promise.all([patch({ rolloutPercent: 100 }), patch({ description: 'Radar' })]);
    const entries = await FeatureFlagAudit.find({ flagKey: 'revision' }).sort({ version: 1 }).lean();
    expect(entries.map(entry => entry.version)).toEqual([1, 2, 3]);
    const fields = entries.slice(1).flatMap(entry => entry.changes.map(change => `${change.field}:${String(change.from)}`));
    expect(fields.sort()).toEqual(['description:', 'rolloutPercent:0']);
  });

  it('still saves the flag if writing the audit entry fails', async () => {
    vi.spyOn(FeatureFlagAudit, 'create').mockRejectedValueOnce(new Error('write failed'));
    expect((await patch({ enabled: true })).status).toBe(200);
    expect((await FeatureFlag.findOne({ key: 'revision' }))?.enabled).toBe(true);
  });

  it('serves the newest entries first to admins only, with an optional flag filter', async () => {
    await patch({ enabled: true });
    await request('/api/v1/ops/flags/search', admin.clerkId, { enabled: true });
    await patch({ rolloutPercent: 50 });

    expect((await request('/api/v1/ops/flags/audit', member.clerkId)).status).toBe(403);
    const all = await (await request('/api/v1/ops/flags/audit', admin.clerkId)).json();
    expect(all.data.map((entry: { flagKey: string; version: number }) => `${entry.flagKey}@${entry.version}`))
      .toEqual(['revision@2', 'search@1', 'revision@1']);

    const one = await (await request('/api/v1/ops/flags/audit?key=search&limit=5', admin.clerkId)).json();
    expect(one.data).toHaveLength(1);
    expect(one.data[0]).toMatchObject({ flagKey: 'search', actorUsername: admin.username });

    const limited = await (await request('/api/v1/ops/flags/audit?limit=1', admin.clerkId)).json();
    expect(limited.data).toHaveLength(1);
    for (const query of ['limit=0', 'limit=101', 'key=bad%20key', 'other=1']) {
      expect((await request(`/api/v1/ops/flags/audit?${query}`, admin.clerkId)).status).toBe(400);
    }
  });
});

describe('diffFlagChanges', () => {
  it('compares allowlists by value', () => {
    const before = { name: 'x', description: '', enabled: true, rolloutPercent: 0, allowedUserIds: [member._id] };
    expect(diffFlagChanges(before, { allowedUserIds: [member._id] })).toEqual([]);
    expect(diffFlagChanges(before, { allowedUserIds: [] })).toEqual([{ field: 'allowedUserIds', from: [member._id], to: [] }]);
  });
});
