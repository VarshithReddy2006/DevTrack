import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { LeagueStanding, UserSettings, User } from '../../../db/models/index.js';
import { errorHandler } from '../../../middleware/error.js';
import { FakeScoreStore } from './fakeScoreStore.js';

const shared = vi.hoisted(() => ({ userId: '000000000000000000000001', store: null as unknown }));

vi.mock('../../../middleware/index.js', async () => {
  const { asyncHandler } = await import('../../../middleware/error.js');
  const { commonErrors } = await import('../../../shared/response.js');
  return {
    asyncHandler,
    authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.get('authorization') !== 'Bearer league-token') return commonErrors.unauthorized(res);
      Object.assign(req, { user: { id: shared.userId } });
      next();
    },
  };
});
vi.mock('../../../modules/leagues/scoreStore.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../modules/leagues/scoreStore.js')>()),
  getLeagueScoreStore: () => shared.store,
}));

import { leaguesRoutes } from '../../../modules/leagues/leagues.routes.js';

let server: Server;
let base: string;
const headers = { authorization: 'Bearer league-token', 'content-type': 'application/json' };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/leagues', leaguesRoutes);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/leagues`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => { shared.store = new FakeScoreStore(); });

describe('weekly leagues routes', () => {
  it('requires authentication', async () => {
    expect((await fetch(`${base}/current`)).status).toBe(401);
    expect((await fetch(`${base}/participation`, { method: 'PUT', body: '{}' })).status).toBe(401);
  });

  it('GET /current says "not participating" until the user opts in (default off)', async () => {
    const res = await fetch(`${base}/current`, { headers });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ participating: false, standings: [], me: null });
    expect(body.data.secondsUntilReset).toBeGreaterThan(0);
    expect(await LeagueStanding.countDocuments()).toBe(0);
  });

  it('PUT /participation opts in, then GET /current returns the cohort with the caller in it', async () => {
    await User.create({ _id: new Types.ObjectId(shared.userId), clerkId: 'c-1', email: 'one@example.com', username: 'one', displayName: 'One' });

    const put = await fetch(`${base}/participation`, { method: 'PUT', headers, body: JSON.stringify({ participate: true }) });
    expect(put.status).toBe(200);
    expect((await put.json()).data).toEqual({ participating: true });
    expect(await UserSettings.countDocuments({ userId: new Types.ObjectId(shared.userId), 'leagues.participate': true })).toBe(1);

    const current = (await (await fetch(`${base}/current`, { headers })).json()).data;
    expect(current).toMatchObject({ participating: true, division: 'bronze', cohortId: 'c1', cohortSize: 1, me: { rank: 1, points: 0 } });
    expect(current.standings).toEqual([
      { rank: 1, userId: shared.userId, username: 'one', displayName: 'One', avatarUrl: null, points: 0, isMe: true },
    ]);
  });

  it('PUT /participation with false leaves the league', async () => {
    await fetch(`${base}/participation`, { method: 'PUT', headers, body: JSON.stringify({ participate: true }) });
    const off = await fetch(`${base}/participation`, { method: 'PUT', headers, body: JSON.stringify({ participate: false }) });
    expect((await off.json()).data).toEqual({ participating: false });
    expect(await LeagueStanding.countDocuments({ status: 'active' })).toBe(0);
    expect((await (await fetch(`${base}/current`, { headers })).json()).data.participating).toBe(false);
  });

  it.each([
    ['missing field', {}],
    ['string instead of boolean', { participate: 'yes' }],
    ['unknown key', { participate: true, division: 'master' }],
  ])('PUT /participation rejects %s', async (_name, payload) => {
    const res = await fetch(`${base}/participation`, { method: 'PUT', headers, body: JSON.stringify(payload) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(await UserSettings.countDocuments()).toBe(0);
  });
});
