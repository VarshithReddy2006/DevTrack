import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { layoutPageToText, type PositionedTextItem } from './pdf-layout.js';

const PAGE_TIMEOUT_MS = 15_000;
const MAX_PAGES = 12;
const MAX_IMAGE_DIMENSION = 2_400;
const MAX_IMAGE_BYTES = MAX_IMAGE_DIMENSION ** 2 + 1_024;
const MAX_TSV_BYTES = 1024 * 1024;
export const OCR_WORD_THRESHOLD = 50;

export function countResumeWords(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu)?.length ?? 0;
}

/** Tesseract can emit separate words for the same printed line. Preserve large gaps. */
export function orderTesseractText(tsv: string): string {
  const rows = new Map<string, PositionedTextItem[]>();
  for (const record of tsv.split(/\r?\n/)) {
    const [level, page, block, paragraph, line, , left, top, width, height, , ...words] = record.split('\t');
    const str = words.join(' ').trim();
    if (level !== '5' || !str) continue;
    const [x, y, w, h] = [left, top, width, height].map(Number);
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0
      || x + w > MAX_IMAGE_DIMENSION || y + h > MAX_IMAGE_DIMENSION) continue;
    const key = `${page}:${block}:${paragraph}:${line}`;
    const bucket = rows.get(key) ?? [];
    bucket.push({ str, x, y, width: w, height: h });
    rows.set(key, bucket);
  }

  const spans: PositionedTextItem[] = [];
  for (const row of rows.values()) {
    let previous: PositionedTextItem | undefined;
    for (const { str, x, y, width, height } of row.sort((a, b) => a.x - b.x)) {
      if (previous && x - previous.x - previous.width <= 2 * Math.max(height, previous.height)) {
        previous.str += ` ${str}`;
        previous.width = Math.max(previous.width, x + width - previous.x);
        previous.y = Math.min(y, previous.y);
        previous.height = Math.max(height, previous.height);
      } else {
        previous = { str, x, y, width, height };
        spans.push(previous);
      }
    }
  }

  // The renderer uses pixels. Normalize to approximately the scale of PDF points.
  const items = spans.map(({ str, x, y, width, height }) => ({
    str, x: x / 3, y: y / 3, width: width / 3, height: height / 3,
  }));
  return layoutPageToText(items) ?? spans
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(span => span.str).join('\n');
}

class OcrToolError extends Error {
  constructor(readonly tool: string, readonly kind: 'timeout' | 'unavailable' | 'resource' | 'failed') {
    super(`Resume OCR ${tool} ${kind}`);
  }
}

function runTool(
  tool: string,
  args: string[],
  input: Buffer,
  deadline: number,
  maxBuffer: number,
): Promise<Buffer> {
  const timeout = Math.floor(deadline - performance.now());
  if (timeout <= 0) return Promise.reject(new OcrToolError(tool, 'timeout'));
  return new Promise((resolve, reject) => {
    const child = execFile(tool, args, {
      encoding: 'buffer', timeout, maxBuffer, killSignal: 'SIGKILL',
      env: {
        PATH: process.env.PATH,
        TESSDATA_PREFIX: process.env.TESSDATA_PREFIX,
        OMP_THREAD_LIMIT: '1',
      },
    }, (error, stdout) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      // Child errors may include stdout/stderr derived from the uploaded resume.
      const kind = error.code === 'ENOENT' ? 'unavailable'
        : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'resource'
        : error.killed ? 'timeout'
        : error.signal === 'SIGKILL' || error.signal === 'SIGABRT' ? 'resource'
        : 'failed';
      reject(new OcrToolError(tool, kind));
    });
    child.stdin?.on('error', () => { /* The child exit determines the sanitized failure. */ });
    child.stdin?.end(input);
  });
}

export class NonRetryableResumeOcrError extends Error {}

export interface ResumeOcrResult {
  text: string;
  pages: number;
}

export async function recognizeResumePdf(pdf: Buffer, pageCount: number): Promise<ResumeOcrResult> {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) {
    throw new NonRetryableResumeOcrError(`Resume OCR supports up to ${MAX_PAGES} pages. Upload a shorter PDF or a text-based export.`);
  }

  const output: string[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const deadline = performance.now() + PAGE_TIMEOUT_MS;
    const pageNumber = String(page);
    const renderArgs = ['-f', pageNumber, '-l', pageNumber, '-singlefile', '-gray', '-scale-to', String(MAX_IMAGE_DIMENSION), '-'];
    try {
      const image = await runTool('pdftoppm', renderArgs, pdf, deadline, MAX_IMAGE_BYTES);
      const args = ['stdin', 'stdout', '-l', 'eng', '--psm', '3', 'tsv'];
      const recognize = () => runTool('tesseract', args, image, deadline, MAX_TSV_BYTES);
      const tsv = await recognize().catch((error: OcrToolError) => {
        if (error.kind !== 'failed') throw error;
        return recognize();
      });
      output.push(orderTesseractText(tsv.toString('utf8')));
    } catch (error) {
      // Stop this document after a resource failure or timeout, instead of starting more processes.
      const message = `Could not recognize PDF page ${page}: ${error instanceof OcrToolError ? error.message : 'resume OCR failed'}. Upload a text-based PDF if the problem persists.`;
      if (error instanceof OcrToolError && error.kind !== 'failed') {
        throw new NonRetryableResumeOcrError(message);
      }
      throw new Error(message);
    }
  }
  return { text: output.filter(Boolean).join('\n\n'), pages: pageCount };
}
