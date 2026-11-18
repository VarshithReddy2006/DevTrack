import express from 'express';
import { Types } from 'mongoose';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlag } from '../../../db/models/featureFlag.model.js';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { ResumeVariant } from '../../../db/models/resumeVariant.model.js';
import { ResumeBulletRevision } from '../../../db/models/resumeBulletRevision.model.js';
import { errorHandler } from '../../../middleware/error.js';
import { renderBulletEdits, scoreBulletEdits } from '../../../modules/resume/ats/bulletEditScoring.js';
import { GenerateVariantRequestV2Schema, type BulletEditDTO } from '../../../modules/resume/dto/index.js';
import router from '../../../modules/resume/routes/resume-intelligence.routes.js';
import { logger } from '../../../shared/logger.js';

vi.mock('../../../middleware/auth.js', () => ({ authMiddleware: (req: any, res: any, next: any) => {
  if (!req.headers['x-test-user']) return res.sendStatus(401);
  req.user = { id: req.headers['x-test-user'] }; next();
} }));
vi.mock('../../../middleware/rateLimitAdvanced.js', () => ({ rateLimiters: { resume: (_req: any, _res: any, next: any) => next(), resumeRead: (_req: any, _res: any, next: any) => next() } }));

const flawed: BulletEditDTO[] = [
  { section: 'Experience', bulletIndex: 0, originalText: 'Built APIs', editedText: 'did stuff\t\t\twith things\t\t\tok' },
];
const strong: BulletEditDTO[] = [
  { section: 'Experience', bulletIndex: 1, originalText: '', editedText: 'Cut deploy time by 40% with Docker' },
  { section: 'Experience', bulletIndex: 0, originalText: '', editedText: 'Built a Node.js API serving 2M requests' },
  { section: 'Skills', bulletIndex: 0, originalText: '', editedText: 'Node.js, Docker' },
  { section: 'Projects', bulletIndex: 0, originalText: '', editedText: 'DevTrack, a developer progress tracker' },
  { section: 'Education', bulletIndex: 0, originalText: '', editedText: 'BS Computer Science' },
];

const user = new Types.ObjectId().toString();
const otherUser = new Types.ObjectId().toString();
const app = express();
app.use(express.json(), router, errorHandler);
const server = app.listen(0, '127.0.0.1');
let origin: string;

beforeAll(async () => {
  await ResumeBulletRevision.init();
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

beforeEach(async () => {
  vi.restoreAllMocks();
  await ResumeProfile.create({ userId: user, targetRole: 'Full Stack Developer', selectedSkills: ['Node.js', 'Docker'] });
  await ResumeProfile.create({ userId: otherUser, targetRole: 'Full Stack Developer', selectedSkills: ['Node.js', 'Docker'] });
});

function enableLiveEditor(allowedUserIds = [user]) {
  return FeatureFlag.create({ key: 'ats-live-editor', name: 'ats-live-editor', enabled: true, rolloutPercent: 0, allowedUserIds });
}

function postVariant(body: object, as = user) {
  return fetch(`${origin}/variants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': as }, body: JSON.stringify(body) });
}

describe('POST /variants with ats-live-editor on', () => {
  beforeEach(enableLiveEditor.bind(null, undefined));

  it('overwrites a forged clientScore with the server score and stores the edits', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const response = await postVariant({ roleType: 'Backend', bulletEdits: flawed, jobTargetId: '0123456789abcdef01234567', clientScore: 100 });
    expect(response.status).toBe(200);

    const stored = await ResumeVariant.findOne({ userId: user }).lean();
    // Independent check: Experience is the only section found and the bullet has a tab layout.
    expect(stored?.atsScore?.score).toBe(scoreBulletEdits(flawed, { targetRole: 'Full Stack Developer', keywords: stored?.prioritizedSkills }).score);
    expect(stored?.atsScore?.score).toBeLessThan(100);
    expect(stored?.atsScore?.score).toBe(69);
    expect(stored).not.toHaveProperty('clientScore');
    expect(stored?.bulletEdits).toEqual(flawed);
    expect(stored?.bulletRevisionVersion).toBe(1);
    expect(await ResumeBulletRevision.findOne({ resumeId: stored!._id }).lean()).toMatchObject({
      sectionId: '*', versionNumber: 1, atsScore: 69, baseSnapshot: [],
    });
    expect(String(stored?.jobTargetId)).toBe('0123456789abcdef01234567');

    const body = await response.json();
    expect(body.data.atsScore.score).toBe(69);
    expect(JSON.stringify(body)).not.toContain('"clientScore"');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('client=100 server=69 diff=31'));
  });

  it('does not warn when the client score matches the server score', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const response = await postVariant({ roleType: 'Backend', bulletEdits: flawed, clientScore: 69 });
    expect(response.status).toBe(200);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('score drift'));
  });

  it('scores the same bullets the same way regardless of the claimed score', async () => {
    const low = await (await postVariant({ roleType: 'Backend', bulletEdits: strong, clientScore: 0 })).json();
    const high = await (await postVariant({ roleType: 'Backend', bulletEdits: strong, clientScore: 100 })).json();
    expect(low.data.atsScore.score).toBe(high.data.atsScore.score);
    expect(low.data.atsScore.score).toBeGreaterThan(69);
  });

  it('keeps a plain v1 body working and leaves the v2 fields off the variant', async () => {
    const response = await postVariant({ roleType: 'Backend' });
    expect(response.status).toBe(200);
    const stored = await ResumeVariant.findOne({ userId: user }).lean();
    expect(stored).not.toHaveProperty('bulletEdits');
    expect(stored).not.toHaveProperty('atsScore');
  });

  it('returns bulletEdits and atsScore from GET /variants/:variantId', async () => {
    const created = await (await postVariant({ roleType: 'Backend', bulletEdits: strong })).json();
    const response = await fetch(`${origin}/variants/${created.data.variantId}`, { headers: { 'x-test-user': user } });
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.bulletEdits).toEqual(strong);
    expect(data.atsScore).toMatchObject({ score: created.data.atsScore.score, keywordsTotal: 2, keywordsMatched: 2 });
  });

  it.each([
    ['clientScore above 100', { clientScore: 1000 }],
    ['a duplicate section and bulletIndex', { bulletEdits: [flawed[0], { ...flawed[0], section: 'experience' }] }],
    ['a line break inside a bullet', { bulletEdits: [{ ...flawed[0], editedText: 'ok\nSkills' }] }],
    ['an empty edited bullet', { bulletEdits: [{ ...flawed[0], editedText: '   ' }] }],
    ['a malformed jobTargetId', { jobTargetId: 'not-an-id' }],
  ])('rejects %s with 400', async (_name, extra) => {
    const response = await postVariant({ roleType: 'Backend', ...extra });
    expect(response.status).toBe(400);
    expect(await ResumeVariant.countDocuments()).toBe(0);
  });
});

describe('POST /variants with ats-live-editor off', () => {
  it('ignores v2 fields exactly like the v1 endpoint did (flag missing)', async () => {
    const response = await postVariant({ roleType: 'Backend', bulletEdits: flawed, jobTargetId: '0123456789abcdef01234567', clientScore: 100 });
    expect(response.status).toBe(200);
    const stored = await ResumeVariant.findOne({ userId: user }).lean();
    expect(stored).not.toHaveProperty('bulletEdits');
    expect(stored).not.toHaveProperty('jobTargetId');
    expect(stored).not.toHaveProperty('atsScore');
    expect(Object.keys((await response.json()).data).sort()).not.toContain('atsScore');
  });

  it('ignores v2 fields for a user outside the rollout, and does not reject a malformed v2 body', async () => {
    await enableLiveEditor([user]);
    const response = await postVariant({ roleType: 'Backend', bulletEdits: 'garbage', clientScore: 5000 }, otherUser);
    expect(response.status).toBe(200);
    expect(await ResumeVariant.findOne({ userId: otherUser }).lean()).not.toHaveProperty('atsScore');
  });

  it('ignores v2 fields while the flag exists but is disabled', async () => {
    await FeatureFlag.create({ key: 'ats-live-editor', name: 'ats-live-editor', enabled: false, rolloutPercent: 100, allowedUserIds: [user] });
    const response = await postVariant({ roleType: 'Backend', bulletEdits: flawed, clientScore: 100 });
    expect(response.status).toBe(200);
    expect(await ResumeVariant.findOne({ userId: user }).lean()).not.toHaveProperty('atsScore');
  });
});

describe('bullet edit scoring', () => {
  it('renders sections in first-seen order with bullets sorted by index', () => {
    expect(renderBulletEdits(strong).split('\n\n')[0]).toBe('Experience\n- Built a Node.js API serving 2M requests\n- Cut deploy time by 40% with Docker');
    expect(renderBulletEdits(strong).split('\n\n').map(block => block.split('\n')[0])).toEqual(['Experience', 'Skills', 'Projects', 'Education']);
  });

  it('scores a complete resume above a flawed single bullet', () => {
    expect(scoreBulletEdits(strong, { keywords: ['Node.js', 'Docker'] }).score).toBeGreaterThan(scoreBulletEdits(flawed, { keywords: ['Node.js', 'Docker'] }).score);
  });

  it('counts keyword matches from the edited text', () => {
    expect(scoreBulletEdits(strong, { keywords: ['Docker', 'Kubernetes'] })).toMatchObject({ keywordsMatched: 1, keywordsTotal: 2 });
  });

  it('accepts a well formed v2 body and trims the edited text', () => {
    const parsed = GenerateVariantRequestV2Schema.parse({ roleType: 'Backend', bulletEdits: [{ ...flawed[0], editedText: '  trimmed  ' }] });
    expect(parsed.bulletEdits?.[0].editedText).toBe('trimmed');
  });
});
