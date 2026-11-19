import type { Express, Router } from 'express';
import { API_BASE_PATH } from '../config/constants.js';

export function mountApiRoutes(app: Express, routes: Router): void {
  // Expose the v2 revision, resume revision, portfolio, push, and readiness roadmap APIs through shared
  // middleware, including the global rate limit. Other modules remain on v1.
  app.use('/api/v2', (req, res, next) => {
    const quests = ((req.method === 'GET' || req.method === 'HEAD') && /^\/quests\/?$/i.test(req.path)) || (req.method === 'POST' && /^\/quests\/[^/]+\/claim\/?$/i.test(req.path));
    const revision = (req.method === 'GET' || req.method === 'HEAD') && /^\/revision\/(analytics|queue)\/?$/i.test(req.path);
    const history = (req.method === 'GET' || req.method === 'HEAD') && /^\/resume\/[^/]+\/revisions\/?$/i.test(req.path);
    const restore = req.method === 'POST' && /^\/resume\/[^/]+\/revisions\/[^/]+\/restore\/?$/i.test(req.path);
    const save = req.method === 'PUT' && /^\/resume\/[^/]+\/sections\/[^/]+\/bullets\/?$/i.test(req.path);
    const bulletSuggest = req.method === 'POST' && /^\/resume\/bullets\/suggest\/?$/i.test(req.path);
    const diffScore = req.method === 'POST' && /^\/resume\/diff-score\/?$/i.test(req.path);
    const pushKey = (req.method === 'GET' || req.method === 'HEAD') && /^\/notifications\/push-key\/?$/i.test(req.path);
    const pushSubscription = req.method === 'POST' && /^\/notifications\/(subscribe|unsubscribe)\/?$/i.test(req.path);
    const portfolio = (req.method === 'GET' || req.method === 'HEAD') && /^\/portfolio\/[^/]+\/?$/i.test(req.path);
    const roadmap = ((req.method === 'GET' || req.method === 'HEAD') && /^\/readiness\/roadmap\/?$/i.test(req.path))
      || (req.method === 'POST' && /^\/readiness\/roadmap\/generate\/?$/i.test(req.path))
      || (req.method === 'PATCH' && /^\/readiness\/roadmap\/milestones\/[^/]+\/tasks\/[^/]+\/?$/i.test(req.path));
    return quests || revision || history || restore || save || bulletSuggest || diffScore || pushKey || pushSubscription || portfolio || roadmap ? routes(req, res, next) : next();
  });
  // Handle versioned requests first so /api does not run their middleware twice.
  app.use(API_BASE_PATH, routes);
  app.use('/api', (req, res, next) => {
    if (/^\/v[12](\/|$)/.test(req.path)) return next();
    res.setHeader('X-API-Deprecation-Warning', 'The unversioned /api endpoints are deprecated and will be removed in a future release. Please migrate to /api/v1.');
    return routes(req, res, next);
  });
}
