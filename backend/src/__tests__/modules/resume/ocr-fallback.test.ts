import { beforeEach, describe, expect, it, vi } from 'vitest';
import { countResumeWords, orderTesseractText, recognizeResumePdf } from '../../../modules/resume/parsing/ocr-fallback.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execute }));

const OCR_OUTPUT = '5\t1\t1\t1\t1\t1\t25\t50\t24\t12\t90\tExample';

function simulateToolResponses(...results: Array<string | Error>) {
  for (const result of results) {
    execute.mockImplementationOnce((_tool, _args, _options, callback) => {
      queueMicrotask(() => {
        if (result instanceof Error) callback(result, Buffer.alloc(0));
        else callback(null, Buffer.from(result));
      });
      return { stdin: { on: vi.fn(), end: vi.fn() } };
    });
  }
}

describe('resume OCR limits', () => {
  beforeEach(() => { execute.mockReset(); });

  it('preserves Unicode words and ignores whitespace and punctuation', () => {
    expect(countResumeWords('  Résumé co-op, developer’s: हिन्दी  ')).toBe(4);
    expect(countResumeWords(' - —  ... ')).toBe(0);
  });

  it('orders bounds and ignores malformed or out-of-range rows', () => {
    const tsv = [
      '5\t1\t1\t1\t1\t2\t60\t50\t24\t12\t90\tDeveloper',
      '5\t1\t1\t1\t1\t1\t25\t50\t24\t12\t90\tBackend',
      '5\t1\t1\t1\t2\t1\t2500\t50\t24\t12\t90\tInvalid',
    ].join('\n');
    expect(orderTesseractText(tsv)).toBe('Backend Developer');
  });

  it('shares the page deadline between rendering, OCR and a single retry', async () => {
    simulateToolResponses('image', Object.assign(new Error('transient'), { code: 1 }), OCR_OUTPUT);
    await expect(recognizeResumePdf(Buffer.from('pdf'), 1)).resolves.toEqual({ text: 'Example', pages: 1 });
    expect(execute.mock.calls.map(([tool]) => tool)).toEqual(['pdftoppm', 'tesseract', 'tesseract']);
    const limits = execute.mock.calls.map(([, , options]) => options.timeout as number);
    expect(limits[0]).toBeLessThanOrEqual(15_000);
    expect(limits[2]).toBeLessThanOrEqual(limits[1]);
    expect(limits[1]).toBeLessThanOrEqual(limits[0]);
    expect(execute.mock.calls.every(([, , options]) => options.killSignal === 'SIGKILL')).toBe(true);
  });

  it.each([
    [Object.assign(new Error('synthetic secret'), { killed: true }), 'timeout'],
    [Object.assign(new Error('synthetic secret'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'resource'],
  ])('stops this document after a tool limit is hit', async (error, kind) => {
    simulateToolResponses('image', error);
    await expect(recognizeResumePdf(Buffer.from('pdf'), 2)).rejects.toThrow(`PDF page 1: Resume OCR tesseract ${kind}`);
    expect(execute.mock.calls.map(([tool]) => tool)).toEqual(['pdftoppm', 'tesseract']);
  });

  it('rejects an overlong document before launching tools', async () => {
    await expect(recognizeResumePdf(Buffer.from('pdf'), 13)).rejects.toThrow('up to 12 pages');
    expect(execute).not.toHaveBeenCalled();
  });
});
