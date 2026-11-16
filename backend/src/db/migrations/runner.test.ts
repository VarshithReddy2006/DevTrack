import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Connection } from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverMigrations } from './discover.js';
import { createMigrationRunner } from './runner.js';
import type { VersionedMigration } from './types.js';

const runs = 'migration_test_runs';

function migration(version: number): VersionedMigration {
  const name = `2026111600000${version}-sample`;
  return {
    name,
    checksum: `checksum-${version}`,
    async up({ db, session }) {
      await db.collection(runs).insertOne({ name }, { session });
    },
    async down({ db, session }) {
      await db.collection(runs).deleteOne({ name }, { session });
    },
  };
}

function runner(migrations: VersionedMigration[], connection = mongoose.connection) {
  return createMigrationRunner(connection, migrations);
}

async function appliedNames(connection = mongoose.connection) {
  return (await connection.db!.collection(runs).find().toArray()).map(row => row.name);
}

afterEach(async () => {
  await mongoose.connection.db!.collection(runs).deleteMany({});
});

describe('migration runner', () => {
  it('checks pending versions and applies an ordered batch exactly once', async () => {
    const migrations = [migration(1), migration(2), migration(3)];
    const subject = runner([...migrations].reverse());
    await expect(subject.check()).rejects.toThrow('Pending:');
    await subject.up();
    const ledger = await subject.status();
    await subject.up();
    expect(await appliedNames()).toEqual(migrations.map(item => item.name));
    expect(await subject.status()).toEqual(ledger);
    await expect(subject.down(0)).rejects.toThrow('positive integer');
    expect(ledger).toMatchObject(migrations.map(({ name, checksum }) => ({
      name, checksum, batch: 1, appliedAt: expect.any(Date), executionTimeMs: expect.any(Number), status: 'success',
    })));
    await expect(subject.check()).resolves.toBeUndefined();
  });

  it('rejects a new migration that sorts before an applied version', async () => {
    const later = migration(2);
    await runner([later]).up();
    await expect(runner([migration(1), later]).up()).rejects.toThrow('sorts before applied migration');
    expect(await appliedNames()).toEqual([later.name]);
  });

  it('rolls back only the latest batch in reverse order and can reapply it', async () => {
    const initial = migration(1);
    const second = migration(2);
    const third = migration(3);
    const rolledBack: string[] = [];
    for (const item of [second, third]) {
      const down = item.down;
      item.down = async context => {
        rolledBack.push(item.name);
        await down(context);
      };
    }
    await runner([initial]).up();
    const subject = runner([third, initial, second]);
    await subject.up();
    await subject.down(1);
    await expect(runner([initial]).check()).resolves.toBeUndefined();
    expect(rolledBack).toEqual([third.name, second.name]);
    expect(await appliedNames()).toEqual([initial.name]);
    expect((await subject.status()).map(entry => entry.status)).toEqual(['success', 'rolled_back', 'rolled_back']);
    await subject.up();
    expect(await appliedNames()).toEqual([initial.name, second.name, third.name]);
  });

  it('detects changed file bytes and missing applied files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devtrack-migrations-'));
    const url = pathToFileURL(directory + sep);
    const name = '20261116000001-checksum';
    const file = join(directory, name + '.mjs');
    const source = `export default { name: '${name}', async up() {}, async down() {} };`;
    try {
      await writeFile(file, source);
      await runner(await discoverMigrations(url)).up();
      await writeFile(file, source + '\n// changed');
      const subject = runner(await discoverMigrations(url));
      await expect(subject.up()).rejects.toThrow('checksum mismatch');
      await expect(subject.down()).rejects.toThrow('checksum mismatch');
      await expect(subject.check()).rejects.toThrow('checksum mismatch');
      await expect(runner([]).check()).rejects.toThrow('Migration file missing');
    } finally {
      await rm(file, { force: true });
      await rmdir(directory);
    }
  });

  it('aborts failed writes and resumes at the failed migration on a replica set', async () => {
    const first = migration(1);
    const failing = migration(2);
    const up = failing.up;
    let fail = true;
    failing.up = async context => {
      await up(context);
      if (fail) throw new Error('apply failed');
    };
    const subject = runner([first, failing, migration(3)]);
    await expect(subject.up()).rejects.toThrow('apply failed');
    expect(await appliedNames()).toEqual([first.name]);
    expect((await subject.status()).map(entry => entry.status)).toEqual(['success', 'failed', 'pending']);
    fail = false;
    await subject.up();
    expect((await subject.status()).map(entry => entry.status)).toEqual(['success', 'success', 'success']);
  });

  it('keeps the entire rollback batch applied when one reversal fails', async () => {
    const first = migration(1);
    const second = migration(2);
    const down = first.down;
    first.down = async context => {
      await down(context);
      throw new Error('reversal failed');
    };
    const subject = runner([first, second]);
    await subject.up();
    await expect(subject.down()).rejects.toThrow('reversal failed');
    expect(await appliedNames()).toEqual([first.name, second.name]);
    expect((await subject.status()).map(entry => entry.status)).toEqual(['success', 'success']);
  });

  it('rejects another writer while a migration is running', async () => {
    const item = migration(1);
    let markEntered!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    item.up = async () => {
      markEntered();
      await paused;
    };
    const subject = runner([item]);
    const active = subject.up();
    try {
      await Promise.race([entered, active]);
      await expect(subject.up()).rejects.toThrow('already locked');
      await expect(subject.down()).rejects.toThrow('already locked');
    } finally {
      resume();
      await active;
    }
  });

  it('blocks retries after a standalone migration has made partial writes', async () => {
    const server = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
    const connection = mongoose.createConnection(server.getUri(), { autoCreate: false, autoIndex: false });
    try {
      await connection.asPromise();
      const first = migration(1);
      const second = migration(2);
      const up = second.up;
      second.up = async context => {
        await up(context);
        throw new Error('standalone failed');
      };
      const subject = runner([first, second], connection);
      await expect(subject.up()).rejects.toThrow('standalone failed');
      expect(await appliedNames(connection)).toEqual([first.name, second.name]);
      expect(await subject.status()).toMatchObject([{ status: 'success' }, { status: 'failed', recovery: 'up' }]);
      await expect(subject.up()).rejects.toThrow('requires manual recovery');
      await expect(subject.down()).rejects.toThrow('requires manual recovery');
      await expect(subject.check()).rejects.toThrow('requires manual recovery');
    } finally {
      await connection.close();
      await server.stop();
    }
  });
});