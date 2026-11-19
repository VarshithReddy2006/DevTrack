import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { User } from '../../../db/models/user.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import { UsernameReservation } from '../../../db/models/usernameReservation.model.js';
import { Project } from '../../../db/models/project.model.js';
import { PublicProfileService } from '../../../modules/profile/publicProfile.service.js';
import { PublicationService } from '../../../modules/profile/publication.service.js';
import { getCachedPortfolio, portfolioCacheKey, PORTFOLIO_REFRESH_MS, PORTFOLIO_TTL_SECONDS } from '../../../modules/profile/portfolioCache.service.js';
import { publicPortfolioRoutes } from '../../../modules/profile/publicProfile.routes.js';
import { updateProfile } from '../../../modules/profile/profile.service.js';
import { createProject, deleteProject, updateProject } from '../../../modules/projects/projects.service.js';
import { mountApiRoutes } from '../../../routes/mount.js';
import { invalidateCacheTag, portfolioTag, readTaggedCache, writeTaggedCache } from '../../../shared/redis/cacheTags.js';
import { portfolioRedis, resetPortfolioRedis, tags, values } from '../../fixtures/portfolioRedis.js';

vi.mock('../../../shared/redis/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../shared/redis/client.js')>(),
  getRedisClient: () => portfolioRedis, isRedisConfigured: () => false,
}));
vi.mock('../../../shared/cache/cacheManager.js', () => ({ cacheManager: { invalidateDashboard: vi.fn(async () => {}) } }));
vi.mock('../../../modules/readiness/services/VerifiedProjectIngestionService.js', () => ({
  VerifiedProjectIngestionService: { ingestAfterChange: vi.fn(async () => {}), queueRefresh: vi.fn(async () => {}) },
}));

let server: Server;
let base: string;
let middlewareCalls = 0;
let counter = 0;
const allSections = { streak: true, dsa: true, github: true, projects: true, activity: true };
const key = (slug = 'cache-owner') => portfolioCacheKey(slug);

async function seed(slug = 'cache-owner', overrides: Record<string, unknown> = {}) {
  const user = await User.create({ clerkId: `cache-${counter++}`, username: slug, email: `${slug}@example.test`, displayName: 'Cache Owner' });
  const profile = await PublicProfile.create({
    userId: user._id, username: slug, slug, published: true, visibility: 'public', sections: allSections,
    publicationVersion: 1, snapshot: { version: 2, identity: { displayName: 'Cache Owner' }, projects: [{ name: 'Verified project' }] },
    ...overrides,
  });
  return { user, profile, tag: portfolioTag(String(user._id)) };
}
const read = (slug = 'cache-owner', headers: Record<string, string> = {}, prefix = '/api/v2') => fetch(`${base}${prefix}/portfolio/${slug}`, { headers });

beforeAll(async () => {
  await Promise.all([PublicProfile.init(), UserSettings.init(), UsernameReservation.init()]);
  const app = express();
  const routes = express.Router();
  routes.use((_req, _res, next) => { middlewareCalls++; next(); });
  routes.use('/portfolio', publicPortfolioRoutes);
  mountApiRoutes(app, routes);
  app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false });
  });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => { resetPortfolioRedis(); middlewareCalls = 0; });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('public portfolio HTTP representation', () => {
  it.each(['/api/v2', '/api/v1', '/api'])('serves anonymous public JSON once through shared middleware at %s', async prefix => {
    const { user } = await seed();
    const response = await read('CACHE-OWNER', {}, prefix);
    expect(response.status).toBe(200);
    expect(middlewareCalls).toBe(1);
    expect(await response.json()).toMatchObject({ success: true, data: { username: 'cache-owner', identity: { displayName: 'Cache Owner' } } });
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('etag')).toMatch(/^"[\w-]+"$/);
    expect(values.get(key())?.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(tags.get(`cache:tag:${portfolioTag(String(user._id))}`)?.has(key())).toBe(true);
    expect(values.get(key())?.value).not.toContain(user.email);
    expect(values.get(key())?.value).not.toContain(user.clerkId);
  });

  it('reuses the same serialized body and ETag without loading the full snapshot on a hit', async () => {
    await seed();
    const first = await read(); const text = await first.text();
    const find = vi.spyOn(PublicProfile, 'findOne');
    const guard = vi.spyOn(PublicProfile, 'aggregate');
    const second = await read();
    expect(await second.text()).toBe(text);
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
    expect(find).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledTimes(1); // Indexed metadata/privacy guard only.
  });

  it('uses the unique slug and user privacy indexes for the authorization guard', async () => {
    const { user } = await seed(); await UserSettings.create({ userId: user._id });
    const aggregate = vi.spyOn(PublicProfile, 'aggregate');
    await getCachedPortfolio('cache-owner');
    const pipeline = aggregate.mock.calls[0][0]!;
    aggregate.mockRestore();
    const plan = JSON.stringify(await PublicProfile.aggregate(pipeline).explain('executionStats'));
    expect(plan).toContain('slug_1');
    expect(plan).toContain('userId_1');
  });

  it.each(['strong', 'weak', 'list', 'wildcard'])('supports %s If-None-Match after checking privacy', async variant => {
    await seed();
    const first = await read(); const tag = first.headers.get('etag')!;
    await first.arrayBuffer();
    const validator = variant === 'strong' ? tag : variant === 'weak' ? 'W/' + tag : variant === 'list' ? `"different", W/${tag}` : '*';
    const response = await read('cache-owner', { 'If-None-Match': validator });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBe(tag);
  });

  it('returns a full response for a nonmatching validator and supports HEAD', async () => {
    await seed(); await (await read()).arrayBuffer();
    expect((await read('cache-owner', { 'If-None-Match': '"different"' })).status).toBe(200);
    const response = await fetch(`${base}/api/v2/portfolio/cache-owner`, { method: 'HEAD' });
    expect(response.status).toBe(200); expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBeTruthy();
  });

  it('changes the ETag when the published snapshot changes and hides opted-out sections', async () => {
    const { user } = await seed();
    const first = await read(); const tag = first.headers.get('etag')!; await first.arrayBuffer();
    await PublicProfile.updateOne({ userId: user._id }, { $set: { 'snapshot.identity.displayName': 'Changed', 'snapshot.computedAt': new Date(Date.now() + 1) } });
    await UserSettings.create({ userId: user._id, privacy: { showProjects: false, showGithub: false } });
    const second = await read('cache-owner', { 'If-None-Match': tag });
    expect(second.status).toBe(200); expect(second.headers.get('etag')).not.toBe(tag);
    expect((await second.json()).data).toMatchObject({ identity: { displayName: 'Changed' }, projects: [] });
    expect(values.get(key())?.value).not.toContain('Verified project');
  });

  it('does not expose other v2 routes or allow portfolio writes through the new mount', async () => {
    expect((await fetch(`${base}/api/v2/portfolio/cache-owner`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/v2/profile`)).status).toBe(404);
    expect(middlewareCalls).toBe(0);
  });
});

describe('privacy and invalidation lifecycle', () => {
  it.each([{ published: false }, { visibility: 'private' }, { visibility: 'recruiter_only' }])('never caches a nonpublic profile %j', async fields => {
    await seed('cache-owner', fields);
    const response = await read('cache-owner', { 'If-None-Match': '*' });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(values.has(key())).toBe(false);
  });

  it('returns the same 404 for unknown handles and rejects malformed handles without MongoDB work', async () => {
    const unknown = await read('no-such-user'); expect(unknown.status).toBe(404);
    const find = vi.spyOn(PublicProfile, 'findOne');
    for (const slug of ['ab', 'a'.repeat(31), 'bad/name', '\u0000bad', '...', 'cache-owner:tag']) expect(await getCachedPortfolio(slug)).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it('unpublishes and purges a warmed cache before answering a matching validator', async () => {
    const { user } = await seed();
    const first = await read(); const tag = first.headers.get('etag')!; await first.arrayBuffer();
    await PublicationService.unpublishProfile(user._id);
    expect(values.has(key())).toBe(false);
    const response = await read('cache-owner', { 'If-None-Match': tag });
    expect(response.status).toBe(404); expect(response.headers.get('etag')).not.toBe(tag);
  });

  it('purges privacy model writes and still fails closed after a raw write bypasses hooks', async () => {
    const { user } = await seed();
    await UserSettings.create({ userId: user._id });
    await getCachedPortfolio('cache-owner');
    await UserSettings.updateOne({ userId: user._id }, { $set: { 'privacy.showProjects': false } });
    expect(values.has(key())).toBe(false);
    await getCachedPortfolio('cache-owner');
    await UserSettings.collection.updateOne({ userId: user._id }, { $set: { 'privacy.profileVisibility': 'private' } });
    expect(values.has(key())).toBe(true);
    expect((await read('cache-owner', { 'If-None-Match': '*' })).status).toBe(404);
    expect(values.has(key())).toBe(false);
  });

  it('does not return hidden sections from a warm cache when raw privacy writes bypass invalidation', async () => {
    const { user } = await seed(); await UserSettings.create({ userId: user._id });
    const before = await getCachedPortfolio('cache-owner'); expect(before!.body).toContain('Verified project');
    await UserSettings.collection.updateOne({ userId: user._id }, { $set: { 'privacy.showProjects': false } });
    const after = await getCachedPortfolio('cache-owner');
    expect(JSON.parse(after!.body).data.projects).toEqual([]);
    expect(after!.etag).not.toBe(before!.etag);
  });

  it('invalidates saves and findOneAndUpdate by _id, and deletion restores default visibility safely', async () => {
    const { user } = await seed(); const settings = await UserSettings.create({ userId: user._id });
    await getCachedPortfolio('cache-owner'); settings.privacy.showProjects = false; await settings.save();
    expect(values.has(key())).toBe(false);
    await getCachedPortfolio('cache-owner');
    await UserSettings.findOneAndUpdate({ _id: settings._id }, { $set: { 'privacy.showProjects': true } });
    expect(values.has(key())).toBe(false);
    await getCachedPortfolio('cache-owner');
    await UserSettings.deleteOne({ userId: user._id });
    expect(values.has(key())).toBe(false);
    expect(JSON.parse((await getCachedPortfolio('cache-owner'))!.body).data.projects).toHaveLength(1);
  });

  it('invalidates profile edits and snapshot rebuilds without affecting another user', async () => {
    const { user } = await seed(); await seed('other-owner');
    await getCachedPortfolio('cache-owner'); await getCachedPortfolio('other-owner');
    await updateProfile(String(user._id), { displayName: 'New name' });
    expect(values.has(key())).toBe(false); expect(values.has(key('other-owner'))).toBe(true);
    await getCachedPortfolio('cache-owner');
    await PublicProfileService.computeProfile(user._id);
    expect(values.has(key())).toBe(false);
    expect(JSON.parse((await getCachedPortfolio('cache-owner'))!.body).data.identity.displayName).toBe('New name');
  });

  it('invalidates project creation, updates and deletion through the real service', async () => {
    const { user } = await seed();
    await getCachedPortfolio('cache-owner');
    const project = await createProject(String(user._id), { name: 'New project', description: '', techStack: [], status: 'planning', visibility: 'private' });
    expect(values.has(key())).toBe(false);
    await getCachedPortfolio('cache-owner');
    await updateProject(String(user._id), project.id, { name: 'Renamed project' }); expect(values.has(key())).toBe(false);
    await getCachedPortfolio('cache-owner');
    expect(await deleteProject(String(user._id), project.id)).toBe(true); expect(values.has(key())).toBe(false);
    expect(await Project.countDocuments()).toBe(0);
  });

  it('purges the old slug on a publication rename and makes the old URL unresolvable', async () => {
    const { user } = await seed(); await getCachedPortfolio('cache-owner');
    await PublicationService.publishProfile(user._id, { slug: 'new-handle', sections: allSections, consentVersion: '2026-11' });
    expect(values.has(key())).toBe(false);
    expect(await getCachedPortfolio('cache-owner')).toBeNull();
    expect(await getCachedPortfolio('new-handle')).not.toBeNull();
  });

  it('rejects a snapshot if privacy changes while a cold fill is reading it', async () => {
    const { user } = await seed(); await UserSettings.create({ userId: user._id });
    const find = PublicProfile.findOne.bind(PublicProfile);
    const spy = vi.spyOn(PublicProfile, 'findOne').mockImplementation(((...args: Parameters<typeof PublicProfile.findOne>) => {
      const query = find(...args);
      if ((args[0] as { _id?: unknown } | undefined)?._id) {
        const exec = query.exec.bind(query);
        query.exec = async () => {
          const doc = await exec();
          await UserSettings.collection.updateOne({ userId: user._id }, { $set: { 'privacy.profileVisibility': 'private' } });
          return doc;
        };
      }
      return query;
    }) as typeof PublicProfile.findOne);
    expect(await getCachedPortfolio('cache-owner')).toBeNull();
    spy.mockRestore(); expect(values.has(key())).toBe(false);
  });
});

describe('Redis failures, SWR and generation fences', () => {
  it('coalesces concurrent cold fills into one full snapshot load', async () => {
    await seed(); const find = vi.spyOn(PublicProfile, 'findOne');
    const entries = await Promise.all(Array.from({ length: 10 }, () => getCachedPortfolio('cache-owner')));
    expect(new Set(entries.map(entry => entry!.etag)).size).toBe(1);
    expect(find.mock.calls.filter(([filter]) => (filter as { _id?: unknown } | undefined)?._id)).toHaveLength(1);
  });

  it('bypasses a disconnected or failed cache and still enforces current privacy', async () => {
    const { user } = await seed(); portfolioRedis.status = 'reconnecting';
    expect(await getCachedPortfolio('cache-owner')).not.toBeNull(); expect(values.has(key())).toBe(false);
    portfolioRedis.status = 'ready'; portfolioRedis.mget.mockRejectedValueOnce(new Error('Redis down'));
    expect(await getCachedPortfolio('cache-owner')).not.toBeNull();
    await UserSettings.create({ userId: user._id, privacy: { profileVisibility: 'private' } });
    portfolioRedis.status = 'reconnecting';
    expect(await getCachedPortfolio('cache-owner')).toBeNull();
  });

  it('treats corrupt data and Redis write failure as a miss without rejecting a public read', async () => {
    await seed(); values.set(key(), { value: '{broken' });
    portfolioRedis.eval.mockRejectedValueOnce(new Error('Redis write failed'));
    expect(await getCachedPortfolio('cache-owner')).not.toBeNull();
    expect(values.has(key())).toBe(false);
    expect(await getCachedPortfolio('cache-owner')).not.toBeNull();
  });

  it('bounds stalled Redis reads and invalidation instead of hanging requests or committed writes', async () => {
    await seed(); portfolioRedis.mget.mockImplementationOnce(() => new Promise(() => {}));
    expect(await getCachedPortfolio('cache-owner')).not.toBeNull();
    portfolioRedis.eval.mockImplementationOnce(() => new Promise(() => {}));
    await expect(invalidateCacheTag('user:stalled')).resolves.toBeUndefined();
  });

  it('refuses a delayed fill after tag invalidation and purges all aliases for that user', async () => {
    const tag = portfolioTag(String(new Types.ObjectId()));
    const generation = (await readTaggedCache('one', tag))!.generation;
    await writeTaggedCache('one', tag, generation, 'first', 3600);
    await writeTaggedCache('two', tag, generation, 'second', 3600);
    await invalidateCacheTag(tag);
    expect(values.has('one')).toBe(false); expect(values.has('two')).toBe(false);
    await writeTaggedCache('one', tag, generation, 'stale', 3600);
    expect(values.has('one')).toBe(false);
  });

  it('does not purge a reassigned handle when its previous owner invalidates their tag', async () => {
    await writeTaggedCache('portfolio:view:reused', 'user:old', '0', 'old', 3600);
    await writeTaggedCache('portfolio:view:reused', 'user:new', '0', 'new', 3600);
    await invalidateCacheTag('user:old');
    expect(values.get('portfolio:view:reused')?.value).toBe('new');
  });

  it('refreshes a five-minute-old entry in the background and expires it after one hour', async () => {
    await seed(); vi.useFakeTimers({ toFake: ['Date'] });
    await getCachedPortfolio('cache-owner');
    const first = JSON.parse(values.get(key())!.value).refreshedAt;
    vi.setSystemTime(Date.now() + PORTFOLIO_REFRESH_MS + 1);
    const evalCount = portfolioRedis.eval.mock.calls.length;
    await getCachedPortfolio('cache-owner');
    await vi.waitFor(() => expect(portfolioRedis.eval.mock.calls.length).toBeGreaterThan(evalCount));
    expect(JSON.parse(values.get(key())!.value).refreshedAt).toBeGreaterThan(first);
    vi.setSystemTime(Date.now() + (PORTFOLIO_TTL_SECONDS + 1) * 1000);
    await getCachedPortfolio('cache-owner');
    expect(JSON.parse(values.get(key())!.value).refreshedAt).toBe(Date.now());
  });

  it('rebuilds an older published snapshot once before caching the current format', async () => {
    await seed('cache-owner', { snapshot: { version: 1 } });
    const compute = vi.spyOn(PublicProfileService, 'computeProfile');
    expect(await getCachedPortfolio('cache-owner')).not.toBeNull();
    expect(compute).toHaveBeenCalledTimes(1);
    expect((await PublicProfile.findOne())?.snapshot.version).toBe(2);
  });

  it('does not fall back to cached data on an authoritative database error', async () => {
    await seed(); await getCachedPortfolio('cache-owner');
    vi.spyOn(PublicProfile, 'aggregate').mockImplementationOnce(() => { throw new Error('MongoDB unavailable'); });
    const response = await read('cache-owner', { 'If-None-Match': '*' });
    expect(response.status).toBe(500); expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

it.runIf(process.env.PORTFOLIO_PERF === '1')('measures local cache-hit latency and HTTP throughput with real MongoDB and fixture Redis', async () => {
  await seed();
  const startMiss = performance.now(); await getCachedPortfolio('cache-owner');
  const missMs = performance.now() - startMiss;
  const samples: number[] = [];
  for (let i = 0; i < 200; i++) { const start = performance.now(); await getCachedPortfolio('cache-owner'); samples.push(performance.now() - start); }
  const startHttp = performance.now();
  for (let batch = 0; batch < 25; batch++) {
    await Promise.all(Array.from({ length: 20 }, async () => { const response = await read(); expect(response.status).toBe(200); await response.arrayBuffer(); }));
  }
  samples.sort((a, b) => a - b);
  await writeFile('portfolio-cache-performance.tmp', JSON.stringify({
    transport: 'fixture Redis, real temporary MongoDB, isolated HTTP router without ingress rate limits',
    samples: samples.length, missMs, cacheHitMedianMs: samples[100], cacheHitP95Ms: samples[190],
    httpRequests: 500, httpConcurrency: 20, httpRps: 500 / ((performance.now() - startHttp) / 1000),
  }, null, 2));
}, 60_000);
