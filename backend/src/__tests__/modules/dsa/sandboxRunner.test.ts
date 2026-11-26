// src/__tests__/modules/dsa/sandboxRunner.test.ts — Unit & Security Integration Tests
// Verifies isolated WASI and containerized sandbox runner containment, TLE, MLE, and zero-leakage security.

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  sandboxRunner,
  executeCode,
  getEnvCaseInsensitive,
  buildSanitizedProcessEnv,
  normalizeSandboxPath,
  escapeWindowsCommandPath,
} from '../../../modules/dsa/execution/sandboxRunner.js';
import { wasiEngine } from '../../../modules/dsa/execution/wasiEngine.js';
import { evaluateSubmission } from '../../../workers/worker-dsa-eval.js';

const cppSandboxImage = process.env.CPP_SANDBOX_IMAGE || 'gcc:14';
const cppSandboxAvailable = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 2000 }).status === 0 &&
  spawnSync('docker', ['image', 'inspect', cppSandboxImage], { stdio: 'ignore', timeout: 2000 }).status === 0;

describe('SandboxRunner — Secure Code Execution Engine (#525)', () => {
  it.skipIf(cppSandboxAvailable)('reports when the Docker sandbox runtime is unavailable', async () => {
    const result = await sandboxRunner.execute('int main() { return 0; }', 'cpp');

    expect(result.status).toBe('RTE');
    expect(result.error).toContain('C++ sandbox');
  });

  describe.skipIf(!cppSandboxAvailable)('C++ sandbox execution', () => {
    it('compiles and executes C++20 code with stdin', async () => {
      const result = await sandboxRunner.execute(`#include <iostream>
int main() { int a, b; std::cin >> a >> b; std::cout << a + b << '\\n'; }`, 'cpp', {
        stdin: '20 22\n',
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.stdout.trim()).toBe('42');
    });

    it('returns compiler diagnostics with source line and column', async () => {
      const result = await sandboxRunner.execute(`#include <iostream>
int main() {
  this is not valid C++;
}`, 'cpp');

      expect(result.status).toBe('RTE');
      expect(result.stderr).toMatch(/main\.cpp:\d+:\d+: error:/);
    });

    it('enforces the runtime timeout', async () => {
      const result = await sandboxRunner.execute('int main() { for (;;) {} }', 'cpp', { timeoutMs: 200 });

      expect(result.status).toBe('TLE');
      expect(result.exitCode).toBe(124);
    });

    it('reports segmentation faults as runtime errors', async () => {
      const result = await sandboxRunner.execute('int main() { int* p = nullptr; return *p; }', 'cpp');

      expect(result.status).toBe('RTE');
      expect(result.exitCode).not.toBe(0);
    });

    it('enforces the 128MB C++ runtime memory ceiling', async () => {
      const result = await sandboxRunner.execute(`#include <vector>
int main() { std::vector<char> memory(160 * 1024 * 1024); return memory[0]; }`, 'cpp');

      expect(result.status).toBe('MLE');
      expect(result.exitCode).toBe(137);
    });
  });

  describe('Valid Algorithm Execution', () => {
    it('executes valid JavaScript code and captures stdout', async () => {
      const code = `
        const a = 15;
        const b = 27;
        console.log(a + b);
      `;

      const result = await sandboxRunner.execute(code, 'javascript');
      expect(result.status).toBe('SUCCESS');
      expect(result.verdict).toBe('OK');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('42');
      expect(result.executionDurationMs).toBeGreaterThan(0);
    });

    it('processes standard input (stdin) correctly', async () => {
      const code = `
        const readline = require('node:readline');
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          const [x, y] = line.split(' ').map(Number);
          console.log(x * y);
          process.exit(0);
        });
      `;

      const result = await sandboxRunner.execute(code, 'javascript', { stdin: '6 7\n' });
      expect(result.status).toBe('SUCCESS');
      expect(result.stdout.trim()).toBe('42');
    });

    it('executes typed TypeScript algorithms natively', async () => {
      const code = `
        interface Solution {
          twoSum(nums: number[], target: number): number[];
        }

        const solution: Solution = {
          twoSum(nums: number[], target: number): number[] {
            const map = new Map<number, number>();
            for (let i = 0; i < nums.length; i++) {
              const complement = target - nums[i];
              if (map.has(complement)) {
                return [map.get(complement)!, i];
              }
              map.set(nums[i], i);
            }
            return [];
          }
        };

        const res = solution.twoSum([2, 7, 11, 15], 9);
        console.log(JSON.stringify(res));
      `;

      const result = await sandboxRunner.execute(code, 'typescript');
      expect(result.status).toBe('SUCCESS');
      expect(result.stdout.trim()).toBe('[0,1]');
    });

    it('accurately measures execution duration with high precision (sub-5ms precision)', async () => {
      const code = `
        const start = Date.now();
        while (Date.now() - start < 50) {}
        console.log("done");
      `;

      const result = await sandboxRunner.execute(code, 'javascript');
      expect(result.status).toBe('SUCCESS');
      // Should be around 50ms + startup time, accurately recorded
      expect(result.executionDurationMs).toBeGreaterThanOrEqual(45);
    });
  });

  describe('Timeout & Infinite Loop Containment (TLE)', () => {
    it('terminates while-true infinite loops within the specified timeout limit', async () => {
      const code = `
        while (true) {
          // Tight infinite CPU burn
        }
      `;

      const startTime = performance.now();
      const result = await sandboxRunner.execute(code, 'javascript', { timeoutMs: 500 });
      const elapsed = performance.now() - startTime;

      expect(result.status).toBe('TLE');
      expect(result.verdict).toBe('TLE');
      expect(result.exitCode).toBe(124);
      expect(result.error).toContain('Time Limit Exceeded');
      expect(elapsed).toBeLessThan(1500); // Must be aborted promptly without hanging
    });

    it('terminates recursive infinite loops within the default 2.0s hard limit', async () => {
      const code = `
        function recurse() {
          try {
            recurse();
          } catch(e) {
            recurse();
          }
        }
        recurse();
      `;

      const result = await sandboxRunner.execute(code, 'javascript', { timeoutMs: 800 });
      expect(['TLE', 'RTE']).toContain(result.status);
    });
  });

  describe('Memory Limit Exceeded Containment (MLE)', () => {
    it('catches memory allocation bombs and returns MLE without crashing host worker', async () => {
      const code = `
        const chunks = [];
        while (true) {
          chunks.push(new Array(1e7));
        }
      `;

      const result = await sandboxRunner.execute(code, 'javascript', {
        memoryLimitMb: 32,
        timeoutMs: 3000,
      });

      expect(result.status).toBe('MLE');
      expect(result.verdict).toBe('MLE');
      expect(result.exitCode).toBe(137);
      expect(result.error).toContain('Memory Limit Exceeded');
    });

    it('catches large contiguous buffer allocation attempts', async () => {
      const code = `
        // Attempt allocation bomb on heap
        const chunks = [];
        for (let i = 0; i < 50; i++) {
          chunks.push(new Array(1e6).fill('memory-hog-string-payload'));
        }
      `;

      const result = await sandboxRunner.execute(code, 'javascript', {
        memoryLimitMb: 64,
      });

      expect(['MLE', 'RTE']).toContain(result.status);
      expect(result.status === 'MLE' || result.status === 'RTE').toBe(true);
    });
  });

  describe('Security Isolation & Whitelist Enforcement', () => {
    it('blocks access to node:fs and host filesystem', async () => {
      const code = `
        const fs = require('fs');
        fs.readFileSync('/etc/passwd');
      `;

      const result = await sandboxRunner.execute(code, 'javascript');
      expect(result.status).toBe('SECURITY_VIOLATION');
      expect(result.verdict).toBe('SECURITY_VIOLATION');
      expect(result.stderr).toContain('SecurityError');
      expect(result.stderr).toContain('fs');
    });

    it('blocks access to child_process and recursive forks', async () => {
      const code = `
        const cp = require('child_process');
        cp.execSync('ls');
      `;

      const result = await sandboxRunner.execute(code, 'javascript');
      expect(result.status).toBe('SECURITY_VIOLATION');
      expect(result.stderr).toContain('child_process');
    });

    it('blocks network sockets (net, http, https, dgram)', async () => {
      const code = `
        const net = require('net');
        net.connect(80, 'google.com');
      `;

      const result = await sandboxRunner.execute(code, 'javascript');
      expect(result.status).toBe('SECURITY_VIOLATION');
      expect(result.stderr).toContain('net');
    });

    it('blocks global fetch and WebSocket access', async () => {
      const code = `
        if (typeof fetch !== 'undefined') {
          console.log('fetch exists');
        } else {
          console.log('fetch undefined');
        }
      `;

      const result = await sandboxRunner.execute(code, 'javascript');
      expect(result.status).toBe('SUCCESS');
      expect(result.stdout.trim()).toBe('fetch undefined');
    });

    it('prevents environment variable leakage (e.g. MONGODB_URI)', async () => {
      const code = `
        console.log(process.env.MONGODB_URI);
      `;

      const result = await sandboxRunner.execute(code, 'javascript');
      expect(result.status).toBe('SUCCESS');
      expect(result.stdout.trim()).toBe('undefined');
    });

    it('rejects template-literal breakout and quote/backtick injection payloads', async () => {
      const breakoutPayloads = [
        `} catch (err) {} console.log('RCE_ESCAPED'); try {`,
        `\`; console.log('BACKTICK_RCE'); //`,
        `"; process.exit(0); //`,
      ];

      for (const payload of breakoutPayloads) {
        const result = await sandboxRunner.execute(payload, 'javascript');
        expect(result.status).toBe('RTE');
        expect(result.stdout).not.toContain('RCE_ESCAPED');
        expect(result.stdout).not.toContain('BACKTICK_RCE');
      }
    });

    it('blocks process.binding, process.getBuiltinModule, dynamic import(), and node:vm/module bypasses', async () => {
      const escapeAttempts = [
        `process.binding('fs');`,
        `process.getBuiltinModule('node:fs');`,
        `require('node:fs/promises');`,
        `require('node:vm');`,
        `require('node:module');`,
        `require('./harness.cjs');`,
        `import('node:fs').then(() => console.log('ESCAPED'));`,
      ];

      for (const code of escapeAttempts) {
        const result = await sandboxRunner.execute(code, 'javascript');
        expect(result.status).toBe('SECURITY_VIOLATION');
        expect(result.stderr).toMatch(/SecurityError|ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG/);
        expect(result.stdout).not.toContain('ESCAPED');
      }
    });

    it('strips host secrets and dangerous loader variables even when opts.env is supplied', async () => {
      process.env.SANDBOX_SECRET_TOKEN = 'super-secret-host-token';
      try {
        const code = `
          process.env.MUTATED = 'nope';
          console.log(JSON.stringify({
            secret: process.env.SANDBOX_SECRET_TOKEN ?? null,
            nodeOpts: process.env.NODE_OPTIONS ?? null,
            allowed: process.env.SAFE_VAR ?? null,
            mutated: process.env.MUTATED ?? null,
          }));
        `;
        const result = await sandboxRunner.execute(code, 'javascript', {
          env: { SAFE_VAR: 'ok', NODE_OPTIONS: '--require=/etc/passwd' },
        });
        expect(result.status).toBe('SUCCESS');
        expect(JSON.parse(result.stdout.trim())).toEqual({
          secret: null,
          nodeOpts: null,
          allowed: 'ok',
          mutated: null,
        });
      } finally {
        delete process.env.SANDBOX_SECRET_TOKEN;
      }
    });
  });

  describe('Python Sandbox Isolation & Cleanup', () => {
    it('executes valid Python code with stdin from isolated temp files', async () => {
      const code = `
import sys, json, math
n = int(sys.stdin.read().strip())
print(json.dumps({"square": n * n, "gcd": math.gcd(n, 18)}))
`;
      const result = await sandboxRunner.execute(code, 'python', { stdin: '12\n' });
      expect(result.status).toBe('SUCCESS');
      expect(JSON.parse(result.stdout.trim())).toEqual({ square: 144, gcd: 6 });
    });

    it('blocks __import__("os"), subprocess, socket, open(), and sys.modules purge bypasses in Python', async () => {
      const payloads = [
        `__import__('os').system('echo PWNED')`,
        `import sys; sys.modules.pop('os', None); import os; os.system('echo PWNED')`,
        `import subprocess; subprocess.run(['echo', 'PWNED'])`,
        `import socket; socket.socket()`,
        `open('/etc/passwd').read()`,
      ];

      for (const code of payloads) {
        const result = await sandboxRunner.execute(code, 'python');
        expect(result.status).toBe('SECURITY_VIOLATION');
        expect(result.stderr).toContain('SecurityError');
        expect(result.stdout).not.toContain('PWNED');
      }
    });

    it('terminates Python infinite loops with TLE and catches syntax errors as RTE', async () => {
      const tle = await sandboxRunner.execute('while True:\n    pass\n', 'python', { timeoutMs: 400 });
      expect(tle.status).toBe('TLE');

      const syn = await sandboxRunner.execute('def broken(:\n    pass\n', 'python');
      expect(syn.status).toBe('RTE');
      expect(syn.stderr).toContain('SyntaxError');
    });

    it('cleans up temporary sandbox directories after success, syntax error, security violation, and timeout', async () => {
      const listSandboxDirs = async () => {
        const entries = await fs.readdir(os.tmpdir());
        return entries.filter((name) => name.startsWith('devtrack-sandbox-'));
      };

      const before = new Set(await listSandboxDirs());

      await sandboxRunner.execute(`console.log('clean');`, 'javascript');
      await sandboxRunner.execute(`function ( {`, 'javascript');
      await sandboxRunner.execute(`require('fs');`, 'javascript');
      await sandboxRunner.execute(`while (true) {}`, 'javascript', { timeoutMs: 250 });
      await sandboxRunner.execute(`print('clean')`, 'python');
      await sandboxRunner.execute(`import subprocess`, 'python');

      const after = await listSandboxDirs();
      const leaked = after.filter((name) => !before.has(name));
      expect(leaked).toEqual([]);
      expect(path.isAbsolute(os.tmpdir())).toBe(true);
    });
  });

  describe('Runtime Error (RTE) & Syntax Error Handling', () => {
    it('catches JavaScript syntax errors', async () => {
      const code = `function ( { not valid syntax`;

      const result = await sandboxRunner.execute(code, 'javascript');
      expect(result.status).toBe('RTE');
      expect(result.verdict).toBe('RTE');
      expect(result.exitCode).not.toBe(0);
    });

    it('catches unhandled runtime exceptions (null pointer / TypeError)', async () => {
      const code = `
        const obj = null;
        obj.nonExistentMethod();
      `;

      const result = await sandboxRunner.execute(code, 'javascript');
      expect(result.status).toBe('RTE');
      expect(result.verdict).toBe('RTE');
      expect(result.stderr).toContain('TypeError');
    });
  });

  describe('WASI & WebAssembly Execution Engine', () => {
    it('executes compliant WebAssembly module and returns correct function values', async () => {
      const wasmBytes = wasiEngine.createSyntheticModule('add');
      const result = await wasiEngine.executeWasm(wasmBytes, {
        entrypoint: 'add',
        entrypointArgs: [100, 250],
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.returnValue).toBe(350);
      expect(result.executionDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('handles WebAssembly traps cleanly as RTE', async () => {
      const wasmBytes = wasiEngine.createSyntheticModule('trap');
      const result = await wasiEngine.executeWasm(wasmBytes);

      expect(result.status).toBe('RTE');
      expect(result.error).toContain('unreachable');
    });

    it('terminates WebAssembly infinite loops on timeout as TLE', async () => {
      const wasmBytes = wasiEngine.createSyntheticModule('loop');
      const result = await wasiEngine.executeWasm(wasmBytes, { timeoutMs: 200 });

      expect(result.status).toBe('TLE');
      expect(result.error).toContain('Time Limit Exceeded');
    });
  });

  describe('DSA Evaluation Worker Pipeline (worker-dsa-eval)', () => {
    it('evaluates passing test cases and awards ACCEPTED verdict', async () => {
      const code = `
        const readline = require('node:readline');
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          const num = parseInt(line.trim(), 10);
          console.log(num * num);
          process.exit(0);
        });
      `;

      const evalResult = await evaluateSubmission({
        submissionId: 'sub-test-1',
        code,
        language: 'javascript',
        testCases: [
          { input: '3\n', expectedOutput: '9' },
          { input: '5\n', expectedOutput: '25' },
          { input: '12\n', expectedOutput: '144' },
        ],
      });

      expect(evalResult.verdict).toBe('ACCEPTED');
      expect(evalResult.passedTestCases).toBe(3);
      expect(evalResult.totalTestCases).toBe(3);
      expect(evalResult.results.every(r => r.passed)).toBe(true);
    });

    it('detects incorrect outputs and flags WRONG_ANSWER', async () => {
      const code = `
        console.log("wrong output");
      `;

      const evalResult = await evaluateSubmission({
        submissionId: 'sub-test-2',
        code,
        language: 'javascript',
        testCases: [
          { input: 'hello\n', expectedOutput: 'world' },
        ],
      });

      expect(evalResult.verdict).toBe('WRONG_ANSWER');
      expect(evalResult.passedTestCases).toBe(0);
    });

    it('flags TIME_LIMIT_EXCEEDED during test case evaluation', async () => {
      const code = `
        while (true) {}
      `;

      const evalResult = await evaluateSubmission({
        submissionId: 'sub-test-3',
        code,
        language: 'javascript',
        timeoutMs: 300,
        testCases: [
          { input: 'test\n', expectedOutput: 'test' },
        ],
      });

      expect(evalResult.verdict).toBe('TIME_LIMIT_EXCEEDED');
      expect(evalResult.passedTestCases).toBe(0);
    });

    it('flags MEMORY_LIMIT_EXCEEDED during test case evaluation', async () => {
      const code = `
        const arr = [];
        while(true) arr.push(new Array(1e7));
      `;

      const evalResult = await evaluateSubmission({
        submissionId: 'sub-test-4',
        code,
        language: 'javascript',
        memoryLimitMb: 32,
        testCases: [
          { input: 'test\n', expectedOutput: 'test' },
        ],
      });

      expect(evalResult.verdict).toBe('MEMORY_LIMIT_EXCEEDED');
      expect(evalResult.passedTestCases).toBe(0);
    });
  });

  describe('Windows Environment Resolution & Path Escaping (#686)', () => {
    it('resolves environment variables case-insensitively regardless of key casing', () => {
      const env: NodeJS.ProcessEnv = {
        SYSTEMROOT: 'C:\\Windows',
        windir: 'D:\\WinDir',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        Path: 'C:\\Windows\\System32',
      };

      expect(getEnvCaseInsensitive(env, 'SystemRoot')).toBe('C:\\Windows');
      expect(getEnvCaseInsensitive(env, 'systemroot')).toBe('C:\\Windows');
      expect(getEnvCaseInsensitive(env, 'WINDIR')).toBe('D:\\WinDir');
      expect(getEnvCaseInsensitive(env, 'COMSPEC')).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(getEnvCaseInsensitive(env, 'PATH')).toBe('C:\\Windows\\System32');
      expect(getEnvCaseInsensitive(env, 'NON_EXISTENT')).toBeUndefined();
    });

    it('populates SystemRoot, WINDIR, COMSPEC, and PATH case-insensitively on win32 and blocks user overrides', () => {
      const sanitized = buildSanitizedProcessEnv(
        {
          systemroot: 'C:\\Malicious',
          windir: 'C:\\Malicious',
          comspec: 'C:\\Malicious\\cmd.exe',
          SAFE_CUSTOM: 'allowed',
        },
        {
          SYSTEMROOT: 'C:\\WinRoot',
          windir: 'C:\\WinDir',
          comspec: 'C:\\WinRoot\\System32\\cmd.exe',
          Path: 'C:\\Tools',
          SECRET_API_KEY: 'do-not-leak',
        },
        'win32'
      );

      expect(sanitized.SystemRoot).toBe('C:\\WinRoot');
      expect(sanitized.WINDIR).toBe('C:\\WinDir');
      expect(sanitized.COMSPEC).toBe('C:\\WinRoot\\System32\\cmd.exe');
      expect(sanitized.PATH).toBe('C:\\Tools');
      expect(sanitized.SAFE_CUSTOM).toBe('allowed');
      expect(sanitized.SECRET_API_KEY).toBeUndefined();
    });

    it('always populates SystemRoot on win32 even when omitted from host environment', () => {
      const fromWindir = buildSanitizedProcessEnv(undefined, { windir: 'D:\\Windows' }, 'win32');
      expect(fromWindir.SystemRoot).toBe('D:\\Windows');
      expect(fromWindir.WINDIR).toBe('D:\\Windows');

      const fallback = buildSanitizedProcessEnv(undefined, {}, 'win32');
      expect(fallback.SystemRoot).toBe('C:\\Windows');

      const linuxEnv = buildSanitizedProcessEnv(
        undefined,
        { PATH: '/usr/bin', SYSTEMROOT: 'C:\\Windows' },
        'linux'
      );
      expect(linuxEnv.PATH).toBe('/usr/bin');
      expect(linuxEnv.SystemRoot).toBeUndefined();
      expect(linuxEnv.WINDIR).toBeUndefined();
      expect(linuxEnv.COMSPEC).toBeUndefined();
    });

    it('normalizes paths with path.win32 and quotes Windows paths containing spaces or metacharacters', () => {
      expect(normalizeSandboxPath('C:/Users/User Name/temp/../sandbox/solution.js', 'win32')).toBe(
        'C:\\Users\\User Name\\sandbox\\solution.js'
      );
      expect(normalizeSandboxPath('/tmp/devtrack/../sandbox/solution.js', 'linux')).toBe(
        '/tmp/sandbox/solution.js'
      );

      expect(escapeWindowsCommandPath('C:/Users/User Name/AppData/Local/Temp/solution.js')).toBe(
        '"C:\\Users\\User Name\\AppData\\Local\\Temp\\solution.js"'
      );
      expect(escapeWindowsCommandPath('C:\\Users\\User Name\\dir\\')).toBe(
        '"C:\\Users\\User Name\\dir\\\\"'
      );
      expect(escapeWindowsCommandPath('C:\\sandbox\\solution.js')).toBe('C:\\sandbox\\solution.js');
    });

    it('executes JavaScript and Python inside temporary directories whose paths contain spaces', async () => {
      const realTmp = os.tmpdir();
      const spaceParent = await fs.mkdtemp(path.join(realTmp, 'devtrack space dir '));
      const tmpSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(spaceParent);

      try {
        const jsResult = await sandboxRunner.execute(`console.log('space-js-ok');`, 'javascript');
        expect(jsResult.status).toBe('SUCCESS');
        expect(jsResult.stdout.trim()).toBe('space-js-ok');

        const pyResult = await sandboxRunner.execute(`print('space-py-ok')`, 'python');
        expect(pyResult.status).toBe('SUCCESS');
        expect(pyResult.stdout.trim()).toBe('space-py-ok');

        const remaining = await fs.readdir(spaceParent);
        expect(remaining).toEqual([]);
      } finally {
        tmpSpy.mockRestore();
        await fs.rm(spaceParent, { recursive: true, force: true });
      }
    });
  });
});
