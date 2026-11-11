import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import router from '../routes/resume-intelligence.routes.js';
import { errorHandler } from '../../../middleware/error.js';

const pdf = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../../../middleware/auth.js', () => ({ authMiddleware: (req: any, res: any, next: any) => {
  if (!req.headers['x-test-user']) return res.sendStatus(401);
  req.user = { id: req.headers['x-test-user'] }; next();
} }));
vi.mock('../../../middleware/rateLimitAdvanced.js', () => ({ rateLimiters: { resume: (_req: any, _res: any, next: any) => next(), resumeRead: (_req: any, _res: any, next: any) => next() } }));
vi.mock('puppeteer', () => ({ default: { launch: async () => ({ newPage: async () => ({ setJavaScriptEnabled: async () => {}, close: async () => {}, setRequestInterception: async () => {}, on: () => {}, setContent: async () => {}, pdf: pdf.generate }), close: async () => {} }) } }));

const report = { executiveSummary: {}, roleAlignment: {}, credibilityAnalysis: { unsupportedClaims: [], projectRankings: [] }, recommendations: [] };
const owner = '012345678901234567890123';
const app = express();
app.use(express.json(), router, errorHandler);
const server = app.listen(0, '127.0.0.1');
let url: string;
beforeAll(async () => {
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dossier-pdf`;
  vi.spyOn(ResumeSession, 'findOne').mockImplementation((query: any) => Promise.resolve(
    query.userId === owner && query.sessionId === 'owned' && query.currentStage === 'COMPLETED' ? { reportState: { generated: true, reportData: report } } : null,
  ) as never);
});
afterAll(async () => { vi.restoreAllMocks(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

async function post(body: object, user?: string) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body) });
}

it('serves an authenticated owner a PDF attachment', async () => {
  pdf.generate.mockResolvedValueOnce(Buffer.from('%PDF-synthetic'));
  const response = await post({ sessionId: 'owned' }, owner);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf/);
  expect(response.headers.get('content-disposition')).toContain('devtrack-dossier.pdf');
  expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
});

it('rejects anonymous, foreign, missing and invalid requests', async () => {
  expect((await post({ sessionId: 'owned' })).status).toBe(401);
  expect((await post({ sessionId: 'owned' }, 'aaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
  expect((await post({ sessionId: 'missing' }, owner)).status).toBe(404);
  expect((await post({ sessionId: '' }, owner)).status).toBe(400);
});

it('returns an error when PDF generation fails', async () => {
  pdf.generate.mockRejectedValueOnce(new Error('renderer failed'));
  const response = await post({ sessionId: 'owned' }, owner);
  expect(response.status).toBe(500);
  expect(response.headers.get('content-type')).not.toContain('application/pdf');
});
