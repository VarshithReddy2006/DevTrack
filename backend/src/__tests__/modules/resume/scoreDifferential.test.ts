import { generateKeyPairSync, sign } from 'node:crypto';
import { Agent, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import express from 'express';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { scoreDifferential } from '@devtrack/ats-core';
import { bulletRevisionRoutes } from '../../../modules/resume/resume.routes.js';
import { mountApiRoutes } from '../../../routes/mount.js';
import { errorHandler } from '../../../middleware/error.js';
import { scoreDifferentialSchema } from '../../../modules/resume/scoreDifferential.service.js';

const adapters = vi.hoisted(() => ({ limited: false, rateCalls: 0 }));
vi.mock('../../../middleware/rateLimitAdvanced.js', () => ({ rateLimiters: {
  resumeRead: (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    adapters.rateCalls++;
    if (adapters.limited) { res.set('Retry-After', '60').sendStatus(429); return; }
    next();
  },
  resume: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
} }));

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const input = {
  originalBullets: ['Built reliable services handling requests for customers across multiple regions'],
  revisedBullets: ['Built reliable Node.js services handling requests for customers across multiple regions'],
  targetKeywords: ['Node.js'],
};
function token(overrides: Record<string, unknown> = {}, privateKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'https://test.clerk.accounts.dev', sub: 'user_test', sid: 'sess_test', iat: now, nbf: now - 10, exp: now + 3600, azp: 'https://example.test', ...overrides })).toString('base64url');
  const data = `${header}.${claims}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

describe('Stateless ATS differential HTTP API', () => {
  let server: Server;
  let origin: string;
  let validToken: string;
  let middlewareCalls = 0;
  const serverTimes: number[] = [];
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const query = vi.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(() => { throw new Error('MongoDB query forbidden'); });
  const aggregate = vi.spyOn(mongoose.Aggregate.prototype, 'exec').mockImplementation(() => { throw new Error('MongoDB aggregation forbidden'); });
  const connect = vi.spyOn(mongoose, 'connect').mockImplementation(() => { throw new Error('MongoDB connection forbidden'); });

  beforeAll(async () => {
    const app = express();
    app.use((_req, res, next) => {
      const start = performance.now();
      res.once('finish', () => serverTimes.push(performance.now() - start));
      next();
    });
    app.use(express.json({ limit: '100kb' }));
    const router = express.Router();
    router.use((_req, _res, next) => { middlewareCalls++; next(); });
    router.use('/resume', bulletRevisionRoutes);
    mountApiRoutes(app, router);
    app.use(errorHandler);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    agent.destroy();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.stubEnv('CLERK_JWT_KEY', keys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
    vi.stubEnv('CLERK_SECRET_KEY', '');
    vi.stubEnv('CORS_ORIGIN', 'https://example.test');
    validToken = token();
    adapters.limited = false;
    adapters.rateCalls = middlewareCalls = 0;
  });
  afterEach(() => {
    expect(query).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
  const request = (body: unknown = input, authorization: string | null = validToken, prefix = '/api/v2') => fetch(`${origin}${prefix}/resume/diff-score`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization === null ? {} : { Authorization: `Bearer ${authorization}` }) },
    body: JSON.stringify(body),
  });
  const benchmarkRequest = (body: unknown) => new Promise<void>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest(`${origin}/api/v2/resume/diff-score`, {
      method: 'POST', agent, headers: { Authorization: `Bearer ${validToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`Benchmark returned ${res.statusCode}`);
          JSON.parse(Buffer.concat(chunks).toString());
          resolve();
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });

  it('returns shared-core scores over v2, v1, and legacy aliases using real JWT signature verification', async () => {
    for (const prefix of ['/api/v2', '/api/v1', '/api']) {
      middlewareCalls = 0;
      const res = await request(input, validToken, prefix);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, data: scoreDifferential(input) });
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(middlewareCalls).toBe(1);
    }
  });

  it.each(['missing', 'malformed', 'expired', 'signature', 'origin', 'subject', 'session', 'future'])('rejects %s authentication without consulting MongoDB', async (kind) => {
    const invalid = {
      missing: null, malformed: 'not-a-jwt', expired: token({ exp: Math.floor(Date.now() / 1000) - 60 }),
      signature: token({}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey),
      origin: token({ azp: 'https://attacker.test' }), subject: token({ sub: '' }), session: token({ sid: '' }),
      future: token({ nbf: Math.floor(Date.now() / 1000) + 60 }),
    }[kind];
    expect((await request(input, invalid)).status).toBe(401);
    expect(adapters.rateCalls).toBe(0);
  });

  it('fails closed without configured Clerk credentials', async () => {
    vi.stubEnv('CLERK_JWT_KEY', '');
    expect((await request()).status).toBe(401);
  });

  it.each([
    {}, { ...input, originalBullets: 'invalid' }, { ...input, revisedBullets: [12] },
    { ...input, originalBullets: Array(101).fill('text') }, { ...input, revisedBullets: ['x'.repeat(1001)] },
    { ...input, targetKeywords: [''] }, { ...input, targetKeywords: Array(101).fill('skill') },
    { ...input, targetKeywords: ['x'.repeat(81)] }, { ...input, originalBullets: Array(51).fill('x'.repeat(1000)) },
    { ...input, expectedScore: 100 },
  ])('rejects invalid request input case %# before calculation', async (body) => {
    expect((await request(body)).status).toBe(400);
  });

  it('handles deletions and completely empty input', async () => {
    const empty = { originalBullets: [], revisedBullets: [], targetKeywords: [] };
    expect((await (await request(empty)).json()).data).toMatchObject({ originalScore: 0, revisedScore: 0, delta: 0 });
    expect((await (await request({ ...input, revisedBullets: [] })).json()).data.delta).toBeLessThan(0);
  });

  it('retains the read-computation limiter instead of the expensive generation budget', async () => {
    adapters.limited = true;
    const res = await request();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it('enforces the aggregate text bound across original and revised bullets', () => {
    expect(scoreDifferentialSchema.safeParse({ ...input, originalBullets: Array(25).fill('x'.repeat(1000)), revisedBullets: Array(25).fill('x'.repeat(1000)) }).success).toBe(true);
    expect(scoreDifferentialSchema.safeParse({ ...input, originalBullets: Array(25).fill('x'.repeat(1000)), revisedBullets: Array(26).fill('x'.repeat(1000)) }).success).toBe(false);
  });

  it.skipIf(process.env.ATS_BENCHMARK !== '1')('benchmarks 1000 pure calculations and authenticated local HTTP responses', async () => {
    const p95 = (values: number[]) => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
    const scenarios = {
      typical: { ...input, originalBullets: Array(20).fill(input.originalBullets[0]), revisedBullets: Array(20).fill(input.revisedBullets[0]), targetKeywords: ['Node.js', 'Redis', 'TypeScript', 'PostgreSQL', 'Docker'] },
      bounded: { originalBullets: Array(25).fill('Built Node.js reliable services for customers '.repeat(22).slice(0, 1000)), revisedBullets: Array(25).fill('Built Redis reliable services for customers '.repeat(23).slice(0, 1000)), targetKeywords: Array.from({ length: 100 }, (_, i) => `skill${i}`) },
    };
    for (const [name, body] of Object.entries(scenarios)) {
      for (let warmup = 0; warmup < 100; warmup++) scoreDifferential(body);
      const pure: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const start = performance.now(); scoreDifferential(body); pure.push(performance.now() - start);
      }
      for (let warmup = 0; warmup < 100; warmup++) await benchmarkRequest(body);
      const http: number[] = [];
      serverTimes.length = 0;
      for (let i = 0; i < 1000; i++) {
        const start = performance.now();
        await benchmarkRequest(body);
        http.push(performance.now() - start);
      }
      process.stdout.write(JSON.stringify({ scenario: name, iterations: 1000, pureP95Ms: p95(pure), serverP95Ms: p95(serverTimes), httpP95Ms: p95(http) }) + '\n');
      expect.soft(p95(pure)).toBeLessThan(15);
      expect.soft(p95(http)).toBeLessThan(20);
    }
  }, 120_000);
});
