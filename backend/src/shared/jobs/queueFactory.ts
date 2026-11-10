import { Queue } from 'bullmq';
import { QueueNames } from './types.js';
import { QueueRegistry } from '../../infrastructure/queues/QueueRegistry.js';

export function getOrCreateQueue(name: string): Queue {
  return QueueRegistry.getOrCreateQueue(name);
}

export function getQueue(name: string): Queue | undefined {
  return QueueRegistry.getQueue(name);
}

export function getAllQueues(): Queue[] {
  return QueueRegistry.getAllQueues();
}

export async function closeAllQueues(): Promise<void> {
  const { dlqService } = await import('./dlq.service.js');
  await dlqService.close();
  await QueueRegistry.closeAllQueues();
}

// Pre-registered queue getters
export function getPlatformSyncQueue(): Queue {
  return getOrCreateQueue(QueueNames.PLATFORM_SYNC);
}

export function getStreakRecalcQueue(): Queue {
  return getOrCreateQueue(QueueNames.STREAK_RECALC);
}

export function getSystemMaintenanceQueue(): Queue {
  return getOrCreateQueue(QueueNames.SYSTEM_MAINTENANCE);
}

export function getXpProcessingQueue(): Queue {
  return getOrCreateQueue(QueueNames.XP_PROCESSING);
}

export function getNotificationQueue(): Queue {
  return getOrCreateQueue(QueueNames.NOTIFICATIONS);
}

// Readiness Queue Getters
export function getReadinessDsaQueue(): Queue {
  return getOrCreateQueue(QueueNames.READINESS_DSA);
}

export function getReadinessProjectsQueue(): Queue {
  return getOrCreateQueue(QueueNames.READINESS_PROJECTS);
}

export function getReadinessSkillsQueue(): Queue {
  return getOrCreateQueue(QueueNames.READINESS_SKILLS);
}

export function getReadinessBenchmarksQueue(): Queue {
  return getOrCreateQueue(QueueNames.READINESS_BENCHMARKS);
}

export function getReadinessRoadmapQueue(): Queue {
  return getOrCreateQueue(QueueNames.READINESS_ROADMAP);
}

export function getReadinessAggregationQueue(): Queue {
  return getOrCreateQueue(QueueNames.READINESS_AGGREGATION);
}

// Resume Intelligence Queue Getters
export function getResumeUploadQueue(): Queue {
  return getOrCreateQueue(QueueNames.RESUME_UPLOAD);
}

export function getResumeATSQueue(): Queue {
  return getOrCreateQueue(QueueNames.RESUME_ATS);
}

export function getResumeEmbeddingQueue(): Queue {
  return getOrCreateQueue(QueueNames.RESUME_EMBEDDING);
}

export function getResumeSemanticQueue(): Queue {
  return getOrCreateQueue(QueueNames.RESUME_SEMANTIC);
}

export function getResumeRecommendationQueue(): Queue {
  return getOrCreateQueue(QueueNames.RESUME_RECOMMENDATION);
}

export function getResumeReplayQueue(): Queue {
  return getOrCreateQueue(QueueNames.RESUME_REPLAY);
}
