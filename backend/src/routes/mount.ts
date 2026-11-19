import type { Express, Router } from 'express';
import { API_BASE_PATH } from '../config/constants.js';

export function mountApiRoutes(app: Express, routes: Router): void {
  // Expose the v2 revision and resume revision APIs through shared middleware,
  // including the global rate limit. Other modules remain on v1.
  app.use('/api/v2', (req, res, next) => {
    const revision = (req.method === 'GET' || req.method === 'HEAD') && /^\/revision\/(analytics|queue)\/?$/i.test(req.path);
    const history = (req.method === 'GET' || req.method === 'HEAD') && /^\/resume\/[^/]+\/revisions\/?$/i.test(req.path);
    const restore = req.method === 'POST' && /^\/resume\/[^/]+\/revisions\/[^/]+\/restore\/?$/i.test(req.path);
    const save = req.method === 'PUT' && /^\/resume\/[^/]+\/sections\/[^/]+\/bullets\/?$/i.test(req.path);
    return revision || history || restore || save ? routes(req, res, next) : next();
  });
  // Handle versioned requests first so /api does not run their middleware twice.
  app.use(API_BASE_PATH, routes);
  app.use('/api', (req, res, next) => {
    if (/^\/v[12](\/|$)/.test(req.path)) return next();
    res.setHeader('X-API-Deprecation-Warning', 'The unversioned /api endpoints are deprecated and will be removed in a future release. Please migrate to /api/v1.');
    return routes(req, res, next);
  });
}
