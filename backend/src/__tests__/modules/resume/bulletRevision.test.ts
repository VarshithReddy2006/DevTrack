import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import jsonPatch from 'fast-json-patch';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { ResumeVariant, type IBulletEdit } from '../../../db/models/resumeVariant.model.js';
import { ResumeBulletRevision } from '../../../db/models/resumeBulletRevision.model.js';
import { BulletRevisionService } from '../../../modules/resume/bulletRevision.service.js';
import { bulletRevisionRoutes } from '../../../modules/resume/resume.routes.js';
import { scoreBulletEdits } from '../../../modules/resume/ats/bulletEditScoring.js';
import { errorHandler } from '../../../middleware/error.js';
import { mountApiRoutes } from '../../../routes/mount.js';

vi.mock('../../../middleware/auth.js', () => ({ authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const id = req.get('x-test-user');
  if (!id) return res.sendStatus(401);
  Object.assign(req, { user: { id } });
  next();
} }));
const limits = vi.hoisted(() => ({ reads: 0, writes: 0 }));
vi.mock('../../../middleware/rateLimitAdvanced.js', () => ({ rateLimiters: {
  resumeRead: (_req: express.Request, _res: express.Response, next: express.NextFunction) => { limits.reads++; next(); },
  resume: (_req: express.Request, _res: express.Response, next: express.NextFunction) => { limits.writes++; next(); },
} }));

const user = new Types.ObjectId().toHexString();
const other = new Types.ObjectId().toHexString();
const bullets = (text: string, section = 'experience'): IBulletEdit[] => [{ section, bulletIndex: 0, originalText: 'Original', editedText: text }];
const initial = [...bullets('Built Node.js APIs'), ...bullets('Deployed Docker services', 'projects')];
let resumeId: string;
let server: Server;
let origin: string;
let globalCalls = 0;

beforeAll(async () => {
  await Promise.all([ResumeBulletRevision.init(), ResumeProfile.init(), ResumeVariant.init()]);
  const app = express();
  const router = express.Router();
  router.use((_req, _res, next) => { globalCalls++; next(); });
  router.use('/resume', bulletRevisionRoutes);
  // The upload router follows the revision router in production and authenticates
  // all unmatched paths. The new router must not consume its request budget.
  router.get('/resume/session/test', (_req, res) => res.json({ success: true }));
  app.use(express.json());
  mountApiRoutes(app, router);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  const profile = await ResumeProfile.create({ userId: user, targetRole: 'Backend' });
  const resume = await ResumeVariant.create({ userId: user, resumeProfileId: profile._id,
    variantId: 'test-variant', roleType: 'Backend', prioritizedSkills: ['Node.js', 'Docker'], bulletEdits: initial });
  resumeId = resume._id.toString();
  limits.reads = limits.writes = globalCalls = 0;
});

function save(text: string, expectedVersion: number, section = 'experience') {
  return BulletRevisionService.saveSection(user, resumeId, section, bullets(text, section), expectedVersion);
}
function request(path: string, method = 'GET', body?: object, as: string | undefined = user) {
  return fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', ...(as ? { 'x-test-user': as } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
const path = () => `/api/v2/resume/${resumeId}`;

describe('bullet revision ledger', () => {
  it('creates five sequential compact forward/reverse patches and server scores', async () => {
    const states = [initial];
    for (let index = 1; index <= 5; index++) {
      const result = await save(`Built Node.js APIs ${index}`, index - 1);
      states.push(JSON.parse(JSON.stringify(result!.bulletEdits)));
    }
    const history = await BulletRevisionService.history(user, resumeId);
    expect(history!.currentVersion).toBe(5);
    expect(history!.revisions.map(r => r.versionNumber)).toEqual([1, 2, 3, 4, 5]);
    let state = history!.revisions[0].baseSnapshot!;
    expect(state).toEqual(initial);
    for (const [index, revision] of history!.revisions.entries()) {
      expect(revision.userId.toHexString()).toBe(user);
      expect(revision.sectionId).toBe('experience');
      state = jsonPatch.applyPatch(state, revision.patch, true, false).newDocument;
      expect(state).toEqual(states[index + 1]);
      expect(jsonPatch.applyPatch(state, revision.inversePatch, true, false).newDocument).toEqual(states[index]);
      expect(revision.patch).toEqual([{ op: 'replace', path: '/0/editedText', value: `Built Node.js APIs ${index + 1}` }]);
      expect(revision.atsScore).toBe(scoreBulletEdits(state, { targetRole: 'Backend', keywords: ['Node.js', 'Docker'] }).score);
      if (index) expect(revision.baseSnapshot).toBeUndefined();
    }
  });

  it('restores only the target section, preserving later edits elsewhere and recording rollback', async () => {
    await save('Experience version one', 0);
    await save('Experience version two', 1);
    await save('Projects version three', 2, 'projects');
    const restored = await BulletRevisionService.restore(user, resumeId, 1, 3);
    expect(restored!.bulletEdits?.map(b => b.editedText)).toEqual(['Experience version one', 'Projects version three']);
    expect(restored!.bulletRevisionVersion).toBe(4);
    const history = await BulletRevisionService.history(user, resumeId);
    expect(history!.revisions.at(-1)).toMatchObject({ versionNumber: 4, restoredFrom: 1, sectionId: 'experience' });
    await BulletRevisionService.restore(user, resumeId, 4, 4);
    expect((await BulletRevisionService.history(user, resumeId))!.currentVersion).toBe(5);
  });

  it('captures the existing live-editor initial save and supports whole-resume initial restore', async () => {
    await ResumeVariant.updateOne({ _id: resumeId }, { $unset: { bulletEdits: 1 } });
    await BulletRevisionService.saveInitial(user, resumeId, initial);
    await save('Changed later', 1);
    const restored = await BulletRevisionService.restore(user, resumeId, 1, 2);
    expect(JSON.parse(JSON.stringify(restored!.bulletEdits))).toEqual(initial);
    expect((await BulletRevisionService.history(user, resumeId))!.revisions[0].sectionId).toBe('*');
  });

  it('can undo the first legacy edit by restoring its version-zero baseline', async () => {
    await save('First destructive edit', 0);
    const response = await request(`${path()}/revisions/0/restore`, 'POST', { expectedVersion: 1 });
    expect(response.status).toBe(200);
    expect((await response.json()).data.bulletEdits).toEqual(initial);
    expect((await BulletRevisionService.history(user, resumeId))!.revisions.at(-1)).toMatchObject({
      restoredFrom: 0, sectionId: '*', versionNumber: 2,
    });
  });

  it('does not create revisions for identical saves and supports section addition/deletion', async () => {
    await save(initial[0].editedText, 0);
    expect((await BulletRevisionService.history(user, resumeId))!.currentVersion).toBe(0);
    await save('New skill', 0, 'skills');
    const deleted = await BulletRevisionService.saveSection(user, resumeId, 'experience', [], 1);
    expect(deleted!.bulletEdits?.map(b => b.section)).toEqual(['projects', 'skills']);
    await BulletRevisionService.restore(user, resumeId, 1, 2);
    // Version 1 changed skills; restoring it does not resurrect the deleted experience section.
    expect((await ResumeVariant.findById(resumeId))!.bulletEdits?.map(b => b.section)).toEqual(['projects', 'skills']);
  });

  it('keeps at most 50 records, rebases the oldest snapshot and never reuses a version', async () => {
    for (let index = 1; index <= 55; index++) await save(`Version ${index}`, index - 1);
    const history = await BulletRevisionService.history(user, resumeId);
    expect(history!.revisions).toHaveLength(50);
    expect(history!.revisions[0].versionNumber).toBe(6);
    let state = history!.revisions[0].baseSnapshot!;
    for (const revision of history!.revisions) {
      state = jsonPatch.applyPatch(state, revision.patch, true, false).newDocument;
      expect(state[0].editedText).toBe(`Version ${revision.versionNumber}`);
    }
    await expect(BulletRevisionService.restore(user, resumeId, 1, 55)).rejects.toMatchObject({ statusCode: 404 });
    await expect(BulletRevisionService.restore(user, resumeId, 0, 55)).rejects.toMatchObject({ statusCode: 404 });
    const restored = await BulletRevisionService.restore(user, resumeId, 6, 55);
    expect(restored!.bulletRevisionVersion).toBe(56);
    expect(restored!.bulletEdits![0].editedText).toBe('Version 6');
    expect(await ResumeBulletRevision.countDocuments({ resumeId })).toBe(50);
  }, 60000);

  it('serializes concurrent saves and rejects stale versions without losing the winning edit', async () => {
    const results = await Promise.allSettled([save('First edit', 0), save('Second edit', 0)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409, code: 'REVISION_CONFLICT' });
    expect(await ResumeBulletRevision.countDocuments({ resumeId })).toBe(1);
    const stored = await ResumeVariant.findById(resumeId);
    expect(stored!.bulletRevisionVersion).toBe(1);
    expect(['First edit', 'Second edit']).toContain(stored!.bulletEdits![0].editedText);
  });

  it('rolls back a resume update when inserting its ledger record fails', async () => {
    vi.spyOn(ResumeBulletRevision, 'create').mockRejectedValueOnce(new Error('ledger write failed'));
    await expect(save('Must not persist', 0)).rejects.toThrow('ledger write failed');
    const stored = await ResumeVariant.findById(resumeId).lean();
    expect(stored!.bulletRevisionVersion).toBeUndefined();
    expect(stored!.bulletEdits).toEqual(initial);
    expect(await ResumeBulletRevision.countDocuments({ resumeId })).toBe(0);
  });

  it('rolls back pruning, the new revision, and the resume together on failure', async () => {
    for (let index = 1; index <= 50; index++) await save(`Version ${index}`, index - 1);
    vi.spyOn(ResumeBulletRevision, 'deleteMany').mockRejectedValueOnce(new Error('prune failed'));
    await expect(save('Must not persist', 50)).rejects.toThrow('prune failed');
    const history = await BulletRevisionService.history(user, resumeId);
    expect(history!.currentVersion).toBe(50);
    expect(history!.revisions).toHaveLength(50);
    expect(history!.revisions[0].versionNumber).toBe(1);
    expect(history!.revisions[1].baseSnapshot).toBeUndefined();
    expect((await ResumeVariant.findById(resumeId))!.bulletEdits![0].editedText).toBe('Version 50');
  }, 60000);
});

describe('revision HTTP routes', () => {
  it.each(['/api/v2', '/api/v1', '/api'])('authenticates and returns ordered private history through %s', async prefix => {
    await save('First', 0);
    const url = `${prefix}/resume/${resumeId}/revisions`;
    expect((await request(url, 'GET', undefined, '')).status).toBe(401);
    globalCalls = 0;
    const response = await request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.has('x-api-deprecation-warning')).toBe(prefix === '/api');
    expect(globalCalls).toBe(1);
    expect((await response.json()).data).toMatchObject({ currentVersion: 1, revisions: [{ versionNumber: 1 }] });
  });

  it('saves and restores through v2 using write budgets and rejects stale requests', async () => {
    const saved = await request(`${path()}/sections/Experience/bullets`, 'PUT', { expectedVersion: 0, bullets: bullets('HTTP first') });
    expect(saved.status).toBe(200);
    expect(limits.writes).toBe(1);
    expect((await request(`${path()}/sections/experience/bullets`, 'PUT', { expectedVersion: 0, bullets: bullets('Stale') })).status).toBe(409);
    const restored = await request(`${path()}/revisions/1/restore`, 'POST', { expectedVersion: 1 });
    expect(restored.status).toBe(200);
    expect((await restored.json()).data.bulletRevisionVersion).toBe(2);
    expect(limits.writes).toBe(3);
  });

  it('returns 404 for another owner or missing resume/revision and never mutates them', async () => {
    expect((await request(`${path()}/revisions`, 'GET', undefined, other)).status).toBe(404);
    expect((await request(`${path()}/sections/experience/bullets`, 'PUT', { expectedVersion: 0, bullets: [] }, other)).status).toBe(404);
    expect((await request(`${path()}/revisions/1/restore`, 'POST', { expectedVersion: 0 }, other)).status).toBe(404);
    expect((await request(`/api/v2/resume/${new Types.ObjectId()}/revisions`)).status).toBe(404);
    expect((await request(`${path()}/revisions/99/restore`, 'POST', { expectedVersion: 0 })).status).toBe(404);
    expect(await ResumeBulletRevision.countDocuments()).toBe(0);
  });

  it.each([
    ['missing expected version', { bullets: [] }],
    ['negative expected version', { expectedVersion: -1, bullets: [] }],
    ['forged score', { expectedVersion: 0, bullets: [], atsScore: 100 }],
    ['duplicate indexes', { expectedVersion: 0, bullets: [...bullets('One'), ...bullets('Two')] }],
    ['multiline text', { expectedVersion: 0, bullets: bullets('Bad\ntext') }],
    ['too many bullets', { expectedVersion: 0, bullets: Array.from({ length: 201 }, (_, bulletIndex) => ({ ...bullets('Text')[0], bulletIndex })) }],
  ])('rejects %s without writing a revision', async (_label, body) => {
    expect((await request(`${path()}/sections/experience/bullets`, 'PUT', body)).status).toBe(400);
    expect(await ResumeBulletRevision.countDocuments()).toBe(0);
  });

  it('rejects malformed IDs, reserved sections, invalid restore versions and unsupported v2 APIs', async () => {
    expect((await request('/api/v2/resume/not-an-id/revisions')).status).toBe(400);
    expect((await request(`${path()}/sections/*/bullets`, 'PUT', { expectedVersion: 0, bullets: [] })).status).toBe(400);
    for (const version of ['-1', '1.5', '9007199254740993']) {
      expect((await request(`${path()}/revisions/${version}/restore`, 'POST', { expectedVersion: 0 })).status).toBe(400);
    }
    expect((await request('/api/v2/resume/profile')).status).toBe(404);
  });

  it('leaves existing upload/session paths to their own authentication and budgets', async () => {
    expect((await request('/api/v1/resume/session/test')).status).toBe(200);
    expect(limits).toEqual({ reads: 0, writes: 0 });
  });
});
