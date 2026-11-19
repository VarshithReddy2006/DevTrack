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
  task: 'cleanup_failed_jobs' | 'prune_old_events' | 'health_check' | 'generate_daily_missions' | 'generate_weekly_missions' | 'cleanup_stale_sync_locks' | 'streak_at_risk_check' | 'generate_daily_challenge' | 'audit_public_profiles' | 'reap_stale_focus_sessions' | 'check_contest_starting_soon' | 'platform_sync_sweep';
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
  generation?: number;
  userId?: string;
  requestId?: string;
}

export interface ResumeEmbeddingJobData {
  sessionId: string;
  generation?: number;
  userId?: string;
  requestId?: string;
}

export interface ResumeSemanticJobData {
  sessionId: string;
  generation?: number;
  userId?: string;
  requestId?: string;
}

export interface ResumeRecommendationJobData {
  sessionId: string;
  generation?: number;
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
  maxFailedRows?: number;
  requestId?: string;
}

export const MAX_DATASET_INGESTION_BATCH_SIZE = 5000;

export interface DatasetValidationJobData {
  datasetId: string;
  batchId?: string;
  requestId?: string;
}

export interface LeagueScoreJobData {
  userId: string;
  sourceType: string;
  sourceId: string;
  xpAwarded: number;
  /** ISO timestamp of the XP ledger write; picks the league week the points belong to. */
  occurredAt: string;
  requestId?: string;
}

export interface LeagueRolloverJobData {
  /** Week to finalize. Omit on the repeatable schedule: the worker finalizes the week before the current one. */
  weekKey?: string;
  requestId?: string;
}

export interface OgRenderJobData {
  userId: string;
  requestId?: string;
}

/** Job target analysis (WORKER_TYPE=ai). The JD text itself never travels in the job: the worker loads it. */
export interface JdParseJobData {
  userId: string;
  jobTargetId: string;
  requestId?: string;
}

export interface JdScoreJobData {
  userId: string;
  jobTargetId: string;
  requestId?: string;
}

/**
 * One answer to evaluate. `stateVersion` is the session version at which the answer was
 * accepted (state SCORING); the worker only writes a result while the session is still there.
 */
export interface InterviewScoreJobData {
  sessionId: string;
  turnIndex: number;
  stateVersion: number;
  requestId?: string;
}

export interface DossierRenderJobData {
  userId: string;
  requestId?: string;
}

export type JobData = PlatformSyncJobData | RealtimeEventJobData | SystemMaintenanceJobData | XpProcessingJobData | StreakRecalcJobData | NotificationJobData | ResumeUploadJobData | ResumeCheckpointJobData | ResumeATSJobData | ResumeEmbeddingJobData | ResumeSemanticJobData | ResumeRecommendationJobData | ResumeReplayJobData | DatasetIngestionJobData | DatasetValidationJobData | LeagueScoreJobData | LeagueRolloverJobData | OgRenderJobData | DossierRenderJobData | InterviewScoreJobData | JdParseJobData | JdScoreJobData;

export const QueueNames = {
  PLATFORM_SYNC: 'platform-sync',
  CONTEST_REFRESH: 'contest-refresh',
  CONTEST_RATING_SYNC: 'contest-rating-sync',
  SYSTEM_MAINTENANCE: 'system-maintenance',
  XP_PROCESSING: 'xp-processing',
  STREAK_RECALC: 'streak-recalc',
  NOTIFICATIONS: 'notifications',
  PROFILE_REBUILD: 'profile-rebuild',

  // Weekly Leagues
  LEAGUE_SCORE: 'league-score',
  LEAGUE_ROLLOVER: 'league-rollover',
  
  // Render pool (WORKER_TYPE=render)
  OG_RENDER: 'domain-og-render',
  DOSSIER_RENDER: 'dossier-render',

  // AI pool (WORKER_TYPE=ai): job description parsing, match scoring, interview scoring
  JD_PARSE: 'jd-parse',
  JD_SCORE: 'jd-score',
  INTERVIEW_SCORE: 'interview-score',

  // Domain event consumers (outbox relay delivers here)
  DOMAIN_READINESS: 'domain-readiness',
  DOMAIN_FOCUS_XP: 'domain-focus-xp',
  DOMAIN_FOCUS_STREAK: 'domain-focus-streak',
  DOMAIN_FOCUS_MISSIONS: 'domain-focus-missions',
  DOMAIN_FOCUS_ACTIVITY: 'domain-focus-activity',

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
