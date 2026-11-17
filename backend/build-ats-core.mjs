import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = new URL('./node_modules/@devtrack/ats-core/', import.meta.url);
const tsconfig = new URL('tsconfig.json', packageRoot);
const compiledEntry = new URL('dist/index.js', packageRoot);
// The runtime image copies the compiled workspace without source or build tools.
if (!existsSync(tsconfig) && existsSync(compiledEntry)) process.exit(0);

let compiler;
try {
  compiler = require.resolve('typescript/bin/tsc');
} catch (error) {
  // The production image already contains the compiled workspace and omits dev dependencies.
  if (error.code === 'MODULE_NOT_FOUND' && existsSync(compiledEntry)) process.exit(0);
  throw error;
}

const result = spawnSync(process.execPath, [
  compiler, '-p', fileURLToPath(tsconfig),
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status === 0) {
  // TypeScript skips emitting JSON from the installed package under node_modules.
  copyFileSync(
    new URL('src/taxonomy/v1.json', packageRoot),
    new URL('dist/taxonomy/v1.json', packageRoot),
  );
}
process.exitCode = result.status ?? 1;
