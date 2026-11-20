import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { registerSchema, validate } from '@hyperjump/json-schema/draft-2020-12';
import { z } from 'zod';
import * as contracts from '@devtrack/contracts';
import { createOpenApiDocument, serializeOpenApiDocument } from '../src/openapi/build.ts';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const officialSchema = JSON.parse(readFileSync(new URL('fixtures/openapi-3.1-schema.json', import.meta.url), 'utf8'));
registerSchema(officialSchema);
const validateDocument = await validate(officialSchema.$id);
const componentValidators = {};
for (const [name, schema] of Object.entries(createOpenApiDocument().components.schemas)) {
  const id = `https://devtrack.test/schemas/${name}`;
  registerSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema }, id);
  componentValidators[name] = await validate(id);
}

test('generated document validates against the pinned official OpenAPI 3.1 meta-schema', () => {
  const doc = createOpenApiDocument();
  assert.equal(validateDocument(doc).valid, true);
  assert.equal(doc.openapi, '3.1.0');
  const invalid = structuredClone(doc); delete invalid.info.title;
  assert.equal(validateDocument(invalid).valid, false, 'Negative control must fail the official meta-schema');
});

test('every exported shared Zod schema is documented and local references resolve', () => {
  const doc = createOpenApiDocument();
  for (const [name, value] of Object.entries(contracts)) if (value instanceof z.ZodType) {
    assert.ok(Object.hasOwn(doc.components.schemas, name.replace(/Schema$/, '')), `Missing ${name}`);
  }
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith('#/'), `Unexpected remote reference ${value.$ref}`);
      const target = value.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
      assert.notEqual(target, undefined, `Broken reference ${value.$ref}`);
    }
    Object.values(value).forEach(visit);
  }
  visit(doc);
});

test('request constraints, coercion output and response status reflect current routes', async () => {
  const doc = createOpenApiDocument();
  const start = doc.paths['/focus/sessions'].post;
  assert.ok(start.responses[201]); assert.equal(start.responses[200], undefined);
  assert.equal(start.requestBody.required, true);
  assert.equal(start.requestBody.content['application/json'].schema.$ref, '#/components/schemas/FocusStartRequest');
  const heartbeat = doc.paths['/focus/sessions/{id}/heartbeat'].post;
  assert.equal(heartbeat.parameters.find(p => p.name === 'id').in, 'path');
  assert.equal(heartbeat.parameters.find(p => p.name === 'id').required, true);
  assert.equal(heartbeat.requestBody, undefined); assert.ok(heartbeat.responses[429]);
  const limit = doc.paths['/revision/due'].get.parameters.find(p => p.name === 'limit');
  assert.equal(limit.schema.default, 10);
  registerSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...limit.schema }, 'https://devtrack.test/schemas/DueLimit');
  const validateLimit = await validate('https://devtrack.test/schemas/DueLimit');
  assert.equal(validateLimit(10).valid, true);
  for (const invalid of [0, -1, .5, 101, 9007199254740992]) assert.equal(validateLimit(invalid).valid, false);
  assert.deepEqual(doc.paths['/contests/upcoming'].get.parameters.map(p => p.name), ['platform']);
  assert.deepEqual(doc.paths['/revision/analytics'].get.servers, [{ url: '/api/v1' }, { url: '/api/v2' }]);
  assert.deepEqual(doc['x-pending-contract-modules'], ['dsa', 'portfolio', 'readiness', 'interview', 'leagues']);
  for (const path of Object.values(doc.paths)) for (const operation of Object.values(path)) {
    for (const status of [400, 401, 404, 500]) assert.ok(operation.responses[status]);
    for (const response of Object.values(operation.responses)) for (const media of Object.keys(response.content)) {
      assert.ok(['application/json', 'text/event-stream'].includes(media));
    }
  }
});

test('ticket authentication is separate from bearer authentication and has event-stream media', () => {
  const doc = createOpenApiDocument();
  assert.deepEqual(doc.security, [{ BearerAuth: [] }]);
  assert.equal(doc.components.securitySchemes.BearerAuth.scheme, 'bearer');
  assert.deepEqual(doc.paths['/events'].get.security, [{ SseTicket: [] }]);
  assert.equal(doc.components.securitySchemes.SseTicket.in, 'query');
  assert.equal(doc.components.securitySchemes.SseTicket.name, 'ticket');
  assert.equal(doc.paths['/events'].get.responses[200].content['text/event-stream'].schema.type, 'string');
  assert.ok(doc.paths['/events'].get.parameters.find(p => p.name === 'ticket').required);
});

test('generated component constraints validate representative accepted and rejected data', () => {
  const validateId = componentValidators.ObjectId;
  assert.equal(validateId('ABCDEF0123456789ABCDEF01').valid, true);
  assert.equal(validateId('not-an-object-id').valid, false);
  const validateReview = componentValidators.ReviewSubmitRequest;
  assert.equal(validateReview({ rating: 'hard', reviewSeq: 0 }).valid, true);
  assert.equal(validateReview({ rating: 'hard', reviewSeq: -1 }).valid, false);
  assert.equal(validateReview({ rating: 'hard', reviewSeq: 0, xp: 1000 }).valid, false);
  const validateError = componentValidators.HttpErrorResponse;
  for (const error of [
    { success: false, code: 'FOCUS_SESSION_NOT_FOUND', message: 'Not found' },
    { error: 'UNAUTHORIZED', message: 'Authentication required' },
    { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid input' } },
  ]) assert.equal(validateError(error).valid, true);
});

test('generation is byte-stable and the tracked document has no drift', () => {
  assert.equal(serializeOpenApiDocument(), serializeOpenApiDocument());
  assert.equal(readFileSync(join(packageRoot, 'openapi.json'), 'utf8'), serializeOpenApiDocument());
});

function fixture(action) {
  const temporary = mkdtempSync(join(tmpdir(), 'devtrack-openapi-'));
  try {
    cpSync(join(packageRoot, 'src'), join(temporary, 'src'), { recursive: true });
    cpSync(join(packageRoot, 'openapi.json'), join(temporary, 'openapi.json'));
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ type: 'module' }));
    symlinkSync(join(repoRoot, 'node_modules'), join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const run = args => spawnSync(process.execPath, ['--import', 'tsx', join(temporary, 'src/openapi/build.ts'), ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 20000 });
    action(temporary, run);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

test('CLI rejects actual source drift without overwriting output, and regeneration repairs it', () => {
  fixture((temporary, run) => {
    const output = join(temporary, 'openapi.json'), previous = readFileSync(output, 'utf8');
    assert.equal(run(['--check']).status, 0);
    const source = join(temporary, 'src/focus/focus.schemas.ts');
    const original = readFileSync(source, 'utf8'); assert.ok(original.includes('.max(80)'));
    writeFileSync(source, original.replace('.max(80)', '.max(81)'));
    const drift = run(['--check']); assert.equal(drift.status, 1); assert.match(drift.stderr, /is stale/);
    assert.equal(readFileSync(output, 'utf8'), previous);
    assert.equal(run([]).status, 0);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).components.schemas.FocusStartRequest.properties.mode.maxLength, 81);
    assert.equal(run(['--check']).status, 0);
  });
});

test('CLI fails closed for a missing artifact and invalid invocation', () => {
  fixture((temporary, run) => {
    const output = join(temporary, 'openapi.json'); rmSync(output);
    const missing = run(['--check']); assert.equal(missing.status, 1); assert.match(missing.stderr, /is missing/); assert.equal(existsSync(output), false);
    const invalid = run(['--unknown']); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Usage/); assert.equal(existsSync(output), false);
  });
});
