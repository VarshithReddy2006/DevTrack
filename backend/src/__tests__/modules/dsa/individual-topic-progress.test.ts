import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DsaProblem, DsaTopicProgress } from '../../../db/models/index.js';
import { errorHandler } from '../../../middleware/error.js';
import dsaRoutes from '../../../modules/dsa/dsa.routes.js';

vi.mock('../../../middleware/index.js', async () => {
  const { validateBody } = await import('../../../middleware/validation.js');
  const { asyncHandler } = await import('../../../middleware/error.js');
  const { commonErrors } = await import('../../../shared/response.js');
  return {
    validateBody,
    asyncHandler,
    authMiddleware: [
      (req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (req.get('authorization') !== 'Bearer test-owner') {
          commonErrors.unauthorized(res);
          return;
        }
        Object.assign(req, { user: { id: '000000000000000000000001' } });
        next();
      },
    ],
  };
});

const userId = new Types.ObjectId('000000000000000000000001');
let server: Server;
let base: string;

beforeAll(async () => {
  await Promise.all([DsaProblem.init(), DsaTopicProgress.init()]);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/dsa', dsaRoutes);
  app.use(errorHandler);
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/dsa`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function request(method: string, route: string, body?: unknown) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-owner',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function createProblem(category = 'dynamic-programming', difficulty = 'medium') {
  const response = await request('POST', '/problems', {
    title: 'DP Subsequence Test',
    platform: 'leetcode',
    category,
    difficulty,
    tags: ['dp'],
    url: 'https://leetcode.com/problems/dp-subsequence-test',
  });
  expect(response.status).toBe(201);
  return response.body.data.id as string;
}

describe('Issue #114: individual problem updates and deletions reconcile DsaTopicProgress', () => {
  it('marking an individual problem solved via PATCH reconciles DsaTopicProgress and sets solvedAt', async () => {
    const problemId = await createProblem('trees', 'easy');

    // Initially progress is 1 problem, 0 solved
    let topic = await DsaTopicProgress.findOne({ userId, topicName: 'trees' }).lean();
    expect(topic).toMatchObject({ totalProblems: 1, solvedCount: 0, easySolved: 0 });

    // Mark as solved individually
    const patchRes = await request('PATCH', `/problems/${problemId}`, { status: 'solved' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.status).toBe('solved');
    expect(patchRes.body.data.solvedAt).toBeDefined();

    // Verify DsaTopicProgress was reconciled
    topic = await DsaTopicProgress.findOne({ userId, topicName: 'trees' }).lean();
    expect(topic).toMatchObject({ totalProblems: 1, solvedCount: 1, easySolved: 1 });
  });

  it('transitioning an individual problem from solved to unsolved clears solvedAt and decreases solvedCount', async () => {
    const problemId = await createProblem('greedy', 'easy');
    await request('PATCH', `/problems/${problemId}`, { status: 'solved' });

    let topic = await DsaTopicProgress.findOne({ userId, topicName: 'greedy' }).lean();
    expect(topic?.solvedCount).toBe(1);

    // Now transition to unsolved
    const patchRes = await request('PATCH', `/problems/${problemId}`, { status: 'unsolved' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.status).toBe('unsolved');
    expect(patchRes.body.data.solvedAt).toBeNull();

    // Verify database directly
    const doc = await DsaProblem.findById(problemId).lean();
    expect(doc?.solvedAt).toBeUndefined();

    // Verify topic progress updated
    topic = await DsaTopicProgress.findOne({ userId, topicName: 'greedy' }).lean();
    expect(topic).toMatchObject({ totalProblems: 1, solvedCount: 0, easySolved: 0 });
  });

  it('updating problem notes or tags without changing status does not increment submissionCount', async () => {
    const problemId = await createProblem('arrays', 'easy');
    const initial = await DsaProblem.findById(problemId).lean();
    const initialSubmissionCount = initial?.submissionCount || 0;

    // Send status: 'unsolved' (which was already the status) along with notes
    const patchRes = await request('PATCH', `/problems/${problemId}`, {
      status: 'unsolved',
      notes: 'New notes added here',
    });
    expect(patchRes.status).toBe(200);

    const updated = await DsaProblem.findById(problemId).lean();
    expect(updated?.submissionCount).toBe(initialSubmissionCount);
    expect(updated?.notes).toBe('New notes added here');
  });

  it('deleting an individual problem reconciles DsaTopicProgress totalCount and solvedCount', async () => {
    const problemId = await createProblem('backtracking', 'hard');
    await request('PATCH', `/problems/${problemId}`, { status: 'solved' });

    let topic = await DsaTopicProgress.findOne({ userId, topicName: 'backtracking' }).lean();
    expect(topic).toMatchObject({ totalProblems: 1, solvedCount: 1, hardSolved: 1 });

    // Delete problem
    const delRes = await request('DELETE', `/problems/${problemId}`);
    expect(delRes.status).toBe(200);

    // Verify topic progress reduced
    topic = await DsaTopicProgress.findOne({ userId, topicName: 'backtracking' }).lean();
    expect(topic).toMatchObject({ totalProblems: 0, solvedCount: 0, hardSolved: 0 });
  });
});
