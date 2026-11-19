import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { commonErrors } from '../../shared/response.js';
import { getCachedPortfolio } from './portfolioCache.service.js';

export const publicPortfolioRoutes = Router();
publicPortfolioRoutes.get('/:username', asyncHandler(async (req, res) => {
  // A downstream cache cannot check a subsequent unpublish/privacy change. Require origin validation.
  res.set('Cache-Control', 'no-store');
  const portfolio = await getCachedPortfolio(req.params.username as string);
  if (!portfolio) { commonErrors.notFound(res, 'Public Profile'); return; }
  res.set({ 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: portfolio.etag });
  const validators = req.get('If-None-Match')?.split(',').map(value => value.trim());
  if (validators?.some(value => value === '*' || value.replace(/^W\//, '') === portfolio.etag)) {
    res.status(304).end();
    return;
  }
  res.type('json').send(portfolio.body);
}));
