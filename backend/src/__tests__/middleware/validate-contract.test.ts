import express from 'express';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorCodes, FocusHeartbeatRequestSchema, FocusStartRequestSchema, PaginationQuerySchema } from '@devtrack/contracts';
import { validateContract } from '../../middleware/validation.js';

let server: Server;
let baseUrl: string;
const id = '656565656565656565656565';
const app = express();
app.use(express.json());
app.post('/focus/:id', validateContract({
  body: FocusStartRequestSchema,
  query: PaginationQuerySchema,
  params: FocusHeartbeatRequestSchema,
}, (req, res) => {
  const plannedMinutes: number = req.validBody.plannedSec / 60;
  const page: number = req.validQuery.page;
  const sessionId: string = req.validParams.id;
  res.json({ plannedMinutes, mode: req.validBody.mode, page, sessionId, rawPage: req.query.page });
}));

app.post('/plain', validateContract({ body: z.record(z.unknown()) }), (req, res) => {
  res.json({ validated: req.validBody, received: req.body });
});

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

afterAll(async () => {
  if (!server) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function post(path: string, body: string) {
  return fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

it('exposes transformed values with inferred types and preserves the original query', async () => {
  const response = await post('/focus/' + id + '?page=2', JSON.stringify({ mode: ' study ', plannedSec: 300 }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ plannedMinutes: 5, mode: 'study', page: 2, sessionId: id, rawPage: '2' });
});

it('reports field paths across body, query and route params in a 400 envelope', async () => {
  const response = await post('/focus/bad-id?page=-2', JSON.stringify({ mode: 'study', plannedSec: -1 }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    success: false,
    error: { code: ErrorCodes.VALIDATION_ERROR, details: {
      'body.plannedSec': [expect.any(String)],
      'query.page': [expect.any(String)],
      'params.id': [expect.any(String)],
    } },
  });
});

it('supports separate handlers and sanitizes nested inputs without mutating the raw payload', async () => {
  const response = await post('/plain', '{"list":[{"value":1,"$field":2,"dotted.key":3,"constructor":4}]}');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    validated: { list: [{ value: 1 }] },
    received: { list: [{ value: 1, '$field': 2, 'dotted.key': 3, constructor: 4 }] },
  });
});
