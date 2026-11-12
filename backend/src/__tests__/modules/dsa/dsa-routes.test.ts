import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DsaProblem } from '../../../db/models/index.js';
import { errorHandler } from '../../../middleware/error.js';
import dsaRoutes from '../../../modules/dsa/dsa.routes.js';

// Keep the real validation, controllers, service, and disposable MongoDB.
// Replace only external Clerk authentication with a fixed test identity.
vi.mock('../../../middleware/index.js', async () => {
  const { validateBody } = await import('../../../middleware/validation.js');
  const { asyncHandler } = await import('../../../middleware/error.js');
  const { commonErrors } = await import('../../../shared/response.js');
  return {
    validateBody,
    asyncHandler,
    authMiddleware: [(req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.get('authorization') !== 'Bearer test-owner') {
        commonErrors.unauthorized(res);
        return;
      }
      Object.assign(req, { user: { id: '000000000000000000000001' } });
      next();
    }],
  };
});

describe('DSA problem routes', () => {
  const ownerId = new Types.ObjectId('000000000000000000000001');
  const otherUserId = new Types.ObjectId('000000000000000000000002');
  let server: Server | undefined;
  let baseUrl: string;
  let ownedIds: string[];
  let foreignId: string;

  beforeAll(async () => {
    await DsaProblem.init();
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
    const problems = await DsaProblem.create([
      { userId: ownerId, externalId: 'owned-1', title: 'Owned problem 1' },
      { userId: ownerId, externalId: 'owned-2', title: 'Owned problem 2' },
      { userId: otherUserId, externalId: 'foreign-1', title: 'Foreign problem' },
    ].map(problem => ({
      ...problem,
      platform: 'leetcode',
      difficulty: 'easy',
      url: 'https://leetcode.com/problems/two-sum/',
      category: 'arrays',
      status: 'unsolved',
    })));
    ownedIds = problems.slice(0, 2).map(problem => problem._id.toString());
    foreignId = problems[2]._id.toString();
  });

  async function patch(path: string, payload: unknown, authenticated = true) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { Authorization: 'Bearer test-owner' } : {}),
      },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }

  async function postProblem(platform: unknown, authenticated = true, title = 'Manual practice problem') {
    const response = await fetch(`${baseUrl}/problems`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { Authorization: 'Bearer test-owner' } : {}),
      },
      body: JSON.stringify({
        title, platform, difficulty: 'medium',
        url: 'https://example.com/practice/' + encodeURIComponent(title), tags: ['arrays'], category: 'arrays',
      }),
    });
    return { status: response.status, body: await response.json() };
  }

  it.each(['leetcode', 'codeforces', 'codechef', 'hackerrank', 'other'])(
    'creates and persists a %s problem through the real route and service', async platform => {
      const response = await postProblem(platform);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ success: true, data: { platform, status: 'unsolved' } });
      const stored = await DsaProblem.findById(response.body.data.id).lean();
      expect(stored).toMatchObject({ platform, title: 'Manual practice problem', difficulty: 'medium' });
      expect(stored?.userId.toString()).toBe(ownerId.toString());
    }
  );

  it.each(['leetcode', 'codeforces', 'other'])(
    'creates multiple manual %s problems for the same user',
    async platform => {
      const first = await postProblem(platform, true, 'First manual problem');
      const second = await postProblem(platform, true, 'Second manual problem');

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const rows = await DsaProblem.find({
        userId: ownerId,
        _id: { $in: [first.body.data.id, second.body.data.id] },
      }).lean();
      expect(rows.map(row => row.title).sort()).toEqual(['First manual problem', 'Second manual problem']);
      expect(rows.every(row => row.platform === platform && row.externalId)).toBe(true);
      expect(new Set(rows.map(row => row.externalId)).size).toBe(2);
    },
  );

  it('can create a manual problem beside a legacy blank ID and preserves provider uniqueness', async () => {
    const legacy = await DsaProblem.create({
      userId: ownerId, platform: 'leetcode', title: 'Legacy manual problem',
      difficulty: 'easy', category: 'arrays', url: 'https://example.com/practice/legacy',
    });
    expect(legacy.externalId).toBe('');

    const response = await postProblem('leetcode', true, 'New manual problem');
    expect(response.status).toBe(201);
    expect((await DsaProblem.findById(legacy._id).lean())?.externalId).toBe('');
    expect((await DsaProblem.findById(response.body.data.id).lean())?.externalId).toBeTruthy();

    const providerProblem = {
      userId: ownerId, platform: 'leetcode', externalId: 'two-sum', title: 'Imported Two Sum',
      difficulty: 'easy', category: 'arrays', url: 'https://leetcode.com/problems/two-sum/',
    };
    await DsaProblem.create(providerProblem);
    await expect(DsaProblem.create(providerProblem)).rejects.toMatchObject({ code: 11000 });
  });

  it.each(['unsupported', 'CodeChef', '', null, 42, undefined])(
    'rejects an invalid problem platform (%j) without writing a record', async platform => {
      const before = await DsaProblem.countDocuments();
      const response = await postProblem(platform);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
      expect(await DsaProblem.countDocuments()).toBe(before);
    }
  );

  it('requires authentication when creating a problem', async () => {
    const response = await postProblem('codechef', false);
    expect(response.status).toBe(401);
    expect(await DsaProblem.countDocuments({ platform: 'codechef' })).toBe(0);
  });

  it('also rejects unsupported platforms at the persistence boundary', async () => {
    const invalid = new DsaProblem({ userId: ownerId, title: 'Invalid', platform: 'unsupported',
      difficulty: 'easy', url: 'https://example.com', category: 'arrays' });
    await expect(invalid.validate()).rejects.toThrow(/platform/);
  });

  it('routes bulk-status to the bulk handler and updates only owned problems', async () => {
    const response = await patch('/problems/bulk-status', {
      problemIds: [...ownedIds, foreignId],
      status: 'solved',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, message: '2 problems updated successfully' });
    const owned = await DsaProblem.find({ _id: { $in: ownedIds } }).lean();
    expect(owned).toHaveLength(2);
    expect(owned.every(problem => problem.status === 'solved' && problem.solvedAt instanceof Date)).toBe(true);
    expect((await DsaProblem.findById(foreignId).lean())?.status).toBe('unsolved');
  });

  it('still routes an individual problem PATCH to the single-item handler', async () => {
    const response = await patch(`/problems/${ownedIds[0]}`, { notes: 'Review the two-pointer solution' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: { id: ownedIds[0], notes: 'Review the two-pointer solution' },
    });
    expect((await DsaProblem.findById(ownedIds[0]).lean())?.notes).toBe('Review the two-pointer solution');
  });

  it('accepts uppercase hexadecimal problem IDs', async () => {
    const response = await patch('/problems/bulk-status', {
      problemIds: ownedIds.map(id => id.toUpperCase()),
      status: 'solved',
    });

    expect(response.status).toBe(200);
    expect(await DsaProblem.countDocuments({ userId: ownerId, status: 'solved' })).toBe(2);
    expect((await DsaProblem.findById(foreignId).lean())?.status).toBe('unsolved');
  });

  it('returns a bad request when an individual problem ID cannot be constructed', async () => {
    const response = await patch('/problems/invalid-id', { notes: 'Not a valid problem ID' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, code: 'VALIDATION_ERROR', message: 'Validation failed' });
    expect(await DsaProblem.countDocuments({ notes: 'Not a valid problem ID' })).toBe(0);
  });

  it('does not update a bulk selection containing only foreign-owned problems', async () => {
    const response = await patch('/problems/bulk-status', { problemIds: [foreignId], status: 'solved' });

    // Preserve the existing bulk API: inaccessible records are excluded, not disclosed.
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, message: '0 problems updated successfully' });
    expect((await DsaProblem.findById(foreignId).lean())?.status).toBe('unsolved');
  });

  it('still rejects an individual update of a foreign-owned problem', async () => {
    const response = await patch(`/problems/${foreignId}`, { notes: 'Not permitted' });

    expect(response.status).toBe(404);
    expect((await DsaProblem.findById(foreignId).lean())?.notes).toBeNull();
  });

  it.each([
    { status: 'solved' },
    { problemIds: 'not-an-array', status: 'solved' },
    { problemIds: [], status: 'invalid-status' },
    { problemIds: [], status: 'solved' },
    { problemIds: ['invalid-id'], status: 'solved' },
    { problemIds: [''], status: 'solved' },
    { problemIds: ['a'.repeat(23)], status: 'solved' },
    { problemIds: ['g'.repeat(24)], status: 'solved' },
  ])('rejects a malformed bulk body: %j', async payload => {
    const response = await patch('/problems/bulk-status', payload);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    expect(await DsaProblem.countDocuments({ status: 'solved' })).toBe(0);
  });

  it('rejects a mixed valid/invalid selection before making any updates', async () => {
    const response = await patch('/problems/bulk-status', {
      problemIds: [ownedIds[0], 'invalid-id'],
      status: 'solved',
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      code: 'VALIDATION_ERROR',
      details: { 'problemIds.1': ['Invalid problem ID format'] },
    });
    expect(await DsaProblem.countDocuments({ status: 'solved' })).toBe(0);
  });

  it('requires authentication for bulk updates', async () => {
    const response = await patch('/problems/bulk-status', { problemIds: ownedIds, status: 'solved' }, false);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      success: false,
      message: 'Unauthorized',
      code: 'UNAUTHORIZED',
      statusCode: 401,
      timestamp: expect.any(String),
    });
    expect(await DsaProblem.countDocuments({ status: 'solved' })).toBe(0);
  });

  describe('individual status updates', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const previous = new Date('2026-10-01T09:00:00Z');

    beforeEach(() => {
      // Freeze dates without interfering with HTTP or MongoDB timers.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
    });

    afterEach(() => { vi.useRealTimers(); });

    async function seedSubmissionMetadata() {
      await DsaProblem.findByIdAndUpdate(ownedIds[0], {
        $set: { status: 'solved', submissionCount: 7, solvedAt: previous, lastSubmittedAt: previous },
      });
    }

    it.each(['unsolved', 'attempted', 'solved', 'revisit'] as const)(
      'persists %s with one increment and the existing timestamp semantics', async status => {
        await seedSubmissionMetadata();
        const response = await patch(`/problems/${ownedIds[0]}`, { status });
        const solvedAt = status === 'solved' ? now : null;

        expect.soft(response.status).toBe(200);
        expect.soft(response.body).toMatchObject({ success: true, data: {
          id: ownedIds[0], status, submissionCount: 8,
          lastSubmittedAt: now.toISOString(), solvedAt: solvedAt ? solvedAt.toISOString() : null,
        } });
        expect(await DsaProblem.findById(ownedIds[0]).lean()).toMatchObject({
          status, submissionCount: 8, lastSubmittedAt: now, solvedAt,
        });
        expect(await DsaProblem.findById(ownedIds[1]).lean()).toMatchObject({ status: 'unsolved', submissionCount: 0 });
      },
    );

    it('increments the default zero counter and retains the problem response fields', async () => {
      const response = await patch(`/problems/${ownedIds[0]}`, { status: 'attempted' });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        id: ownedIds[0], externalId: 'owned-1', title: 'Owned problem 1', platform: 'leetcode',
        difficulty: 'easy', url: 'https://leetcode.com/problems/two-sum/', tags: [], category: 'arrays',
        status: 'attempted', notes: null, timeTaken: null, submissionCount: 1,
        lastSubmittedAt: now.toISOString(), solvedAt: null, isFavorite: false,
        createdAt: expect.any(String), updatedAt: now.toISOString(),
      });
      expect(await DsaProblem.findById(ownedIds[0]).lean()).toMatchObject({
        status: 'attempted', submissionCount: 1, lastSubmittedAt: now, solvedAt: null,
      });
    });

    it('combines a status increment with supported non-status fields', async () => {
      const response = await patch(`/problems/${ownedIds[0]}`, {
        status: 'solved', notes: 'Reviewed solution', timeTaken: 15, isFavorite: true, tags: ['arrays'],
      });

      expect(response.status).toBe(200);
      expect(await DsaProblem.findById(ownedIds[0]).lean()).toMatchObject({
        status: 'solved', notes: 'Reviewed solution', timeTaken: 15, isFavorite: true, tags: ['arrays'],
        submissionCount: 1, solvedAt: now, lastSubmittedAt: now,
      });
    });

    it.each([{ notes: 'Notes only' }, {}])('preserves submission metadata without status: %j', async payload => {
      await seedSubmissionMetadata();
      const response = await patch(`/problems/${ownedIds[0]}`, payload);

      expect(response.status).toBe(200);
      expect(await DsaProblem.findById(ownedIds[0]).lean()).toMatchObject({
        ...payload, status: 'solved', submissionCount: 7, solvedAt: previous, lastSubmittedAt: previous,
      });
    });

    it('increments once per repeated valid request and dates the latest solve', async () => {
      const counters: number[] = [];
      for (const [index, status] of (['solved', 'revisit', 'solved'] as const).entries()) {
        vi.setSystemTime(new Date(now.getTime() + index * 60_000));
        const response = await patch(`/problems/${ownedIds[0]}`, { status });
        expect(response.status).toBe(200);
        counters.push(response.body.data.submissionCount);
      }
      expect(counters).toEqual([1, 2, 3]);
      const latest = new Date(now.getTime() + 2 * 60_000);
      expect(await DsaProblem.findById(ownedIds[0]).lean()).toMatchObject({
        status: 'solved', submissionCount: 3, solvedAt: latest, lastSubmittedAt: latest,
      });
    });

    it('does not lose increments when valid status requests run concurrently', async () => {
      await seedSubmissionMetadata();
      const responses = await Promise.all(Array.from({ length: 8 }, () =>
        patch(`/problems/${ownedIds[0]}`, { status: 'attempted' }),
      ));

      expect(responses.map(response => response.status)).toEqual(Array(8).fill(200));
      expect(responses.map(response => response.body.data.submissionCount).sort((a, b) => a - b))
        .toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
      expect(await DsaProblem.findById(ownedIds[0]).lean()).toMatchObject({
        status: 'attempted', submissionCount: 15, lastSubmittedAt: now, solvedAt: null,
      });
    });

    it.each(['foreign', 'missing'])('returns 404 for a %s record with a valid status payload', async target => {
      const id = target === 'foreign' ? foreignId : new Types.ObjectId().toHexString();
      const response = await patch(`/problems/${id}`, { status: 'solved' });

      expect(response.status).toBe(404);
      expect(await DsaProblem.countDocuments()).toBe(3);
      expect(await DsaProblem.findById(foreignId).lean()).toMatchObject({
        status: 'unsolved', submissionCount: 0, solvedAt: null, lastSubmittedAt: null,
      });
    });

    it('rejects invalid status before persisting any mixed-field changes', async () => {
      await seedSubmissionMetadata();
      const response = await patch(`/problems/${ownedIds[0]}`, { status: 'invalid', notes: 'Must not persist' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(await DsaProblem.findById(ownedIds[0]).lean()).toMatchObject({
        status: 'solved', submissionCount: 7, notes: null, solvedAt: previous, lastSubmittedAt: previous,
      });
    });

    it('requires authentication for individual status updates', async () => {
      const response = await patch(`/problems/${ownedIds[0]}`, { status: 'solved' }, false);
      expect(response.status).toBe(401);
      expect(await DsaProblem.findById(ownedIds[0]).lean()).toMatchObject({
        status: 'unsolved', submissionCount: 0, solvedAt: null, lastSubmittedAt: null,
      });
    });

    it('rejects malformed IDs with a valid status without changing any record', async () => {
      const response = await patch('/problems/invalid-id', { status: 'solved' });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Validation failed' });
      expect(await DsaProblem.countDocuments({ submissionCount: { $ne: 0 } })).toBe(0);
    });
  });
});
