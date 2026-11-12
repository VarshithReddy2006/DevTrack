import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DSAProfile } from '../../db/models/dsaProfile.model.js';
import { IntelligenceRecommendation } from '../../db/models/intelligenceRecommendation.model.js';
import { ResumeProfile } from '../../db/models/resumeProfile.model.js';
import { ResumeSession } from '../../db/models/resumeSession.model.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { errorHandler } from '../../middleware/error.js';
import { RecommendationLifecycleEngineClass } from '../readiness/recommendation/RecommendationLifecycleEngine.js';
import { readinessRoutes } from '../readiness/readiness.routes.js';
import recommendationRoutes from './recommendation.routes.js';
import { RecommendationIntelligenceService } from './recommendation.service.js';

const accounts = vi.hoisted(() => ({
  ada: '609000000000000000000001',
  lin: '609000000000000000000002',
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: [(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => {
    const account = req.get('x-test-account');
    if (account !== 'ada' && account !== 'lin') {
      res.sendStatus(401);
      return;
    }
    req.user = { id: accounts[account], clerkId: account, email: '', username: account, role: 'user' };
    next();
  }],
}));

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/readiness', readinessRoutes);
  app.use('/recommendations', recommendationRoutes);
  app.use(errorHandler);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve());
  });
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function request(path: string, account?: keyof typeof accounts, body?: object, method = body ? 'PUT' : 'GET') {
  const headers = new Headers();
  if (account) headers.set('x-test-account', account);
  if (body) headers.set('content-type', 'application/json');
  return fetch(base + path, {
    headers,
    method,
    body: body && JSON.stringify(body),
  });
}

describe('readiness DSA authorization', () => {
  it('requires sign-in for every DSA endpoint', async () => {
    expect((await request('/readiness/dsa')).status).toBe(401);
    expect((await request('/readiness/dsa/profile')).status).toBe(401);
    expect((await request('/readiness/dsa', undefined, { platform: 'manual' })).status).toBe(401);
  });

  it('reads and updates only the signed-in account', async () => {
    await DSAProfile.create([
      { userId: accounts.ada, platform: 'manual', totalSolved: 12, easySolved: 12 },
      { userId: accounts.lin, platform: 'manual', totalSolved: 24, easySolved: 24 },
    ]);

    const response = await request('/readiness/dsa', 'ada');
    expect(response.status).toBe(200);
    expect((await response.json()).data.difficultyDistribution.total).toBe(12);

    const profile = await request('/readiness/dsa/profile?platform=manual', 'lin');
    expect(profile.status).toBe(200);
    expect((await profile.json()).data.totalSolved).toBe(24);

    const updated = await request('/readiness/dsa', 'ada', { platform: 'manual', currentStreak: 4 });
    expect(updated.status).toBe(200);
    const ada = await DSAProfile.findOne({ userId: accounts.ada });
    const lin = await DSAProfile.findOne({ userId: accounts.lin });
    expect(ada).toMatchObject({ currentStreak: 4, totalSolved: 12, isVerified: false });
    expect(lin).toMatchObject({ currentStreak: 0, totalSolved: 24 });
  });
});

describe('recommendation authorization', () => {
  it('requires sign-in for the report and intelligence routes', async () => {
    expect((await request('/recommendations/report')).status).toBe(401);
    expect((await request('/recommendations/intelligence/sample-resume')).status).toBe(401);
    expect((await request('/recommendations/report', 'ada')).status).toBe(200);
  });

  it('refreshes owned profile and session recommendations, and hides unavailable resources', async () => {
    const profile = await ResumeProfile.create({ userId: accounts.ada });
    const sessionId = new Types.ObjectId();
    await ResumeSession.collection.insertOne({
      _id: sessionId,
      userId: new Types.ObjectId(accounts.ada),
      sessionId: 'sample-resume',
    });
    const foreignRow = await IntelligenceRecommendation.create({
      userId: accounts.lin,
      resumeProfileId: profile._id,
      category: 'semantic',
      title: 'Other account fixture',
      content: 'Separate owner',
    });

    for (const reference of [String(profile._id), 'sample-resume', String(sessionId)]) {
      const owned = await request('/recommendations/intelligence/' + reference, 'ada');
      expect(owned.status).toBe(200);
      const rows = (await owned.json()).data;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row: { userId: string }) => row.userId === accounts.ada)).toBe(true);
    }

    const unavailable = await request('/recommendations/intelligence/missing-resume', 'lin');
    expect(unavailable.status).toBe(404);
    expect(await IntelligenceRecommendation.findById(foreignRow._id).lean()).toMatchObject({
      title: 'Other account fixture',
      state: 'active',
    });
  });

  it('persists user actions across refreshes and rejects foreign or invalid transitions', async () => {
    const profile = await ResumeProfile.create({ userId: accounts.ada });
    const listPath = '/recommendations/intelligence/' + profile._id;
    const first = await request(listPath, 'ada');
    const [{ id }] = (await first.json()).data;
    expect(id).toMatch(/^[a-f0-9]{24}$/);
    const action = (name: string, account?: keyof typeof accounts) =>
      request('/recommendations/intelligence/' + id + '/' + name, account, undefined, 'POST');

    expect((await action('accept')).status).toBe(401);
    expect((await action('accept', 'lin')).status).toBe(404);
    expect((await action('view', 'ada')).status).toBe(200);

    const accepts = await Promise.all([action('accept', 'ada'), action('accept', 'ada')]);
    expect(accepts.map(response => response.status)).toEqual([200, 200]);
    expect((await action('complete', 'ada')).status).toBe(200);
    expect((await action('dismiss', 'ada')).status).toBe(409);

    const refreshed = await request(listPath, 'ada');
    const rows = (await refreshed.json()).data;
    expect(rows).toContainEqual(expect.objectContaining({ id, state: 'completed' }));
    expect(rows.filter((row: { id: string }) => row.id === id)).toHaveLength(1);
    const engine = new RecommendationLifecycleEngineClass();
    const lifecycle = await engine.getLifecycle(id, accounts.ada);
    expect(lifecycle).toMatchObject({
      state: 'completed',
      viewCount: 1,
      acceptedAt: expect.any(Date),
      completedAt: expect.any(Date),
    });
    expect(lifecycle?.lifecycleEvents.map(event => event.eventType))
      .toEqual(['generated', 'viewed', 'accepted', 'completed']);
    expect(await engine.getMetrics(accounts.ada)).toMatchObject({
      totalRecommendations: rows.length,
      acceptanceRate: Math.round(100 / rows.length),
      completionRate: 100,
      decayRate: 0,
    });
  });

  it('keeps one lifecycle per finding under concurrent refreshes and preserves dismissals', async () => {
    const profile = await ResumeProfile.create({ userId: accounts.ada });
    const path = '/recommendations/intelligence/' + profile._id;
    const responses = await Promise.all([request(path, 'ada'), request(path, 'ada')]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const [first, second] = await Promise.all(responses.map(response => response.json()));
    expect(first.data.map((row: { id: string }) => row.id).sort())
      .toEqual(second.data.map((row: { id: string }) => row.id).sort());
    expect(await IntelligenceRecommendation.countDocuments({ resumeProfileId: profile._id }))
      .toBe(first.data.length);

    const [{ id }] = first.data;
    const dismissPath = '/recommendations/intelligence/' + id + '/dismiss';
    expect((await request(dismissPath, 'ada', undefined, 'POST')).status).toBe(200);
    const refreshed = await request(path, 'ada');
    expect((await refreshed.json()).data).not.toContainEqual(expect.objectContaining({ id }));
    expect(await IntelligenceRecommendation.findById(id).lean()).toMatchObject({
      state: 'ignored', ignoredAt: expect.any(Date),
    });
  });

  it('keeps prior findings for metrics but only lists current active findings', async () => {
    const profile = await ResumeProfile.create({ userId: accounts.ada });
    const previous = await IntelligenceRecommendation.create({
      userId: accounts.ada, resumeProfileId: profile._id, category: 'ats',
      title: 'Old finding', content: 'Evidence that no longer exists.',
    });

    const response = await request('/recommendations/intelligence/' + profile._id, 'ada');
    const rows = (await response.json()).data;
    expect(response.status).toBe(200);
    expect(rows).not.toContainEqual(expect.objectContaining({ id: String(previous._id) }));
    const engine = new RecommendationLifecycleEngineClass();
    expect(await engine.getMetrics(accounts.ada)).toMatchObject({ totalRecommendations: rows.length + 1 });
  });

  it('bounds view history and persists decay and retirement for legacy rows', async () => {
    const resumeProfileId = new Types.ObjectId();
    const userId = new Types.ObjectId(accounts.ada);
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const { insertedId } = await IntelligenceRecommendation.collection.insertOne({
      resumeProfileId, userId, category: 'ats', title: 'Legacy', content: 'Fixture', state: 'active', createdAt,
    });
    const visible = await IntelligenceRecommendation.create({
      resumeProfileId, userId, category: 'ats', title: 'Visible', content: 'Fixture',
    });
    const engine = new RecommendationLifecycleEngineClass();
    await Promise.all(Array.from({ length: 55 }, () => engine.recordAction(String(visible._id), accounts.ada, 'view')));
    const viewed = await engine.getLifecycle(String(visible._id), accounts.ada);
    expect(viewed?.viewCount).toBe(55);
    expect(viewed?.lifecycleEvents).toHaveLength(50);

    await engine.updateDecay({ userId, resumeProfileId }, new Date('2026-01-06T00:00:00Z'));
    expect(await engine.getLifecycle(String(insertedId), accounts.ada)).toMatchObject({ state: 'decayed' });
    await engine.updateDecay({ userId, resumeProfileId }, new Date('2026-02-01T00:00:00Z'));
    expect(await engine.getLifecycle(String(insertedId), accounts.ada)).toMatchObject({
      state: 'retired', decayedAt: expect.any(Date), retiredAt: expect.any(Date),
    });
    expect(await engine.getMetrics(accounts.ada)).toMatchObject({ decayRate: 50, retiredCount: 1 });
    expect(await engine.getMetrics(accounts.lin)).toMatchObject({ totalRecommendations: 0 });
  });

  it('populates only dependencies belonging to the same account and resume', async () => {
    const resumeId = new Types.ObjectId().toString();
    const common = { resumeProfileId: resumeId, category: 'ats', title: 'Recommendation', content: 'Fixture' };
    const own = await IntelligenceRecommendation.create({ ...common, userId: accounts.ada });
    const foreign = await IntelligenceRecommendation.create({ ...common, userId: accounts.lin });
    const row = await IntelligenceRecommendation.create({
      ...common,
      userId: accounts.ada,
      dependencies: [own._id, foreign._id],
    });

    const recommendations = await RecommendationIntelligenceService.getActiveRecommendations(accounts.ada, resumeId);
    const dependencies = recommendations.find(item => String(item._id) === String(row._id))?.dependencies;
    expect(dependencies).toEqual([expect.objectContaining({ _id: own._id })]);
  });
});
