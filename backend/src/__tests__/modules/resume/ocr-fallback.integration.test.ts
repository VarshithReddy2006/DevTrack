import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentParsingPipeline } from '../../../modules/resume/parsing/document-parsing-pipeline.js';

import { scanPdf, type RasterPage } from './scanned-resume-fixture.js';

describe.runIf(process.env.RUN_RESUME_OCR_INTEGRATION === '1')('scanned resume parsing with real OCR', () => {
  let directory: string;
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'devtrack-resume-ocr-test-')); });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  async function parseFixture(name: string, pages: RasterPage[]) {
    const filePath = join(directory, name);
    await writeFile(filePath, scanPdf(pages));
    return new DocumentParsingPipeline().parse('test-session', filePath, name);
  }

  it('routes a one-page scan into OCR and returns the recovered content to the pipeline', async () => {
    const result = await parseFixture('single.pdf', [[['Professional Summary', 'Built reliable billing services', 'Maintained incident response logs']]]);
    expect(result.success, result.error).toBe(true);
    expect(result.document?.metadata).toMatchObject({ pages: 1, ocrPages: 1 });
    expect(result.document?.sections.summary).toContain('Built reliable billing services');
  }, 20_000);

  it('reads the full left column before the right and preserves page order', async () => {
    const result = await parseFixture('columns.pdf', [
      [
        ['Managed payment services', 'Built deployment tooling', 'Delivered reliable billing', 'Verified nightly backups'],
        ['Studied computer science', 'Completed distributed systems', 'Practiced algorithm design', 'Maintained research records'],
      ],
      [['Professional Certifications', 'Completed cloud engineering course']],
    ]);
    expect(result.success, result.error).toBe(true);
    const text = result.document!.text;
    const tokens = ['Managed payment services', 'Verified nightly backups', 'Studied computer science', 'Maintained research records', 'Completed cloud engineering course'];
    for (const token of tokens) expect(text).toContain(token);
    expect(tokens.map(token => text.indexOf(token))).toEqual(tokens.map(token => text.indexOf(token)).sort((a, b) => a - b));
    expect(result.document?.metadata).toMatchObject({ pages: 2, ocrPages: 2 });
  }, 35_000);

  it('rejects an empty scan with a user-readable message', async () => {
    const result = await parseFixture('blank.pdf', [[[]]]);
    expect(result).toMatchObject({ success: false, retryable: false, error: expect.stringContaining('No readable text') });
  }, 20_000);
});
