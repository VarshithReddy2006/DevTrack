// src/modules/revision/revision.controller.ts — Revision cards HTTP controllers
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/index.js';
import {
  RevisionService,
  RevisionCardNotFoundError,
  RevisionCardStaleError,
} from './revision.service.js';
import type { ReviewRating } from './sm2.js';
import { RevisionAnalyticsService } from './revisionAnalytics.service.js';

export async function getRevisionAnalyticsController(
  req: AuthenticatedRequest,
  res: Response
): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  const data = await RevisionAnalyticsService.getAnalytics(userId);
  // Analytics is private and the server-side Redis cache is scoped to the user.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ success: true, data });
}

export async function getDueCardsController(
  req: AuthenticatedRequest,
  res: Response
): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
  }

  const limitQuery = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
  const limit = Number.isFinite(limitQuery) ? limitQuery : 10;

  const cards = await RevisionService.getDueCards({
    userId,
    limit,
  });

  return res.json({
    success: true,
    count: cards.length,
    data: cards,
  });
}

export async function submitReviewController(
  req: AuthenticatedRequest,
  res: Response
): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
  }

  const rawId = req.params.id;
  const cardId = Array.isArray(rawId) ? rawId[0] : (rawId as string);
  const { rating, reviewSeq } = req.body;

  if (!cardId) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Card ID parameter is required' });
  }

  const validRatings: ReviewRating[] = ['failed', 'hard', 'easy'];
  if (!validRatings.includes(rating)) {
    return res.status(400).json({
      error: 'INVALID_RATING',
      message: "Rating must be one of 'failed', 'hard', or 'easy'",
    });
  }

  if (typeof reviewSeq !== 'number' || reviewSeq < 0 || !Number.isInteger(reviewSeq)) {
    return res.status(400).json({
      error: 'INVALID_REVIEW_SEQ',
      message: 'reviewSeq must be a non-negative integer',
    });
  }

  try {
    const updatedCard = await RevisionService.submitReview({
      userId,
      cardId,
      rating,
      reviewSeq,
    });

    return res.json({
      success: true,
      data: updatedCard,
    });
  } catch (err) {
    if (err instanceof RevisionCardStaleError) {
      return res.status(409).json({
        error: 'REVISION_CARD_STALE',
        message: err.message,
      });
    }

    if (err instanceof RevisionCardNotFoundError) {
      return res.status(404).json({
        error: 'REVISION_CARD_NOT_FOUND',
        message: err.message,
      });
    }

    throw err;
  }
}
