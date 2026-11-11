// src/shared/jobs/types.ts — Typed job definitions for BullMQ queues

import type { XpSourceType } from '../../db/models/index.js';

export interface PlatformSyncJobData {
  userId: string;
  platformName: string;
  requestId?: string;
}

export interface RealtimeEventJobData {
  userId: string;
  eventType: 'sync_started' | 'sync_completed' | 'sync_failed' | 'new_submission';
  platform?: string;
  stats?: Record<string, unknown>;
  requestId?: string;
}

export interface SystemMaintenanceJobData {
  task: 'cleanup_failed_jobs' | 'prune_old_events' | 'health_check' | 'generate_daily_missions' | 'generate_weekly_missions' | 'cleanup_stale_sync_locks' | 'streak_at_risk_check' | 'generate_daily_challenge';
  requestId?: string;
}

export interface XpProcessingJobData {
  userId: string;
  sourceType: XpSourceType;
  sourceId: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export interface StreakRecalcJobData {
  userId: string;
  streakType: 'dsa' | 'github' | 'unified';
  requestId?: string;
}

export interface NotificationJobData {
  type: 'streak_at_risk' | 'streak_milestone' | 'level_up' | 'inactivity';
  userId: string;
  data: Record<string, unknown>;
  requestId?: string;
}

export interface ResumeUploadJobData {
  sessionId: string;
  userId?: string;
  filePath: string;
  originalFilename: string;
  requestId?: string;
}

export interface ResumeCheckpointJobData {
  sessionId: string;
  userId: string;
  recoveryRetryCount: number;
}

export interface ResumeATSJobData {
  sessionId: string;
  userId?: string;
  requestId?: string;
}

export interface ResumeEmbeddingJobData {
  sessionId: string;
  userId?: string;
  requestId?: string;
}

export interface ResumeSemanticJobData {
  sessionId: string;
  userId?: string;
  requestId?: string;
}

export interface ResumeRecommendationJobData {
  sessionId: string;
  userId?: string;
  requestId?: string;
}

export interface ResumeReplayJobData {
  sessionId: string;
  userId?: string;
  requestId?: string;
}

export interface DatasetIngestionJobData {
  datasetId: string;
  sourceFilePath: string;
  batchSize?: number;
  requestId?: string;
}

export interface DatasetValidationJobData {
  datasetId: string;
  batchId?: string;
  requestId?: string;
}

export type JobData = PlatformSyncJobData | RealtimeEventJobData | SystemMaintenanceJobData | XpProcessingJobData | StreakRecalcJobData | NotificationJobData | ResumeUploadJobData | ResumeCheckpointJobData | ResumeATSJobData | ResumeEmbeddingJobData | ResumeSemanticJobData | ResumeRecommendationJobData | ResumeReplayJobData | DatasetIngestionJobData | DatasetValidationJobData;

export const QueueNames = {
  PLATFORM_SYNC: 'platform-sync',
  SYSTEM_MAINTENANCE: 'system-maintenance',
  XP_PROCESSING: 'xp-processing',
  STREAK_RECALC: 'streak-recalc',
  NOTIFICATIONS: 'notifications',
  PROFILE_REBUILD: 'profile-rebuild',
  
  // Readiness Decoupled Pipelines
  READINESS_DSA: 'readiness-dsa',
  READINESS_PROJECTS: 'readiness-projects',
  READINESS_SKILLS: 'readiness-skills',
  READINESS_BENCHMARKS: 'readiness-benchmarks',
  READINESS_ROADMAP: 'readiness-roadmap',
  READINESS_AGGREGATION: 'readiness-aggregation',
  
  // Resume Intelligence Pipelines
  RESUME_UPLOAD: 'resume-upload',
  RESUME_ATS: 'resume-ats',
  RESUME_EMBEDDING: 'resume-embedding',
  RESUME_SEMANTIC: 'resume-semantic',
  RESUME_RECOMMENDATION: 'resume-recommendation',
  RESUME_REPLAY: 'resume-replay',
  
  // Dataset Operationalization Pipelines
  DATASET_INGESTION: 'dataset-ingestion',
  DATASET_VALIDATION: 'dataset-validation',
} as const;

// Retry configuration
export const JobRetryConfig = {
  platformSync: {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 2000 },
  },
  realtimeEvents: {
    attempts: 2,
    backoff: { type: 'fixed' as const, delay: 1000 },
  },
  systemMaintenance: {
    attempts: 1,
    backoff: { type: 'fixed' as const, delay: 0 },
  },
  xpProcessing: {
    attempts: 2,
    backoff: { type: 'fixed' as const, delay: 500 },
  },
  standard: {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 1000 },
  },
} as const;