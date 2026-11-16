import { randomUUID } from 'node:crypto';
import type { ClientSession, Connection } from 'mongoose';
import { schemaMigrationSchema } from '../models/schemaMigration.model.js';
import type { VersionedMigration } from './types.js';

type Direction = 'up' | 'down';

function mongoErrorCode(error: unknown, code: number): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function ambiguousCommit(error: unknown): boolean {
  return error instanceof Error && 'hasErrorLabel' in error &&
    typeof error.hasErrorLabel === 'function' && error.hasErrorLabel('UnknownTransactionCommitResult');
}

export function createMigrationRunner(connection: Connection, migrations: VersionedMigration[]) {
  const database = connection.db;
  if (!database) throw new Error('Connect to MongoDB before creating the migration runner');
  const db = database;

  const ledger = connection.model('SchemaMigration', schemaMigrationSchema);
  const locks = db.collection<{ _id: string; owner: string; startedAt: Date }>('schema_migration_locks');
  const activeLock = { _id: 'runner' };
  const ordered = [...migrations].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const byName = new Map(ordered.map(migration => [migration.name, migration]));
  if (byName.size !== ordered.length) throw new Error('Duplicate migration names');

  async function readLedger() {
    return ledger.find().read('primary').sort({ name: 1 }).lean().exec();
  }

  type Entry = Awaited<ReturnType<typeof readLedger>>[number];

  function verify(entries: Entry[]) {
    for (const entry of entries) {
      const migration = byName.get(entry.name);
      if (entry.recovery) throw new Error(`Migration ${entry.name} requires manual recovery after ${entry.recovery}`);
      if (!migration && entry.status === 'success') throw new Error(`Migration file missing: ${entry.name}`);
      if (migration && migration.checksum !== entry.checksum) {
        throw new Error(`Migration checksum mismatch: ${entry.name}`);
      }
    }
  }

  async function withLock(action: (transactional: boolean) => Promise<void>) {
    const lock = { ...activeLock, owner: randomUUID(), startedAt: new Date() };
    const writeConcern = { w: 'majority' } as const;
    try {
      await locks.insertOne(lock, { writeConcern });
    } catch (error) {
      if (mongoErrorCode(error, 11000)) throw new Error('A migration run is already locked');
      throw error;
    }

    let release = true;
    try {
      const hello = await db.admin().command({ hello: 1 });
      await action(Boolean(hello.setName || hello.msg === 'isdbgrid'));
    } catch (error) {
      release = !ambiguousCommit(error);
      throw error;
    } finally {
      if (release) await locks.deleteOne({ ...activeLock, owner: lock.owner }, { writeConcern });
    }
  }

  async function inTransaction(action: (session: ClientSession) => Promise<void>) {
    const session = await connection.startSession();
    try {
      await session.withTransaction(() => action(session), {
        readPreference: 'primary',
        writeConcern: { w: 'majority' },
      });
    } finally {
      await session.endSession();
    }
  }

  async function record(
    migration: VersionedMigration,
    batch: number,
    appliedAt: Date | null,
    executionTimeMs: number,
    status: 'success' | 'failed' | 'rolled_back',
    session?: ClientSession,
    recovery?: Direction,
  ) {
    const { name, checksum } = migration;
    await ledger.replaceOne(
      { _id: name },
      { _id: name, name, checksum, batch, appliedAt, executionTimeMs, status, ...(recovery && { recovery }) },
      { upsert: true, ...(session ? { session } : { writeConcern: { w: 'majority' } }) },
    );
  }

  async function execute(
    migration: VersionedMigration,
    direction: Direction,
    batch: number,
    previous?: Entry,
    session?: ClientSession,
  ) {
    if (!session) {
      // Persist the recovery marker before any standalone schema or data changes.
      await record(migration, batch, previous?.appliedAt ?? null, 0, 'failed', undefined, direction);
    }
    const started = Date.now();
    await migration[direction]({ db, session });
    await record(
      migration, batch, direction === 'up' ? new Date() : previous?.appliedAt ?? null,
      Date.now() - started, direction === 'up' ? 'success' : 'rolled_back', session,
    );
  }

  return {
    async status() {
      const entries = new Map((await readLedger()).map(entry => [entry.name, entry]));
      return [...entries.values(), ...ordered.filter(migration => !entries.has(migration.name))
        .map(({ name, checksum }) => ({ name, checksum, status: 'pending' as const }))]
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async check() {
      const entries = await readLedger();
      verify(entries);
      const applied = new Set(entries.filter(entry => entry.status === 'success').map(entry => entry.name));
      const pending = ordered.filter(migration => !applied.has(migration.name));
      if (pending.length) throw new Error(`Run migrate:up before starting. Pending: ${pending.map(m => m.name).join(', ')}`);
      if (await locks.findOne(activeLock, { readPreference: 'primary' })) throw new Error('A migration run is already locked');
    },

    async up() {
      await withLock(async transactional => {
        const entries = await readLedger();
        verify(entries);
        const entriesByName = new Map(entries.map(entry => [entry.name, entry]));
        const batch = entries.reduce((max, entry) => Math.max(max, entry.batch), 0) + 1;
        const pending = ordered.filter(migration => entriesByName.get(migration.name)?.status !== 'success');
        const latestApplied = entries.filter(entry => entry.status === 'success').at(-1);
        if (latestApplied && pending.length && pending[0].name < latestApplied.name) {
          throw new Error(`Migration ${pending[0].name} sorts before applied migration ${latestApplied.name}`);
        }
        for (const migration of pending) {
          const previous = entriesByName.get(migration.name);
          if (!transactional) {
            await execute(migration, 'up', batch, previous);
            continue;
          }
          const started = Date.now();
          try {
            await inTransaction(session => execute(migration, 'up', batch, previous, session));
          } catch (error) {
            if (!ambiguousCommit(error)) {
              await record(migration, batch, previous?.appliedAt ?? null, Date.now() - started, 'failed');
            }
            throw error;
          }
        }
      });
    },

    async down(steps = 1) {
      if (!Number.isSafeInteger(steps) || steps < 1) throw new Error('Step must be a positive integer');
      await withLock(async transactional => {
        const entries = await readLedger();
        verify(entries);
        const applied = entries.filter(entry => entry.status === 'success').reverse();
        const batches = [...new Set(applied.map(entry => entry.batch))].sort((a, b) => b - a).slice(0, steps);
        for (const batch of batches) {
          const rollback = async (session?: ClientSession) => {
            for (const entry of applied.filter(candidate => candidate.batch === batch)) {
              await execute(byName.get(entry.name)!, 'down', batch, entry, session);
            }
          };
          if (transactional) await inTransaction(rollback);
          else await rollback();
        }
      });
    },
  };
}