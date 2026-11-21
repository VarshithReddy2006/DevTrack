// slowQueryProfiler.test.ts: slow query log with winning plans, against mongodb-memory-server.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { attachSlowQueryProfiler, summarizePlan, type SlowQueryProfiler } from '../../db/slowQueryProfiler.js';

let connection: mongoose.Connection;
let collection: mongoose.mongo.Collection;
let profiler: SlowQueryProfiler | undefined;
const logger = { warn: vi.fn() };

function slowQueries() {
  return logger.warn.mock.calls.map(([, details]) => details as Record<string, unknown>);
}

beforeAll(async () => {
  // A second client on the in-memory server with command monitoring on, like connectDatabase() outside production.
  const { host, port, name } = mongoose.connection;
  connection = await mongoose.createConnection(`mongodb://${host}:${port}/${name}?directConnection=true`, { monitorCommands: true }).asPromise();
  collection = connection.db!.collection('slow_query_fixture');
  await collection.createIndex({ userId: 1 });
});

afterAll(async () => {
  await connection.db!.dropCollection('slow_query_fixture').catch(() => undefined);
  await connection.close();
});

beforeEach(async () => {
  await profiler?.idle();
  profiler?.detach();
  profiler = undefined;
  logger.warn.mockReset();
  await collection.deleteMany({});
  await collection.insertMany([
    { userId: 'u1', score: 1, email: 'ana@example.com' },
    { userId: 'u2', score: 5, email: 'ben@example.com' },
  ]);
});

describe('attachSlowQueryProfiler', () => {
  it('logs an unindexed query as COLLSCAN and an indexed one as IXSCAN', async () => {
    profiler = attachSlowQueryProfiler(connection, { thresholdMs: 0, logger });

    // Explains finish in any order, so wait for each one before the next command.
    await collection.find({ score: 5 }).toArray();
    await profiler.idle();
    await collection.find({ userId: 'u1' }).toArray();
    await profiler.idle();

    expect(slowQueries()).toEqual([
      expect.objectContaining({ event: 'slow_query', collection: 'slow_query_fixture', operation: 'find', plan: 'COLLSCAN', filterKeys: ['score'] }),
      expect.objectContaining({ event: 'slow_query', operation: 'find', plan: 'IXSCAN', indexes: ['userId_1'], filterKeys: ['userId'] }),
    ]);
    expect(slowQueries()[0].durationMs).toEqual(expect.any(Number));
  });

  it('explains aggregations, counts and writes without running them again', async () => {
    profiler = attachSlowQueryProfiler(connection, { thresholdMs: 0, logger });

    await collection.aggregate([{ $match: { userId: 'u2' } }, { $group: { _id: '$userId', total: { $sum: '$score' } } }]).toArray();
    await profiler.idle();
    await collection.countDocuments({ score: { $gt: 0 } });
    await profiler.idle();
    await collection.updateOne({ score: 1 }, { $inc: { score: 1 } });
    await profiler.idle();
    await collection.deleteMany({ email: 'nobody@example.com' });
    await profiler.idle();

    expect(slowQueries().map(entry => [entry.operation, entry.plan])).toEqual([
      ['aggregate', 'IXSCAN'],
      ['aggregate', 'COLLSCAN'],
      ['update', 'COLLSCAN'],
      ['delete', 'COLLSCAN'],
    ]);
    // The explain did not apply the update a second time.
    expect((await collection.findOne({ userId: 'u1' }))?.score).toBe(2);
  });

  it('logs field names but never filter values', async () => {
    profiler = attachSlowQueryProfiler(connection, { thresholdMs: 0, logger });

    await collection.findOne({ email: 'ana@example.com' });
    await profiler.idle();

    expect(slowQueries()).toEqual([expect.objectContaining({ filterKeys: ['email'], plan: 'COLLSCAN' })]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('ana@example.com');
  });

  it('ignores queries under the threshold', async () => {
    profiler = attachSlowQueryProfiler(connection, { thresholdMs: 60_000, logger });

    await collection.find({ score: 5 }).toArray();
    await profiler.idle();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stops logging after detach', async () => {
    profiler = attachSlowQueryProfiler(connection, { thresholdMs: 0, logger });
    profiler.detach();

    await collection.find({ score: 5 }).toArray();
    await profiler.idle();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still logs the slow query when the explain fails', async () => {
    profiler = attachSlowQueryProfiler(connection, { thresholdMs: 0, logger });
    const command = vi.spyOn(mongoose.mongo.Db.prototype, 'command').mockRejectedValueOnce(new Error('explain not allowed'));

    try {
      await collection.find({ score: 5 }).toArray();
      await profiler.idle();
    } finally {
      command.mockRestore();
    }

    expect(slowQueries()).toEqual([expect.objectContaining({ operation: 'find', plan: 'UNKNOWN', explainError: 'explain not allowed' })]);
  });
});

describe('summarizePlan', () => {
  it('reads the slot based engine layout and skips rejected plans', () => {
    const explain = {
      queryPlanner: {
        winningPlan: {
          queryPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'userId_1_nextReviewAt_1' } },
          slotBasedPlan: { stages: '[1] scan s1 s2' },
        },
        rejectedPlans: [{ stage: 'COLLSCAN' }],
      },
    };
    expect(summarizePlan(explain)).toEqual({ plan: 'IXSCAN', stages: ['FETCH', 'IXSCAN'], indexes: ['userId_1_nextReviewAt_1'] });
  });

  it('reports COLLSCAN when any shard scans the collection', () => {
    const explain = {
      queryPlanner: {
        winningPlan: {
          stage: 'SHARD_MERGE',
          shards: [
            { winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'userId_1' } } },
            { winningPlan: { stage: 'COLLSCAN' } },
          ],
        },
      },
    };
    expect(summarizePlan(explain).plan).toBe('COLLSCAN');
  });
});
