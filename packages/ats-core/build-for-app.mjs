import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tsconfig = new URL('tsconfig.json', import.meta.url);
const compiledEntry = new URL('dist/index.js', import.meta.url);
if (!existsSync(tsconfig) && existsSync(compiledEntry)) process.exit(0);
const require = createRequire(resolve('package.json'));
let compiler;
try {
  compiler = require.resolve('typescript/bin/tsc');
} catch (error) {
  if (error.code === 'MODULE_NOT_FOUND' && existsSync(compiledEntry)) process.exit(0);
  throw error;
}
const result = spawnSync(process.execPath, [compiler, '-p', fileURLToPath(tsconfig)], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status === 0) {
  copyFileSync(new URL('src/taxonomy/v1.json', import.meta.url), new URL('dist/taxonomy/v1.json', import.meta.url));
}
process.exitCode = result.status ?? 1;
