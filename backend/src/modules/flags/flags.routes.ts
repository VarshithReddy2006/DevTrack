import { Router, type Response } from 'express';
import { z } from 'zod';
import { featureFlagKeyPattern } from '../../db/models/featureFlag.model.js';
import { adminMiddleware, authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { objectIdSchema, validateBody, validateContract, validateParams } from '../../middleware/validation.js';
import { successResponse } from '../../shared/response.js';
import { activeFlagKeys, listFlagAudit, listFlags, updateFlag } from './flags.service.js';

const flagParams = z.object({ key: z.string().regex(featureFlagKeyPattern) });
const flagPatch = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000),
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100),
  allowedUserIds: z.array(objectIdSchema).max(1000).transform(ids => [...new Set(ids.map(id => id.toLowerCase()))]),
}).partial().strict().refine(changes => Object.keys(changes).length > 0, 'Provide at least one flag setting');
const flagAuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  key: z.string().regex(featureFlagKeyPattern).optional(),
}).strict();

export const flagRoutes = Router();
flagRoutes.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  successResponse(res, await activeFlagKeys(req.user!.id));
});

export const opsFlagRoutes = Router();
opsFlagRoutes.use(authMiddleware, adminMiddleware);
opsFlagRoutes.get('/', async (_req, res) => {
  successResponse(res, await listFlags());
});
opsFlagRoutes.get('/audit', validateContract({ query: flagAuditQuery }, async (req, res) => {
  successResponse(res, await listFlagAudit(req.validQuery));
}));
opsFlagRoutes.patch<{ key: string }>('/:key', validateParams(flagParams), validateBody(flagPatch), async (req, res) => {
  const user = (req as AuthenticatedRequest).user!;
  successResponse(res, await updateFlag(req.params.key, req.body, { id: user.id, username: user.username }));
});
