import type { Express, Router } from 'express';
import { API_BASE_PATH } from '../config/constants.js';

export function mountApiRoutes(app: Express, routes: Router): void {
  // Expose only the requested v2 endpoint through the shared API middleware,
  // including its global rate limit. Other modules remain on v1.
  app.use('/api/v2', (req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/revision\/analytics\/?$/i.test(req.path)) {
      return routes(req, res, next);
    }
    return next();
  });
  // Handle versioned requests first so /api does not run their middleware twice.
  app.use(API_BASE_PATH, routes);
  app.use('/api', (req, res, next) => {
    if (/^\/v[12](\/|$)/.test(req.path)) return next();
    res.setHeader('X-API-Deprecation-Warning', 'The unversioned /api endpoints are deprecated and will be removed in a future release. Please migrate to /api/v1.');
    return routes(req, res, next);
  });
}
