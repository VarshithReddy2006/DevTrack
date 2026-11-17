import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { ProfileView } from '../../../db/models/profileView.model.js';
import { User } from '../../../db/models/user.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import { registerPublicProfileShell } from '../../../modules/profile/ogShell.routes.js';
import { cacheManager } from '../../../shared/cache/cacheManager.js';

const origin = 'https://portfolio.example.test';
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  registerPublicProfileShell(app, origin);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

afterEach(() => vi.restoreAllMocks());

async function makeProfile(slug: string, indexable = true) {
  return PublicProfile.create({
    userId: new Types.ObjectId(),
    username: slug,
    slug,
    published: true,
    visibility: 'public',
    isIndexable: indexable,
    snapshot: { identity: { displayName: 'Sam & Jules <Team>' } },
    seo: {
      ogDescription: 'Builds "fast" APIs & <services>',
      ogImageUrl: 'https://images.example.test/share.png',
    },
  });
}

it('returns server-rendered, escaped metadata with a canonical link and noindex', async () => {
  const profile = await makeProfile('sam-and-jules', false);
  const response = await fetch(base + '/u/sam-and-jules', { headers: { 'User-Agent': 'Slackbot-LinkExpanding' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  const html = await response.text();
  expect(html).toContain('<title>Sam &amp; Jules &lt;Team&gt; - DevTrack Portfolio</title>');
  expect(html).toContain('<meta property="og:description" content="Builds &quot;fast&quot; APIs &amp; &lt;services&gt;">');
  expect(html).toContain('<meta property="og:image" content="https://images.example.test/share.png">');
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  expect(html).toContain('<meta name="robots" content="noindex">');
  expect(html).toContain('<link rel="canonical" href="' + origin + '/u/sam-and-jules">');
  expect(html).toContain('<a id="portfolio-link" href="' + origin + '/portfolio/sam-and-jules">');
  expect(html).not.toContain('<Team>');
  expect(await ProfileView.countDocuments({ profileUserId: profile.userId })).toBe(0);
});

it('serves a same-origin script that transfers browsers to the public SPA route', async () => {
  const response = await fetch(base + '/u/.well-known/portfolio-redirect.js');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('javascript');
  const href = origin + '/portfolio/sam-and-jules';
  const replace = vi.fn();
  runInNewContext(await response.text(), {
    window: { location: { replace } },
    document: { getElementById: () => ({ href }) },
  });
  expect(replace).toHaveBeenCalledExactlyOnceWith(href);
});

it('redirects uppercase slugs and leaves unpublished user accounts unpublished', async () => {
  await User.create({
    clerkId: 'clerk_unpublished', username: 'unpublished',
    email: 'unpublished@example.test', displayName: 'Unpublished',
  });
  const upper = await fetch(base + '/u/Sam.And.Jules', { redirect: 'manual' });
  expect(upper.status).toBe(301);
  expect(upper.headers.get('location')).toBe(origin + '/u/sam.and.jules');
  expect((await fetch(base + '/u/unpublished')).status).toBe(404);
  expect(await PublicProfile.exists({ slug: 'unpublished' })).toBeNull();
});

it('reuses the template and bypasses cache rendering for matching validators', async () => {
  const profile = await makeProfile('cache-test');
  await PublicProfile.updateOne({ _id: profile._id }, { $set: { 'seo.ogImageUrl': null } });
  const cache = vi.spyOn(cacheManager, 'getOrSet');
  const endpoint = base + '/u/cache-test';
  const initial = await fetch(endpoint);
  const tag = initial.headers.get('etag')!;
  const html = await initial.text();
  expect(tag).toMatch(/^W\/"[^"]+"$/);
  expect(html).toContain(origin + '/portfolio-preview.png');
  expect(cache).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^cache:portfolio-shell:/), expect.any(Function), 300);

  expect(await (await fetch(endpoint)).text()).toBe(html);
  const conditional = await fetch(endpoint, { headers: { 'If-None-Match': '"other", ' + tag } });
  expect(conditional.status).toBe(304);
  expect(await conditional.text()).toBe('');
  expect(cache).toHaveBeenCalledTimes(1);

  await PublicProfile.updateOne({ _id: profile._id }, { $set: { isIndexable: false } });
  const changed = await fetch(endpoint, { headers: { 'If-None-Match': tag } });
  expect(changed.status).toBe(200);
  expect(changed.headers.get('etag')).not.toBe(tag);
  expect(await changed.text()).toContain('content="noindex"');
});

it('rechecks both privacy sources before honoring an old ETag', async () => {
  const profile = await makeProfile('privacy-test');
  const endpoint = base + '/u/privacy-test';
  const initial = await fetch(endpoint);
  const tag = initial.headers.get('etag')!;
  await initial.text();
  expect(initial.status).toBe(200);
  await UserSettings.create({ userId: profile.userId, privacy: { profileVisibility: 'private' } });
  const settingsPrivate = await fetch(endpoint, { headers: { 'If-None-Match': tag } });
  expect(settingsPrivate.status).toBe(404);
  expect(settingsPrivate.headers.get('cache-control')).toBe('no-store');
  await UserSettings.deleteOne({ userId: profile.userId });

  await PublicProfile.updateOne({ _id: profile._id }, { $set: { visibility: 'recruiter_only' } });
  expect((await fetch(endpoint, { headers: { 'If-None-Match': tag } })).status).toBe(404);
});
