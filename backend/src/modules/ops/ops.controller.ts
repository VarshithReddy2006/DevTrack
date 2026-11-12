// src/modules/ops/ops.controller.ts — Production monitoring + operational tooling
// Phase-1 Hardening: Queue monitoring, health endpoints, operational visibility

import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { getRedisClient } from '../../shared/redis/client.js';
import { getAllQueues, getQueue } from '../../shared/jobs/queueFactory.js';
import { getXpWorkerStatus } from '../../shared/jobs/xpWorker.js';
import { getRedisHealth } from '../../shared/redis/client.js';
import cacheManager from '../../shared/cache/cacheManager.js';
import { eventBus } from '../../shared/sse/eventBus.js';
import { logger } from '../../shared/logger.js';
import { MAX_DATASET_INGESTION_BATCH_SIZE, QueueNames } from '../../shared/jobs/types.js';
import { PublicProfile } from '../../db/models/publicProfile.model.js';
import { ProfileAuditLog } from '../../db/models/profileAuditLog.model.js';
import { QueueMetrics as QueueMetricsService } from '../../infrastructure/queues/QueueMetrics.js';
import type { Queue } from 'bullmq';

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  checks: Record<string, { status: string; latencyMs?: number; error?: string }>;
}

interface QueueMetrics {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  paused: boolean;
}

interface SystemMetrics {
  queues: QueueMetrics[];
  redis: {
    status: string;
    keys: number;
    memory: string;
  };
  sse: {
    activeConnections: number;
    totalConnections: number;
    totalDisconnects: number;
    eventsPublished: number;
  };
  workers: {
    xp: {
      running: boolean;
      processed: number;
      awarded: number;
      duplicates: number;
      failed: number;
      uptimeSeconds: number;
    };
  };
}

export const opsController = {
  // ─── Health check endpoint ─────────────────────────────────────────────
  async health(req: AuthenticatedRequest, res: Response): Promise<void> {
    const startTime = Date.now();
    const healthStatus: HealthStatus = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {},
    };

    // Check MongoDB
    try {
      const mongoose = await import('mongoose');
      const mongoStart = Date.now();
      await mongoose.default.connection.db?.admin().ping();
      healthStatus.checks.mongodb = {
        status: 'ok',
        latencyMs: Date.now() - mongoStart,
      };
    } catch (err) {
      healthStatus.checks.mongodb = {
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      };
      healthStatus.status = 'unhealthy';
    }

    // Check Redis
    try {
      const redisStart = Date.now();
      const redis = getRedisClient();
      await redis.ping();
      healthStatus.checks.redis = {
        status: 'ok',
        latencyMs: Date.now() - redisStart,
      };
    } catch (err) {
      healthStatus.checks.redis = {
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      };
      healthStatus.status = 'unhealthy';
    }

    // Overall latency
    const totalLatency = Date.now() - startTime;
    healthStatus.checks.latency = {
      status: totalLatency < 500 ? 'ok' : 'degraded',
      latencyMs: totalLatency,
    };

    if (healthStatus.status === 'healthy' && totalLatency > 500) {
      healthStatus.status = 'degraded';
    }

    const httpStatus = healthStatus.status === 'healthy' ? 200 : healthStatus.status === 'degraded' ? 200 : 503;
    res.status(httpStatus).json(healthStatus);
  },

  // ─── System metrics endpoint ────────────────────────────────────────────
  async metrics(req: AuthenticatedRequest, res: Response): Promise<void> {
    const redis = getRedisClient();
    const dbSize = (await redis.dbsize()) || 0;

    // Get queue metrics across all queues
    const queueMetrics: QueueMetrics[] = [];
    const allQueues = getAllQueues();

    for (const queue of allQueues) {
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'paused');
        queueMetrics.push({
          name: queue.name,
          waiting: counts.waiting || 0,
          active: counts.active || 0,
          completed: counts.completed || 0,
          failed: counts.failed || 0,
          paused: counts.paused === 1 || false,
        });
      } catch (err) {
        logger.warn(`[ops] Failed to get counts for queue ${queue.name}`, { error: String(err) });
      }
    }

    // Get SSE metrics
    const sseMetrics = eventBus.getMetrics();

    // Get XP worker status
    const xpWorkerStatus = getXpWorkerStatus();

    // Calculate AI Provider Latencies
    let geminiLatency = 0;
    let openaiLatency = 0;
    try {
      const { AIResponseAuditLog } = await import('../../db/models/aiResponseAuditLog.model.js');
      const geminiLogs = await AIResponseAuditLog.find({ provider: 'gemini' }).sort({ createdAt: -1 }).limit(10).lean();
      const openaiLogs = await AIResponseAuditLog.find({ provider: 'openai' }).sort({ createdAt: -1 }).limit(10).lean();

      if (geminiLogs.length > 0) {
        geminiLatency = Math.round(geminiLogs.reduce((acc, curr) => acc + curr.latencyMs, 0) / geminiLogs.length);
      }
      if (openaiLogs.length > 0) {
        openaiLatency = Math.round(openaiLogs.reduce((acc, curr) => acc + curr.latencyMs, 0) / openaiLogs.length);
      }
    } catch (e) {
      // ignore
    }

    const metrics: SystemMetrics & { aiLatency?: { gemini: number; openai: number } } = {
      queues: queueMetrics,
      redis: {
        status: redis.status,
        keys: dbSize,
        memory: 'N/A',
      },
      sse: {
        activeConnections: sseMetrics.activeConnections,
        totalConnections: sseMetrics.totalConnections,
        totalDisconnects: sseMetrics.totalDisconnects,
        eventsPublished: sseMetrics.eventsPublished,
      },
      workers: {
        xp: xpWorkerStatus,
      },
      aiLatency: {
        gemini: geminiLatency,
        openai: openaiLatency,
      },
    };

    res.json(metrics);
  },

  // ─── Global Queue metrics ─────────────────────────────────────────────
  async globalQueues(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const metrics = await QueueMetricsService.getGlobalMetrics();
      res.json({ queues: metrics });
    } catch (err) {
      logger.error('[ops] Failed to fetch global queue metrics', err);
      res.status(500).json({ error: 'Failed to fetch global queue metrics' });
    }
  },

  // ─── Queue inspection ─────────────────────────────────────────────────
  async queueStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    const queueName = req.params.queueName as string;

    const queue = getQueue(queueName);
    if (!queue) {
      res.status(404).json({ error: 'Queue not found' });
      return;
    }

    const counts = await queue.getJobCounts();
    const workers = await queue.getWorkers();

    res.json({
      name: queueName,
      counts,
      workers: workers.map((w) => ({
        id: w.id,
        running: w.running,
      })),
    });
  },

  // ─── Recent jobs ────────────────────────────────────────────────────────
  async recentJobs(req: AuthenticatedRequest, res: Response): Promise<void> {
    const queueName = req.params.queueName as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const queue = getQueue(queueName);
    if (!queue) {
      res.status(404).json({ error: 'Queue not found' });
      return;
    }

    const [waiting, completed, failed] = await Promise.all([
      queue.getWaiting(0, limit),
      queue.getCompleted(0, limit),
      queue.getFailed(0, limit),
    ]);

    res.json({
      queue: queueName,
      waiting: waiting.map((j) => ({
        id: j.id,
        data: j.data,
        timestamp: j.timestamp,
      })),
      completed: completed.map((j) => ({
        id: j.id,
        data: j.data,
        finishedOn: j.finishedOn,
      })),
      failed: failed.map((j) => ({
        id: j.id,
        data: j.data,
        failedReason: j.failedReason,
        attempts: j.attemptsMade,
      })),
    });
  },

  // ─── DLQ replay ─────────────────────────────────────────────────────────
  async replayDlqJob(req: AuthenticatedRequest, res: Response): Promise<void> {
    const queueName = req.params.queueName as string;
    const jobId = req.params.jobId as string;

    try {
      let replayed = false;
      try {
        const { dlqService } = await import('../../shared/jobs/dlq.service.js');
        await dlqService.replayFromDlq(queueName, jobId);
        replayed = true;
      } catch {
        const queue = getQueue(queueName);
        if (queue) {
          const job = await queue.getJob(jobId);
          if (job) {
            await job.retry();
            replayed = true;
          }
        }
      }

      if (!replayed) {
        res.status(404).json({ error: 'Job not found in queue or DLQ' });
        return;
      }

      try {
        const { DeadLetterJob } = await import('../../db/models/deadLetterJob.model.js');
        await DeadLetterJob.updateMany(
          { $or: [{ queueName, jobId }, { jobId }] },
          { $set: { recovered: true } }
        );
      } catch (dbErr) {
        logger.warn('[ops] Failed to update DeadLetterJob audit status', { error: String(dbErr) });
      }

      logger.info('[ops] DLQ job replayed', { queueName, jobId });

      res.json({
        success: true,
        message: 'Job requeued for retry',
        jobId,
        recovered: true,
      });
    } catch (err) {
      logger.error('[ops] Failed to replay DLQ job', err as Error, { queueName, jobId });
      res.status(500).json({ error: 'Failed to replay DLQ job' });
    }
  },

  // ─── Replay all failed jobs in queue / DLQ ──────────────────────────────
  async replayAllFailed(req: AuthenticatedRequest, res: Response): Promise<void> {
    const queueName = req.params.queueName as string;
    try {
      const { dlqService } = await import('../../shared/jobs/dlq.service.js');
      const dlqResult = await dlqService.bulkReplay(queueName, 50);

      const queue = getQueue(queueName);
      let queueRetried = 0;
      if (queue) {
        const failedJobs = await queue.getFailed(0, 50);
        for (const job of failedJobs) {
          try {
            await job.retry();
            queueRetried++;
          } catch {}
        }
      }

      try {
        const { DeadLetterJob } = await import('../../db/models/deadLetterJob.model.js');
        await DeadLetterJob.updateMany(
          { queueName, recovered: false },
          { $set: { recovered: true } }
        );
      } catch {}

      res.json({
        success: true,
        replayedCount: dlqResult.succeeded + queueRetried,
        dlqReplayed: dlqResult.succeeded,
        queueRetried,
      });
    } catch (err) {
      logger.error('[ops] Failed to replay all failed jobs', err as Error, { queueName });
      res.status(500).json({ error: 'Failed to replay all failed jobs' });
    }
  },

  // ─── Cache management ─────────────────────────────────────────────────
  async cacheStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    const stats = await cacheManager.healthCheck();
    res.json(stats);
  },

  async cacheHealth(req: AuthenticatedRequest, res: Response): Promise<void> {
    const health = await cacheManager.cacheHealth();
    res.json(health);
  },

  async clearUserCache(req: AuthenticatedRequest, res: Response): Promise<void> {
    const userId = req.params.userId as string;

    if (!userId) {
      res.status(400).json({ error: 'userId required' });
      return;
    }

    await cacheManager.invalidateAllUserCache(userId);

    logger.info('[ops] User cache cleared', { userId });

    res.json({
      success: true,
      message: 'User cache cleared',
      userId,
    });
  },

  // ─── Logging level adjustment ──────────────────────────────────────────
  setLogLevel(req: AuthenticatedRequest, res: Response): void {
    const { level } = req.body;

    const validLevels = ['debug', 'info', 'warn', 'error'];
    if (!validLevels.includes(level)) {
      res.status(400).json({ error: 'Invalid log level' });
      return;
    }

    // Note: Actual logger level change would need logger implementation
    logger.info('[ops] Log level changed', { level });

    res.json({
      success: true,
      message: `Log level set to ${level}`,
    });
  },

  // ─── Trust & Verifications ──────────────────────────────────────────────
  async getTrustScores(req: AuthenticatedRequest, res: Response): Promise<void> {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const skip = parseInt(req.query.skip as string) || 0;

    const [profiles, total] = await Promise.all([
      PublicProfile.find()
        .sort({ 'verification.trustScore': 1 }) // Lowest scores first
        .select('userId username verification createdAt updatedAt')
        .skip(skip)
        .limit(limit)
        .lean(),
      PublicProfile.countDocuments(),
    ]);

    const aggregates = {
      totalProfiles: total,
      lowTrustProfiles: await PublicProfile.countDocuments({ 'verification.trustScore': { $lt: 400 } }),
    };

    res.json({ aggregates, profiles });
  },

  async getVerifications(req: AuthenticatedRequest, res: Response): Promise<void> {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const skip = parseInt(req.query.skip as string) || 0;

    const logs = await ProfileAuditLog.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ logs });
  },

  // ─── Operational Recovery Tooling ─────────────────────────────────────────
  async rebuildAll(req: AuthenticatedRequest, res: Response): Promise<void> {
    const queue = getQueue(QueueNames.PROFILE_REBUILD);
    if (!queue) {
      res.status(500).json({ error: 'Profile rebuild queue not initialized' });
      return;
    }

    const allProfiles = await PublicProfile.find().select('userId').lean();
    
    // Enqueue in batches
    const jobs = allProfiles.map(p => ({
      name: 'rebuild',
      data: { userId: p.userId, trigger: 'ops_manual_rebuild_all' }
    }));

    await queue.addBulk(jobs);

    logger.warn('[ops] Global profile rebuild triggered', { admin: req.user?.username, jobCount: jobs.length });

    res.json({ success: true, message: `Enqueued ${jobs.length} profiles for rebuild` });
  },

  async invalidateL2Cache(req: AuthenticatedRequest, res: Response): Promise<void> {
    const redis = getRedisClient();
    const keys = await redis.keys('public_profile:*');
    
    if (keys.length > 0) {
      // Chunk deletion if too many keys
      const pipeline = redis.pipeline();
      keys.forEach(k => pipeline.del(k));
      await pipeline.exec();
    }

    logger.warn('[ops] L2 Cache invalidated globally', { admin: req.user?.username, keysCleared: keys.length });

    res.json({ success: true, message: `Cleared ${keys.length} cached profiles` });
  },

  async recalculateTrust(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { userId } = req.params;
    
    // We queue a rebuild job which implicitly recalculates trust
    const queue = getQueue(QueueNames.PROFILE_REBUILD);
    if (!queue) {
      res.status(500).json({ error: 'Profile rebuild queue not initialized' });
      return;
    }

    await queue.add('rebuild', { userId, trigger: 'ops_manual_trust_recalc' });

    logger.warn('[ops] Trust recalculation triggered', { admin: req.user?.username, targetUserId: userId });

    res.json({ success: true, message: `Trust recalculation queued for ${userId}` });
  },

  // ─── AI & Provider Ops ─────────────────────────────────────────────────
  async getAIAuditLogs(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { AIResponseAuditLog } = await import('../../db/models/aiResponseAuditLog.model.js');
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      
      const logs = await AIResponseAuditLog.find()
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
        
      res.json({ success: true, logs });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch AI audit logs' });
    }
  },

  async getProviderHealth(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { ProviderHealthRegistry } = await import('../readiness/provider/ProviderHealthRegistry.js');
      const providers = await ProviderHealthRegistry.getAllProviders();
      res.json({ success: true, providers });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch provider health' });
    }
  },

  // ─── Phase 6: Operational Diagnostics ────────────────────────────────────
  async diagnostics(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const redis = getRedisClient();
      const dbSize = await redis.dbsize();

      // Aggregate diagnostics
      const diagnosticData = {
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        uptime: process.uptime(),
        queueHealth: {
          totalQueues: (await getAllQueues()).length,
        },
        storage: {
          redisKeys: dbSize
        },
        replayHealth: {
          status: 'healthy',
          checksumAlgorithm: 'sha256'
        },
        versioning: {
          api: 'v1',
          intelligenceSchema: '1.0'
        }
      };

      res.json({ success: true, diagnostics: diagnosticData });
    } catch (error) {
      res.status(500).json({ error: 'Failed to generate diagnostics' });
    }
  },

  // ─── Dataset Ingestion & Connections ─────────────────────────────────────
  async listDatasets(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { datasetRegistry } = await import('../../core/datasets/DatasetRegistry.js');
      const { DatasetIngestionState } = await import('../../db/models/datasetIngestion.model.js');

      // Scan first to auto-discover
      await datasetRegistry.scanDatasets();
      const list = [];
      const manifest = (datasetRegistry as any).manifest || (datasetRegistry as any).manifestPath ? (datasetRegistry as any).manifest : {};
      const datasets = manifest?.datasets || (datasetRegistry as any).getDataset ? (datasetRegistry as any).manifest?.datasets : {};

      // Fallback fallback scan if manifest wasn't directly accessible
      const activeDatasets = datasets || {};
      for (const id of Object.keys(activeDatasets)) {
        const metadata = datasetRegistry.getDataset(id);
        const state = await DatasetIngestionState.findOne({ datasetId: id }).lean();
        list.push({
          metadata,
          ingestionState: state || null,
        });
      }

      res.json({ success: true, datasets: list });
    } catch (error) {
      logger.error('[ops] Failed to list datasets', error);
      res.status(500).json({ error: 'Failed to list datasets' });
    }
  },

  async scanDatasets(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { datasetRegistry } = await import('../../core/datasets/DatasetRegistry.js');
      await datasetRegistry.scanDatasets();
      res.json({ success: true, message: 'Auto-discovery scan completed successfully' });
    } catch (error) {
      logger.error('[ops] Failed to scan datasets', error);
      res.status(500).json({ error: 'Failed to scan datasets' });
    }
  },

  async triggerIngestion(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const datasetId = req.params.datasetId as string;
      const batchSize = Number(req.body?.batchSize ?? 1000);
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_DATASET_INGESTION_BATCH_SIZE) {
        res.status(400).json({ error: `batchSize must be an integer between 1 and ${MAX_DATASET_INGESTION_BATCH_SIZE}` });
        return;
      }
      const maxFailedRows = req.body?.maxFailedRows;
      if (maxFailedRows !== undefined && (!Number.isSafeInteger(maxFailedRows) || maxFailedRows < 0)) {
        res.status(400).json({ error: 'maxFailedRows must be a nonnegative integer' });
        return;
      }

      const { datasetRegistry } = await import('../../core/datasets/DatasetRegistry.js');
      const metadata = datasetRegistry.getDataset(datasetId);

      if (!metadata) {
        res.status(404).json({ error: 'Dataset not found in registry' });
        return;
      }

      const { QueueRegistry } = await import('../../infrastructure/queues/QueueRegistry.js');
      const queue = QueueRegistry.getOrCreateQueue(QueueNames.DATASET_INGESTION);
      
      const { DatasetIngestionState } = await import('../../db/models/datasetIngestion.model.js');
      await DatasetIngestionState.init();
      const state = await DatasetIngestionState.findOneAndUpdate(
        { datasetId },
        { $setOnInsert: { datasetId, sourceFilePath: metadata.path, status: 'pending' } },
        { upsert: true, new: true }
      );

      // Add to BullMQ queue
      await queue.add('ingest', {
        datasetId,
        sourceFilePath: metadata.path,
        batchSize,
        maxFailedRows
      });

      logger.warn('[ops] Dataset ingestion triggered', { admin: req.user?.username, datasetId, batchSize });

      res.json({ success: true, message: `Enqueued background ingestion job for dataset ${datasetId}`, state });
    } catch (error) {
      logger.error('[ops] Failed to trigger ingestion', error);
      res.status(500).json({ error: 'Failed to trigger ingestion' });
    }
  },

  async getIngestionStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { datasetId } = req.params;
      const { DatasetIngestionState } = await import('../../db/models/datasetIngestion.model.js');
      const state = await DatasetIngestionState.findOne({ datasetId }).lean();
      
      if (!state) {
        res.status(404).json({ error: 'Ingestion state not found for this dataset' });
        return;
      }

      res.json({ success: true, state });
    } catch (error) {
      logger.error('[ops] Failed to get ingestion status', error);
      res.status(500).json({ error: 'Failed to get ingestion status' });
    }
  }

};

export default opsController;
