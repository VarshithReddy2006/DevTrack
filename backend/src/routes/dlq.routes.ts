import { Router, type RequestHandler } from 'express';
import { authMiddleware, adminMiddleware } from '../middleware/auth.js';
import { dlqService, DlqNotFoundError, DLQ_QUEUE_NAMES } from '../shared/jobs/dlq.service.js';

const knownQueues = new Set<string>(DLQ_QUEUE_NAMES);

export function createDlqRoutes(auth: RequestHandler | RequestHandler[] = authMiddleware, admin: RequestHandler = adminMiddleware) {
  const router = Router();
  router.use(auth, admin);
  router.use((req, res, next) => {
    const queue = req.query.queue;
    if (typeof queue !== 'string' || !knownQueues.has(queue)) {
      res.status(400).json({ error: 'A known queue query parameter is required' });
      return;
    }
    next();
  });
  router.get('/', async (req, res) => {
    const offset = Number(req.query.offset ?? 0);
    const limit = Number(req.query.limit ?? 50);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      res.status(400).json({ error: 'offset must be non-negative and limit must be between 1 and 100' });
      return;
    }
    const entries = await dlqService.list(req.query.queue as string, offset, offset + limit - 1);
    res.json({ entries, offset, limit });
  });
  const mutate = (action: 'retry' | 'delete'): RequestHandler => async (req, res, next) => {
    try {
      const queue = req.query.queue as string;
      const id = req.params.id as string;
      if (action === 'retry') await dlqService.replayFromDlq(queue, id);
      else await dlqService.remove(queue, id);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof DlqNotFoundError) { res.status(404).json({ error: error.message }); return; }
      next(error);
    }
  };
  router.post('/:id/retry', mutate('retry'));
  router.delete('/:id', mutate('delete'));
  return router;
}
export const dlqRoutes = createDlqRoutes();
