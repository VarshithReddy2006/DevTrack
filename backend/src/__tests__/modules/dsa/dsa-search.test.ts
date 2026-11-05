import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DsaProblem } from '../../../db/models/index.js';
import { errorHandler } from '../../../middleware/error.js';
import dsaRoutes from '../../../modules/dsa/dsa.routes.js';

// Same setup as dsa-routes.test.ts: real routes, service and disposable MongoDB,
// only the Clerk authentication is replaced by a fixed identity.
vi.mock('../../../middleware/index.js', async () => {
  const { validateBody } = await import('../../../middleware/validation.js');
  const { asyncHandler } = await import('../../../middleware/error.js');
  return {
    validateBody,
    asyncHandler,
    authMiddleware: [(req: express.Request, _res: express.Response, next: express.NextFunction) => {
      Object.assign(req, { user: { id: '000000000000000000000001' } });
      next();
    }],
  };
});

describe('GET /dsa/problems?search=', () => {
  const ownerId = new Types.ObjectId('000000000000000000000001');
  let server: Server | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/dsa', dsaRoutes);
    app.use(errorHandler);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/v1/dsa`;
  });

  afterAll(async () => {
    const activeServer = server;
    if (!activeServer) return;
    await new Promise<void>((resolve, reject) => {
      activeServer.close(error => error ? reject(error) : resolve());
    });
  });

  beforeEach(async () => {
    const base = {
      userId: ownerId,
      platform: 'leetcode',
      difficulty: 'easy',
      url: 'https://leetcode.com/problems/two-sum/',
      category: 'arrays',
      status: 'unsolved',
    };
    await DsaProblem.create([
      { ...base, externalId: 'p1', title: 'C++ vector basics', tags: ['stl'] },
      { ...base, externalId: 'p2', title: 'Two Sum', tags: ['hash-map'] },
      { ...base, externalId: 'p3', title: 'Matching (brackets)', tags: ['stack'] },
      { ...base, externalId: 'p4', title: 'Plain title', tags: ['c++'] },
    ]);
  });

  async function search(term: string) {
    const response = await fetch(`${baseUrl}/problems?search=${encodeURIComponent(term)}`);
    const body = await response.json() as { data?: { problems: Array<{ title: string }> } };
    return { status: response.status, titles: (body.data?.problems ?? []).map(p => p.title).sort() };
  }

  it('matches c++ literally in titles and tags instead of returning a 500', async () => {
    const result = await search('c++');
    expect(result.status).toBe(200);
    expect(result.titles).toEqual(['C++ vector basics', 'Plain title']);
  });

  it('accepts an unbalanced bracket', async () => {
    const result = await search('(');
    expect(result.status).toBe(200);
    expect(result.titles).toEqual(['Matching (brackets)']);
  });

  it('does not treat .* as a wildcard', async () => {
    const result = await search('.*');
    expect(result.status).toBe(200);
    expect(result.titles).toEqual([]);
  });

  it('keeps case-insensitive plain search working', async () => {
    const result = await search('TWO sum');
    expect(result.status).toBe(200);
    expect(result.titles).toEqual(['Two Sum']);
  });

  it('rejects an oversized search term', async () => {
    const result = await search('a'.repeat(101));
    expect(result.status).toBe(400);
  });
});
