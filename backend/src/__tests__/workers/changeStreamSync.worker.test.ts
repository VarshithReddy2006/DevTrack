// src/__tests__/workers/changeStreamSync.worker.test.ts
// Unit and integration tests for the MongoDB Change Stream synchronization worker.

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import mongoose, { Types } from 'mongoose';
import type Redis from 'ioredis';
import {
  ChangeStreamSyncWorker,
  isReplicaSetSupported,
  createChangeStreamSyncWorker,
  type CollectionSyncConfig,
} from '../../workers/changeStreamSync.worker.js';
import { InMemorySearchProvider } from '../../shared/search/providers/inMemorySearchProvider.js';
import { RedisResumeTokenStore } from '../../shared/search/searchResumeToken.js';
import { RedisLeaderLock, DEFAULT_SEARCH_LEADER_LOCK_KEY } from '../../shared/search/searchLeaderLock.js';

describe('ChangeStreamSyncWorker', () => {
  let searchProvider: InMemorySearchProvider;
  let resumeStoreMap: Map<string, string>;
  let resumeTokenStore: RedisResumeTokenStore;
  let mockRedisForTokens: Partial<Redis>;
  let leaderStoreMap: Map<string, { value: string; expiresAt: number }>;
  let mockRedisForLock: Partial<Redis>;
  let leaderLock: RedisLeaderLock;

  const mockStream = {
    on: vi.fn(),
    close: vi.fn(),
  };

  const testConfig: CollectionSyncConfig = {
    collectionName: 'test_dsa',
    entityType: 'dsa',
    indexName: 'devtrack_dsa',
    model: {
      watch: vi.fn().mockReturnValue(mockStream),
    } as any,
  };

  beforeEach(() => {
    searchProvider = new InMemorySearchProvider();

    // Token store mock
    resumeStoreMap = new Map();
    mockRedisForTokens = {
      get: vi.fn(async (key: string) => resumeStoreMap.get(key) ?? null),
      set: vi.fn(async (key: string, val: string) => {
        resumeStoreMap.set(key, val);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => (resumeStoreMap.delete(key) ? 1 : 0)),
      eval: vi.fn(async (_script: string, _num: number, ...args: Array<string | number>) => {
        const lockKey = String(args[0]);
        const targetKey = String(args[1]);
        const ownerToken = String(args[2]);
        const payload = String(args[3]);

        const leaderEntry = leaderStoreMap.get(lockKey);
        if (leaderEntry && leaderEntry.value === ownerToken && leaderEntry.expiresAt > Date.now()) {
          resumeStoreMap.set(targetKey, payload);
          return 1;
        }
        return 0;
      }),
    } as unknown as Redis;
    resumeTokenStore = new RedisResumeTokenStore(mockRedisForTokens as Redis);

    // Leader lock mock
    leaderStoreMap = new Map();
    mockRedisForLock = {
      set: vi.fn(async (key: string, value: string, _px?: string, ttlMs?: number, nx?: string) => {
        if (nx === 'NX' && leaderStoreMap.has(key)) return null;
        leaderStoreMap.set(key, { value, expiresAt: Date.now() + (ttlMs || 10000) });
        return 'OK';
      }),
      eval: vi.fn(async (_script: string, _num: number, ...args: Array<string | number>) => {
        const key = String(args[0]);
        const owner = String(args[1]);
        const entry = leaderStoreMap.get(key);
        if (entry && entry.value === owner) {
          if (args[2] != null) {
            entry.expiresAt = Date.now() + Number(args[2]);
            return 1;
          }
          leaderStoreMap.delete(key);
          return 1;
        }
        return 0;
      }),
    } as unknown as Redis;
    leaderLock = new RedisLeaderLock({ redisClient: mockRedisForLock as Redis });
  });



  // ==========================================================================
  // Replica Set Preflight
  // ==========================================================================
  describe('Replica Set Preflight', () => {
    it('returns true when connected to a MongoDB replica set with setName', async () => {
      const mockConn = {
        readyState: 1,
        db: {
          command: vi.fn().mockResolvedValue({ setName: 'rs0', hosts: ['localhost:27017'] }),
        },
      } as unknown as mongoose.Connection;

      expect(await isReplicaSetSupported(mockConn)).toBe(true);
    });

    it('returns true when connected to a sharded cluster (mongos)', async () => {
      const mockConn = {
        readyState: 1,
        db: {
          command: vi.fn().mockResolvedValue({ msg: 'isdbgrid' }),
        },
      } as unknown as mongoose.Connection;

      expect(await isReplicaSetSupported(mockConn)).toBe(true);
    });

    it('returns false when connected to a standalone MongoDB without replica set', async () => {
      const mockConn = {
        readyState: 1,
        db: {
          command: vi.fn().mockResolvedValue({ ismaster: true }), // No setName, no isdbgrid
        },
      } as unknown as mongoose.Connection;

      expect(await isReplicaSetSupported(mockConn)).toBe(false);
    });

    it('returns false when MongoDB is disconnected (readyState !== 1)', async () => {
      const mockConn = {
        readyState: 0,
      } as unknown as mongoose.Connection;

      expect(await isReplicaSetSupported(mockConn)).toBe(false);
    });

    it('returns false when MongoDB command throws an error', async () => {
      const mockConn = {
        readyState: 1,
        db: {
          command: vi.fn().mockRejectedValue(new Error('Connection failed')),
        },
      } as unknown as mongoose.Connection;

      expect(await isReplicaSetSupported(mockConn)).toBe(false);
    });
  });

  // ==========================================================================
  // Leadership & Standby Lifecycle
  // ==========================================================================
  describe('Leadership Lifecycle', () => {
    it('starts as active leader when lease is acquired', async () => {
      const worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [testConfig],
        connection: { readyState: 1, db: { command: vi.fn().mockResolvedValue({ setName: 'rs0' }) } } as any,
      });

      const leaderSpy = vi.fn();
      worker.on('leader', leaderSpy);

      await worker.start();

      expect(worker.isLeader).toBe(true);
      expect(worker.isRunning).toBe(true);
      expect(leaderSpy).toHaveBeenCalledTimes(1);

      await worker.stop();
    });

    it('stands by as follower when lease is held by another worker', async () => {
      // Simulate another worker holding the lock
      leaderStoreMap.set(DEFAULT_SEARCH_LEADER_LOCK_KEY, { value: 'other-worker', expiresAt: Date.now() + 10000 });

      const worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [testConfig],
        connection: { readyState: 1, db: { command: vi.fn().mockResolvedValue({ setName: 'rs0' }) } } as any,
      });

      const followerSpy = vi.fn();
      worker.on('follower', followerSpy);

      await worker.start();

      expect(worker.isLeader).toBe(false);
      expect(followerSpy).toHaveBeenCalledTimes(1);

      await worker.stop();
    });

    it('shuts down active sync and discards pending buffers when leadership is lost', async () => {
      const worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [testConfig],
        connection: { readyState: 1, db: { command: vi.fn().mockResolvedValue({ setName: 'rs0' }) } } as any,
      });

      await worker.start();
      expect(worker.isLeader).toBe(true);

      const lostSpy = vi.fn();
      worker.on('leadership_lost', lostSpy);

      // Simulate leadership lost callback
      (worker as any).handleLeadershipLost();

      expect(worker.isLeader).toBe(false);
      expect(lostSpy).toHaveBeenCalledTimes(1);

      await worker.stop();
    });
  });

  // ==========================================================================
  // Event Processing, Document Mapping & Privacy Enforcement
  // ==========================================================================
  describe('Change Event Processing & Privacy Gating', () => {
    let worker: ChangeStreamSyncWorker;

    beforeEach(async () => {
      worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        maxBatchSize: 10,
        batchDelayMs: 100,
        monitoredCollections: [testConfig],
        connection: { readyState: 1, db: { command: vi.fn().mockResolvedValue({ setName: 'rs0' }) } } as any,
      });

      await worker.start();
    });

    afterEach(async () => {
      await worker.stop();
    });

    it('processes an insert event: maps and indexes eligible document', async () => {
      const problemId = new Types.ObjectId();
      const insertChange = {
        _id: { _data: 'resume-token-1' },
        operationType: 'insert',
        fullDocument: {
          _id: problemId,
          title: 'Binary Tree Inorder Traversal',
          category: 'Trees',
          platform: 'leetcode',
          difficulty: 'easy',
          tags: ['tree', 'dfs'],
        },
        documentKey: { _id: problemId },
      };

      await worker.handleChangeEvent(testConfig, insertChange);
      await worker.flushCollectionBatch(testConfig);

      const searchRes = await searchProvider.search('devtrack_dsa', 'binary');
      expect(searchRes.totalHits).toBe(1);
      expect(searchRes.hits[0].document.title).toBe('Binary Tree Inorder Traversal');

      // Assert resume token was persisted
      const token = await resumeTokenStore.getResumeToken(testConfig.collectionName);
      expect(token).toEqual({ _data: 'resume-token-1' });
    });

    it('processes an update event with updateLookup: maps and indexes updated document', async () => {
      const problemId = new Types.ObjectId();
      const updateChange = {
        _id: { _data: 'resume-token-update' },
        operationType: 'update',
        fullDocument: {
          _id: problemId,
          title: 'Graph Valid Tree',
          category: 'Graph',
          platform: 'leetcode',
          difficulty: 'medium',
        },
        documentKey: { _id: problemId },
      };

      await worker.handleChangeEvent(testConfig, updateChange);
      await worker.flushCollectionBatch(testConfig);

      const searchRes = await searchProvider.search('devtrack_dsa', 'graph');
      expect(searchRes.totalHits).toBe(1);
      expect(searchRes.hits[0].document.title).toBe('Graph Valid Tree');
    });

    it('processes a delete event: removes document from search index', async () => {
      const problemId = new Types.ObjectId().toString();

      // Pre-seed search index
      await searchProvider.indexDocument('devtrack_dsa', problemId, {
        id: problemId,
        type: 'dsa',
        title: 'Delete Me Problem',
      });
      expect((await searchProvider.search('devtrack_dsa', 'delete')).totalHits).toBe(1);

      const deleteChange = {
        _id: { _data: 'resume-token-del' },
        operationType: 'delete',
        documentKey: { _id: problemId },
      };

      await worker.handleChangeEvent(testConfig, deleteChange);
      await worker.flushCollectionBatch(testConfig);

      expect((await searchProvider.search('devtrack_dsa', 'delete')).totalHits).toBe(0);
    });

    it('PRIVACY GATE: purges profile from search when transitioned to private/unpublished', async () => {
      const profileConfig: CollectionSyncConfig = {
        collectionName: 'test_profiles',
        entityType: 'profile',
        indexName: 'devtrack_profiles',
        model: { watch: vi.fn().mockReturnValue(mockStream) } as any,
      };

      const profileId = new Types.ObjectId().toString();

      // Initially indexed
      await searchProvider.indexDocument('devtrack_profiles', profileId, {
        id: profileId,
        type: 'profile',
        title: 'alice_dev',
      });
      expect((await searchProvider.search('devtrack_profiles', 'alice')).totalHits).toBe(1);

      // Event arrives where user set visibility: 'private'
      const privateChange = {
        _id: { _data: 'token-privatize' },
        operationType: 'update',
        fullDocument: {
          _id: profileId,
          username: 'alice_dev',
          published: true,
          visibility: 'private', // INELIGIBLE!
          isIndexable: true,
        },
        documentKey: { _id: profileId },
      };

      await worker.handleChangeEvent(profileConfig, privateChange);
      await worker.flushCollectionBatch(profileConfig);

      // Assert profile was immediately purged from search
      expect((await searchProvider.search('devtrack_profiles', 'alice')).totalHits).toBe(0);
    });

    it('VERIFICATION GATE: purges project from search when status is rejected/unverified', async () => {
      const projectConfig: CollectionSyncConfig = {
        collectionName: 'test_projects',
        entityType: 'project',
        indexName: 'devtrack_projects',
        model: { watch: vi.fn().mockReturnValue(mockStream) } as any,
      };

      const projectId = new Types.ObjectId().toString();

      // Initially indexed
      await searchProvider.indexDocument('devtrack_projects', projectId, {
        id: projectId,
        type: 'project',
        title: 'owner/cool-repo',
      });
      expect((await searchProvider.search('devtrack_projects', 'cool-repo')).totalHits).toBe(1);

      // Event arrives where project status was changed to 'rejected'
      const rejectedChange = {
        _id: { _data: 'token-rejected' },
        operationType: 'update',
        fullDocument: {
          _id: projectId,
          repoFullName: 'owner/cool-repo',
          verification: { status: 'rejected' }, // INELIGIBLE!
        },
        documentKey: { _id: projectId },
      };

      await worker.handleChangeEvent(projectConfig, rejectedChange);
      await worker.flushCollectionBatch(projectConfig);

      // Assert project was purged from search
      expect((await searchProvider.search('devtrack_projects', 'cool-repo')).totalHits).toBe(0);
    });
  });

  // ==========================================================================
  // Checkpoint Ordering & Batching Safety
  // ==========================================================================
  describe('Checkpoint Ordering & Fault Resilience', () => {
    it('CHECKPOINT SAFETY: does NOT advance resume token if search provider write fails', async () => {
      const failingProvider: Partial<InMemorySearchProvider> = {
        indexDocuments: vi.fn().mockRejectedValue(new Error('Search engine unavailable')),
        deleteDocuments: vi.fn().mockResolvedValue(undefined),
      };

      const worker = new ChangeStreamSyncWorker({
        searchProvider: failingProvider as InMemorySearchProvider,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [testConfig],
        connection: { readyState: 1, db: { command: vi.fn().mockResolvedValue({ setName: 'rs0' }) } } as any,
      });

      await worker.start();

      const insertChange = {
        _id: { _data: 'token-should-not-advance' },
        operationType: 'insert',
        fullDocument: {
          _id: new Types.ObjectId(),
          title: 'Test Problem',
        },
        documentKey: { _id: new Types.ObjectId() },
      };

      await worker.handleChangeEvent(testConfig, insertChange);

      // Flushing should fail
      await expect(worker.flushCollectionBatch(testConfig)).rejects.toThrow('Search engine unavailable');

      // Verify resume token was NEVER saved in Redis
      const token = await resumeTokenStore.getResumeToken(testConfig.collectionName);
      expect(token).toBeNull();

      await worker.stop();
    });

    it('batches multiple events and flushes immediately when maxBatchSize is reached', async () => {
      const worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        maxBatchSize: 3, // Flush every 3 events
        batchDelayMs: 10_000,
        monitoredCollections: [testConfig],
        connection: { readyState: 1, db: { command: vi.fn().mockResolvedValue({ setName: 'rs0' }) } } as any,
      });

      await worker.start();

      const flushSpy = vi.fn();
      worker.on('flushed', flushSpy);

      // Send 2 events (under limit)
      await worker.handleChangeEvent(testConfig, {
        _id: 'tok-1',
        operationType: 'insert',
        fullDocument: { _id: '1', title: 'Problem 1' },
        documentKey: { _id: '1' },
      });
      await worker.handleChangeEvent(testConfig, {
        _id: 'tok-2',
        operationType: 'insert',
        fullDocument: { _id: '2', title: 'Problem 2' },
        documentKey: { _id: '2' },
      });

      expect(flushSpy).not.toHaveBeenCalled();

      // Send 3rd event (hits maxBatchSize = 3)
      await worker.handleChangeEvent(testConfig, {
        _id: 'tok-3',
        operationType: 'insert',
        fullDocument: { _id: '3', title: 'Problem 3' },
        documentKey: { _id: '3' },
      });

      expect(flushSpy).toHaveBeenCalledTimes(1);

      // Checkpoint must advance to tok-3
      const token = await resumeTokenStore.getResumeToken(testConfig.collectionName);
      expect(token).toBe('tok-3');

      await worker.stop();
    });

    it('graceful shutdown flushes remaining partial batch and persists checkpoint', async () => {
      const worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        maxBatchSize: 100, // Large threshold
        batchDelayMs: 60_000,
        monitoredCollections: [testConfig],
        connection: { readyState: 1, db: { command: vi.fn().mockResolvedValue({ setName: 'rs0' }) } } as any,
      });

      await worker.start();

      await worker.handleChangeEvent(testConfig, {
        _id: 'shutdown-token-42',
        operationType: 'insert',
        fullDocument: { _id: '42', title: 'Shutdown Problem' },
        documentKey: { _id: '42' },
      });

      // Stop worker: should flush pending batch before releasing lease
      await worker.stop();

      const token = await resumeTokenStore.getResumeToken(testConfig.collectionName);
      expect(token).toBe('shutdown-token-42');

      const searchRes = await searchProvider.search('devtrack_dsa', 'shutdown');
      expect(searchRes.totalHits).toBe(1);
    });
  });

  // ==========================================================================
  // Factory Helper
  // ==========================================================================
  describe('Factory Helper', () => {
    it('creates an instance via createChangeStreamSyncWorker()', () => {
      const instance = createChangeStreamSyncWorker();
      expect(instance).toBeInstanceOf(ChangeStreamSyncWorker);
    });
  });

  // ==========================================================================
  // SEC-01: Batch Loss Prevention & Buffer Protection
  // ==========================================================================
  describe('SEC-01: Batch Loss Prevention & Buffer Protection', () => {
    it('retains pending items in batchMap when search provider write fails', async () => {
      const failingProvider = {
        name: 'failing',
        indexDocuments: vi.fn().mockRejectedValue(new Error('SearchProvider network failure')),
        deleteDocuments: vi.fn().mockResolvedValue(undefined),
        indexDocument: vi.fn(),
        deleteDocument: vi.fn(),
        search: vi.fn(),
        clear: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
      };

      const worker = new ChangeStreamSyncWorker({
        searchProvider: failingProvider as any,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [testConfig],
        batchDelayMs: 1000,
      });

      await worker.start();
      expect(worker.isLeader).toBe(true);

      const dsaDoc = {
        _id: new Types.ObjectId(),
        title: 'Pending Retention Test',
        platform: 'leetcode',
        difficulty: 'easy',
        url: 'https://leetcode.com/problems/test/',
        status: 'solved',
      };

      await worker.handleChangeEvent(testConfig, {
        operationType: 'insert',
        _id: 'token-retain-1',
        fullDocument: dsaDoc,
      });

      const pendingBefore = (worker as any).pendingBatches.get(testConfig.collectionName);
      expect(pendingBefore.size).toBe(1);

      // Attempt manual flush which will fail
      await expect(worker.flushCollectionBatch(testConfig)).rejects.toThrow('SearchProvider network failure');

      // Crucial: pendingBatches must STILL contain the unwritten item!
      const pendingAfter = (worker as any).pendingBatches.get(testConfig.collectionName);
      expect(pendingAfter.size).toBe(1);
      expect(pendingAfter.has(String(dsaDoc._id))).toBe(true);

      // Checkpoint must NOT be updated
      const token = await resumeTokenStore.getResumeToken(testConfig.collectionName);
      expect(token).toBeNull();

      await worker.stop();
    });

    it('evicts only successfully flushed items and preserves items added during flush', async () => {
      let resolveWrite: () => void;
      let callCount = 0;
      const slowProvider = {
        name: 'slow',
        indexDocuments: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return new Promise<void>((resolve) => {
              resolveWrite = resolve;
            });
          }
          return Promise.resolve();
        }),
        deleteDocuments: vi.fn().mockResolvedValue(undefined),
        indexDocument: vi.fn(),
        deleteDocument: vi.fn(),
        search: vi.fn(),
        clear: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
      };

      const worker = new ChangeStreamSyncWorker({
        searchProvider: slowProvider as any,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [testConfig],
        batchDelayMs: 10000,
      });

      await worker.start();

      const doc1 = {
        _id: new Types.ObjectId(),
        title: 'Initial Item',
        platform: 'leetcode',
        difficulty: 'easy',
        url: 'https://leetcode.com/p1',
        status: 'solved',
      };

      await worker.handleChangeEvent(testConfig, {
        operationType: 'insert',
        _id: 'token-initial-1',
        fullDocument: doc1,
      });

      // Start flush asynchronously
      const flushPromise = worker.flushCollectionBatch(testConfig);

      // While write is in flight, a second change arrives
      const doc2 = {
        _id: new Types.ObjectId(),
        title: 'Mid-flight Item',
        platform: 'leetcode',
        difficulty: 'medium',
        url: 'https://leetcode.com/p2',
        status: 'solved',
      };

      await worker.handleChangeEvent(testConfig, {
        operationType: 'insert',
        _id: 'token-midflight-2',
        fullDocument: doc2,
      });

      // Complete the in-flight provider write
      resolveWrite!();
      await flushPromise;

      // Pending batches should now ONLY contain doc2 (doc1 evicted)
      const pending = (worker as any).pendingBatches.get(testConfig.collectionName);
      expect(pending.size).toBe(1);
      expect(pending.has(String(doc1._id))).toBe(false);
      expect(pending.has(String(doc2._id))).toBe(true);

      await worker.stop();
    });

    it('guards against unbounded buffer growth with maxBufferSize', async () => {
      const worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [testConfig],
        maxBatchSize: 100,
        batchDelayMs: 10000,
        maxBufferSize: 3,
      });

      await worker.start();

      for (let i = 1; i <= 5; i++) {
        await worker.handleChangeEvent(testConfig, {
          operationType: 'insert',
          _id: `token-${i}`,
          fullDocument: {
            _id: new Types.ObjectId(),
            title: `Item ${i}`,
            platform: 'leetcode',
            difficulty: 'easy',
            url: `https://leetcode.com/p${i}`,
            status: 'solved',
          },
        });
      }

      const pending = (worker as any).pendingBatches.get(testConfig.collectionName);
      expect(pending.size).toBeLessThanOrEqual(3);

      await worker.stop();
    });
  });

  // ==========================================================================
  // SEC-02: Checkpoint Fencing & Lease Loss Demotion
  // ==========================================================================
  describe('SEC-02: Checkpoint Fencing & Lease Loss Demotion', () => {
    it('demotes worker and halts streams when checkpoint fence is rejected by Redis', async () => {
      const worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [testConfig],
        batchDelayMs: 10000,
      });

      await worker.start();
      expect(worker.isLeader).toBe(true);

      const leadershipLostSpy = vi.fn();
      worker.on('leadership_lost', leadershipLostSpy);

      // Enqueue an event
      await worker.handleChangeEvent(testConfig, {
        operationType: 'insert',
        _id: 'token-fenced-test',
        fullDocument: {
          _id: new Types.ObjectId(),
          title: 'Fence Test',
          platform: 'leetcode',
          difficulty: 'easy',
          url: 'https://leetcode.com/pfence',
          status: 'solved',
        },
      });

      // Simulate lease stolen by another worker in Redis
      const lockKey = leaderLock.lockKey;
      leaderStoreMap.set(lockKey, { value: 'successor-worker-other-uuid', expiresAt: Date.now() + 10000 });

      // Trigger flush
      await worker.flushCollectionBatch(testConfig);

      // Verify leadership was lost
      expect(worker.isLeader).toBe(false);
      expect(leadershipLostSpy).toHaveBeenCalled();

      // Checkpoint was NOT written
      const token = await resumeTokenStore.getResumeToken(testConfig.collectionName);
      expect(token).toBeNull();

      await worker.stop();
    });
  });

  // ==========================================================================
  // SEC-04: Stream Lifecycle & Asynchronous Shutdown
  // ==========================================================================
  describe('SEC-04: Stream Lifecycle & Asynchronous Shutdown', () => {
    it.each([
      ['invalidate event', async (worker: ChangeStreamSyncWorker, config: CollectionSyncConfig) => {
        await worker.handleChangeEvent(config, { operationType: 'invalidate', _id: { _data: 'invalidate-token' } });
      }],
      ['expired resume token', async (worker: ChangeStreamSyncWorker, config: CollectionSyncConfig) => {
        await (worker as any).handleStreamError(config, Object.assign(new Error('Resume token is no longer available'), { code: 286 }));
      }],
    ])('rebuilds the search index and starts fresh after %s', async (_scenario, triggerRecovery) => {
      const sourceDocument = {
        _id: new Types.ObjectId(),
        title: 'Recovered Problem',
        category: 'Trees',
        platform: 'leetcode',
        difficulty: 'easy',
        tags: ['tree'],
      };
      const streams = [0, 1].map(() => ({
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }));
      const watch = vi.fn().mockImplementation(() => streams.shift());
      const find = vi.fn(() => ({ lean: () => Promise.resolve([sourceDocument]) }));
      const recoveryConfig: CollectionSyncConfig = {
        ...testConfig,
        model: { watch, find } as any,
      };
      const worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [recoveryConfig],
        connection: { readyState: 1, db: { command: vi.fn().mockResolvedValue({ setName: 'rs0' }) } } as any,
      });

      await searchProvider.indexDocument(recoveryConfig.indexName, 'stale-id', {
        id: 'stale-id', type: 'dsa', title: 'Stale Problem',
      });
      await resumeTokenStore.saveResumeToken(recoveryConfig.collectionName, { _data: 'old-token' });
      await worker.start();
      await triggerRecovery(worker, recoveryConfig);

      expect(watch).toHaveBeenCalledTimes(2);
      expect(watch.mock.calls[1][1]).not.toHaveProperty('resumeAfter');
      expect(await resumeTokenStore.getResumeToken(recoveryConfig.collectionName)).toBeNull();
      expect((await searchProvider.search(recoveryConfig.indexName, 'stale')).totalHits).toBe(0);
      expect((await searchProvider.search(recoveryConfig.indexName, 'recovered')).totalHits).toBe(1);
      expect(find).toHaveBeenCalledWith({});

      await worker.stop();
    });

    it('awaits stream.close() and removes change listeners on stream close', async () => {
      let closeCalled = false;
      const asyncCloseStream = {
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        close: vi.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 20));
          closeCalled = true;
        }),
      };

      const customConfig: CollectionSyncConfig = {
        ...testConfig,
        model: {
          watch: vi.fn().mockReturnValue(asyncCloseStream),
        } as any,
      };

      const worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [customConfig],
      });

      await worker.start();
      await worker.stop();

      expect(asyncCloseStream.removeAllListeners).toHaveBeenCalledWith('change');
      expect(asyncCloseStream.removeAllListeners).toHaveBeenCalledWith('error');
      expect(asyncCloseStream.close).toHaveBeenCalled();
      expect(closeCalled).toBe(true);
    });

    it('handles concurrent stop() calls safely via shared stopPromise', async () => {
      const worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [testConfig],
      });

      await worker.start();
      expect(worker.isRunning).toBe(true);

      // Fire concurrent stop() calls
      const [res1, res2, res3] = await Promise.all([
        worker.stop(),
        worker.stop(),
        worker.stop(),
      ]);

      expect(res1).toBeUndefined();
      expect(res2).toBeUndefined();
      expect(res3).toBeUndefined();
      expect(worker.isRunning).toBe(false);
      expect(worker.isLeader).toBe(false);
    });
  });

  // ==========================================================================
  // Live Change Stream Integration (MongoMemoryReplSet)
  // ==========================================================================
  describe('Live Change Stream Integration (MongoMemoryReplSet)', () => {
    it('synchronizes a live DsaProblem insert via MongoDB Change Stream into search provider', async () => {
      // Ensure collection exists in MongoDB
      await mongoose.model('DsaProblem').createCollection();

      const liveConfig: CollectionSyncConfig = {
        collectionName: mongoose.model('DsaProblem').collection.name,
        entityType: 'dsa',
        indexName: 'devtrack_dsa',
        model: mongoose.model('DsaProblem'),
      };

      const worker = new ChangeStreamSyncWorker({
        searchProvider,
        resumeTokenStore,
        leaderLock,
        monitoredCollections: [liveConfig],
        batchDelayMs: 20,
      });

      await worker.start();
      expect(worker.isLeader).toBe(true);

      const ownerId = new Types.ObjectId();
      await mongoose.model('DsaProblem').create({
        userId: ownerId,
        title: 'Merge K Sorted Lists',
        platform: 'leetcode',
        difficulty: 'hard',
        url: 'https://leetcode.com/problems/merge-k-sorted-lists/',
        category: 'Heap',
        tags: ['heap', 'divide-and-conquer'],
        status: 'solved',
      });

      // Await flush with polling fallback up to 6s under parallel suite load
      for (let i = 0; i < 60; i++) {
        const res = await searchProvider.search('devtrack_dsa', 'merge');
        if (res.totalHits > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Verify search provider has indexed the problem
      const searchRes = await searchProvider.search('devtrack_dsa', 'merge');
      expect(searchRes.totalHits).toBe(1);
      expect(searchRes.hits[0].document.title).toBe('Merge K Sorted Lists');

      // Verify resume token was persisted in Redis
      const token = await resumeTokenStore.getResumeToken(liveConfig.collectionName);
      expect(token).not.toBeNull();

      await worker.stop();
    });
  });
});
