import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { RenderArtifact } from '../../../db/models/renderArtifact.model.js';
import { loadDossierData } from '../../../modules/profile/dossier/dossierData.js';
import { renderDossierArtifact } from '../../../modules/profile/dossier/dossier.service.js';
import { dossierDeps } from '../../../modules/profile/dossier.controller.js';
import profileRoutes from '../../../modules/profile/profile.routes.js';
import { getObjectStorage, LocalDiskObjectStorage } from '../../../shared/storage/objectStorage.js';

const env = vi.hoisted(() => {
  process.env.UPLOAD_DIR = `${process.env.TMPDIR ?? '/tmp'}/devtrack-dossier-test-${process.pid}`;
  process.env.OBJECT_STORAGE_SIGNING_SECRET = 'dossier-test-signing-secret-0123456789';
  return { uploadDir: process.env.UPLOAD_DIR };
});
const actor = vi.hoisted(() => ({ id: '' }));
const browser = vi.hoisted(() => ({
  launch: vi.fn(), pdf: vi.fn(), setContent: vi.fn(), setJavaScriptEnabled: vi.fn(), setRequestInterception: vi.fn(),
  on: vi.fn(), pageClose: vi.fn(), close: vi.fn(),
}));
vi.mock('puppeteer', () => ({ default: { launch: browser.launch } }));
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

beforeEach(() => {
  vi.clearAllMocks();
  browser.pdf.mockResolvedValue(Buffer.from('%PDF-1.4 synthetic dossier'));
  browser.setContent.mockResolvedValue(undefined);
  browser.pageClose.mockResolvedValue(undefined);
  browser.close.mockResolvedValue(undefined);
  browser.launch.mockResolvedValue({
    newPage: async () => ({
      close: browser.pageClose, setJavaScriptEnabled: browser.setJavaScriptEnabled,
      setRequestInterception: browser.setRequestInterception, on: browser.on, setContent: browser.setContent, pdf: browser.pdf,
    }),
    close: browser.close,
  });
});
afterAll(() => rm(env.uploadDir, { recursive: true, force: true }));

let counter = 0;
async function makeProfile(overrides: Record<string, unknown> = {}) {
  const username = `dossier-user-${counter++}`;
  return PublicProfile.create({
    userId: new Types.ObjectId(), username, slug: username,
    snapshot: {
      version: 2,
      identity: { displayName: 'Grace <b>Hopper</b>', levelName: 'Engineer', joinedAt: new Date('2025-01-02') },
      consistency: { currentStreak: 9, longestStreak: 40, activeDaysLast30: 20, activeDaysLast90: 60, activeDaysLast365: 200, weeklyConsistencyScore: 71, monthlyConsistencyScore: 66 },
      dsa: { totalSolved: 700, contestsParticipated: 12, bestContestRating: 1850, platformBreakdown: [{ platform: 'leetcode', solved: 500, rating: 1700 }, { platform: 'codeforces', solved: 200, rating: null }] },
      github: { isVerified: true, totalContributions: 3000, contributionsLast365: 900, primaryLanguages: ['TypeScript', 'Rust'] },
      projects: [
        { name: 'Compiler', repoFullName: 'grace/compiler', verification: { status: 'verified', verifiedAt: new Date('2025-06-01') }, metrics: { primaryLanguage: 'Rust', stars: 42 } },
        { name: 'Unverified', repoFullName: 'grace/nope', verification: { status: 'pending' }, metrics: {} },
      ],
      velocityIndicators: { trend: 'steady' },
    },
    ...overrides,
  });
}

describe('dossier data', () => {
  it('collects ratings, verified repositories and focus consistency', async () => {
    const profile = await makeProfile();
    const source = await loadDossierData(profile.userId);
    expect(source.status).toBe('ok');
    if (source.status !== 'ok') return;
    expect(source.data.platforms).toEqual([{ platform: 'leetcode', solved: 500, rating: 1700 }, { platform: 'codeforces', solved: 200, rating: null }]);
    expect(source.data.projects).toEqual([{ name: 'Compiler', repo: 'grace/compiler', language: 'Rust', stars: 42, verifiedOn: '2025-06-01' }]);
    expect(source.data.consistency).toMatchObject({ currentStreak: 9, activeDaysLast365: 200, weeklyScore: 71, trend: 'steady' });
    expect(source.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses profiles without a snapshot or under anti-gaming review', async () => {
    expect(await loadDossierData(new Types.ObjectId())).toEqual({ status: 'unavailable', reason: 'no_snapshot' });
    const flagged = await makeProfile({ 'antiGaming.isFlagged': true });
    expect(await loadDossierData(flagged.userId)).toEqual({ status: 'unavailable', reason: 'under_review' });
  });
});

describe('dossier render worker job (Puppeteer mocked, real local-disk storage)', () => {
  const storage = () => getObjectStorage();

  it('renders a single-page PDF with the network blocked, stores it and records the artifact', async () => {
    const profile = await makeProfile();
    const outcome = await renderDossierArtifact(profile.userId);
    expect(outcome.status).toBe('rendered');
    if (outcome.status !== 'rendered') return;

    // Chromium is driven the safe way: no JS, every request aborted, --no-sandbox launch.
    expect(browser.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true, args: ['--no-sandbox'] }));
    expect(browser.setJavaScriptEnabled).toHaveBeenCalledWith(false);
    expect(browser.setRequestInterception).toHaveBeenCalledWith(true);
    const onRequest = browser.on.mock.calls.find(([event]) => event === 'request')![1] as (request: { abort(): Promise<void> }) => void;
    const abort = vi.fn().mockResolvedValue(undefined);
    onRequest({ abort });
    expect(abort).toHaveBeenCalledOnce();
    expect(browser.pdf).toHaveBeenCalledWith(expect.objectContaining({ pageRanges: '1', printBackground: true }));
    expect(browser.close).toHaveBeenCalledOnce();

    const html = browser.setContent.mock.calls[0][0] as string;
    expect(html).toContain('Grace &lt;b&gt;Hopper&lt;/b&gt;');
    expect(html).not.toContain('<b>Hopper</b>');
    expect(html).toContain('grace/compiler');
    expect(html).not.toContain('grace/nope');
    expect(html).toContain('1,850');

    expect((await storage().get(outcome.key))!.subarray(0, 5).toString()).toBe('%PDF-');
    const row = await RenderArtifact.findOne({ userId: profile.userId });
    expect(row).toMatchObject({ type: 'pdf_dossier', status: 'ready', storageUrl: outcome.key, contentType: 'application/pdf', contentHash: outcome.contentHash });
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it('serves unchanged content from the stored PDF without starting a browser', async () => {
    const profile = await makeProfile();
    await renderDossierArtifact(profile.userId);
    browser.launch.mockClear();
    expect((await renderDossierArtifact(profile.userId)).status).toBe('cached');
    expect(browser.launch).not.toHaveBeenCalled();
  });

  it('renders again when the content changed and removes the stale PDF', async () => {
    const profile = await makeProfile();
    const first = await renderDossierArtifact(profile.userId);
    await PublicProfile.updateOne({ _id: profile._id }, { $set: { 'snapshot.dsa.totalSolved': 800 } });
    const second = await renderDossierArtifact(profile.userId);
    expect(second.status).toBe('rendered');
    expect(browser.launch).toHaveBeenCalledTimes(2);
    expect(await RenderArtifact.countDocuments({ userId: profile.userId })).toBe(1);
    const files = await readdir(path.join(env.uploadDir, 'render', 'dossiers', String(profile.userId)));
    expect(files).toEqual([path.basename((second as { key: string }).key)]);
    expect(await storage().exists((first as { key: string }).key)).toBe(false);
  });

  it('re-renders when the stored file is gone even though the row says ready', async () => {
    const profile = await makeProfile();
    const first = await renderDossierArtifact(profile.userId) as { key: string };
    await storage().delete(first.key);
    expect((await renderDossierArtifact(profile.userId)).status).toBe('rendered');
  });

  it('skips a profile that is under review and marks a pending request failed', async () => {
    const profile = await makeProfile({ 'antiGaming.isFlagged': true });
    await RenderArtifact.create({ artifactKey: `pdf_dossier:${profile.userId}`, userId: profile.userId, type: 'pdf_dossier', contentHash: 'b'.repeat(64), status: 'pending', contentType: 'application/pdf', expiresAt: new Date(Date.now() + 60_000) });
    expect(await renderDossierArtifact(profile.userId)).toEqual({ status: 'skipped', reason: 'under_review' });
    expect(browser.launch).not.toHaveBeenCalled();
    expect(await RenderArtifact.findOne({ userId: profile.userId })).toMatchObject({ status: 'failed', error: 'under_review' });
  });

  it('does not write anything when the PDF renderer throws', async () => {
    const profile = await makeProfile();
    const failing = vi.fn().mockRejectedValue(new Error('chromium crashed'));
    await expect(renderDossierArtifact(profile.userId, { render: failing })).rejects.toThrow('chromium crashed');
    expect(await RenderArtifact.countDocuments({ userId: profile.userId })).toBe(0);
  });

  it('can be handed a different storage driver', async () => {
    const profile = await makeProfile();
    const dir = await mkdtemp(path.join(tmpdir(), 'devtrack-alt-'));
    try {
      const alt = new LocalDiskObjectStorage({ root: dir, secret: 'another-signing-secret-0123456789', downloadPath: '/x' });
      const outcome = await renderDossierArtifact(profile.userId, { storage: alt, render: async () => Buffer.from('%PDF-alt') }) as { key: string };
      expect((await alt.get(outcome.key))!.toString()).toBe('%PDF-alt');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('dossier routes', () => {
  let server: Server;
  let base: string;
  // Stands in for the render worker: runs the same job body the worker runs.
  const enqueue = vi.fn(async (userId: string) => { await renderDossierArtifact(userId); });

  beforeAll(async () => {
    const app = express();
    app.use('/api/v1/profile', profileRoutes);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1/profile/dossier';
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  beforeEach(() => {
    actor.id = '';
    enqueue.mockClear();
    vi.spyOn(dossierDeps, 'enqueue').mockImplementation(enqueue);
  });
  afterEach(() => vi.restoreAllMocks());

  const post = () => fetch(base, { method: 'POST' });
  const status = async () => (await (await fetch(base)).json()).data;

  it('requires a session to request or read a dossier', async () => {
    expect((await post()).status).toBe(401);
    expect((await fetch(base)).status).toBe(401);
  });

  it('queues a render, then hands out a signed link to a real PDF download', async () => {
    const profile = await makeProfile();
    actor.id = String(profile.userId);
    expect(await status()).toEqual({ status: 'none' });

    const requested = await post();
    expect(requested.status).toBe(202);
    expect((await requested.json()).data).toEqual({ status: 'pending' });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(String(profile.userId));
    expect(await RenderArtifact.countDocuments({ userId: profile.userId })).toBe(1);

    const ready = await status(); // the in-process "worker" has finished by now
    expect(ready.status).toBe('ready');
    const link = new URL(ready.download.url, 'http://x');
    expect(link.pathname).toBe('/api/v1/profile/dossier/download');
    expect(new Date(ready.download.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect(new Date(ready.download.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);

    actor.id = ''; // the link needs no session
    const download = await fetch(base + '/download' + link.search);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(download.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await download.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('answers a repeat request for unchanged content with a fresh link and no new job', async () => {
    const profile = await makeProfile();
    actor.id = String(profile.userId);
    await post();
    enqueue.mockClear();
    const again = await post();
    expect(again.status).toBe(200);
    expect((await again.json()).data.status).toBe('ready');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects tampered, expired, foreign-prefix and malformed links with the same 403', async () => {
    const profile = await makeProfile();
    actor.id = String(profile.userId);
    await post();
    const { download } = await status();
    const link = new URL(download.url, 'http://x');
    actor.id = '';
    const get = (search: string) => fetch(base + '/download' + search);

    const bad = new URL(link); bad.searchParams.set('sig', bad.searchParams.get('sig')!.replace(/^./, c => (c === 'A' ? 'B' : 'A')));
    const later = new URL(link); later.searchParams.set('expires', String(Number(link.searchParams.get('expires')) + 3_600_000));
    const key = link.searchParams.get('key')!;
    const expired = getObjectStorage().signUrl(key, Date.now() - 16 * 60 * 1000).url;
    const traversal = getObjectStorage().signUrl('dossiers/x/ok.pdf').url.replace('dossiers%2Fx%2Fok.pdf', 'dossiers%2F..%2F..%2Fetc%2Fpasswd');
    const outside = getObjectStorage().signUrl('other/area.pdf').url;

    const responses = await Promise.all([bad.search, later.search, new URL(expired, 'http://x').search, new URL(traversal, 'http://x').search, new URL(outside, 'http://x').search, '', '?key=dossiers/x/y.pdf'].map(get));
    expect(responses.map(response => response.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    expect((await get(link.search)).status).toBe(200); // the untouched link still works
  });

  it('answers 404 for a validly signed link whose file no longer exists', async () => {
    const { url } = getObjectStorage().signUrl('dossiers/gone/missing.pdf');
    expect((await fetch(base + '/download' + new URL(url, 'http://x').search)).status).toBe(404);
  });

  it('answers 409 when there is nothing to certify', async () => {
    actor.id = String(new Types.ObjectId());
    const none = await post();
    expect(none.status).toBe(409);
    expect((await none.json()).code).toBe('DOSSIER_UNAVAILABLE');
    const flagged = await makeProfile({ 'antiGaming.isFlagged': true });
    actor.id = String(flagged.userId);
    expect((await post()).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('shows one user nothing of another user\'s dossier', async () => {
    const owner = await makeProfile();
    actor.id = String(owner.userId);
    await post();
    actor.id = String(new Types.ObjectId());
    expect(await status()).toEqual({ status: 'none' });
  });

  it('reports a failed render instead of pending forever', async () => {
    const profile = await makeProfile();
    actor.id = String(profile.userId);
    enqueue.mockImplementation(async () => undefined); // no worker answers
    await post();
    expect((await status()).status).toBe('pending');
    await RenderArtifact.updateOne({ userId: profile.userId }, { $set: { status: 'failed', error: 'render_failed' } });
    expect(await status()).toEqual({ status: 'failed', error: 'render_failed' });
  });
});
