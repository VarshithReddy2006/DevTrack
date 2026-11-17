import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { RenderArtifact } from '../../../db/models/renderArtifact.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import { buildOgCard, hashOgCard, ogArtifactKey, printable } from '../../../modules/profile/og/ogCard.js';
import { renderOgPng } from '../../../modules/profile/og/ogRenderer.js';
import { ogImageDeps } from '../../../modules/profile/ogImage.controller.js';
import { loadOgCard, renderOgArtifact } from '../../../modules/profile/ogImage.service.js';
import { registerPublicProfileShell } from '../../../modules/profile/ogShell.routes.js';
import { PublicationService } from '../../../modules/profile/publication.service.js';
import profileRoutes from '../../../modules/profile/profile.routes.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const dimensions = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

let counter = 0;
async function makeProfile(overrides: Record<string, unknown> = {}) {
  const slug = `og-user-${counter++}`;
  return PublicProfile.create({
    userId: new Types.ObjectId(),
    username: slug,
    slug,
    published: true,
    visibility: 'public',
    sections: { streak: true, dsa: true, github: true, projects: true, activity: false },
    snapshot: {
      version: 2,
      identity: { displayName: 'Ada Lovelace', levelName: 'Engineer' },
      consistency: { currentStreak: 12 },
      dsa: { totalSolved: 1234 },
      github: { contributionsLast365: 842, verifiedProjectCount: 3, primaryLanguages: ['TypeScript', 'Go'] },
    },
    ...overrides,
  });
}

describe('OG card data', () => {
  it('only contains sections the owner chose to show', async () => {
    const profile = await makeProfile({ sections: { streak: true, dsa: false, github: false, projects: false, activity: false } });
    const source = await loadOgCard({ slug: profile.slug });
    expect(source!.card.stats).toEqual([{ label: 'Day streak', value: '12' }]);
    expect(source!.card.languages).toEqual([]);
    expect(JSON.stringify(source!.card)).not.toContain('1,234');
  });

  it('applies privacy settings on top of the publication sections', async () => {
    const profile = await makeProfile();
    await UserSettings.create({ userId: profile.userId, privacy: { showDsaProgress: false, showGithub: false } });
    const { card } = (await loadOgCard({ slug: profile.slug }))!;
    expect(card.stats.map(stat => stat.label)).toEqual(['Day streak', 'Verified projects']);
    expect(card.languages).toEqual([]);
  });

  it('formats counts, falls back to the handle and drops glyphs the bundled font lacks', async () => {
    const profile = await makeProfile({ 'snapshot.identity.displayName': '你好' });
    const { card } = (await loadOgCard({ slug: profile.slug }))!;
    expect(card.displayName).toBe(profile.slug);
    expect(card.stats).toContainEqual({ label: 'Problems solved', value: '1,234' });
    expect(printable('Zo\u00eb \u{1F600} Smith', 40)).toBe('Zo\u00eb Smith');
    expect(printable('a'.repeat(60), 40)).toHaveLength(40);
  });

  it('hashes the card content: same content same hash, changed content new hash', async () => {
    const profile = await makeProfile();
    const first = (await loadOgCard({ slug: profile.slug }))!;
    expect((await loadOgCard({ slug: profile.slug }))!.contentHash).toBe(first.contentHash);
    await PublicProfile.updateOne({ _id: profile._id }, { $set: { 'snapshot.consistency.currentStreak': 13 } });
    expect((await loadOgCard({ slug: profile.slug }))!.contentHash).not.toBe(first.contentHash);
    // Fields that are not on the card do not change it.
    const before = (await loadOgCard({ slug: profile.slug }))!.contentHash;
    await PublicProfile.updateOne({ _id: profile._id }, { $set: { 'snapshot.dsa.hardSolved': 99, 'stats.profileViews': 5 } });
    expect((await loadOgCard({ slug: profile.slug }))!.contentHash).toBe(before);
    expect(hashOgCard(first.card)).toBe(first.contentHash);
  });

  it('returns nothing for unpublished, non-public and settings-private profiles', async () => {
    const unpublished = await makeProfile({ published: false });
    const recruiterOnly = await makeProfile({ visibility: 'recruiter_only' });
    const hidden = await makeProfile();
    await UserSettings.create({ userId: hidden.userId, privacy: { profileVisibility: 'private' } });
    for (const profile of [unpublished, recruiterOnly, hidden]) expect(await loadOgCard({ slug: profile.slug })).toBeNull();
    expect(await loadOgCard({ slug: 'nobody-here' })).toBeNull();
  });
});

describe('OG renderer (satori + resvg)', () => {
  it('produces a 1200x630 PNG', async () => {
    const profile = await makeProfile();
    const png = await renderOgPng((await loadOgCard({ slug: profile.slug }))!.card);
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(dimensions(png)).toEqual({ width: 1200, height: 630 });
  });

  it('renders a card with no visible sections and very long text', async () => {
    const png = await renderOgPng(buildOgCard({
      username: 'x'.repeat(30),
      sections: { streak: false, dsa: false, github: false, projects: false },
      snapshot: {
        identity: { displayName: 'W'.repeat(200), levelName: 'Engineer', avatarUrl: null, joinedAt: new Date(), timezone: 'UTC', level: 1, totalXp: 0 },
      },
    } as never));
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(dimensions(png)).toEqual({ width: 1200, height: 630 });
  });
});

describe('content-hash cache', () => {
  const fakePng = () => Buffer.concat([PNG_MAGIC, Buffer.from('fake')]);

  it('stores one artifact per profile and skips the renderer when the content is unchanged', async () => {
    const profile = await makeProfile();
    const render = vi.fn(async () => fakePng());

    expect(await renderOgArtifact(profile.userId, render)).toMatchObject({ status: 'rendered' });
    expect(await renderOgArtifact(profile.userId, render)).toMatchObject({ status: 'cached' });
    expect(render).toHaveBeenCalledTimes(1);

    const stored = await RenderArtifact.findOne({ artifactKey: ogArtifactKey(String(profile.userId)) }).select('+content');
    expect(stored).toMatchObject({ type: 'og_image', status: 'ready', contentType: 'image/png', storageUrl: null, byteLength: fakePng().length });
    expect(stored!.contentHash).toBe((await loadOgCard({ slug: profile.slug }))!.contentHash);
    expect(stored!.content!.equals(fakePng())).toBe(true);
  });

  it('renders again, in place, when the card content changes', async () => {
    const profile = await makeProfile();
    const render = vi.fn(async () => fakePng());
    await renderOgArtifact(profile.userId, render);
    const first = await RenderArtifact.findOne({ userId: profile.userId });
    await PublicProfile.updateOne({ _id: profile._id }, { $set: { 'snapshot.dsa.totalSolved': 2000 } });

    expect(await renderOgArtifact(profile.userId, render)).toMatchObject({ status: 'rendered' });
    expect(render).toHaveBeenCalledTimes(2);
    expect(await RenderArtifact.countDocuments({ userId: profile.userId })).toBe(1);
    expect((await RenderArtifact.findOne({ userId: profile.userId }))!.contentHash).not.toBe(first!.contentHash);
  });

  it('does not trust an expired artifact', async () => {
    const profile = await makeProfile();
    const render = vi.fn(async () => fakePng());
    await renderOgArtifact(profile.userId, render);
    await RenderArtifact.updateOne({ userId: profile.userId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await renderOgArtifact(profile.userId, render)).toMatchObject({ status: 'rendered' });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('skips an unpublished profile and deletes its stored card', async () => {
    const profile = await makeProfile();
    const render = vi.fn(async () => fakePng());
    await renderOgArtifact(profile.userId, render);
    await PublicProfile.updateOne({ _id: profile._id }, { $set: { published: false } });

    expect(await renderOgArtifact(profile.userId, render)).toEqual({ status: 'skipped', reason: 'unpublished' });
    expect(render).toHaveBeenCalledTimes(1);
    expect(await RenderArtifact.countDocuments({ userId: profile.userId })).toBe(0);
  });

  it('enforces a unique artifactKey', async () => {
    await RenderArtifact.init();
    const base = { artifactKey: 'og_image:dup', userId: new Types.ObjectId(), type: 'og_image', contentHash: 'a'.repeat(64), contentType: 'image/png', expiresAt: new Date(Date.now() + 1000) };
    await RenderArtifact.create(base);
    await expect(RenderArtifact.create({ ...base })).rejects.toMatchObject({ code: 11000 });
  });
});

describe('GET /api/v1/profile/public/:username/og.png', () => {
  let server: Server;
  let base: string;
  // Stands in for the render worker: runs the same job body the worker runs.
  const enqueue = vi.fn(async (userId: string) => { await renderOgArtifact(userId); });

  beforeAll(async () => {
    const app = express();
    registerPublicProfileShell(app, 'https://portfolio.example.test', 'https://api.example.test');
    app.use('/api/v1/profile', profileRoutes);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  beforeEach(() => {
    enqueue.mockClear();
    vi.spyOn(ogImageDeps, 'enqueue').mockImplementation(enqueue);
    ogImageDeps.waitMs = 5000;
  });
  afterEach(() => vi.restoreAllMocks());

  const og = (slug: string, headers: Record<string, string> = {}) => fetch(`${base}/api/v1/profile/public/${slug}/og.png`, { headers });
  const withoutTimestamp = async (response: Response) => { const { timestamp: _t, ...rest } = await response.json(); return rest; };

  it('returns a real 1200x630 PNG for a published profile and serves repeats from the cache', async () => {
    const profile = await makeProfile();
    const first = await og(profile.slug);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/png');
    const png = Buffer.from(await first.arrayBuffer());
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(dimensions(png)).toEqual({ width: 1200, height: 630 });
    expect(enqueue).toHaveBeenCalledTimes(1);

    const second = await og(profile.slug.toUpperCase());
    expect(second.status).toBe(200);
    expect(Buffer.from(await second.arrayBuffer()).equals(png)).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1); // no second job, so no second render
    expect(await RenderArtifact.countDocuments({ userId: profile.userId })).toBe(1);
  });

  it('answers a matching validator with 304 and does not queue anything', async () => {
    const profile = await makeProfile();
    const first = await og(profile.slug);
    const tag = first.headers.get('etag')!;
    await first.arrayBuffer();
    enqueue.mockClear();
    const again = await og(profile.slug, { 'If-None-Match': tag });
    expect(again.status).toBe(304);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns the same 404 body for an unpublished profile as for an unknown handle, without queuing', async () => {
    const profile = await makeProfile({ published: false });
    const hidden = await og(profile.slug);
    const unknown = await og('no-such-handle');
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await withoutTimestamp(hidden)).toEqual(await withoutTimestamp(unknown));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('stops serving, even with a valid validator, once the profile is unpublished', async () => {
    const profile = await makeProfile();
    const first = await og(profile.slug);
    const tag = first.headers.get('etag')!;
    await first.arrayBuffer();
    expect(await RenderArtifact.countDocuments({ userId: profile.userId })).toBe(1);

    await PublicationService.unpublishProfile(profile.userId);
    expect(await RenderArtifact.countDocuments({ userId: profile.userId })).toBe(0);
    expect((await og(profile.slug, { 'If-None-Match': tag })).status).toBe(404);
  });

  it('answers 503 with Retry-After when no worker produces the image in time', async () => {
    const profile = await makeProfile();
    enqueue.mockImplementation(async () => undefined);
    ogImageDeps.waitMs = 300;
    const response = await og(profile.slug);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('advertises the card in the public profile API and the share shell, for published profiles only', async () => {
    const profile = await makeProfile();
    const api = await (await fetch(`${base}/api/v1/profile/public/${profile.slug}`)).json();
    expect(api.data.seo.ogImageUrl).toMatch(new RegExp(`^/api/v1/profile/public/${profile.slug}/og\\.png\\?v=\\d+-[0-9a-z]+$`));

    const shell = await (await fetch(`${base}/u/${profile.slug}`)).text();
    expect(shell).toContain(`<meta property="og:image" content="https://api.example.test/api/v1/profile/public/${profile.slug}/og.png?v=`);

    const hidden = await makeProfile({ published: false });
    expect((await fetch(`${base}/u/${hidden.slug}`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/profile/public/${hidden.slug}`)).status).toBe(404);
  });
});
