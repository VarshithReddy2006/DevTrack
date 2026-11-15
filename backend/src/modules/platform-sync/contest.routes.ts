import { Router } from 'express';
import { asyncHandler, authMiddleware } from '../../middleware/index.js';
import { commonErrors, successResponse } from '../../shared/response.js';
import { contestRefreshService } from './contests/contestRefresh.service.js';
import type { ContestPlatform } from './contests/ContestSource.js';

const router = Router();
const supportedPlatforms: ContestPlatform[] = ['leetcode', 'codeforces', 'atcoder', 'codechef'];

router.get(
  '/upcoming',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const platformParam = typeof req.query.platform === 'string' ? req.query.platform : undefined;

    if (platformParam && !supportedPlatforms.includes(platformParam as ContestPlatform)) {
      commonErrors.badRequest(res, `Unsupported contest platform. Supported: ${supportedPlatforms.join(', ')}`);
      return;
    }

    const contests = await contestRefreshService.getUpcomingContests(platformParam as ContestPlatform | undefined);
    successResponse(res, contests, 'Upcoming contests retrieved');
  })
);

export default router;
