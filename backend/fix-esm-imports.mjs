#!/usr/bin/env node
/**
 * fix-esm-imports.mjs
 *
 * Post-build script that patches all compiled .js files in dist/ to add .js
 * extensions to relative imports. This is required because:
 *  - The source TypeScript files use extensionless relative imports (e.g. './controller')
 *  - TypeScript compiles them as-is to ESM output
 *  - Node.js strict ESM mode requires explicit .js extensions          
 *  - --experimental-specifier-resolution=node was removed in Node 22
 *
 * Run after tsc: `tsc && node fix-esm-imports.mjs`
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, extname } from 'path';

const DIST_DIR = './dist';

const KNOWN_EXTENSIONS = new Set(['.js', '.json', '.cjs', '.mjs', '.node']);

function hasKnownExtension(importPath) {
  const lastSegment = importPath.split('/').pop() ?? '';
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex === -1) return false;
  return KNOWN_EXTENSIONS.has(lastSegment.slice(dotIndex));
}

function fixFile(filePath) {
  let content = readFileSync(filePath, 'utf8');
  let changed = false;

  // Fix: from './foo' or from "../bar/baz"
  const fixedContent = content
    .replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g, (match, quote, importPath) => {
      if (hasKnownExtension(importPath)) return match;
      changed = true;
      return `from ${quote}${importPath}.js${quote}`;
    })
    // Fix dynamic imports: import('./foo') or import("../bar")
    .replace(/import\((['"])(\.\.?\/[^'"]+)\1\)/g, (match, quote, importPath) => {
      if (hasKnownExtension(importPath)) return match;
      changed = true;
      return `import(${quote}${importPath}.js${quote})`;
    })
    // Fix export from: export { foo } from './bar'
    .replace(/from\s+(['"])(\.\.?\/[^'"]+)\1(?=\s*;?\s*$)/gm, (match, quote, importPath) => {
      if (hasKnownExtension(importPath)) return match;
      changed = true;
      return `from ${quote}${importPath}.js${quote}`;
    });

  if (changed) {
    writeFileSync(filePath, fixedContent, 'utf8');
  }
  return changed;
}

function walkAndFix(dir) {
  let fixed = 0;
  let total = 0;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      const result = walkAndFix(fullPath);
      fixed += result.fixed;
      total += result.total;
    } else if (extname(entry) === '.js') {
      total++;
      if (fixFile(fullPath)) fixed++;
    }
  }
  return { fixed, total };
}

console.log(`[fix-esm-imports] Patching relative imports in ${DIST_DIR}...`);
const { fixed, total } = walkAndFix(DIST_DIR);
console.log(`[fix-esm-imports] Done. Patched ${fixed} of ${total} files.`);

// Ship the versioned modules unchanged so the ledger hashes the executed file bytes.
const migrationSource = './src/db/migrations/versioned';
const migrationDist = join(DIST_DIR, 'db/migrations/versioned');
mkdirSync(migrationDist, { recursive: true });
for (const entry of readdirSync(migrationDist, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.mjs')) unlinkSync(join(migrationDist, entry.name));
}
for (const entry of readdirSync(migrationSource, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.mjs')) {
    copyFileSync(join(migrationSource, entry.name), join(migrationDist, entry.name));
  }
}
