import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileAuditLog } from '../../../db/models/profileAuditLog.model.js';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { RESERVED_SLUGS, UsernameReservation } from '../../../db/models/usernameReservation.model.js';
import { User } from '../../../db/models/user.model.js';
import { migratePublicProfileOptIn, rollbackPublicProfileOptIn } from '../../../db/migrations/0013-public-profile-opt-in.js';
import { registerPublicProfileShell } from '../../../modules/profile/ogShell.routes.js';
import profileRoutes from '../../../modules/profile/profile.routes.js';
import { PublicProfileService } from '../../../modules/profile/publicProfile.service.js';
import { consumerRegistry, type DomainEventEnvelope } from '../../../shared/events/index.js';
import mongoose from 'mongoose';

const actor = vi.hoisted(() => ({ id: '' }));
vi.mock('../../../middleware/index.js', async original => {
  const actual = await original<typeof import('../../../middleware/index.js')>();
  return {
    ...actual,
    authMiddleware: (req: Request, res: Response, next: NextFunction) => {
      if (!actor.id) { res.status(401).json({ success: false }); return; }
      Object.assign(req, { user: { id: actor.id } });
      next();
    },
  };
});

const events: DomainEventEnvelope[] = [];
for (const type of ['profile.published', 'profile.unpublished']) {
  consumerRegistry.register(type, { name: 'privacyTestConsumer', dedup: 'natural', handle: async event => { events.push(event); } });
}

let server: Server;
let base: string;

beforeAll(async () => {
  // The unique indexes are what make the handle reservation race-safe, so wait for them.
  await Promise.all([PublicProfile.init(), UsernameReservation.init()]);
  const app = express();
  app.use(express.json());
  registerPublicProfileShell(app, 'https://portfolio.example.test');
  app.use('/api/v1/profile', profileRoutes);
  app.use((error: { statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode || 500).json({ success: false });
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => { events.length = 0; });
afterEach(() => vi.restoreAllMocks());

let counter = 0;
async function makeUser(username = `owner${counter++}`) {
  return User.create({ clerkId: `clerk_${username}`, username, displayName: username, email: `${username}@example.test` });
}

const allSections = { streak: true, dsa: true, github: true, projects: true, activity: true };
const publish = (body: unknown) => fetch(base + '/api/v1/profile/publication', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const unpublish = () => fetch(base + '/api/v1/profile/publication', { method: 'DELETE' });
const readPublication = () => fetch(base + '/api/v1/profile/publication');
const readPublic = (slug: string) => fetch(`${base}/api/v1/profile/public/${slug}`);
const validBody = (slug: string, sections: Record<string, boolean> = { dsa: true }) => ({ slug, sections, consentVersion: '2026-11' });

async function asUser(username?: string) {
  const user = await makeUser(username);
  actor.id = String(user._id);
  return user;
}

describe('privacy defaults', () => {
  it('creates profile documents private, unindexed, unpublished and with every section hidden', async () => {
    const user = await makeUser();
    const profile = await PublicProfile.create({ userId: user._id, username: user.username, slug: user.username });
    expect(profile).toMatchObject({
      published: false, visibility: 'private', isIndexable: false, publicationVersion: 0,
      sections: { streak: false, dsa: false, github: false, projects: false, activity: false },
    });
  });

  it('computing a profile does not expose it, and the public endpoint never builds one', async () => {
    const user = await makeUser();
    await PublicProfileService.computeProfile(user._id);
    expect(await PublicProfile.findOne({ userId: user._id })).toMatchObject({ published: false, visibility: 'private' });

    const other = await makeUser();
    expect((await readPublic(other.username)).status).toBe(404);
    expect(await PublicProfile.exists({ userId: other._id })).toBeNull();
    expect((await readPublic(user.username)).status).toBe(404);
  });

  it('answers unknown, unpublished and privately configured handles with the same 404', async () => {
    const unpublished = await makeUser('stayprivate');
    await PublicProfileService.computeProfile(unpublished._id);
    await asUser('wentdark');
    expect((await publish(validBody('went-dark'))).status).toBe(200);
    expect((await unpublish()).status).toBe(200);

    const bodies: unknown[] = [];
    for (const handle of ['no-such-user', 'stayprivate', 'went-dark']) {
      const response = await readPublic(handle);
      expect(response.status).toBe(404);
      const { timestamp, ...rest } = await response.json();
      expect(typeof timestamp).toBe('string');
      bodies.push(rest);
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);

    const shell = await Promise.all(['no-such-user', 'stayprivate', 'went-dark'].map(async handle => {
      const response = await fetch(`${base}/u/${handle}`);
      return [response.status, await response.text()];
    }));
    expect(new Set(shell.map(entry => JSON.stringify(entry))).size).toBe(1);
    expect(shell[0][0]).toBe(404);
  });
});

describe('publishing', () => {
  it('rejects reserved and malformed handles without touching any state', async () => {
    const user = await asUser();
    for (const slug of ['admin', 'api', 'settings', 'focus', 'interview', 'ADMIN']) {
      const response = await publish(validBody(slug));
      expect(response.status, slug).toBe(409);
    }
    for (const slug of ['ab', '-bad-start', 'bad-end-', 'has space', 'under_score', 'a'.repeat(31), '../x']) {
      expect((await publish(validBody(slug))).status, slug).toBe(400);
    }
    expect((await publish({ slug: 'fine-slug', sections: { dsa: true, secrets: true }, consentVersion: '1' })).status).toBe(400);
    expect((await publish({ slug: 'fine-slug', sections: {} })).status).toBe(400);
    expect(await UsernameReservation.countDocuments({ userId: user._id })).toBe(0);
    expect(await PublicProfile.exists({ userId: user._id, published: true })).toBeNull();
    expect(events).toHaveLength(0);
    expect(RESERVED_SLUGS).toEqual(expect.arrayContaining(['admin', 'api', 'settings', 'focus', 'interview']));
  });

  it('publishes in one step: reservation, visibility, chosen sections, version, audit entry and event', async () => {
    const user = await asUser();
    const response = await publish({
      ...validBody('Sam-Builds', { dsa: true, projects: true }),
      settings: { theme: 'monokai-hacker', sectionOrder: ['projects', 'dsa', 'github', 'activity', 'streak'] },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      published: true, slug: 'sam-builds', publicationVersion: 1, consentVersion: '2026-11',
      sections: { dsa: true, projects: true, streak: false, github: false, activity: false },
      settings: { theme: 'monokai-hacker', sectionOrder: ['projects', 'dsa', 'github', 'activity', 'streak'] },
    });

    expect(await UsernameReservation.findOne({ slug: 'sam-builds' })).toMatchObject({ status: 'active' });
    expect(String((await UsernameReservation.findOne({ slug: 'sam-builds' }))!.userId)).toBe(String(user._id));
    expect(await PublicProfile.findOne({ userId: user._id })).toMatchObject({
      published: true, visibility: 'public', slug: 'sam-builds', isIndexable: false, publicationVersion: 1,
    });
    expect(await ProfileAuditLog.findOne({ userId: user._id, eventType: 'visibility_changed' })).toMatchObject({
      triggeredBy: 'user', details: { published: true, slug: 'sam-builds', publicationVersion: 1 },
    });
    expect(events).toMatchObject([{ type: 'profile.published', userId: String(user._id), payload: { slug: 'sam-builds', publicationVersion: 1 } }]);

    const publicRead = await readPublic('sam-builds');
    expect(publicRead.status).toBe(200);
    const dto = (await publicRead.json()).data;
    expect(dto.dsa).toBeDefined();
    expect(dto.github).toBeUndefined();
    expect(dto.consistency).toBeUndefined();
    expect(dto.activityHeatmap).toBeUndefined();
    expect(dto.projects).toEqual([]);
    expect(dto.settings).toEqual({ theme: 'monokai-hacker', sectionOrder: ['projects', 'dsa', 'github', 'activity', 'streak'] });
  });

  it('keeps the chosen handle when the profile is rebuilt later', async () => {
    const user = await asUser();
    await publish(validBody('my-handle'));
    await PublicProfileService.computeProfile(user._id);
    expect(await PublicProfile.findOne({ userId: user._id })).toMatchObject({
      slug: 'my-handle', seo: { canonicalUrl: 'https://devtrack.io/u/my-handle' },
    });
    expect((await readPublic('my-handle')).status).toBe(200);
  });

  it('preserves existing portfolio settings when an older client omits them', async () => {
    await asUser();
    expect((await publish({
      ...validBody('keeps-settings', { dsa: true }),
      settings: { theme: 'monokai-hacker', sectionOrder: ['projects', 'dsa', 'github', 'activity', 'streak'] },
    })).status).toBe(200);
    expect((await publish(validBody('keeps-settings', { github: true }))).status).toBe(200);
    expect(await PublicProfile.findOne({ userId: actor.id })).toMatchObject({
      settings: { theme: 'monokai-hacker', sectionOrder: ['projects', 'dsa', 'github', 'activity', 'streak'] },
    });
  });

  it('returns safe defaults for a legacy profile without stored settings', async () => {
    await asUser();
    expect((await publish(validBody('legacy-settings', { dsa: true }))).status).toBe(200);
    await PublicProfile.updateOne({ userId: actor.id }, { $unset: { settings: 1 } });
    const response = await readPublication();
    expect(response.status).toBe(200);
    expect((await response.json()).data.settings).toEqual({
      theme: 'modern-dark',
      sectionOrder: ['streak', 'dsa', 'github', 'projects', 'activity'],
    });
  });

  it('refuses a handle another user holds or uses as a username, and the loser keeps no reservation', async () => {
    await asUser();
    await publish(validBody('taken-handle'));
    await makeUser('existingname');

    const second = await asUser();
    const clash = await publish(validBody('taken-handle'));
    expect(clash.status).toBe(409);
    const usernameClash = await publish(validBody('ExistingName'));
    expect(usernameClash.status).toBe(409);
    expect(await UsernameReservation.countDocuments({ userId: second._id })).toBe(0);
    expect(await PublicProfile.exists({ userId: second._id, published: true })).toBeNull();
  });

  it('rolls everything back when a later step of the transaction fails', async () => {
    const user = await asUser();
    vi.spyOn(ProfileAuditLog, 'create').mockRejectedValueOnce(new Error('audit down'));
    expect((await publish(validBody('rolled-back'))).status).toBe(500);
    expect(await UsernameReservation.exists({ slug: 'rolled-back' })).toBeNull();
    expect(await PublicProfile.findOne({ userId: user._id })).toMatchObject({ published: false, publicationVersion: 0 });
    expect(events).toHaveLength(0);
    expect((await readPublic('rolled-back')).status).toBe(404);
  });

  it('releases the old handle when the owner picks a new one, and others can then claim it', async () => {
    const first = await asUser();
    await publish(validBody('old-handle'));
    const changed = await publish(validBody('new-handle', { streak: true }));
    expect((await changed.json()).data).toMatchObject({ slug: 'new-handle', publicationVersion: 2 });
    expect(await UsernameReservation.findOne({ slug: 'old-handle' })).toMatchObject({ status: 'released' });
    expect(await UsernameReservation.countDocuments({ userId: first._id, status: 'active' })).toBe(1);
    expect((await readPublic('old-handle')).status).toBe(404);

    const second = await asUser();
    expect((await publish(validBody('old-handle'))).status).toBe(200);
    expect(String((await UsernameReservation.findOne({ slug: 'old-handle' }))!.userId)).toBe(String(second._id));
    expect(await UsernameReservation.findOne({ slug: 'old-handle' })).toMatchObject({ status: 'active' });
  });

  it('lets the owner republish with different sections under the same handle', async () => {
    await asUser();
    await publish(validBody('steady', { dsa: true }));
    const again = await publish(validBody('steady', { github: true }));
    expect(again.status).toBe(200);
    expect((await again.json()).data).toMatchObject({
      publicationVersion: 2, sections: { github: true, dsa: false },
    });
  });
});

describe('unpublishing', () => {
  it('takes effect on the very next request, bumps the version and emits an event', async () => {
    const user = await asUser();
    await publish(validBody('going-away'));
    expect((await readPublic('going-away')).status).toBe(200);

    const response = await unpublish();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ published: false, slug: null, publicationVersion: 2 });
    expect((await readPublic('going-away')).status).toBe(404);
    expect((await fetch(`${base}/u/going-away`)).status).toBe(404);

    expect(await PublicProfile.findOne({ userId: user._id })).toMatchObject({ published: false, visibility: 'private' });
    expect(await UsernameReservation.findOne({ slug: 'going-away' })).toMatchObject({ status: 'active' });
    expect(await ProfileAuditLog.countDocuments({ userId: user._id, eventType: 'visibility_changed' })).toBe(2);
    expect(events.map(event => event.type)).toEqual(['profile.published', 'profile.unpublished']);
    expect(events[1].payload).toMatchObject({ slug: 'going-away', publicationVersion: 2 });
  });

  it('is idempotent and works for users who never published', async () => {
    const user = await asUser();
    const response = await unpublish();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ published: false, publicationVersion: 0 });
    await publish(validBody('twice'));
    await unpublish();
    await unpublish();
    expect(await PublicProfile.findOne({ userId: user._id })).toMatchObject({ publicationVersion: 2 });
    expect(events.filter(event => event.type === 'profile.unpublished')).toHaveLength(1);
  });

  it('requires authentication for every publication route', async () => {
    actor.id = '';
    expect((await fetch(base + '/api/v1/profile/publication')).status).toBe(401);
    expect((await publish(validBody('anonymous'))).status).toBe(401);
    expect((await unpublish()).status).toBe(401);
  });

  it('reports the current state on GET, hidden by default', async () => {
    await asUser();
    const before = await (await fetch(base + '/api/v1/profile/publication')).json();
    expect(before.data).toMatchObject({
      published: false, slug: null, publicationVersion: 0,
      sections: { streak: false, dsa: false, github: false, projects: false, activity: false },
    });
    await publish(validBody('visible-now', allSections));
    expect((await (await fetch(base + '/api/v1/profile/publication')).json()).data)
      .toMatchObject({ published: true, slug: 'visible-now', sections: allSections });
  });
});

describe('migration 0012', () => {
  it('unpublishes legacy public profiles, seeds system handles and is safe to run twice', async () => {
    const db = mongoose.connection.db!;
    const legacyUser = await makeUser('legacyowner');
    // A v1 document: public and indexable, none of the opt-in fields.
    await db.collection('publicprofiles').insertOne({
      userId: legacyUser._id, username: 'legacyowner', slug: 'legacyowner', visibility: 'public', isIndexable: true,
      snapshot: { version: 2 }, antiGaming: { isFlagged: false }, stats: {},
    });
    const publishedUser = await makeUser('alreadymigrated');
    actor.id = String(publishedUser._id);
    await publish(validBody('kept-public'));

    await migratePublicProfileOptIn(db);
    await migratePublicProfileOptIn(db);

    expect(await PublicProfile.findOne({ userId: legacyUser._id })).toMatchObject({
      published: false, visibility: 'private', isIndexable: false, publicationVersion: 0,
      sections: { streak: false, dsa: false, github: false, projects: false, activity: false },
    });
    expect((await readPublic('legacyowner')).status).toBe(404);
    // Profiles that already went through the new flow are left alone.
    expect(await PublicProfile.findOne({ slug: 'kept-public' })).toMatchObject({ published: true, publicationVersion: 1 });

    expect(await UsernameReservation.countDocuments({ status: 'reserved_system' })).toBe(RESERVED_SLUGS.length);
    expect(await UsernameReservation.findOne({ slug: 'api' })).toMatchObject({ status: 'reserved_system', userId: null });
    // The database itself refuses a second reservation for a handle.
    await expect(db.collection('usernamereservations').insertOne({ slug: 'api', status: 'active', userId: legacyUser._id }))
      .rejects.toMatchObject({ code: 11000 });

    await rollbackPublicProfileOptIn(db);
    expect(await UsernameReservation.countDocuments({ status: 'reserved_system' })).toBe(0);
    expect(await db.collection('publicprofiles').findOne({ slug: 'legacyowner' })).not.toHaveProperty('published');
    expect(await db.collection('publicprofiles').findOne({ slug: 'legacyowner' })).toMatchObject({ visibility: 'private' });
    await rollbackPublicProfileOptIn(db);
  });
});
