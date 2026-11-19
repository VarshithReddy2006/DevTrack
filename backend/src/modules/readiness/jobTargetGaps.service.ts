import { ReadinessInput } from '../../db/models/readinessInput.model.js';
import { cacheManager, CACHE_KEYS } from '../../shared/cache/cacheManager.js';

export interface JobTargetGaps {
  jobTargetId: string;
  matchScore: number;
  missingSkills: string[];
  highPrioritySkills: string[];
  scoredAt: string;
}

/** The most recently scored target supplies advisory readiness goals, not verified skills. */
export function getJobTargetGaps(userId: string): Promise<JobTargetGaps | null> {
  return cacheManager.getOrSet(CACHE_KEYS.readinessGaps(userId), async () => {
    const doc = await ReadinessInput.findOne({ userId }).select('jobTargets.latestScore').lean();
    const score = doc?.jobTargets?.latestScore;
    return score ? {
      jobTargetId: score.jobTargetId,
      matchScore: score.matchScore,
      missingSkills: score.missingSkills,
      highPrioritySkills: score.highPrioritySkills,
      scoredAt: score.scoredAt.toISOString(),
    } : null;
  });
}
