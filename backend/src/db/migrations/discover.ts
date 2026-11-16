import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Migration, VersionedMigration } from './types.js';

export async function discoverMigrations(
  directory = new URL('./versioned/', import.meta.url),
): Promise<VersionedMigration[]> {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(file => file.isFile() && file.name.endsWith('.mjs'))
    .map(file => file.name)
    .sort();

  return Promise.all(files.map(async file => {
    if (!/^\d{14}-[a-z0-9-]+\.mjs$/.test(file)) {
      throw new Error(`Invalid migration filename: ${file}`);
    }
    const url = new URL(file, directory);
    const checksum = createHash('sha256').update(await readFile(url)).digest('hex');
    // Key the module cache by content so repeated discovery can load a changed file.
    url.searchParams.set('checksum', checksum);
    const { default: migration } = await import(url.href) as { default?: Migration };
    const name = file.slice(0, -4);
    if (migration?.name !== name || typeof migration.up !== 'function' || typeof migration.down !== 'function') {
      throw new Error(`Invalid migration export in ${file}`);
    }
    return { ...migration, checksum };
  }));
}