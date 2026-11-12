import { isObjectIdOrHexString, Types, type PipelineStage } from 'mongoose';
import { DsaSubmission } from '../../../db/models/dsaSubmission.model.js';
import { ReadinessCore, type IReadinessCore } from '../../../db/models/readinessCore.model.js';
import type { IReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import type { IReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { logger } from '../../../shared/logger.js';

type MomentumTrend = IReadinessCore['momentumTrend'];
type ActivityWindow = { _id: boolean; count: number };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function classifyMomentum(
  submissionDelta: number,
  projectDelta: number,
  solveConsistency: number,
  contributionConsistency: number,
): MomentumTrend {
  const submissionDirection = Math.sign(submissionDelta);
  const projectDirection = Math.sign(projectDelta);
  let direction = submissionDirection + projectDirection;

  // Use persisted consistency to resolve disagreement between the two activity sources.
  if (direction === 0 && submissionDirection !== 0) {
    direction = submissionDirection * (solveConsistency - contributionConsistency);
  }

  if (direction > 0) return 'improving';
  if (direction < 0) return 'declining';
  return 'stagnating';
}

function activityDelta(windows: ActivityWindow[]): number {
  const recent = windows.find(window => window._id)?.count ?? 0;
  const previous = windows.find(window => !window._id)?.count ?? 0;
  return recent - previous;
}

function countByWindow(field: string, boundary: Date): PipelineStage.Group {
  return { $group: { _id: { $gte: [field, boundary] }, count: { $sum: 1 } } };
}

export const ReadinessMomentumEngine = {
  async computeMomentum(
    userId: string,
    dsaData: Pick<IReadinessDsa, 'solveConsistency'> | null | undefined,
    projectData: Pick<IReadinessProjects, 'complexityMetrics'> | null | undefined,
  ): Promise<MomentumTrend> {
    if (!isObjectIdOrHexString(userId)) return 'stagnating';

    try {
      const now = new Date();
      const boundary = new Date(now.getTime() - WEEK_MS);
      const range = { $gte: new Date(now.getTime() - 2 * WEEK_MS), $lte: now };
      // Mongoose does not cast IDs in aggregation pipelines.
      const owner = new Types.ObjectId(userId);
      const [submissions, projects] = await Promise.all([
        DsaSubmission.aggregate<ActivityWindow>([
          { $match: { userId: owner, submittedAt: range } },
          countByWindow('$submittedAt', boundary),
        ]),
        VerifiedProject.aggregate<ActivityWindow>([
          {
            $match: {
              userId: owner,
              'verification.status': 'verified',
              'metrics.userCommitCount': { $gt: 0 },
              'metrics.lastCommitAt': range,
            },
          },
          // The timestamp tracks the latest repository commit. Count each verified project once.
          countByWindow('$metrics.lastCommitAt', boundary),
        ]),
      ]);

      const trend = classifyMomentum(
        activityDelta(submissions),
        activityDelta(projects),
        dsaData?.solveConsistency ?? 0,
        projectData?.complexityMetrics?.contributionConsistency ?? 0,
      );
      await ReadinessCore.updateOne({ userId }, { momentumTrend: trend });
      return trend;
    } catch (error) {
      logger.error('[ReadinessMomentumEngine] Error computing momentum', { userId, error });
      return 'stagnating';
    }
  },
};
