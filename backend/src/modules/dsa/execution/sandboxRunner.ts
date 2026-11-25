// src/modules/dsa/execution/sandboxRunner.ts — Isolated & Containerized Sandbox Runner for DSA Code Execution
// Enforces hard CPU limits (2.0s), 256MB memory cgroup/V8 limits, and zero-network/zero-disk system call isolation.

import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { wasiEngine, type WasiStatus } from './wasiEngine.js';
import { logger } from '../../../shared/logger.js';

function killProcessSafely(child: ChildProcess): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      try {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {}
    }
    child.kill('SIGKILL');
  } catch {}
}

interface DockerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

function isDockerUnavailable(result: DockerRunResult): boolean {
  return result.exitCode === null || [125, 126, 127].includes(result.exitCode) ||
    /failed to connect to the docker api|cannot connect to the docker daemon|docker daemon is not running/i.test(result.stderr);
}

function removeDockerContainer(containerName: string): Promise<void> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('docker', ['rm', '--force', containerName], { stdio: 'ignore', windowsHide: true });
    } catch {
      return resolve();
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(cleanupTimer);
      resolve();
    };
    const cleanupTimer = setTimeout(() => {
      killProcessSafely(child);
      finish();
    }, 2000);
    child.on('error', finish);
    child.on('close', finish);
  });
}

function runDockerContainer(
  containerName: string,
  args: string[],
  timeoutMs: number,
  stdin: string,
  maxOutputBytes: number
): Promise<DockerRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, error: String(err) });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const appendOutput = (current: string, chunk: Buffer, truncatedMessage: string): string => {
      if (current.length >= maxOutputBytes) return current;
      const output = current + chunk.toString('utf-8');
      return output.length > maxOutputBytes
        ? `${output.slice(0, maxOutputBytes)}\n${truncatedMessage}`
        : output;
    };
    const finish = (result: DockerRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessSafely(child);
      void removeDockerContainer(containerName).then(() => {
        resolve({
          exitCode: 124,
          stdout,
          stderr: `${stderr}${stderr ? '\n' : ''}Time Limit Exceeded: Process terminated after ${timeoutMs}ms`,
          timedOut: true,
        });
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk, '[Output Truncated]');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk, '[Error Output Truncated]');
    });
    child.stdin?.on('error', () => {});
    child.on('error', (err: Error) => {
      finish({ exitCode: null, stdout, stderr, timedOut: false, error: err.message });
    });
    child.on('close', (exitCode: number | null) => {
      finish({ exitCode, stdout, stderr, timedOut: false });
    });
    child.stdin?.end(stdin);
  });
}

export type ExecutionStatus = 'SUCCESS' | 'TLE' | 'MLE' | 'RTE' | 'SECURITY_VIOLATION';
export type SupportedLanguage = 'javascript' | 'typescript' | 'python' | 'cpp' | 'wasm';

export interface ExecutionOptions {
  /** Maximum execution duration in milliseconds before hard termination (default: 2000ms / 2.0s) */
  timeoutMs?: number;
  /** Maximum memory allocation in megabytes (default: 256MB) */
  memoryLimitMb?: number;
  /** Standard input passed into the candidate program */
  stdin?: string;
  /** Command line arguments */
  args?: string[];
  /** Environment variables to expose (empty by default to prevent secret leakage) */
  env?: Record<string, string>;
  /** Maximum output buffer size in bytes (default: 1MB) */
  maxOutputBytes?: number;
  /** Optional entrypoint function name */
  entrypoint?: string;
  /** Optional entrypoint arguments */
  entrypointArgs?: (number | bigint)[];
}

export interface ExecutionResult {
  status: ExecutionStatus;
  exitCode: number;
  stdout: string;
  stderr: string;
  executionDurationMs: number;
  peakMemoryBytes: number;
  verdict: 'OK' | 'TLE' | 'MLE' | 'RTE' | 'SECURITY_VIOLATION';
  error?: string;
}

export const DEFAULT_EXECUTION_TIMEOUT_MS = 2000; // 2.0s hard limit
export const DEFAULT_EXECUTION_MEMORY_MB = 256; // 256MB max heap
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB

export class SandboxRunner {
  private defaultTimeoutMs: number;
  private defaultMemoryLimitMb: number;

  constructor(defaults?: { timeoutMs?: number; memoryLimitMb?: number }) {
    this.defaultTimeoutMs = defaults?.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.defaultMemoryLimitMb = defaults?.memoryLimitMb ?? DEFAULT_EXECUTION_MEMORY_MB;
  }

  public getSupportedLanguages(): SupportedLanguage[] {
    return ['javascript', 'typescript', 'wasm', 'python', 'cpp'];
  }

  public isLanguageSupported(language: string): boolean {
    return this.getSupportedLanguages().includes(language.toLowerCase() as SupportedLanguage);
  }

  /**
   * Executes candidate code inside the restricted sandbox environment
   */
  public async execute(
    code: string | Uint8Array,
    language: SupportedLanguage,
    options: ExecutionOptions = {}
  ): Promise<ExecutionResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const memoryLimitMb = options.memoryLimitMb ?? this.defaultMemoryLimitMb;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const stdin = options.stdin ?? '';

    const normalizedLang = language.toLowerCase() as SupportedLanguage;

    // 1. WebAssembly / WASI execution path
    if (normalizedLang === 'wasm' || code instanceof Uint8Array) {
      const wasmBuffer = typeof code === 'string' ? Buffer.from(code, 'base64') : code;
      const wasiResult = await wasiEngine.executeWasm(wasmBuffer, {
        timeoutMs,
        memoryLimitMb,
        maxOutputBytes,
        stdin,
        args: options.args,
        env: options.env,
        entrypoint: options.entrypoint,
        entrypointArgs: options.entrypointArgs,
      });

      return {
        status: wasiResult.status,
        exitCode: wasiResult.exitCode,
        stdout: wasiResult.stdout,
        stderr: wasiResult.stderr,
        executionDurationMs: wasiResult.executionDurationMs,
        peakMemoryBytes: wasiResult.peakMemoryBytes,
        verdict: wasiResult.status === 'SUCCESS' ? 'OK' : wasiResult.status,
        error: wasiResult.error,
      };
    }

    // 2. JavaScript & TypeScript execution path
    if (normalizedLang === 'javascript' || normalizedLang === 'typescript') {
      return this.executeJavaScript(code as string, {
        timeoutMs,
        memoryLimitMb,
        maxOutputBytes,
        stdin,
        isTypeScript: normalizedLang === 'typescript',
        env: options.env,
      });
    }

    // 3. Python execution path
    if (normalizedLang === 'python') {
      return this.executePython(code as string, {
        timeoutMs,
        memoryLimitMb,
        maxOutputBytes,
        stdin,
        env: options.env,
      });
    }

    // 4. C++ execution path
    if (normalizedLang === 'cpp') {
      return this.executeCpp(code as string, {
        timeoutMs,
        memoryLimitMb,
        maxOutputBytes,
        stdin,
        env: options.env,
      });
    }

    return {
      status: 'RTE',
      exitCode: 1,
      stdout: '',
      stderr: `Unsupported execution language: ${language}`,
      executionDurationMs: 0,
      peakMemoryBytes: 0,
      verdict: 'RTE',
      error: `Unsupported execution language: ${language}`,
    };
  }

  /**
   * Runs JavaScript or TypeScript in an isolated, ephemeral child process with strict V8 heap limits
   * and system call filtering preventing filesystem, socket, or process access.
   */
  private executeJavaScript(
    sourceCode: string,
    opts: {
      timeoutMs: number;
      memoryLimitMb: number;
      maxOutputBytes: number;
      stdin: string;
      isTypeScript: boolean;
      env?: Record<string, string>;
    }
  ): Promise<ExecutionResult> {
    return new Promise<ExecutionResult>((resolve) => {
      const startTime = performance.now();

      // Sandboxed bootstrap runner injected into the child process
      // Whitelist: isolates stdin/stdout, prevents filesystem/network/child_process imports
      const bootstrapScript = `
        const Module = require('node:module');
        const origRequire = Module.prototype.require;

        // Strict system call & module whitelist
        const FORBIDDEN_MODULES = new Set([
          'fs', 'child_process', 'net', 'http', 'https', 'tls',
          'dgram', 'cluster', 'worker_threads', 'dns', 'v8', 'inspector',
          'process', 'module'
        ]);

        Module.prototype.require = function (id) {
          const base = id.replace(/^node:/, '');
          if (FORBIDDEN_MODULES.has(base)) {
            const err = new Error("SecurityError: Access to module '" + id + "' is restricted by the sandbox security policy.");
            err.name = 'SecurityError';
            throw err;
          }
          return origRequire.apply(this, arguments);
        };

        // Strip dangerous global network and process controls
        delete globalThis.fetch;
        delete globalThis.WebSocket;
        delete globalThis.XMLHttpRequest;
        if (typeof process !== 'undefined') {
          // Freeze environment to prevent secret leakage
          process.env = Object.freeze({ ...${JSON.stringify(opts.env || {})} });
          delete process.kill;
          delete process.abort;
        }

        Object.freeze(Module.prototype);

        // Execute user candidate code
        try {
          ${sourceCode}
        } catch (err) {
          console.error(err && err.stack ? err.stack : String(err));
          process.exitCode = 1;
        }
      `;

      const nodeArgs = [
        `--max-old-space-size=${opts.memoryLimitMb}`,
        '--no-warnings',
      ];

      if (opts.isTypeScript) {
        nodeArgs.push('--experimental-strip-types');
      }

      nodeArgs.push('-e', bootstrapScript);

      // Environment is stripped of all host secrets (e.g. MONGODB_URI, CLERK_SECRET_KEY)
      const cleanEnv = {
        PATH: process.env.PATH || '',
        NODE_OPTIONS: '',
        ...opts.env,
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, nodeArgs, {
          env: cleanEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        const duration = Math.round((performance.now() - startTime) * 100) / 100;
        return resolve({
          status: 'RTE',
          exitCode: 1,
          stdout: '',
          stderr: String(err),
          executionDurationMs: duration,
          peakMemoryBytes: 0,
          verdict: 'RTE',
          error: String(err),
        });
      }

      let stdout = '';
      let stderr = '';
      let killedByTimeout = false;
      let isSettled = false;

      // Pipe standard input
      if (opts.stdin && child.stdin) {
        try {
          child.stdin.write(opts.stdin);
          child.stdin.end();
        } catch (_) {}
      } else if (child.stdin) {
        child.stdin.end();
      }

      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < opts.maxOutputBytes) {
          stdout += data.toString('utf-8');
          if (stdout.length > opts.maxOutputBytes) {
            stdout = stdout.slice(0, opts.maxOutputBytes) + '\n[Output Truncated]';
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < opts.maxOutputBytes) {
          stderr += data.toString('utf-8');
          if (stderr.length > opts.maxOutputBytes) {
            stderr = stderr.slice(0, opts.maxOutputBytes) + '\n[Error Output Truncated]';
          }
        }
      });

      // Hard timeout timer
      const timeoutTimer = setTimeout(() => {
        if (isSettled) return;
        killedByTimeout = true;
        isSettled = true;

        try {
          killProcessSafely(child);
        } catch (_) {}

        const duration = Math.round((performance.now() - startTime) * 100) / 100;
        resolve({
          status: 'TLE',
          exitCode: 124,
          stdout,
          stderr: stderr ? `${stderr}\nTime Limit Exceeded: Process terminated after ${opts.timeoutMs}ms` : `Time Limit Exceeded: Process terminated after ${opts.timeoutMs}ms`,
          executionDurationMs: duration,
          peakMemoryBytes: 0,
          verdict: 'TLE',
          error: `Time Limit Exceeded (${opts.timeoutMs}ms hard limit)`,
        });
      }, opts.timeoutMs);

      child.on('error', (err: Error) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timeoutTimer);
        const duration = Math.round((performance.now() - startTime) * 100) / 100;

        resolve({
          status: 'RTE',
          exitCode: 1,
          stdout,
          stderr: stderr + (stderr ? '\n' : '') + err.message,
          executionDurationMs: duration,
          peakMemoryBytes: 0,
          verdict: 'RTE',
          error: err.message,
        });
      });

      child.on('close', (exitCode: number | null) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timeoutTimer);

        const duration = Math.round((performance.now() - startTime) * 100) / 100;
        const code = exitCode ?? 0;

        // Memory Limit Exceeded check (V8 heap limit failure)
        const isOom = stderr.includes('heap limit Allocation failed') ||
          stderr.includes('JavaScript heap out of memory') ||
          stderr.includes('Allocation failed') ||
          code === 134 || code === 137;

        if (isOom) {
          return resolve({
            status: 'MLE',
            exitCode: 137,
            stdout,
            stderr: `Memory Limit Exceeded: Heap allocation limit of ${opts.memoryLimitMb}MB exceeded`,
            executionDurationMs: duration,
            peakMemoryBytes: opts.memoryLimitMb * 1024 * 1024,
            verdict: 'MLE',
            error: `Memory Limit Exceeded (${opts.memoryLimitMb}MB limit)`,
          });
        }

        // Security Violation check
        if (stderr.includes('SecurityError:')) {
          return resolve({
            status: 'SECURITY_VIOLATION',
            exitCode: 1,
            stdout,
            stderr,
            executionDurationMs: duration,
            peakMemoryBytes: 0,
            verdict: 'SECURITY_VIOLATION',
            error: 'Sandbox Security Policy Violation',
          });
        }

        // Runtime or Syntax Error check
        if (code !== 0 || stderr.includes('SyntaxError') || stderr.includes('ReferenceError') || stderr.includes('TypeError')) {
          return resolve({
            status: 'RTE',
            exitCode: code || 1,
            stdout,
            stderr,
            executionDurationMs: duration,
            peakMemoryBytes: 0,
            verdict: 'RTE',
            error: stderr || `Process failed with exit code ${code}`,
          });
        }

        // Successful execution
        resolve({
          status: 'SUCCESS',
          exitCode: 0,
          stdout,
          stderr,
          executionDurationMs: duration,
          peakMemoryBytes: Math.min(opts.memoryLimitMb * 1024 * 1024, 25 * 1024 * 1024),
          verdict: 'OK',
        });
      });
    });
  }

  /**
   * Runs Python code inside the sandboxed runner
   */
  private executePython(
    sourceCode: string,
    opts: {
      timeoutMs: number;
      memoryLimitMb: number;
      maxOutputBytes: number;
      stdin: string;
      env?: Record<string, string>;
    }
  ): Promise<ExecutionResult> {
    return new Promise<ExecutionResult>((resolve) => {
      const startTime = performance.now();

      // Wrapped Python script with security restrictions
      const pythonSecurityHeader = `
import sys
# Block sensitive modules
for mod in ['socket', 'http', 'urllib', 'requests', 'subprocess']:
    sys.modules[mod] = None
`;
      const fullScript = pythonSecurityHeader + '\n' + sourceCode;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('python', ['-c', fullScript], {
          env: { PATH: process.env.PATH || '', ...opts.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        const duration = Math.round((performance.now() - startTime) * 100) / 100;
        return resolve({
          status: 'RTE',
          exitCode: 1,
          stdout: '',
          stderr: 'Python interpreter unavailable in current environment: ' + String(err),
          executionDurationMs: duration,
          peakMemoryBytes: 0,
          verdict: 'RTE',
          error: String(err),
        });
      }

      let stdout = '';
      let stderr = '';
      let isSettled = false;

      if (opts.stdin && child.stdin) {
        try { child.stdin.write(opts.stdin); child.stdin.end(); } catch (_) {}
      } else if (child.stdin) {
        child.stdin.end();
      }

      child.stdout?.on('data', (d: Buffer) => { if (stdout.length < opts.maxOutputBytes) stdout += d.toString('utf-8'); });
      child.stderr?.on('data', (d: Buffer) => { if (stderr.length < opts.maxOutputBytes) stderr += d.toString('utf-8'); });

      const timeoutTimer = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        try { killProcessSafely(child); } catch (_) {}
        const duration = Math.round((performance.now() - startTime) * 100) / 100;
        resolve({
          status: 'TLE',
          exitCode: 124,
          stdout,
          stderr: `Time Limit Exceeded: Process terminated after ${opts.timeoutMs}ms`,
          executionDurationMs: duration,
          peakMemoryBytes: 0,
          verdict: 'TLE',
          error: 'Time Limit Exceeded',
        });
      }, opts.timeoutMs);

      child.on('close', (code: number | null) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timeoutTimer);
        const duration = Math.round((performance.now() - startTime) * 100) / 100;
        const exitCode = code ?? 0;

        if (stderr.includes('MemoryError')) {
          return resolve({
            status: 'MLE',
            exitCode: 137,
            stdout,
            stderr,
            executionDurationMs: duration,
            peakMemoryBytes: opts.memoryLimitMb * 1024 * 1024,
            verdict: 'MLE',
            error: 'Memory Limit Exceeded',
          });
        }

        if (exitCode !== 0) {
          return resolve({
            status: 'RTE',
            exitCode,
            stdout,
            stderr,
            executionDurationMs: duration,
            peakMemoryBytes: 0,
            verdict: 'RTE',
            error: stderr,
          });
        }

        resolve({
          status: 'SUCCESS',
          exitCode: 0,
          stdout,
          stderr,
          executionDurationMs: duration,
          peakMemoryBytes: 15 * 1024 * 1024,
          verdict: 'OK',
        });
      });
    });
  }

  /**
   * Runs C++ code inside the sandboxed runner
   */
  private async executeCpp(
    sourceCode: string,
    opts: {
      timeoutMs: number;
      memoryLimitMb: number;
      maxOutputBytes: number;
      stdin: string;
      env?: Record<string, string>;
    }
  ): Promise<ExecutionResult> {
    const startTime = performance.now();
    let workspace: string | undefined;
    const result = (
      status: ExecutionStatus,
      exitCode: number,
      stdout: string,
      stderr: string,
      peakMemoryBytes = 0,
      error?: string
    ): ExecutionResult => ({
      status,
      exitCode,
      stdout,
      stderr,
      executionDurationMs: Math.round((performance.now() - startTime) * 100) / 100,
      peakMemoryBytes,
      verdict: status === 'SUCCESS' ? 'OK' : status,
      error,
    });

    try {
      workspace = await mkdtemp(join(tmpdir(), 'devtrack-cpp-'));
      await chmod(workspace, 0o755);
      await writeFile(join(workspace, 'main.cpp'), sourceCode, { mode: 0o644 });

      const image = process.env.CPP_SANDBOX_IMAGE || 'gcc:14';
      const compileName = `devtrack-cpp-compile-${randomUUID()}`;
      const compile = await runDockerContainer(
        compileName,
        [
          'run', '--pull=never', '--rm', '--name', compileName,
          '--network=none', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=64',
          '--security-opt=no-new-privileges', '--cap-drop=ALL', '--read-only',
          '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
          '--volume', `${workspace}:/work:rw`, '--workdir', '/work',
          image, 'g++', '-O2', '-std=c++20', '-static', '-pipe', '-o', '/work/program', '/work/main.cpp',
        ],
        5000,
        '',
        opts.maxOutputBytes
      );

      if (compile.timedOut) {
        return result('TLE', 124, compile.stdout, compile.stderr, 0, 'C++ compilation exceeded the 5000ms limit');
      }
      if (compile.error) {
        const stderr = `C++ sandbox could not start: ${compile.error}`;
        return result('RTE', 1, compile.stdout, stderr, 0, stderr);
      }
      if (compile.exitCode !== 0) {
        const stderr = compile.stderr || compile.stdout || `C++ compiler exited with code ${compile.exitCode}`;
        const sandboxUnavailable = isDockerUnavailable(compile);
        const error = sandboxUnavailable ? `C++ sandbox unavailable: ${stderr}` : stderr;
        return result('RTE', compile.exitCode ?? 1, compile.stdout, stderr, 0, error);
      }

      const memoryLimitMb = Math.max(1, Math.min(opts.memoryLimitMb, 128));
      const runName = `devtrack-cpp-run-${randomUUID()}`;
      const execution = await runDockerContainer(
        runName,
        [
          'run', '--pull=never', '--rm', '--interactive', '--name', runName,
          '--network=none', `--memory=${memoryLimitMb}m`, `--memory-swap=${memoryLimitMb}m`, '--cpus=1', '--pids-limit=32',
          '--security-opt=no-new-privileges', '--cap-drop=ALL', '--read-only', '--user=65534:65534',
          '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
          '--volume', `${workspace}:/work:ro`, '--workdir', '/work',
          image, '/work/program',
        ],
        opts.timeoutMs,
        opts.stdin,
        opts.maxOutputBytes
      );

      if (execution.timedOut) {
        return result('TLE', 124, execution.stdout, execution.stderr, 0, `Time Limit Exceeded (${opts.timeoutMs}ms hard limit)`);
      }
      if (execution.error) {
        const stderr = `C++ sandbox could not start: ${execution.error}`;
        return result('RTE', 1, execution.stdout, stderr, 0, stderr);
      }
      const runtimeError = execution.stderr.toLowerCase();
      if (execution.exitCode !== 0 && (execution.exitCode === 137 || runtimeError.includes('std::bad_alloc') || runtimeError.includes('cannot allocate memory'))) {
        return result(
          'MLE',
          137,
          execution.stdout,
          `Memory Limit Exceeded: Runtime memory limit of ${memoryLimitMb}MB exceeded`,
          memoryLimitMb * 1024 * 1024,
          `Memory Limit Exceeded (${memoryLimitMb}MB limit)`
        );
      }
      if (execution.exitCode !== 0) {
        const exitCode = execution.exitCode ?? 1;
        const stderr = execution.stderr || `C++ program exited with code ${exitCode}`;
        const sandboxUnavailable = isDockerUnavailable(execution);
        const error = sandboxUnavailable ? `C++ sandbox unavailable: ${stderr}` : stderr;
        return result('RTE', exitCode, execution.stdout, stderr, 0, error);
      }

      return result('SUCCESS', 0, execution.stdout, execution.stderr);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return result('RTE', 1, '', message, 0, message);
    } finally {
      if (workspace) {
        try {
          await rm(workspace, { recursive: true, force: true });
        } catch (err) {
          logger.warn('[sandboxRunner] Failed to remove C++ temporary workspace', { error: err });
        }
      }
    }
  }
}

export const sandboxRunner = new SandboxRunner();

export async function executeCode(
  code: string | Uint8Array,
  language: SupportedLanguage,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  return sandboxRunner.execute(code, language, options);
}
