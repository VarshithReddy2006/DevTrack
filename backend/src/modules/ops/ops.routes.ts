// src/modules/ops/ops.routes.ts — Operational routes (admin)
import { Router } from 'express';
import { authMiddleware, adminMiddleware, opsAuditorMiddleware } from '../../middleware/auth.js';
import opsController from './ops.controller.js';

const router = Router();

// Health check remains public for load balancers
router.get('/health', opsController.health);

// Metrics and ops require ops auditor or admin
router.get('/metrics', authMiddleware, opsAuditorMiddleware, opsController.metrics);

// Queue management
router.get('/queues', authMiddleware, opsAuditorMiddleware, opsController.globalQueues);
router.get('/queues/:queueName', authMiddleware, opsAuditorMiddleware, opsController.queueStatus);
router.get('/queues/:queueName/jobs', authMiddleware, opsAuditorMiddleware, opsController.recentJobs);
router.post('/queues/:queueName/jobs/:jobId/replay', authMiddleware, adminMiddleware, opsController.replayDlqJob);
router.post('/queues/:queueName/replay-all', authMiddleware, adminMiddleware, opsController.replayAllFailed);

// Cache management
router.get('/cache/stats', authMiddleware, opsAuditorMiddleware, opsController.cacheStats);
router.get('/public/cache-health', authMiddleware, opsAuditorMiddleware, opsController.cacheHealth);
router.delete('/cache/users/:userId', authMiddleware, adminMiddleware, opsController.clearUserCache);

// Logging (admin only)
router.post('/logging', authMiddleware, adminMiddleware, opsController.setLogLevel);

// Trust & Verification
router.get('/trust/scores', authMiddleware, opsAuditorMiddleware, opsController.getTrustScores);
router.get('/trust/verifications', authMiddleware, opsAuditorMiddleware, opsController.getVerifications);

// Operational Recovery Tooling
router.post('/recovery/rebuild-all', authMiddleware, adminMiddleware, opsController.rebuildAll);
router.post('/recovery/invalidate-cache', authMiddleware, adminMiddleware, opsController.invalidateL2Cache);
router.post('/trust/:userId/recalculate', authMiddleware, adminMiddleware, opsController.recalculateTrust);
  router.get('/ai/audits', authMiddleware, opsAuditorMiddleware, opsController.getAIAuditLogs);
  router.get('/providers/health', authMiddleware, opsAuditorMiddleware, opsController.getProviderHealth);
  
  // Dataset Ingestion & Connections
  router.get('/datasets', authMiddleware, opsAuditorMiddleware, opsController.listDatasets);
  router.post('/datasets/scan', authMiddleware, adminMiddleware, opsController.scanDatasets);
  router.post('/datasets/:datasetId/ingest', authMiddleware, adminMiddleware, opsController.triggerIngestion);
  router.get('/datasets/:datasetId/status', authMiddleware, opsAuditorMiddleware, opsController.getIngestionStatus);
  
  // Diagnostics Tooling (Phase 6)
  router.get('/diagnostics', authMiddleware, adminMiddleware, opsController.diagnostics);
  
  export { router as opsRoutes };