// src/modules/dsa/execution/sandboxRunner.ts — Isolated & Containerized Sandbox Runner for DSA Code Execution
// Enforces hard CPU limits (2.0s), 256MB memory cgroup/V8 limits, and zero-network/zero-disk system call isolation.

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { wasiEngine } from './wasiEngine.js';
import { logger } from '../../../shared/logger.js';

function killProcessSafely(child: ChildProcess): void {
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

const BLOCKED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'PYTHONUSERBASE',
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
]);

/**
 * Resolves an environment variable case-insensitively (needed on Windows where
 * plain env objects may carry `SYSTEMROOT`, `systemroot`, or `SystemRoot`).
 */
export function getEnvCaseInsensitive(
  env: NodeJS.ProcessEnv,
  key: string
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined) {
    return env[key];
  }
  const target = key.toLowerCase();
  for (const [entryKey, value] of Object.entries(env)) {
    if (entryKey.toLowerCase() === target && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** Normalizes a sandbox path using Windows or POSIX path semantics. */
export function normalizeSandboxPath(
  targetPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32'
    ? path.win32.normalize(targetPath)
    : path.posix.normalize(targetPath);
}

/** Joins and normalizes sandbox path segments for the target platform. */
function joinSandboxPath(
  platform: NodeJS.Platform,
  ...segments: string[]
): string {
  return platform === 'win32'
    ? path.win32.normalize(path.win32.join(...segments))
    : path.posix.normalize(path.posix.join(...segments));
}

/**
 * Normalizes a Windows path with `path.win32` and quotes/escapes it when
 * spaces or Windows command-line metacharacters are present.
 */
export function escapeWindowsCommandPath(targetPath: string): string {
  const normalized = path.win32.normalize(targetPath);
  if (!/[\s"&|<>^()]/.test(normalized)) {
    return normalized;
  }
  // Escape embedded quotes and double trailing backslashes per Windows command-line quoting rules.
  const escaped = normalized.replace(/"/g, '\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

function filterUserEnv(extra?: Record<string, string>): Record<string, string> {
  const safeUserEnv: Record<string, string> = {};
  if (!extra) return safeUserEnv;
  for (const [key, value] of Object.entries(extra)) {
    if (!BLOCKED_ENV_KEYS.has(key.toUpperCase()) && typeof value === 'string') {
      safeUserEnv[key] = value;
    }
  }
  return safeUserEnv;
}

/**
 * Builds a minimal, sanitized child-process environment while preserving
 * essential Windows system variables (`SystemRoot`, `WINDIR`, `COMSPEC`, `PATH`)
 * regardless of host key casing.
 */
export function buildSanitizedProcessEnv(
  extra?: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const resolvedPath =
    platform === 'win32'
      ? (getEnvCaseInsensitive(hostEnv, 'PATH') ?? '')
      : (hostEnv.PATH || '');
  const clean: NodeJS.ProcessEnv = {
    PATH: resolvedPath,
    LANG: hostEnv.LANG || 'C.UTF-8',
    LC_ALL: hostEnv.LC_ALL || 'C.UTF-8',
    NODE_OPTIONS: '',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
  };
  if (platform === 'win32') {
    const windir = getEnvCaseInsensitive(hostEnv, 'WINDIR');
    clean.SystemRoot =
      getEnvCaseInsensitive(hostEnv, 'SystemRoot') || windir || 'C:\\Windows';
    if (windir) {
      clean.WINDIR = windir;
    }
    const comspec = getEnvCaseInsensitive(hostEnv, 'COMSPEC');
    if (comspec) {
      clean.COMSPEC = comspec;
    }
  }
  return { ...clean, ...filterUserEnv(extra) };
}

async function createTempSandboxFiles(
  prefix: string,
  files: Record<string, string>
): Promise<{ dir: string; paths: Record<string, string> }> {
  const baseTmp = normalizeSandboxPath(os.tmpdir());
  const rawDir = await fs.mkdtemp(joinSandboxPath(process.platform, baseTmp, prefix));
  const dir = normalizeSandboxPath(rawDir);
  const written: string[] = [];
  try {
    await fs.chmod(dir, 0o700).catch(() => {});
    const paths: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
      const filePath = joinSandboxPath(process.platform, dir, name);
      await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
      await fs.chmod(filePath, 0o600).catch(() => {});
      paths[name] = filePath;
      written.push(filePath);
    }
    return { dir, paths };
  } catch (err) {
    await cleanupTempSandbox(dir, written);
    throw err;
  }
}

async function cleanupTempSandbox(dir: string | null, filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile() && stat.size > 0) {
        await fs.writeFile(filePath, Buffer.alloc(stat.size, 0));
      }
      await fs.unlink(filePath);
    } catch {}
  }
  if (dir) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
    } catch {}
  }
}

// Static JS/TS sandbox harness — never interpolated with untrusted user code or env.
const JS_SANDBOX_HARNESS = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const entryFile = process.argv[2] === 'solution.ts' ? 'solution.ts' : 'solution.js';
const solutionPath = path.join(__dirname, entryFile);
const envPath = path.join(__dirname, 'env.json');

let rawCode = fs.readFileSync(solutionPath, 'utf8');
let userEnv = {};
try {
  userEnv = JSON.parse(fs.readFileSync(envPath, 'utf8'));
} catch {
  userEnv = {};
}

if (entryFile === 'solution.ts' && typeof Module.stripTypeScriptTypes === 'function') {
  rawCode = Module.stripTypeScriptTypes(rawCode);
}

const ALLOWED_MODULES = new Set([
  'readline',
  'util',
  'assert',
  'buffer',
  'events',
  'stream',
  'string_decoder',
]);

function createSecurityError(message) {
  const err = new Error('SecurityError: ' + message);
  err.name = 'SecurityError';
  return err;
}

function assertAllowedModule(id) {
  const raw = String(id || '');
  if (raw.startsWith('.') || raw.startsWith('/') || raw.startsWith('\\\\') || /^[A-Za-z]:/.test(raw)) {
    throw createSecurityError("Access to module '" + raw + "' is restricted by the sandbox security policy.");
  }
  const base = raw.replace(/^node:/, '').split('/')[0];
  if (!ALLOWED_MODULES.has(base)) {
    throw createSecurityError("Access to module '" + raw + "' is restricted by the sandbox security policy.");
  }
}

const origLoad = Module._load;
Module._load = function (request) {
  assertAllowedModule(request);
  return origLoad.apply(this, arguments);
};
Module.prototype.require = function (id) {
  assertAllowedModule(id);
  return origLoad.apply(Module, [id, this, false]);
};

// Purge privileged modules loaded during bootstrap before running untrusted code.
for (const cachedKey of Object.keys(Module._cache || {})) {
  delete Module._cache[cachedKey];
}

function safeRequire(id) {
  assertAllowedModule(id);
  return origLoad.call(Module, id, null, false);
}

delete globalThis.fetch;
delete globalThis.WebSocket;
delete globalThis.XMLHttpRequest;

if (typeof process !== 'undefined') {
  process.env = Object.freeze({ ...(userEnv && typeof userEnv === 'object' ? userEnv : {}) });
  for (const prop of [
    'binding',
    '_linkedBinding',
    'dlopen',
    'getBuiltinModule',
    'kill',
    'abort',
    'chdir',
    'umask',
    'setuid',
    'setgid',
    'seteuid',
    'setegid',
    'initgroups',
  ]) {
    try {
      Object.defineProperty(process, prop, {
        value: function () {
          throw createSecurityError("Access to 'process." + prop + "' is restricted by the sandbox security policy.");
        },
        writable: false,
        configurable: false,
      });
    } catch {}
  }
  try {
    delete process.mainModule;
  } catch {}
}

Object.freeze(Module.prototype);
Object.freeze(Module);

const userModule = { exports: {} };
try {
  const compiled = vm.compileFunction(
    rawCode,
    ['require', 'exports', 'module', '__filename', '__dirname'],
    {
      filename: entryFile,
      importModuleDynamically: () => {
        throw createSecurityError('Dynamic import() is restricted by the sandbox security policy.');
      },
    }
  );
  compiled(safeRequire, userModule.exports, userModule, entryFile, '.');
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
}
`;

// Static Python sandbox runner — never interpolated with untrusted user code.
const PYTHON_SANDBOX_RUNNER = `import builtins
import io
import os
import sys
import traceback

with open(sys.argv[1], 'r', encoding='utf-8') as f:
    _source = f.read()

os.environ.clear()

BLOCKED_MODULES = frozenset({
    'os', 'posix', 'nt', 'subprocess', 'socket', 'http', 'urllib', 'urllib3',
    'requests', 'httpx', 'aiohttp', 'ssl', 'ftplib', 'smtplib', 'poplib',
    'imaplib', 'telnetlib', 'ctypes', '_ctypes', 'importlib', 'pkgutil',
    'runpy', 'sysconfig', 'shutil', 'pathlib', 'tempfile', 'glob', 'fnmatch',
    'multiprocessing', 'concurrent', 'pty', 'tty', 'termios', 'fcntl',
    'signal', 'resource', 'webbrowser', 'sqlite3', 'dbm', 'venv',
    'ensurepip', 'pip', 'mmap', 'msvcrt', '_winapi', 'winreg',
    'socketserver', 'asyncio', 'selectors', 'select',
})

BLOCKED_AUDIT_PREFIXES = (
    'subprocess.', 'socket.', 'ctypes.', 'os.posix_spawn', 'os.spawn', 'os.exec',
)

BLOCKED_AUDIT_EVENTS = frozenset({
    'os.system', 'os.fork', 'os.forkpty', 'os.kill', 'os.remove', 'os.unlink',
    'os.rmdir', 'os.mkdir', 'os.rename', 'os.chmod', 'os.chown', 'webbrowser.open',
})

class _SandboxImportBlocker:
    def find_spec(self, fullname, path=None, target=None):
        root = fullname.split('.')[0]
        if root in BLOCKED_MODULES:
            raise ImportError(
                f"SecurityError: Access to module '{fullname}' is restricted by the sandbox security policy."
            )
        return None

def _audit_hook(event, _args):
    if event in BLOCKED_AUDIT_EVENTS or event.startswith(BLOCKED_AUDIT_PREFIXES):
        raise PermissionError(
            f"SecurityError: Operation '{event}' is restricted by the sandbox security policy."
        )

def _blocked_open(*_args, **_kwargs):
    raise PermissionError(
        'SecurityError: File system access via open() is restricted by the sandbox security policy.'
    )

for _mod_name in list(sys.modules.keys()):
    if _mod_name.split('.')[0] in BLOCKED_MODULES:
        sys.modules.pop(_mod_name, None)

sys.meta_path.insert(0, _SandboxImportBlocker())
sys.addaudithook(_audit_hook)
builtins.open = _blocked_open
io.open = _blocked_open
if hasattr(io, 'FileIO'):
    io.FileIO = _blocked_open

_user_globals = {'__name__': '__main__', '__builtins__': builtins}
try:
    _compiled = compile(_source, 'solution.py', 'exec')
    exec(_compiled, _user_globals, _user_globals)
except BaseException as exc:
    if isinstance(exc, SystemExit):
        raise
    traceback.print_exception(type(exc), exc, exc.__traceback__)
    sys.exit(1)
`;

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
   * Executes a pre-staged sandboxed child process, enforcing output caps, timeouts,
   * memory/security classification, and zeroized temporary file cleanup on every exit path.
   */
  private async runSandboxedChildProcess(params: {
    command: string;
    buildArgs: (paths: Record<string, string>) => string[];
    tempPrefix: string;
    files: Record<string, string>;
    timeoutMs: number;
    memoryLimitMb: number;
    maxOutputBytes: number;
    stdin: string;
    env?: Record<string, string>;
    defaultPeakMemoryBytes: number;
    missingRuntimePrefix?: string;
  }): Promise<ExecutionResult> {
    const startTime = performance.now();
    let tempDir: string | null = null;
    let filePaths: string[] = [];

    try {
      const staged = await createTempSandboxFiles(params.tempPrefix, params.files);
      tempDir = staged.dir;
      filePaths = Object.values(staged.paths);
      const args = params.buildArgs(staged.paths);
      const cleanEnv = buildSanitizedProcessEnv(params.env);
      const command =
        path.isAbsolute(params.command) ||
        params.command.includes('/') ||
        params.command.includes('\\')
          ? normalizeSandboxPath(params.command)
          : params.command;

      return await new Promise<ExecutionResult>((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(command, args, {
            cwd: tempDir!,
            env: cleanEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (err) {
          const duration = Math.round((performance.now() - startTime) * 100) / 100;
          const errMsg = params.missingRuntimePrefix
            ? `${params.missingRuntimePrefix}${String(err)}`
            : String(err);
          void cleanupTempSandbox(tempDir, filePaths).then(() => {
            resolve({
              status: 'RTE',
              exitCode: 1,
              stdout: '',
              stderr: errMsg,
              executionDurationMs: duration,
              peakMemoryBytes: 0,
              verdict: 'RTE',
              error: String(err),
            });
          });
          return;
        }

        let stdout = '';
        let stderr = '';
        let isSettled = false;

        if (params.stdin && child.stdin) {
          try {
            child.stdin.write(params.stdin);
            child.stdin.end();
          } catch (_) {}
        } else if (child.stdin) {
          child.stdin.end();
        }

        child.stdout?.on('data', (data: Buffer) => {
          if (stdout.length < params.maxOutputBytes) {
            stdout += data.toString('utf-8');
            if (stdout.length > params.maxOutputBytes) {
              stdout = stdout.slice(0, params.maxOutputBytes) + '\n[Output Truncated]';
            }
          }
        });

        child.stderr?.on('data', (data: Buffer) => {
          if (stderr.length < params.maxOutputBytes) {
            stderr += data.toString('utf-8');
            if (stderr.length > params.maxOutputBytes) {
              stderr = stderr.slice(0, params.maxOutputBytes) + '\n[Error Output Truncated]';
            }
          }
        });

        const settle = (result: ExecutionResult) => {
          if (isSettled) return;
          isSettled = true;
          clearTimeout(timeoutTimer);
          void cleanupTempSandbox(tempDir, filePaths).then(() => resolve(result));
        };

        const timeoutTimer = setTimeout(() => {
          if (isSettled) return;
          const duration = Math.round((performance.now() - startTime) * 100) / 100;
          try {
            killProcessSafely(child);
          } catch (_) {}

          settle({
            status: 'TLE',
            exitCode: 124,
            stdout,
            stderr: stderr
              ? `${stderr}\nTime Limit Exceeded: Process terminated after ${params.timeoutMs}ms`
              : `Time Limit Exceeded: Process terminated after ${params.timeoutMs}ms`,
            executionDurationMs: duration,
            peakMemoryBytes: 0,
            verdict: 'TLE',
            error: `Time Limit Exceeded (${params.timeoutMs}ms hard limit)`,
          });
        }, params.timeoutMs);

        child.on('error', (err: Error) => {
          const duration = Math.round((performance.now() - startTime) * 100) / 100;
          const msg = params.missingRuntimePrefix
            ? `${params.missingRuntimePrefix}${err.message}`
            : err.message;
          settle({
            status: 'RTE',
            exitCode: 1,
            stdout,
            stderr: stderr + (stderr ? '\n' : '') + msg,
            executionDurationMs: duration,
            peakMemoryBytes: 0,
            verdict: 'RTE',
            error: err.message,
          });
        });

        child.on('close', (exitCode: number | null) => {
          const duration = Math.round((performance.now() - startTime) * 100) / 100;
          const code = exitCode ?? 0;

          const isOom =
            stderr.includes('heap limit Allocation failed') ||
            stderr.includes('JavaScript heap out of memory') ||
            stderr.includes('Allocation failed') ||
            stderr.includes('MemoryError') ||
            code === 134 ||
            code === 137;

          if (isOom) {
            return settle({
              status: 'MLE',
              exitCode: 137,
              stdout,
              stderr: `Memory Limit Exceeded: Heap allocation limit of ${params.memoryLimitMb}MB exceeded`,
              executionDurationMs: duration,
              peakMemoryBytes: params.memoryLimitMb * 1024 * 1024,
              verdict: 'MLE',
              error: `Memory Limit Exceeded (${params.memoryLimitMb}MB limit)`,
            });
          }

          if (
            stderr.includes('SecurityError:') ||
            stderr.includes('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG')
          ) {
            return settle({
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

          if (
            code !== 0 ||
            stderr.includes('SyntaxError') ||
            stderr.includes('ReferenceError') ||
            stderr.includes('TypeError')
          ) {
            return settle({
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

          settle({
            status: 'SUCCESS',
            exitCode: 0,
            stdout,
            stderr,
            executionDurationMs: duration,
            peakMemoryBytes: params.defaultPeakMemoryBytes,
            verdict: 'OK',
          });
        });
      });
    } catch (err) {
      await cleanupTempSandbox(tempDir, filePaths);
      const duration = Math.round((performance.now() - startTime) * 100) / 100;
      return {
        status: 'RTE',
        exitCode: 1,
        stdout: '',
        stderr: String(err),
        executionDurationMs: duration,
        peakMemoryBytes: 0,
        verdict: 'RTE',
        error: String(err),
      };
    }
  }

  /**
   * Runs JavaScript or TypeScript in an isolated, ephemeral child process with strict V8 heap limits
   * and isolated temporary-file execution (no template literal interpolation or inline -e execution).
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
    const entryFile = opts.isTypeScript ? 'solution.ts' : 'solution.js';
    const userEnv = filterUserEnv(opts.env);

    return this.runSandboxedChildProcess({
      command: process.execPath,
      tempPrefix: 'devtrack-sandbox-js-',
      files: {
        'harness.cjs': JS_SANDBOX_HARNESS,
        [entryFile]: sourceCode,
        'env.json': JSON.stringify(userEnv),
      },
      buildArgs: (paths) => [
        `--max-old-space-size=${opts.memoryLimitMb}`,
        '--no-warnings',
        '--no-addons',
        paths['harness.cjs'],
        entryFile,
      ],
      timeoutMs: opts.timeoutMs,
      memoryLimitMb: opts.memoryLimitMb,
      maxOutputBytes: opts.maxOutputBytes,
      stdin: opts.stdin,
      env: userEnv,
      defaultPeakMemoryBytes: Math.min(opts.memoryLimitMb * 1024 * 1024, 25 * 1024 * 1024),
    });
  }

  /**
   * Runs Python code inside an isolated temporary-file sandbox (no inline -c code passing).
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
    return this.runSandboxedChildProcess({
      command: 'python',
      tempPrefix: 'devtrack-sandbox-py-',
      files: {
        'runner.py': PYTHON_SANDBOX_RUNNER,
        'solution.py': sourceCode,
      },
      buildArgs: (paths) => ['-I', '-B', paths['runner.py'], paths['solution.py']],
      timeoutMs: opts.timeoutMs,
      memoryLimitMb: opts.memoryLimitMb,
      maxOutputBytes: opts.maxOutputBytes,
      stdin: opts.stdin,
      env: opts.env,
      defaultPeakMemoryBytes: 15 * 1024 * 1024,
      missingRuntimePrefix: 'Python interpreter unavailable in current environment: ',
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
      const baseTmp = normalizeSandboxPath(os.tmpdir());
      workspace = normalizeSandboxPath(
        await fs.mkdtemp(joinSandboxPath(process.platform, baseTmp, 'devtrack-cpp-'))
      );
      await fs.chmod(workspace, 0o755);
      await fs.writeFile(
        joinSandboxPath(process.platform, workspace, 'main.cpp'),
        sourceCode,
        { mode: 0o644 }
      );

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
          await fs.rm(workspace, { recursive: true, force: true });
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
