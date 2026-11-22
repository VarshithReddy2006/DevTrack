// src/workers/changeStreamSync.worker.ts
// MongoDB Change Stream synchronization worker for DevTrack full-text search indexing.
// Coordinates single-leader continuous oplog sync across DsaProblem, PublicProfile, and VerifiedProject.

import { EventEmitter } from 'node:events';
import mongoose, { type Connection } from 'mongoose';
import {
  DsaProblem,
  PublicProfile,
  VerifiedProject,
} from '../db/models/index.js';
import type { ISearchProvider, SearchDocument, SearchEntityType } from '../shared/search/searchClient.types.js';
import { getSearchClient } from '../shared/search/searchClient.js';
import {
  mapDocumentToSearch,
  extractDocumentId,
} from '../shared/search/documentMappers.js';
import {
  getResumeTokenStore,
  RedisResumeTokenStore,
  FencedCheckpointError,
} from '../shared/search/searchResumeToken.js';
import {
  RedisLeaderLock,
  DEFAULT_SEARCH_LEADER_LOCK_KEY,
} from '../shared/search/searchLeaderLock.js';
import { logger } from '../shared/logger.js';

// ============================================================================
// Types & Configuration Contracts
// ============================================================================

export interface CollectionSyncConfig {
  collectionName: string;
  entityType: SearchEntityType;
  indexName: string;
  model: mongoose.Model<any>;
}

export const MONITORED_COLLECTIONS: CollectionSyncConfig[] = [
  {
    collectionName: 'dsaproblems',
    entityType: 'dsa',
    indexName: 'devtrack_dsa',
    model: DsaProblem,
  },
  {
    collectionName: 'publicprofiles',
    entityType: 'profile',
    indexName: 'devtrack_profiles',
    model: PublicProfile,
  },
  {
    collectionName: 'verifiedprojects',
    entityType: 'project',
    indexName: 'devtrack_projects',
    model: VerifiedProject,
  },
];

export interface ChangeStreamSyncWorkerOptions {
  searchProvider?: ISearchProvider;
  resumeTokenStore?: RedisResumeTokenStore;
  leaderLock?: RedisLeaderLock;
  maxBatchSize?: number;
  batchDelayMs?: number;
  pollIntervalMs?: number;
  maxBufferSize?: number;
  connection?: Connection;
  monitoredCollections?: CollectionSyncConfig[];
}

interface QueuedOperation {
  type: 'index' | 'delete';
  id: string;
  doc?: SearchDocument;
  resumeToken: unknown;
  deletedAt?: number;
}

/**
 * Extracts a wall clock or oplog timestamp from a MongoDB change stream event.
 */
export function extractChangeTimestamp(change: any): number {
  if (change?.wallTime instanceof Date) {
    return change.wallTime.getTime();
  }
  if (change?.clusterTime?.getTimestamp && typeof change.clusterTime.getTimestamp === 'function') {
    return change.clusterTime.getTimestamp().getTime();
  }
  if (typeof change?.clusterTime === 'number') {
    return change.clusterTime;
  }
  return Date.now();
}

// ============================================================================
// Preflight Utility: Replica Set & Change Stream Capability
// ============================================================================

/**
 * Verifies whether the active MongoDB connection is a replica set or sharded cluster
 * capable of supporting MongoDB Change Streams.
 */
export async function isReplicaSetSupported(connection?: Connection): Promise<boolean> {
  const conn = connection || mongoose.connection;
  if (conn.readyState !== 1) {
    logger.warn('[changeStreamSync] MongoDB is not connected (readyState !== 1)');
    return false;
  }

  try {
    const db = conn.db;
    if (!db) {
      return false;
    }

    // hello command (fallback to ismaster for older mongod)
    const hello = await db.command({ hello: 1 }).catch(() => db.command({ ismaster: 1 }));
    const isSupported = Boolean(hello && (hello.setName || hello.msg === 'isdbgrid'));

    if (!isSupported) {
      logger.warn('[changeStreamSync] MongoDB is running as standalone; Change Streams require a replica set or mongos cluster', {
        setName: hello?.setName,
        msg: hello?.msg,
      });
    }

    return isSupported;
  } catch (err) {
    logger.warn('[changeStreamSync] Error detecting MongoDB replica set capability', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ============================================================================
// ChangeStreamSyncWorker
// ============================================================================

export class ChangeStreamSyncWorker extends EventEmitter {
  private readonly searchProvider: ISearchProvider;
  private readonly resumeTokenStore: RedisResumeTokenStore;
  private readonly leaderLock: RedisLeaderLock;
  private readonly connection: Connection;
  private readonly monitoredCollections: CollectionSyncConfig[];

  private readonly maxBatchSize: number;
  private readonly batchDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxBufferSize: number;

  private activeStreams = new Map<string, any>();
  private pendingBatches = new Map<string, Map<string, QueuedOperation>>();
  private flushTimers = new Map<string, NodeJS.Timeout>();
  private streamRetryTimers = new Map<string, NodeJS.Timeout>();
  private streamRetryCounts = new Map<string, number>();
  private flushRetryCounts = new Map<string, number>();
  private isFlushing = new Set<string>();
  private readonly maxStreamRetries = 5;
  private readonly maxFlushRetries = 5;

  private followerRetryTimer: NodeJS.Timeout | null = null;
  private stopPromise: Promise<void> | null = null;
  private _isLeader = false;
  private _isRunning = false;
  private _isStopping = false;

  constructor(options: ChangeStreamSyncWorkerOptions = {}) {
    super();
    this.searchProvider = options.searchProvider || getSearchClient();
    this.resumeTokenStore = options.resumeTokenStore || getResumeTokenStore();
    this.leaderLock = options.leaderLock || new RedisLeaderLock({ lockKey: DEFAULT_SEARCH_LEADER_LOCK_KEY });
    this.connection = options.connection || mongoose.connection;
    this.monitoredCollections = options.monitoredCollections || MONITORED_COLLECTIONS;

    this.maxBatchSize = options.maxBatchSize && options.maxBatchSize > 0 ? options.maxBatchSize : 50;
    this.batchDelayMs = options.batchDelayMs && options.batchDelayMs > 0 ? options.batchDelayMs : 100;
    this.pollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0 ? options.pollIntervalMs : 5000;
    this.maxBufferSize = options.maxBufferSize && options.maxBufferSize > 0 ? options.maxBufferSize : 1000;

    // Initialize pending batch map per collection
    for (const c of this.monitoredCollections) {
      this.pendingBatches.set(c.collectionName, new Map());
    }
  }

  public get isLeader(): boolean {
    return this._isLeader;
  }

  public get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Starts the Change Stream sync worker.
   * 1. Validates replica set capability.
   * 2. Coordinates leader election via Redis lease.
   * 3. Streams change events if leader, or stands by as follower.
   */
  public async start(): Promise<boolean> {
    if (this._isRunning) {
      return this._isLeader;
    }

    this._isRunning = true;
    this._isStopping = false;

    // Phase 1: Replica Set Preflight Check
    const supported = await isReplicaSetSupported(this.connection);
    if (!supported) {
      logger.warn('[changeStreamSync] Preflight failed: Change Streams not supported on this MongoDB instance. Worker exiting gracefully.');
      this._isRunning = false;
      return false;
    }

    // Phase 2: Attempt Leader Lease Acquisition
    await this.tryAcquireLeadership();
    return this._isLeader;
  }

  /**
   * Attempts to acquire the leader lease.
   * If acquired, enters active leader sync mode. If not, enters follower standby mode.
   */
  private async tryAcquireLeadership(): Promise<void> {
    if (this._isStopping || !this._isRunning) return;

    try {
      const acquired = await this.leaderLock.acquire();
      if (acquired) {
        this._isLeader = true;
        this.clearFollowerRetry();

        logger.info('[changeStreamSync] Acquired leader lease. Starting change stream synchronization.', {
          ownerToken: this.leaderLock.ownerToken,
        });

        // Start heartbeat with callback for leadership loss
        this.leaderLock.startHeartbeat(() => this.handleLeadershipLost());

        // Start streams across all monitored collections
        await this.startAllStreams();
        this.emit('leader');
      } else {
        this._isLeader = false;
        logger.info('[changeStreamSync] Another worker holds leader lease. Standing by as follower.', {
          pollIntervalMs: this.pollIntervalMs,
        });
        this.scheduleFollowerRetry();
        this.emit('follower');
      }
    } catch (err) {
      this._isLeader = false;
      logger.error('[changeStreamSync] Error during leader lease acquisition attempt', err as Error);
      this.scheduleFollowerRetry();
    }
  }

  private scheduleFollowerRetry(): void {
    if (this.followerRetryTimer || this._isStopping) return;
    this.followerRetryTimer = setTimeout(async () => {
      this.followerRetryTimer = null;
      if (this._isRunning && !this._isLeader && !this._isStopping) {
        await this.tryAcquireLeadership();
      }
    }, this.pollIntervalMs);

    if (typeof this.followerRetryTimer.unref === 'function') {
      this.followerRetryTimer.unref();
    }
  }

  private clearFollowerRetry(): void {
    if (this.followerRetryTimer) {
      clearTimeout(this.followerRetryTimer);
      this.followerRetryTimer = null;
    }
  }

  /**
   * Callback invoked when Redis heartbeat lease renewal fails (e.g. lease expired, stolen, or network partitioned).
   * Shuts down active synchronization immediately to prevent stale writes.
   */
  private handleLeadershipLost(): void {
    if (!this._isLeader) return;

    logger.warn('[changeStreamSync] Leadership lost or expired. Immediately halting change stream consumers and discarding uncommitted buffers.', {
      ownerToken: this.leaderLock.ownerToken,
    });

    this._isLeader = false;

    // Discard uncommitted in-memory batches to prevent stale indexing
    for (const [, timer] of this.flushTimers) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();

    for (const [, timer] of this.streamRetryTimers) {
      clearTimeout(timer);
    }
    this.streamRetryTimers.clear();
    this.flushRetryCounts.clear();

    for (const [, batch] of this.pendingBatches) {
      batch.clear();
    }

    // Close change streams asynchronously
    void this.closeAllStreams();

    this.emit('leadership_lost');

    // Stand by as follower and attempt re-acquisition
    this.scheduleFollowerRetry();
  }

  /**
   * Starts change stream consumers across all configured collections.
   */
  private async startAllStreams(): Promise<void> {
    for (const config of this.monitoredCollections) {
      await this.startStreamForCollection(config);
    }
  }

  /**
   * Starts a change stream on a specific collection.
   */
  private async startStreamForCollection(config: CollectionSyncConfig): Promise<void> {
    if (!this._isLeader || this._isStopping) return;

    try {
      // Read persisted resume token checkpoint
      const resumeToken = await this.resumeTokenStore.getResumeToken(config.collectionName);

      const watchOptions: Record<string, unknown> = {
        fullDocument: 'updateLookup',
      };
      if (resumeToken) {
        watchOptions.resumeAfter = resumeToken;
      }

      logger.info(`[changeStreamSync] Watching collection "${config.collectionName}"`, {
        hasResumeToken: Boolean(resumeToken),
        indexName: config.indexName,
      });

      const changeStream = config.model.watch([], watchOptions);
      if (!changeStream || typeof changeStream.on !== 'function') {
        logger.warn(`[changeStreamSync] Model.watch did not return an EventEmitter for "${config.collectionName}"`);
        return;
      }
      this.activeStreams.set(config.collectionName, changeStream);
      this.streamRetryCounts.delete(config.collectionName);

      changeStream.on('change', async (change: any) => {
        await this.handleChangeEvent(config, change);
      });

      changeStream.on('error', async (err: any) => {
        await this.handleStreamError(config, err);
      });

      changeStream.on('close', () => {
        logger.debug?.(`[changeStreamSync] Stream closed for collection "${config.collectionName}"`);
      });
    } catch (err) {
      logger.error(`[changeStreamSync] Failed to start change stream for "${config.collectionName}"`, err as Error);
      await this.handleStreamError(config, err);
    }
  }

  /**
   * Processes an incoming Change Stream event from MongoDB.
   *
   * Document Mapping & Privacy Enforcement:
   * - 'insert' / 'replace': Maps fullDocument. If eligible -> index; if ineligible -> delete.
   * - 'update': Maps fullDocument (via updateLookup). If eligible -> index; if ineligible -> delete.
   * - 'delete': Extracts document ID -> delete.
   */
  public async handleChangeEvent(config: CollectionSyncConfig, change: any): Promise<void> {
    if (!this._isLeader || this._isStopping) return;

    const resumeToken = change?._id;
    const op = change?.operationType;
    const changeTimestamp = extractChangeTimestamp(change);

    let queueOp: QueuedOperation | null = null;

    if (op === 'insert' || op === 'replace') {
      const fullDoc = change.fullDocument;
      const searchDoc = mapDocumentToSearch(config.entityType, fullDoc);

      if (searchDoc) {
        queueOp = {
          type: 'index',
          id: searchDoc.id,
          doc: searchDoc,
          resumeToken,
        };
      } else {
        const id = extractDocumentId(change.documentKey);
        if (id) {
          queueOp = { type: 'delete', id, resumeToken, deletedAt: changeTimestamp };
        }
      }
    } else if (op === 'update') {
      const fullDoc = change.fullDocument;
      if (!fullDoc) {
        // Document deleted between update and lookup
        const id = extractDocumentId(change.documentKey);
        if (id) {
          queueOp = { type: 'delete', id, resumeToken, deletedAt: changeTimestamp };
        }
      } else {
        const searchDoc = mapDocumentToSearch(config.entityType, fullDoc);
        if (searchDoc) {
          queueOp = {
            type: 'index',
            id: searchDoc.id,
            doc: searchDoc,
            resumeToken,
          };
        } else {
          // Transitioned to ineligible (e.g. published=false or status=rejected) -> Purge from index!
          const id = extractDocumentId(change.documentKey);
          if (id) {
            queueOp = { type: 'delete', id, resumeToken, deletedAt: changeTimestamp };
          }
        }
      }
    } else if (op === 'delete') {
      const id = extractDocumentId(change.documentKey);
      if (id) {
        queueOp = { type: 'delete', id, resumeToken, deletedAt: changeTimestamp };
      }
    } else if (op === 'invalidate') {
      logger.warn(`[changeStreamSync] Stream invalidated for collection "${config.collectionName}". Restarting stream.`);
      await this.restartStreamForCollection(config);
      return;
    }

    if (!queueOp) return;

    // Enqueue in collection's pending batch buffer (deduplicated by document ID)
    let batchMap = this.pendingBatches.get(config.collectionName);
    if (!batchMap) {
      batchMap = new Map();
      this.pendingBatches.set(config.collectionName, batchMap);
    }

    // Guard against unbounded buffer growth on persistent provider failure
    if (batchMap.size >= this.maxBufferSize && !batchMap.has(queueOp.id)) {
      const oldestKey = batchMap.keys().next().value;
      if (oldestKey !== undefined) {
        batchMap.delete(oldestKey);
        logger.warn(`[changeStreamSync] Buffer exceeded maxBufferSize (${this.maxBufferSize}) for "${config.collectionName}"; evicted oldest unwritten event "${oldestKey}" to protect process memory`);
      }
    }

    batchMap.set(queueOp.id, queueOp);

    if (batchMap.size >= this.maxBatchSize) {
      try {
        await this.flushCollectionBatch(config);
      } catch {
        // error handled and emitted inside flushCollectionBatch
      }
    } else {
      this.scheduleCollectionFlush(config);
    }
  }

  private scheduleCollectionFlush(config: CollectionSyncConfig): void {
    if (this.flushTimers.has(config.collectionName)) return;

    const timer = setTimeout(async () => {
      this.flushTimers.delete(config.collectionName);
      try {
        await this.flushCollectionBatch(config);
      } catch {
        // error handled and emitted inside flushCollectionBatch
      }
    }, this.batchDelayMs);

    this.flushTimers.set(config.collectionName, timer);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  private scheduleCollectionFlushWithDelay(config: CollectionSyncConfig, delayMs: number): void {
    if (this.flushTimers.has(config.collectionName)) return;

    const timer = setTimeout(async () => {
      this.flushTimers.delete(config.collectionName);
      await this.flushCollectionBatch(config).catch(() => {});
    }, delayMs);

    this.flushTimers.set(config.collectionName, timer);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  /**
   * Flushes queued operations for a collection to the search provider.
   *
   * CHECKPOINT ORDERING INVARIANT:
   * ------------------------------
   * 1. Check leadership.
   * 2. Send batch writes to search provider.
   * 3. Await provider acknowledgement.
   * 4. Persist resume token to Redis ONLY AFTER provider operation succeeds with atomic leader fencing.
   * If provider throws, resume token is NOT advanced and buffered items are retained for retry.
   */
  public async flushCollectionBatch(config: CollectionSyncConfig): Promise<void> {
    const timer = this.flushTimers.get(config.collectionName);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(config.collectionName);
    }

    if (!this._isLeader && !this._isStopping) {
      this.pendingBatches.get(config.collectionName)?.clear();
      return;
    }

    // Guard against concurrent flushes for the same collection
    if (this.isFlushing.has(config.collectionName)) {
      this.scheduleCollectionFlush(config);
      return;
    }

    const batchMap = this.pendingBatches.get(config.collectionName);
    if (!batchMap || batchMap.size === 0) return;

    this.isFlushing.add(config.collectionName);

    // Snapshot current batch items to flush
    const items = Array.from(batchMap.values());

    const toIndex: Array<{ id: string; doc: SearchDocument }> = [];
    const toDelete: Array<{ id: string; deletedAt?: number }> = [];
    let latestResumeToken: unknown = null;

    for (const item of items) {
      if (item.type === 'index' && item.doc) {
        toIndex.push({ id: item.id, doc: item.doc });
      } else if (item.type === 'delete') {
        toDelete.push({ id: item.id, deletedAt: item.deletedAt });
      }
      latestResumeToken = item.resumeToken;
    }

    try {
      // Step 1: Execute search provider writes
      if (toIndex.length > 0) {
        await this.searchProvider.indexDocuments(config.indexName, toIndex);
      }
      if (toDelete.length > 0) {
        await this.searchProvider.deleteDocuments(config.indexName, toDelete);
      }

      // Step 2: Verify leadership is still intact before advancing checkpoint
      if (!this._isLeader && !this._isStopping) {
        logger.warn(`[changeStreamSync] Leadership lost during indexing; aborting checkpoint persistence for "${config.collectionName}"`);
        return;
      }

      // Step 3: Advance checkpoint ONLY after provider confirmation with atomic leader fencing
      if (latestResumeToken != null) {
        const fencing = {
          lockKey: this.leaderLock.lockKey,
          ownerToken: this.leaderLock.ownerToken,
        };
        await this.resumeTokenStore.saveResumeToken(config.collectionName, latestResumeToken, fencing);
      }

      // Step 4: Evict ONLY the successfully flushed items whose resume tokens haven't been superseded
      for (const flushedItem of items) {
        const current = batchMap.get(flushedItem.id);
        if (current && current.resumeToken === flushedItem.resumeToken) {
          batchMap.delete(flushedItem.id);
        }
      }

      this.flushRetryCounts.delete(config.collectionName);

      this.emit('flushed', {
        collection: config.collectionName,
        indexed: toIndex.length,
        deleted: toDelete.length,
      });
    } catch (err) {
      if (err instanceof FencedCheckpointError) {
        logger.warn(`[changeStreamSync] Checkpoint fence rejected for "${config.collectionName}" (leadership lost). Demoting worker.`, {
          error: err.message,
        });
        this.handleLeadershipLost();
        return;
      }

      // Provider or network error: items remain in batchMap (no eviction).
      const retries = this.flushRetryCounts.get(config.collectionName) || 0;
      if (retries < this.maxFlushRetries) {
        this.flushRetryCounts.set(config.collectionName, retries + 1);
        const delayMs = Math.min(this.batchDelayMs * Math.pow(2, retries), 5000);
        logger.error(`[changeStreamSync] Search provider write failed for collection "${config.collectionName}". Checkpoint NOT advanced. Retrying in ${delayMs}ms.`, err as Error);
        if (this._isLeader && !this._isStopping) {
          this.scheduleCollectionFlushWithDelay(config, delayMs);
        }
      } else {
        logger.error(`[changeStreamSync] Exceeded max flush retries (${this.maxFlushRetries}) for "${config.collectionName}". Checkpoint NOT advanced. Events retained in memory.`, err as Error);
      }

      this.emit('error', err);
      throw err;
    } finally {
      this.isFlushing.delete(config.collectionName);

      // If items remain in batchMap (e.g. added during async flush) and no retry timer is pending, schedule next flush
      if (!this.flushTimers.has(config.collectionName)) {
        const remaining = this.pendingBatches.get(config.collectionName);
        if (remaining && remaining.size > 0 && this._isLeader && !this._isStopping) {
          if (remaining.size >= this.maxBatchSize) {
            void this.flushCollectionBatch(config).catch(() => {});
          } else {
            this.scheduleCollectionFlush(config);
          }
        }
      }
    }
  }

  /**
   * Handles stream errors with controlled backoff.
   */
  private async handleStreamError(config: CollectionSyncConfig, err: any): Promise<void> {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errCode = (err as any)?.code;

    // Check for invalid resume token / oplog history loss (code 286 or 40585)
    if (errCode === 286 || errCode === 40585 || errMsg.includes('ChangeStreamHistoryLost') || errMsg.includes('ResumeTokenInvalid')) {
      logger.error(`[changeStreamSync] FATAL: Resume token is invalid or oplog history was lost for "${config.collectionName}". Stream stopped safely.`, {
        code: errCode,
        error: errMsg,
      });
      await this.closeStreamForCollection(config.collectionName);
      this.emit('error', err);
      return;
    }

    const retries = this.streamRetryCounts.get(config.collectionName) || 0;
    if (retries >= this.maxStreamRetries) {
      logger.error(`[changeStreamSync] Exceeded max stream retries (${this.maxStreamRetries}) for "${config.collectionName}". Stream stopped.`, {
        code: errCode,
        error: errMsg,
      });
      await this.closeStreamForCollection(config.collectionName);
      this.emit('error', err);
      return;
    }

    this.streamRetryCounts.set(config.collectionName, retries + 1);
    const delayMs = Math.min(500 * Math.pow(2, retries), 5000);

    logger.warn(`[changeStreamSync] Transient change stream error on "${config.collectionName}". Retrying in ${delayMs}ms (attempt ${retries + 1}/${this.maxStreamRetries}).`, {
      code: errCode,
      error: errMsg,
    });

    if (this._isLeader && !this._isStopping) {
      const retryTimer = setTimeout(async () => {
        this.streamRetryTimers.delete(config.collectionName);
        if (this._isLeader && !this._isStopping) {
          await this.restartStreamForCollection(config);
        }
      }, delayMs);
      this.streamRetryTimers.set(config.collectionName, retryTimer);
      if (typeof retryTimer.unref === 'function') {
        retryTimer.unref();
      }
    }
  }

  private async restartStreamForCollection(config: CollectionSyncConfig): Promise<void> {
    await this.closeStreamForCollection(config.collectionName);
    if (this._isLeader && !this._isStopping) {
      await this.startStreamForCollection(config);
    }
  }

  private async closeStreamForCollection(collectionName: string): Promise<void> {
    const retryTimer = this.streamRetryTimers.get(collectionName);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.streamRetryTimers.delete(collectionName);
    }
    const stream = this.activeStreams.get(collectionName);
    if (stream) {
      this.activeStreams.delete(collectionName);
      try {
        if (typeof stream.removeAllListeners === 'function') {
          stream.removeAllListeners('change');
          stream.removeAllListeners('error');
        }
        if (typeof stream.close === 'function') {
          await Promise.race([
            stream.close(),
            new Promise((resolve) => setTimeout(resolve, 3000)),
          ]);
        }
      } catch (err) {
        logger.warn(`[changeStreamSync] Error closing stream for "${collectionName}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async closeAllStreams(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const col of Array.from(this.activeStreams.keys())) {
      closePromises.push(this.closeStreamForCollection(col));
    }
    await Promise.allSettled(closePromises);
  }

  /**
   * Graceful shutdown of the worker:
   * 1. Stops accepting new events.
   * 2. Closes change streams asynchronously.
   * 3. Flushes remaining pending batches if still leader.
   * 4. Stops heartbeat renewal.
   * 5. Releases distributed leader lease if held.
   */
  public async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (this._isStopping || !this._isRunning) {
      return;
    }

    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this._isStopping = true;

    logger.info('[changeStreamSync] Initiating graceful shutdown of Change Stream worker.');

    this.clearFollowerRetry();

    // Close change streams asynchronously to stop accepting new events
    await this.closeAllStreams();

    // Flush any pending in-memory batches if still leader
    if (this._isLeader) {
      for (const config of this.monitoredCollections) {
        try {
          await this.flushCollectionBatch(config);
        } catch (err) {
          logger.error(`[changeStreamSync] Error flushing pending batch during shutdown for "${config.collectionName}"`, err as Error);
        }
      }

      this.leaderLock.stopHeartbeat();
      try {
        await this.leaderLock.release();
      } catch (err) {
        logger.warn('[changeStreamSync] Error releasing leader lease during shutdown', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this._isLeader = false;
    this._isRunning = false;
    this._isStopping = false;
    this.stopPromise = null;

    for (const [, timer] of this.flushTimers) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();

    for (const [, timer] of this.streamRetryTimers) {
      clearTimeout(timer);
    }
    this.streamRetryTimers.clear();
    this.flushRetryCounts.clear();

    logger.info('[changeStreamSync] Change Stream worker shutdown complete.');
    this.emit('stopped');
  }
}

// Module factory
export function createChangeStreamSyncWorker(options?: ChangeStreamSyncWorkerOptions): ChangeStreamSyncWorker {
  return new ChangeStreamSyncWorker(options);
}
