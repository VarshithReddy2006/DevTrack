// src/modules/dsa/execution/wasiEngine.ts — Isolated WebAssembly (WASI) Execution Engine
// Enforces strict memory bounds, zero-network and zero-disk policies, and deterministic execution timeouts.

import { WASI } from 'node:wasi';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { logger } from '../../../shared/logger.js';

export type WasiStatus = 'SUCCESS' | 'TLE' | 'MLE' | 'RTE' | 'SECURITY_VIOLATION';

export interface WasiEngineConfig {
  /** Maximum execution duration in milliseconds before timeout abort (default: 2000ms) */
  timeoutMs?: number;
  /** Maximum memory limit in megabytes (default: 256MB) */
  memoryLimitMb?: number;
  /** Maximum output size in bytes to prevent memory flood DoS (default: 1MB) */
  maxOutputBytes?: number;
  /** Standard input to feed into the WASI process */
  stdin?: string;
  /** Command line arguments passed into WASI */
  args?: string[];
  /** Environment variables (empty by default for secret isolation) */
  env?: Record<string, string>;
  /** Optional function entrypoint name when invoking exported functions */
  entrypoint?: string;
  /** Arguments to pass to the function entrypoint */
  entrypointArgs?: (number | bigint)[];
}

export interface WasiExecutionResult {
  status: WasiStatus;
  exitCode: number;
  stdout: string;
  stderr: string;
  executionDurationMs: number;
  peakMemoryBytes: number;
  returnValue?: number | bigint | unknown;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 2000; // 2.0s hard limit per acceptance criteria
const DEFAULT_MEMORY_LIMIT_MB = 256; // 256MB max heap per acceptance criteria
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB
const WASM_PAGE_SIZE = 65536; // 64KB per WebAssembly memory page

export class WasiEngine {
  private defaultTimeoutMs: number;
  private defaultMemoryLimitMb: number;

  constructor(defaults?: { timeoutMs?: number; memoryLimitMb?: number }) {
    this.defaultTimeoutMs = defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMemoryLimitMb = defaults?.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
  }

  /**
   * Validates WebAssembly binary format and exports
   */
  public validateWasm(wasmBytes: Uint8Array | Buffer): {
    valid: boolean;
    error?: string;
    exports?: Array<{ name: string; kind: string }>;
  } {
    try {
      const buffer = Buffer.isBuffer(wasmBytes) ? wasmBytes : Buffer.from(wasmBytes);
      const module = new WebAssembly.Module(buffer as unknown as BufferSource);
      const exports = WebAssembly.Module.exports(module);
      return { valid: true, exports };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Executes a WebAssembly / WASI binary with strict containment, memory limits, and timeouts.
   * Runs in an isolated worker thread to guarantee deterministic cancellation without hanging host processes.
   */
  public async executeWasm(
    wasmBytes: Uint8Array | Buffer,
    config: WasiEngineConfig = {}
  ): Promise<WasiExecutionResult> {
    const timeoutMs = config.timeoutMs ?? this.defaultTimeoutMs;
    const memoryLimitMb = config.memoryLimitMb ?? this.defaultMemoryLimitMb;
    const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const maxPages = Math.floor((memoryLimitMb * 1024 * 1024) / WASM_PAGE_SIZE);

    // Initial validation
    const validation = this.validateWasm(wasmBytes);
    if (!validation.valid) {
      return {
        status: 'RTE',
        exitCode: 1,
        stdout: '',
        stderr: `WebAssembly compilation error: ${validation.error}`,
        executionDurationMs: 0,
        peakMemoryBytes: 0,
        error: validation.error,
      };
    }

    const startTime = performance.now();

    // Isolated worker script for WASI execution
    const workerScript = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { WASI } = require('node:wasi');
      const { performance } = require('node:perf_hooks');

      async function run() {
        const { wasmBuffer, config, maxPages, wasmPageSize } = workerData;
        const startTime = performance.now();

        let stdout = '';
        let stderr = '';
        let peakMemoryBytes = wasmPageSize;

        // Sandboxed WASI Instance with ZERO directory preopens and ZERO host env leakage
        const wasi = new WASI({
          version: 'preview1',
          args: config.args || ['wasi_program'],
          env: config.env || {},
          preopens: {}, // Whitelist: zero filesystem directories mapped
          returnOnExit: true,
        });

        // Intercept WASI stdio calls to buffer output in-memory and enforce output bounds
        const wasiImports = { ...wasi.wasiImport };
        let memoryInstance = null;

        // Custom fd_write trap for isolated stdout and stderr
        const originalFdWrite = wasiImports.fd_write;
        wasiImports.fd_write = function (fd, iovs_ptr, iovs_len, nwritten_ptr) {
          try {
            if (!memoryInstance) return originalFdWrite(fd, iovs_ptr, iovs_len, nwritten_ptr);

            const buffer = new Uint8Array(memoryInstance.buffer);
            const view = new DataView(memoryInstance.buffer);
            let written = 0;
            let outputChunk = '';

            for (let i = 0; i < iovs_len; i++) {
              const ptr = view.getUint32(iovs_ptr + i * 8, true);
              const len = view.getUint32(iovs_ptr + i * 8 + 4, true);
              const bytes = buffer.slice(ptr, ptr + len);
              outputChunk += Buffer.from(bytes).toString('utf-8');
              written += len;
            }

            if (fd === 1) {
              if (stdout.length < config.maxOutputBytes) stdout += outputChunk;
            } else if (fd === 2) {
              if (stderr.length < config.maxOutputBytes) stderr += outputChunk;
            }

            view.setUint32(nwritten_ptr, written, true);
            return 0; // __WASI_ERRNO_SUCCESS
          } catch (e) {
            return 8; // __WASI_ERRNO_BADF
          }
        };

        // System call whitelist enforcement: block all network sockets
        wasiImports.sock_send = () => 58; // __WASI_ERRNO_NOTSUP
        wasiImports.sock_recv = () => 58;
        wasiImports.sock_accept = () => 58;
        wasiImports.sock_shutdown = () => 58;

        // Restrict filesystem modification
        wasiImports.path_open = () => 63; // __WASI_ERRNO_PERM
        wasiImports.path_create_directory = () => 63;
        wasiImports.path_unlink_file = () => 63;

        try {
          const module = new WebAssembly.Module(Buffer.from(wasmBuffer));
          
          // Enforce memory bounds
          let memory = new WebAssembly.Memory({ initial: 1, maximum: maxPages });
          const importObject = {
            wasi_snapshot_preview1: wasiImports,
            env: {
              memory,
              abort: (msg, file, line, col) => {
                throw new Error(\`Abort called: \${msg} at \${file}:\${line}:\${col}\`);
              }
            }
          };

          const instance = new WebAssembly.Instance(module, importObject);
          memoryInstance = instance.exports.memory || memory;
          peakMemoryBytes = memoryInstance.buffer.byteLength;

          let exitCode = 0;
          let returnValue = undefined;

          // Invoke WASI start if exported memory and _start are present, otherwise call directly
          if (typeof instance.exports._start === 'function') {
            if (instance.exports.memory && instance.exports.memory instanceof WebAssembly.Memory) {
              exitCode = wasi.start(instance);
            } else {
              instance.exports._start();
              exitCode = 0;
            }
          } else if (typeof instance.exports._initialize === 'function') {
            if (instance.exports.memory && instance.exports.memory instanceof WebAssembly.Memory) {
              wasi.initialize(instance);
            } else {
              instance.exports._initialize();
            }
          }

          // If a specific entrypoint function is requested
          if (config.entrypoint && typeof instance.exports[config.entrypoint] === 'function') {
            const fn = instance.exports[config.entrypoint];
            const args = config.entrypointArgs || [];
            returnValue = fn(...args);
          }

          peakMemoryBytes = Math.max(peakMemoryBytes, memoryInstance.buffer.byteLength);
          const duration = Math.round((performance.now() - startTime) * 100) / 100;

          parentPort.postMessage({
            status: 'SUCCESS',
            exitCode: exitCode ?? 0,
            stdout,
            stderr,
            executionDurationMs: duration,
            peakMemoryBytes,
            returnValue,
          });
        } catch (err) {
          const duration = Math.round((performance.now() - startTime) * 100) / 100;
          const msg = err instanceof Error ? err.message : String(err);
          const lower = msg.toLowerCase();
          const isOom = (lower.includes('out of memory') || lower.includes('allocation failed') || lower.includes('cannot grow memory') || lower.includes('heap limit') || (lower.includes('memory') && lower.includes('exhaust')));

          parentPort.postMessage({
            status: isOom ? 'MLE' : 'RTE',
            exitCode: isOom ? 137 : 1,
            stdout,
            stderr: stderr + (stderr ? '\\n' : '') + msg,
            executionDurationMs: duration,
            peakMemoryBytes,
            error: msg,
          });
        }
      }

      run();
    `;

    return new Promise<WasiExecutionResult>((resolve) => {
      let isSettled = false;
      const worker = new Worker(workerScript, {
        eval: true,
        workerData: {
          wasmBuffer: Array.from(wasmBytes),
          config: {
            args: config.args,
            env: config.env,
            entrypoint: config.entrypoint,
            entrypointArgs: config.entrypointArgs,
            maxOutputBytes,
          },
          maxPages,
          wasmPageSize: WASM_PAGE_SIZE,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: memoryLimitMb,
        },
      });

      const timer = setTimeout(async () => {
        if (isSettled) return;
        isSettled = true;
        const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
        try {
          await worker.terminate();
        } catch (e) {
          logger.warn('[wasiEngine] Worker termination error on TLE', { error: e });
        }

        resolve({
          status: 'TLE',
          exitCode: 124,
          stdout: '',
          stderr: `Time Limit Exceeded: Execution exceeded ${timeoutMs}ms limit`,
          executionDurationMs: elapsed,
          peakMemoryBytes: maxPages * WASM_PAGE_SIZE,
          error: 'Time Limit Exceeded',
        });
      }, timeoutMs);

      worker.on('message', (result: WasiExecutionResult) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        resolve(result);
      });

      worker.on('error', (err: Error) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
        const msg = err.message || '';
        const isOom = msg.includes('heap limit') || msg.includes('out of memory');

        resolve({
          status: isOom ? 'MLE' : 'RTE',
          exitCode: isOom ? 137 : 1,
          stdout: '',
          stderr: msg,
          executionDurationMs: elapsed,
          peakMemoryBytes: isOom ? memoryLimitMb * 1024 * 1024 : 0,
          error: msg,
        });
      });

      worker.on('exit', (code) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
        resolve({
          status: code === 0 ? 'SUCCESS' : 'RTE',
          exitCode: code,
          stdout: '',
          stderr: code !== 0 ? `Worker exited with non-zero exit code: ${code}` : '',
          executionDurationMs: elapsed,
          peakMemoryBytes: 0,
        });
      });
    });
  }

  /**
   * Generates synthetic, fully compliant WebAssembly binary modules for testing and verification
   * without requiring native external compiler toolchains.
   */
  public createSyntheticModule(type: 'success' | 'add' | 'loop' | 'trap' | 'memory_hog'): Uint8Array {
    switch (type) {
      case 'add':
        // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
        return new Uint8Array([
          0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
          0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
          0x03, 0x02, 0x01, 0x00,
          0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
          0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
        ]);

      case 'success':
        // (module (func (export "_start")))
        return new Uint8Array([
          0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
          0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
          0x03, 0x02, 0x01, 0x00,
          0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
          0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
        ]);

      case 'loop':
        // Infinite loop (module (func (export "_start") (loop (br 0))))
        return new Uint8Array([
          0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
          0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
          0x03, 0x02, 0x01, 0x00,
          0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
          0x0a, 0x09, 0x01, 0x07, 0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b,
        ]);

      case 'trap':
        // Unreachable trap (module (func (export "_start") unreachable))
        return new Uint8Array([
          0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
          0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
          0x03, 0x02, 0x01, 0x00,
          0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
          0x0a, 0x05, 0x01, 0x03, 0x00, 0x00, 0x0b,
        ]);

      case 'memory_hog':
        // Tries to grow memory beyond maximum bounds
        // (module (memory (import "env" "memory") 1 4096) (func (export "_start") (loop (i32.const 5000) (memory.grow) drop (br 0))))
        return new Uint8Array([
          0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
          0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
          0x02, 0x11, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x01, 0x01, 0x80, 0x20,
          0x03, 0x02, 0x01, 0x00,
          0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
          0x0a, 0x0f, 0x01, 0x0d, 0x00, 0x03, 0x40, 0x41, 0x88, 0x27, 0x40, 0x00, 0x1a, 0x0c, 0x00, 0x0b, 0x0b,
        ]);
    }
  }
}

export const wasiEngine = new WasiEngine();
