import { Request, Response } from 'express';
import { z } from 'zod';
import { AnalyticsEvent } from '../../db/models/analyticsEvent.model';
import { UserFeedback } from '../../db/models/userFeedback.model';
import type { AuthenticatedRequest } from '../../middleware/auth';

export const trackEvent = async (req: Request, res: Response) => {
  try {
    const { eventName, properties } = req.body;
    // Only a verified req.user (set by optionalAuthMiddleware) can attribute an event.
    // Anonymous events are stored without a userId.
    const userId = (req as AuthenticatedRequest).user?.id;

    // Never keep a client supplied userId in the stored properties either
    const safeProperties = { ...(properties ?? {}) };
    delete safeProperties.userId;

    await AnalyticsEvent.create({
      userId,
      eventName,
      properties: safeProperties
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to track event:', error);
    res.status(500).json({ error: 'Failed to track event' });
  }
};

export const submitFeedback = async (req: Request, res: Response) => {
  try {
    const { rating, feedback, page } = req.body;
    const userId = (req as AuthenticatedRequest).user?.id;

    await UserFeedback.create({
      userId,
      rating,
      feedback,
      page
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to submit feedback:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
};


const MAX_DASHBOARD_DAYS = 90;
const DEFAULT_DASHBOARD_DAYS = 30;

export const dashboardQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(MAX_DASHBOARD_DAYS).default(DEFAULT_DASHBOARD_DAYS),
});

const FUNNEL_EVENTS = [
  'resume_upload_completed',
  'career_discovery_completed',
  'roadmap_generated',
  'resource_clicked',
  'skill_marked_complete'
];

export const getDashboardMetrics = async (req: Request, res: Response) => {
  try {
    // The route rejects bad values with a 400. Parsing again here applies the default,
    // since validateQuery's result does not stick to req.query on Express 5.
    const { days } = dashboardQuerySchema.parse(req.query);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // One date-bounded aggregation instead of 5 full-collection scans
    const [[facets], feedbackList] = await Promise.all([
      AnalyticsEvent.aggregate<{
        counts: { _id: string; count: number }[];
        completers: { total: number }[];
      }>([
        { $match: { createdAt: { $gte: since }, eventName: { $in: FUNNEL_EVENTS } } },
        {
          $facet: {
            counts: [{ $group: { _id: '$eventName', count: { $sum: 1 } } }],
            // Unique users completing at least one skill
            completers: [
              { $match: { eventName: 'skill_marked_complete', userId: { $type: 'string' } } },
              { $group: { _id: '$userId' } },
              { $count: 'total' }
            ]
          }
        }
      ]),
      UserFeedback.find().sort({ createdAt: -1 }).limit(50).lean()
    ]);

    const countOf = (name: string) => facets?.counts.find(c => c._id === name)?.count ?? 0;
    const resumesUploaded = countOf('resume_upload_completed');
    const discoveryCompleted = countOf('career_discovery_completed');
    const roadmapsGenerated = countOf('roadmap_generated');
    const resourceClicks = countOf('resource_clicked');
    const skillsCompleted = countOf('skill_marked_complete');
    const uniqueCompleters = facets?.completers[0]?.total ?? 0;

    res.json({
      success: true,
      data: {
        window: { days, since: since.toISOString() },
        funnel: {
          resumesUploaded,
          discoveryCompleted,
          roadmapsGenerated,
          resourceClicks,
          skillsCompleted
        },
        metrics: {
          activationRate: resumesUploaded > 0 ? (roadmapsGenerated / resumesUploaded) * 100 : 0,
          learningEngagement: roadmapsGenerated > 0 ? (resourceClicks / roadmapsGenerated) * 100 : 0,
          completionRate: roadmapsGenerated > 0 ? (uniqueCompleters / roadmapsGenerated) * 100 : 0
        },
        feedback: feedbackList
      }
    });
  } catch (error) {
    console.error('Failed to fetch dashboard metrics:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard metrics' });
  }
};
