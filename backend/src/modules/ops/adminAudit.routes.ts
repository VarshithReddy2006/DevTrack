// src/modules/ops/adminAudit.routes.ts: /ops/anti-gaming review endpoints.
// Reading flags is open to every ops role; pardoning or penalizing needs an admin.
import { Router } from 'express';
import { z } from 'zod';
import { ANTI_GAMING_ACTIONS } from '../../db/models/antiGamingDecision.model.js';
import { adminMiddleware, authMiddleware, opsAuditorMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { objectIdSchema, validateContract } from '../../middleware/validation.js';
import { paginatedResponse, successResponse } from '../../shared/response.js';
import { applyReviewAction, FLAGGED_STATES, getFlagBreakdown, listFlaggedProfiles } from './adminAudit.service.js';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  state: z.enum(FLAGGED_STATES).default('open'),
});
const userParams = z.object({ userId: objectIdSchema });
const actionBody = z.object({
  action: z.enum(ANTI_GAMING_ACTIONS),
  note: z.string().trim().min(1, 'A note explaining the decision is required').max(1000),
}).strict();

export const adminAuditRoutes = Router();
adminAuditRoutes.use(authMiddleware);

adminAuditRoutes.get('/flagged', opsAuditorMiddleware, validateContract({ query: listQuery }, async (req, res) => {
  const { state, page, pageSize } = req.validQuery;
  const { items, pagination } = await listFlaggedProfiles(state, { page, pageSize });
  paginatedResponse(res, items, pagination);
}));

adminAuditRoutes.get('/:userId/breakdown', opsAuditorMiddleware, validateContract({ params: userParams }, async (req, res) => {
  successResponse(res, await getFlagBreakdown(req.validParams.userId));
}));

adminAuditRoutes.post('/:userId/action', adminMiddleware, validateContract({ params: userParams, body: actionBody }, async (req, res) => {
  const { id, username, role } = (req as unknown as AuthenticatedRequest).user!;
  const { action, note } = req.validBody;
  successResponse(res, await applyReviewAction(req.validParams.userId, action, note, { id, username, role }));
}));
