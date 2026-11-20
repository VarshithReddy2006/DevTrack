import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as contracts from '../index.js';

const outputPath = fileURLToPath(new URL('../../openapi.json', import.meta.url));
type Content = Record<string, { schema: Record<string, unknown> }>;
type Route = {
  method: 'get' | 'post'; path: string; operationId: string; tags: string[];
  description?: string; servers?: { url: string }[]; security?: Record<string, string[]>[];
  request?: { params?: z.AnyZodObject; query?: z.AnyZodObject; headers?: z.AnyZodObject; body?: { required: boolean; content: Content } };
  responses: Record<number, { description: string; content: Content }>;
};

function normalize2020(node: any): any {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(normalize2020);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'items' && Array.isArray(v)) {
      out.prefixItems = v.map(normalize2020);
      out.items = false;
    } else {
      out[k] = normalize2020(v);
    }
  }
  return out;
}

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const result = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none', pipeStrategy: 'all', effectStrategy: 'input', applyRegexFlags: true });
  // The supported keywords also apply in 2020-12; inherit OpenAPI 3.1's dialect.
  delete result.$schema;
  return normalize2020(result);
}

export function createOpenApiDocument() {
  const schemas: Record<string, Record<string, unknown>> = {}, paths: Record<string, Record<string, unknown>> = {};
  const names = new Map<z.ZodTypeAny, string>();
  const register = (name: string, schema: z.ZodTypeAny) => { schemas[name] = jsonSchema(schema); names.set(schema, name); return schema; };
  const schemaRef = (schema: z.ZodTypeAny): Record<string, unknown> => names.has(schema) ? { $ref: `#/components/schemas/${names.get(schema)}` } : jsonSchema(schema);
  function parameters(schema: z.AnyZodObject | undefined, location: 'path' | 'query' | 'header') {
    return Object.entries(schema?.shape || {}).map(([name, field]) => ({ name, in: location,
      required: location === 'path' || !(field as z.ZodTypeAny).isOptional(), schema: schemaRef(field as z.ZodTypeAny) }));
  }
  function registerPath({ method, path, request, ...operation }: Route) {
    const params = [...parameters(request?.params, 'path'), ...parameters(request?.query, 'query'), ...parameters(request?.headers, 'header')];
    paths[path] ||= {};
    paths[path][method] = { ...operation, ...(params.length ? { parameters: params } : {}), ...(request?.body ? { requestBody: request.body } : {}) };
  }
  // Keep every exported schema visible, including schemas not yet wired to a route.
  for (const [name, schema] of Object.entries(contracts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (schema instanceof z.ZodType) register(name.replace(/Schema$/, ''), schema);
  }
  const BearerAuth = {
    type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Clerk session JWT in the Authorization header.',
  };
  const SseTicket = {
    type: 'apiKey', in: 'query', name: 'ticket',
    description: 'Short-lived single-use ticket from POST /auth/sse-handshake. Never put a bearer JWT in the URL.',
  };
  const success = (data: z.ZodTypeAny) => z.object({
    success: z.literal(true), data, message: z.string().optional(),
    timestamp: contracts.IsoDateTimeSchema.optional(),
  }).passthrough();
  // Current controllers use both legacy top-level errors and the shared envelope.
  const error = register('HttpErrorResponse', z.union([
    contracts.apiResponseEnvelopeSchema(z.unknown()).extend({ success: z.literal(false), error: contracts.ApiErrorSchema }),
    z.object({ success: z.literal(false), message: z.string(), code: z.string().optional() }).passthrough(),
    z.object({ error: z.string(), message: z.string().optional(), code: z.string().optional() }).passthrough(),
  ]));
  const json = (schema: z.ZodTypeAny): Content => ({ 'application/json': { schema: schemaRef(schema) } });
  const errors = {
    400: { description: 'Invalid request.', content: json(error) },
    401: { description: 'Missing, invalid or expired authentication.', content: json(error) },
    404: { description: 'Requested resource was not found.', content: json(error) },
    500: { description: 'Unexpected server error.', content: json(error) },
  };
  const unknownSuccess = { description: 'Successful response. The data payload has no shared Zod response contract yet.', content: json(success(z.unknown())) };
  const id = z.object({ id: contracts.ObjectIdSchema });

  registerPath({
    method: 'get', path: '/contests/upcoming', operationId: 'getUpcomingContests', tags: ['Contests'],
    description: 'The current controller returns an array. Only the platform filter is consumed; the exported pagination contract is not yet wired here.',
    request: { query: contracts.UpcomingContestsQuerySchema.pick({ platform: true }) },
    responses: { 200: { description: 'Upcoming scheduled contests.', content: json(success(z.array(contracts.UpcomingContestSchema))) }, ...errors },
  });
  registerPath({
    method: 'post', path: '/focus/sessions', operationId: 'startFocusSession', tags: ['Focus'],
    description: 'Canonical shared request uses plannedSec. The controller also accepts a legacy plannedDurationMinutes field.',
    request: { body: { required: true, content: json(contracts.FocusStartRequestSchema) } },
    responses: { 201: { ...unknownSuccess, description: 'Focus session created; the server owns session timing.' }, ...errors,
      409: { description: 'A focus session is already open.', content: json(error) } },
  });
  registerPath({ method: 'get', path: '/focus/sessions/active', operationId: 'getActiveFocusSession', tags: ['Focus'], responses: { 200: unknownSuccess, ...errors } });
  for (const action of ['heartbeat', 'pause', 'resume', 'abandon', 'complete'] as const) {
    const responses: Route['responses'] = { 200: unknownSuccess, ...errors };
    if (action === 'heartbeat') responses[429] = { description: 'Heartbeat arrived before the minimum interval.', content: json(error) };
    registerPath({
      method: 'post', path: `/focus/sessions/{id}/${action}`, operationId: `${action}FocusSession`, tags: ['Focus'],
      request: { params: id }, responses,
    });
  }
  registerPath({
    method: 'get', path: '/revision/due', operationId: 'getDueRevisionCards', tags: ['Revision'],
    request: { query: contracts.RevisionDueQuerySchema }, responses: { 200: unknownSuccess, ...errors },
  });
  registerPath({
    method: 'post', path: '/revision/cards/{id}/reviews', operationId: 'submitRevisionReview', tags: ['Revision'],
    request: { params: id, body: { required: true, content: json(contracts.ReviewSubmitRequestSchema) } },
    responses: { 200: unknownSuccess, ...errors, 409: { description: 'Review sequence is stale; reload the card.', content: json(error) } },
  });
  registerPath({
    method: 'get', path: '/revision/analytics', operationId: 'getRevisionAnalytics', tags: ['Revision'],
    servers: [{ url: '/api/v1' }, { url: '/api/v2' }], responses: { 200: unknownSuccess, ...errors },
  });
  registerPath({ method: 'get', path: '/auth/me', operationId: 'getCurrentUser', tags: ['Auth'], responses: { 200: unknownSuccess, ...errors } });
  registerPath({
    method: 'post', path: '/auth/sse-handshake', operationId: 'createSseTicket', tags: ['Auth'],
    responses: { 200: { description: 'Single-use SSE ticket, currently valid for 10 seconds.', content: json(success(z.object({ ticket: z.string().uuid() }))) }, ...errors },
  });
  registerPath({
    method: 'get', path: '/events', operationId: 'streamEvents', tags: ['Realtime'], security: [{ SseTicket: [] }],
    request: { query: z.object({ ticket: z.string().min(1), lastEventId: z.string().optional() }), headers: z.object({ 'Last-Event-ID': z.string().optional() }) },
    responses: { 200: { description: 'Server-sent event frames. Reconnect using a fresh handshake ticket.', content: { 'text/event-stream': { schema: jsonSchema(z.string()) } } }, ...errors },
  });

  return {
    openapi: '3.1.0', info: {
      title: 'DevTrack shared API contracts', version: '0.1.0',
      description: 'Generated from the current shared Zod schemas and explicitly registered backend routes. This is not a catalogue of every backend endpoint. Shared contracts currently cover common, focus, contests and revision. Auth/SSE describe existing runtime routes. Untyped response payloads stay unspecified. Zod transformations and cross-field refinements still require runtime validation.',
    }, servers: [{ url: '/api/v1', description: 'Current versioned API; only explicitly listed operations advertise v2.' }],
    security: [{ BearerAuth: [] }],
    paths, components: { schemas, securitySchemes: { BearerAuth, SseTicket } },
    'x-pending-contract-modules': ['dsa', 'portfolio', 'readiness', 'interview', 'leagues'],
  };
}

export function serializeOpenApiDocument() { return JSON.stringify(createOpenApiDocument(), null, 2) + '\n'; }

function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check') || args.length > 1) throw new Error('Usage: build.ts [--check]');
  const generated = serializeOpenApiDocument();
  if (args[0] === '--check') {
    let committed: string;
    try { committed = readFileSync(outputPath, 'utf8'); }
    catch { throw new Error('openapi.json is missing. Run contracts:build-openapi and commit it.'); }
    if (committed !== generated) throw new Error('openapi.json is stale. Run contracts:build-openapi and commit the diff.');
    console.log('OpenAPI contract is current.');
  } else {
    writeFileSync(outputPath, generated); console.log('Generated packages/contracts/openapi.json.');
  }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
