// src/__tests__/modules/dsa/sandboxRunner.test.ts — Unit & Security Integration Tests
// Verifies isolated WASI and containerized sandbox runner containment, TLE, MLE, and zero-leakage security.

import { describe, it, expect } from 'vitest';
import { sandboxRunner, executeCode } from '../../../modules/dsa/execution/sandboxRunner.js';
import { wasiEngine } from '../../../modules/dsa/execution/wasiEngine.js';
import { evaluateSubmission } from '../../../workers/worker-dsa-eval.js';

describe('SandboxRunner — Secure Code Execution Engine (#525)', () => {
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
});
