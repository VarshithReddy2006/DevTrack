import { Router } from 'express';
import { asyncHandler, authMiddleware } from '../../middleware/index.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { commonErrors, successResponse } from '../../shared/response.js';
import { contestRefreshService } from './contests/contestRefresh.service.js';
import type { ContestPlatform } from './contests/ContestSource.js';
import {
  buildIcs,
  findUserIdByCalendarToken,
  getPreferredPlatforms,
  parsePlatformFilter,
  rotateCalendarToken,
} from './contests/calendarFeed.service.js';

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


async function sendCalendar(res: import('express').Response, platforms: ContestPlatform[], filename: string, inline: boolean) {
  const all = await Promise.all(platforms.map((p) => contestRefreshService.getUpcomingContests(p)));
  const now = new Date();
  const upcoming = all.flat().filter((c) => new Date(c.endTime).getTime() > now.getTime());
  upcoming.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  if (!inline) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buildIcs(upcoming, now));
}

router.get(
  '/export.ics',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const platforms = parsePlatformFilter(req.query.platform);
    if (!platforms) {
      commonErrors.badRequest(res, `Unsupported contest platform. Supported: ${supportedPlatforms.join(', ')}`);
      return;
    }
    await sendCalendar(res, platforms, 'devtrack-contests.ics', false);
  })
);

// Calendar apps cannot send a bearer token, so the feed authenticates with the per-user calendar token.
router.get(
  '/feed.ics',
  asyncHandler(async (req, res) => {
    const userId = await findUserIdByCalendarToken(req.query.token);
    if (!userId) {
      commonErrors.unauthorized(res);
      return;
    }
    await sendCalendar(res, await getPreferredPlatforms(userId), 'devtrack-contests.ics', true);
  })
);

// Creates (or replaces) the token and returns the subscription URLs. The token is only shown here.
router.post(
  '/calendar-token',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const token = await rotateCalendarToken((req as AuthenticatedRequest).user!.id);
    const host = req.get('host');
    const path = `${req.baseUrl}/feed.ics?token=${token}`;
    successResponse(
      res,
      { feedUrl: `${req.protocol}://${host}${path}`, webcalUrl: `webcal://${host}${path}` },
      'Calendar feed token created'
    );
  })
);

export default router;
