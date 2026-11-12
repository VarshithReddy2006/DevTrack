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

function request(path: string, account?: keyof typeof accounts, body?: object) {
  const headers = new Headers();
  if (account) headers.set('x-test-account', account);
  if (body) headers.set('content-type', 'application/json');
  return fetch(base + path, {
    headers,
    method: body ? 'PUT' : 'GET',
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
