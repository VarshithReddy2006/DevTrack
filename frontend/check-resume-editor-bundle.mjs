import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = resolve(process.argv[2] ?? 'dist');
const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8'));
const entry = Object.keys(manifest).find(key => manifest[key].isEntry);
assert(entry, 'Missing application entry in the Vite manifest');
const seen = new Set();
function staticImports(key) {
  if (seen.has(key)) return;
  seen.add(key);
  for (const dependency of manifest[key].imports ?? []) staticImports(dependency);
}
staticImports(entry);
const feature = new Set();
function editorImports(key) {
  if (seen.has(key) || feature.has(key)) return;
  feature.add(key);
  for (const dependency of [...(manifest[key].imports ?? []), ...(manifest[key].dynamicImports ?? [])]) editorImports(dependency);
}
for (const name of ['ResumeEditorWorkspace.tsx', 'BulletEditor.tsx', 'BulletDiff.tsx']) {
  const key = Object.keys(manifest).find(path => path.endsWith('/' + name));
  assert(key && manifest[key].isDynamicEntry && !seen.has(key), `${name} must remain lazy-loaded`);
  editorImports(key);
}
const files = new Set([...feature].flatMap(key => [manifest[key].file, ...(manifest[key].css ?? [])]));
const baselineFiles = new Set([...seen].flatMap(key => [manifest[key].file, ...(manifest[key].css ?? [])]));
const size = [...files].filter(file => !baselineFiles.has(file)).reduce((sum, file) => sum + gzipSync(readFileSync(join(dist, file))).length, 0);
assert(size < 250 * 1024, `Resume editor incremental bundle is ${(size / 1024).toFixed(1)} KiB gzip; limit is 250 KiB`);
console.log(`Resume editor incremental bundle: ${(size / 1024).toFixed(1)} KiB gzip; all three feature chunks are lazy-loaded (limit 250 KiB).`);
