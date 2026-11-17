import { Router } from 'express';
import { z } from 'zod';
import { EVIDENCE_SUBJECT_TYPES, VERIFICATION_STATUSES } from '../../../db/models/resumeEvidenceClaim.model.js';
import { authMiddleware, type AuthenticatedRequest } from '../../../middleware/auth.js';
import { asyncHandler } from '../../../middleware/error.js';
import { commonErrors, successResponse } from '../../../shared/response.js';
import { listEvidenceClaims } from '../evidence/evidenceLedger.service.js';

export const evidenceRoutes = Router();
const filters = z.object({
  subjectType: z.enum(EVIDENCE_SUBJECT_TYPES).optional(),
  verificationStatus: z.enum(VERIFICATION_STATUSES).optional(),
});

evidenceRoutes.get('/claims', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user) return commonErrors.unauthorized(res);
  const parsed = filters.safeParse(req.query);
  if (!parsed.success) return commonErrors.badRequest(res, 'Invalid evidence claim filters');
  const claims = await listEvidenceClaims(req.user.id, parsed.data);
  successResponse(res, claims);
}));
