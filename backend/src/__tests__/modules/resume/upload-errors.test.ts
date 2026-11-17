import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// artifact-storage reads UPLOAD_DIR at import time, so set it before anything loads.
const uploadDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'devtrack-upload-errors-'));
  process.env.UPLOAD_DIR = dir;
  return dir;
});

// The real logger pulls in the tracing stack; monitoring only reports.
vi.mock('../../../shared/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../../../shared/monitoring.js', () => ({ reportError() {} }));

import { uploadSingle } from '../../../modules/resume/upload/multer.config.js';
import { validateUpload } from '../../../modules/resume/upload/upload.validation.js';
import { errorHandler } from '../../../middleware/error.js';

const tmpDir = path.join(uploadDir, 'tmp');
let server: Server;
let baseUrl: string;

async function upload(field: string, name: string, type: string, size: number, content?: Buffer) {
  const form = new FormData();
  form.append(field, new Blob([new Uint8Array(content ?? Buffer.alloc(size, 'a'))], { type }), name);
  const res = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const leftovers = () => (fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []);

beforeAll(async () => {
  const app = express();
  // Same chain as the real route: multer, then validateUpload, then the controller.
  app.post('/upload', uploadSingle, validateUpload, (_req, res) => void res.json({ ok: true }));
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resume upload error responses', () => {
  it('returns 413 FILE_TOO_LARGE for a file over 10 MB and leaves nothing on disk', async () => {
    const res = await upload('resume', 'big.txt', 'text/plain', 11 * 1024 * 1024);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ success: false, code: 'FILE_TOO_LARGE', message: expect.stringMatching(/too large.*10 MB/i) });
    expect(leftovers()).toEqual([]);
  });

  it('returns 415 UNSUPPORTED_FILE_TYPE for a disallowed type', async () => {
    const res = await upload('resume', 'malware.exe', 'application/octet-stream', 2000);
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ success: false, code: 'UNSUPPORTED_FILE_TYPE', message: expect.stringMatching(/unsupported file type/i) });
    expect(leftovers()).toEqual([]);
  });

  it('returns 400 UNEXPECTED_FILE when the field name is not "resume"', async () => {
    const res = await upload('cv', 'resume.txt', 'text/plain', 2000);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'UNEXPECTED_FILE', message: expect.stringContaining('"cv"') });
  });

  it('removes the temp file when validation rejects a file under 1 KB', async () => {
    const res = await upload('resume', 'tiny.txt', 'text/plain', 10);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(leftovers()).toEqual([]);
  });

  it('keeps the file for a valid upload so the controller can use it', async () => {
    const res = await upload('resume', 'resume.txt', 'text/plain', 0, Buffer.from('Software engineer. '.repeat(100)));
    expect(res.status).toBe(200);
    expect(leftovers()).toHaveLength(1);
  });
});
