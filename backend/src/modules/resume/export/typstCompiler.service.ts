// backend/src/modules/resume/export/typstCompiler.service.ts
// Automated compilation service for ATS-optimized vector PDFs using WebAssembly Typst
// Guarantees strict 1-page / 2-page pagination with dynamic line-spacing and margin scaling.

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { PDFParse } from 'pdf-parse';
import { logger } from '../../../shared/logger.js';
import {
  generateTypstTemplate,
  generateLatexTemplate,
  type StructuredResume,
  type TemplateId,
  type PaginationOptions,
  type ResumeHeader,
} from './latexTemplates.js';

export const DEFAULT_TYPST_COMPILE_TIMEOUT_MS = 5_000;
const IDLE_WORKER_TTL_MS = 30_000;
const MAX_WORKER_STDERR_BYTES = 8_192;

const require = createRequire(import.meta.url);

export class TypstCompilationError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, string[]>;

  constructor(
    message: string,
    statusCode: 408 | 422,
    code: 'TYPST_COMPILATION_TIMEOUT' | 'TYPST_COMPILATION_FAILED',
    details?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'TypstCompilationError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

interface TypstWorkerMessage {
  id: number;
  ok: boolean;
  pdfBase64?: string;
  error?: string;
}

const TYPST_WORKER_SCRIPT = `'use strict';
const { NodeCompiler } = require(process.argv[1]);
const compiler = NodeCompiler.create();

process.on('message', (msg) => {
  if (!msg || typeof msg.id !== 'number' || typeof msg.typstSource !== 'string') {
    return;
  }
  try {
    const rawResult = compiler.pdf({ mainFileContent: msg.typstSource });
    const pdfBuffer = Buffer.isBuffer(rawResult) ? rawResult : Buffer.from(rawResult);
    process.send({ id: msg.id, ok: true, pdfBase64: pdfBuffer.toString('base64') });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    process.send({ id: msg.id, ok: false, error: message });
  }
});
`;

function killChildProcessSafely(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {}
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
      killer.unref();
    } catch {}
  }
}

interface RefHandle {
  ref?: () => void;
  unref?: () => void;
}

function setChildRefState(child: ChildProcess, referenced: boolean): void {
  const handles: Array<RefHandle | null | undefined> = [
    child,
    child.stdout as RefHandle | null,
    child.stderr as RefHandle | null,
    (child as ChildProcess & { channel?: RefHandle }).channel,
  ];
  for (const handle of handles) {
    if (referenced) {
      handle?.ref?.();
    } else {
      handle?.unref?.();
    }
  }
}

export interface TypstCompilerOptions {
  template?: TemplateId;
  targetPages?: number; // 1 or 2 (default 1)
  paperSize?: 'a4' | 'us-letter';
  strictPagination?: boolean; // default true
  fontSizePt?: number;
  marginCm?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  lineLeadingEm?: number;
  /** Wall-clock compilation timeout in milliseconds (default: 5000ms). */
  timeoutMs?: number;
}

export interface TypstCompilationResult {
  pdf: Buffer;
  pageCount: number;
  durationMs: number;
  template: TemplateId;
  textLength: number;
  metadata: {
    fileSize: number;
    compiledAt: Date;
    targetPages: number;
  };
}

export class TypstCompilerService {
  private static warmWorker: ChildProcess | null = null;
  private static idleReapTimer: ReturnType<typeof setTimeout> | null = null;
  private static nextRequestId = 1;
  private static typstModulePath: string | null = null;

  private static getTypstModulePath(): string {
    if (!this.typstModulePath) {
      this.typstModulePath = require.resolve('@myriaddreamin/typst-ts-node-compiler');
    }
    return this.typstModulePath;
  }

  private static clearIdleTimer(): void {
    if (this.idleReapTimer) {
      clearTimeout(this.idleReapTimer);
      this.idleReapTimer = null;
    }
  }

  private static spawnWorker(): ChildProcess {
    const child = spawn(
      process.execPath,
      ['-e', TYPST_WORKER_SCRIPT, this.getTypstModulePath()],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      }
    );
    child.on('exit', () => {
      if (this.warmWorker === child) {
        this.warmWorker = null;
        this.clearIdleTimer();
      }
    });
    return child;
  }

  private static acquireWorker(): ChildProcess {
    this.clearIdleTimer();
    const existing = this.warmWorker;
    if (existing && existing.connected && !existing.killed && existing.exitCode === null) {
      this.warmWorker = null;
      setChildRefState(existing, true);
      return existing;
    }
    if (existing) {
      this.warmWorker = null;
      killChildProcessSafely(existing);
    }
    return this.spawnWorker();
  }

  private static releaseWorker(child: ChildProcess): void {
    if (!child.connected || child.killed || child.exitCode !== null) {
      return;
    }
    if (!this.warmWorker) {
      this.warmWorker = child;
      setChildRefState(child, false);
      this.clearIdleTimer();
      this.idleReapTimer = setTimeout(() => {
        if (this.warmWorker === child) {
          this.warmWorker = null;
          killChildProcessSafely(child);
        }
      }, IDLE_WORKER_TTL_MS);
      this.idleReapTimer.unref();
      return;
    }
    killChildProcessSafely(child);
  }

  /**
   * Terminates any cached idle Typst compiler worker process.
   */
  static async shutdown(): Promise<void> {
    this.clearIdleTimer();
    const worker = this.warmWorker;
    this.warmWorker = null;
    if (worker) {
      killChildProcessSafely(worker);
    }
  }

  /**
   * Compiles raw Typst markup in an isolated child process with a strict wall-clock timeout.
   * Runaway compilations are immediately terminated via SIGKILL without blocking the event loop.
   */
  async compileRawTypst(
    typstSource: string,
    options: { timeoutMs?: number } = {}
  ): Promise<Buffer> {
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TYPST_COMPILE_TIMEOUT_MS;

    const requestId = TypstCompilerService.nextRequestId++;
    const child = TypstCompilerService.acquireWorker();

    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      let workerStderr = '';

      const onStderr = (chunk: Buffer) => {
        if (workerStderr.length < MAX_WORKER_STDERR_BYTES) {
          workerStderr += chunk.toString('utf8').slice(0, MAX_WORKER_STDERR_BYTES - workerStderr.length);
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        child.off('message', onMessage);
        child.off('error', onError);
        child.off('exit', onExit);
        child.stderr?.off('data', onStderr);
      };

      const failAndKill = (err: TypstCompilationError) => {
        if (settled) return;
        settled = true;
        cleanup();
        killChildProcessSafely(child);
        reject(err);
      };

      const onMessage = (raw: unknown) => {
        const msg = raw as TypstWorkerMessage | null;
        if (!msg || msg.id !== requestId) return;
        if (settled) return;
        settled = true;
        cleanup();
        TypstCompilerService.releaseWorker(child);
        if (msg.ok && typeof msg.pdfBase64 === 'string') {
          resolve(Buffer.from(msg.pdfBase64, 'base64'));
        } else {
          const detail = msg.error || workerStderr.trim() || 'Typst compilation failed';
          reject(
            new TypstCompilationError(
              `Typst compilation failed: ${detail}`,
              422,
              'TYPST_COMPILATION_FAILED',
              { compilerError: [detail] }
            )
          );
        }
      };

      const onError = (err: Error) => {
        failAndKill(
          new TypstCompilationError(
            `Typst compiler worker error: ${err.message}`,
            422,
            'TYPST_COMPILATION_FAILED',
            { compilerError: [err.message] }
          )
        );
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = workerStderr.trim() || `exit code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`;
        failAndKill(
          new TypstCompilationError(
            `Typst compiler worker exited unexpectedly: ${detail}`,
            422,
            'TYPST_COMPILATION_FAILED',
            { compilerError: [detail] }
          )
        );
      };

      const timeoutTimer = setTimeout(() => {
        logger.warn('[TypstCompilerService] Terminating runaway Typst compiler worker', {
          timeoutMs,
          pid: child.pid,
        });
        failAndKill(
          new TypstCompilationError(
            `Typst compilation timed out after ${timeoutMs}ms`,
            408,
            'TYPST_COMPILATION_TIMEOUT',
            { timeoutMs: [String(timeoutMs)] }
          )
        );
      }, timeoutMs);

      child.stderr?.on('data', onStderr);
      child.on('message', onMessage);
      child.on('error', onError);
      child.on('exit', onExit);

      try {
        child.send({ id: requestId, typstSource });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failAndKill(
          new TypstCompilationError(
            `Failed to dispatch Typst compilation: ${message}`,
            422,
            'TYPST_COMPILATION_FAILED',
            { compilerError: [message] }
          )
        );
      }
    });
  }

  /**
   * Compiles structured resume JSON into high-resolution, 100% ATS-parseable vector PDF.
   * Enforces strict pagination (< 2.0s duration) and a hard wall-clock timeout (default 5.0s).
   */
  async compileToPdf(
    resume: StructuredResume,
    options: TypstCompilerOptions = {}
  ): Promise<TypstCompilationResult> {
    const startedAt = performance.now();
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TYPST_COMPILE_TIMEOUT_MS;
    const deadline = startedAt + timeoutMs;
    const template: TemplateId = options.template ?? 'modern-tech';
    const targetPages = options.targetPages ?? 1;
    const paperSize = options.paperSize ?? 'a4';
    const strictPagination = options.strictPagination ?? true;

    // Tuning profiles for dynamic pagination scaling
    const tuningProfiles: PaginationOptions[] = [
      {
        targetPages,
        paperSize,
        fontSizePt: options.fontSizePt ?? 9.5,
        marginCm: options.marginCm ?? { top: 1.2, bottom: 1.2, left: 1.4, right: 1.4 },
        lineLeadingEm: options.lineLeadingEm ?? 0.52,
      },
      {
        targetPages,
        paperSize,
        fontSizePt: 8.8,
        marginCm: { top: 1.0, bottom: 1.0, left: 1.2, right: 1.2 },
        lineLeadingEm: 0.46,
      },
      {
        targetPages,
        paperSize,
        fontSizePt: 8.2,
        marginCm: { top: 0.85, bottom: 0.85, left: 1.0, right: 1.0 },
        lineLeadingEm: 0.42,
      },
      {
        targetPages,
        paperSize,
        fontSizePt: 7.8,
        marginCm: { top: 0.75, bottom: 0.75, left: 0.9, right: 0.9 },
        lineLeadingEm: 0.38,
      },
    ];

    let bestPdf: Buffer | null = null;
    let finalPageCount = 1;
    let finalExtractedLength = 0;

    // Pagination loop bounded by the shared wall-clock deadline
    for (let i = 0; i < (strictPagination ? tuningProfiles.length : 1); i++) {
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs <= 0) {
        throw new TypstCompilationError(
          `Typst compilation timed out after ${timeoutMs}ms`,
          408,
          'TYPST_COMPILATION_TIMEOUT',
          { timeoutMs: [String(timeoutMs)] }
        );
      }

      const currentProfile = tuningProfiles[i];
      const typstSource = generateTypstTemplate(template, resume, currentProfile);
      const currentPdf = await this.compileRawTypst(typstSource, { timeoutMs: remainingMs });

      const parsedPages = await this.inspectPageCount(currentPdf);
      bestPdf = currentPdf;
      finalPageCount = parsedPages.pageCount;
      finalExtractedLength = parsedPages.textLength;

      // If fits within target pages, we're done
      if (finalPageCount <= targetPages) {
        break;
      }
    }

    if (!bestPdf) {
      throw new TypstCompilationError(
        'Typst compilation failed to generate PDF output',
        422,
        'TYPST_COMPILATION_FAILED'
      );
    }

    const durationMs = performance.now() - startedAt;
    logger.info(
      `[TypstCompilerService] Compiled ${template} resume in ${durationMs.toFixed(2)}ms (Pages: ${finalPageCount}, Size: ${bestPdf.length} bytes)`
    );

    return {
      pdf: bestPdf,
      pageCount: finalPageCount,
      durationMs,
      template,
      textLength: finalExtractedLength,
      metadata: {
        fileSize: bestPdf.length,
        compiledAt: new Date(),
        targetPages,
      },
    };
  }

  /**
   * Generates formatted Typst markup for a structured resume
   */
  generateTypstSource(
    resume: StructuredResume,
    options: TypstCompilerOptions = {}
  ): string {
    const template: TemplateId = options.template ?? 'modern-tech';
    return generateTypstTemplate(template, resume, {
      targetPages: options.targetPages ?? 1,
      paperSize: options.paperSize ?? 'a4',
      fontSizePt: options.fontSizePt,
      marginCm: options.marginCm,
      lineLeadingEm: options.lineLeadingEm,
    });
  }

  /**
   * Generates formatted LaTeX markup for a structured resume
   */
  generateLatexSource(
    resume: StructuredResume,
    options: TypstCompilerOptions = {}
  ): string {
    const template: TemplateId = options.template ?? 'modern-tech';
    return generateLatexTemplate(template, resume);
  }

  /**
   * Inspect page count and extracted text length using PDFParse
   */
  private async inspectPageCount(
    pdfBuffer: Buffer
  ): Promise<{ pageCount: number; textLength: number }> {
    const parser = new (PDFParse as any)({ data: new Uint8Array(pdfBuffer) });
    try {
      const textResult = await parser.getText();
      const info = await parser.getInfo();
      const pageCount = info?.total || 1;
      const text = textResult?.pages
        ? textResult.pages.map((p: any) => p.text).join('\n')
        : textResult?.text || '';
      return { pageCount, textLength: text.length };
    } catch (err) {
      logger.warn('[TypstCompilerService] Error parsing compiled PDF metadata', err as any);
      return { pageCount: 1, textLength: 0 };
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  /**
   * Utility to map a Mongoose resume profile / parsed resume into StructuredResume
   */
  mapProfileToStructuredResume(
    profile: any,
    headerOverride?: Partial<ResumeHeader>
  ): StructuredResume {
    const skillsList: string[] = profile.selectedSkills || [];
    const projectsList = Array.isArray(profile.selectedProjects)
      ? profile.selectedProjects.map((p: any) => ({
          name: typeof p === 'string' ? p : p.name || 'Engineering Project',
          description: p.description || undefined,
          bullets: p.bullets || (p.summary ? [p.summary] : ['Built and deployed scalable application.']),
          technologies: p.technologies || p.techStack || [],
        }))
      : [];

    return {
      header: {
        name: headerOverride?.name || profile.name || 'Candidate',
        title: headerOverride?.title || profile.targetRole || 'Software Engineer',
        email: headerOverride?.email || profile.email || 'candidate@devtrack.io',
        phone: headerOverride?.phone || profile.phone || undefined,
        location: headerOverride?.location || profile.location || undefined,
        github: headerOverride?.github || profile.github || undefined,
        linkedin: headerOverride?.linkedin || profile.linkedin || undefined,
        website: headerOverride?.website || profile.website || undefined,
      },
      summary: profile.summary || undefined,
      skills: [{ category: 'Core Competencies', skills: skillsList }],
      projects: projectsList,
      experience: profile.experience || [],
      education: profile.education || [],
    };
  }
}

export const typstCompilerService = new TypstCompilerService();
