import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { rateLimiters } from '../../middleware/rateLimitAdvanced.js';
import { objectIdSchema, validateContract } from '../../middleware/validation.js';
import { BulletEditSchema } from './dto/index.js';
import { BulletRevisionService } from './bulletRevision.service.js';
import { scoreDifferentialSchema, scoreDifferentialService } from './scoreDifferential.service.js';
import { authenticateScoreDifferential } from './scoreDifferential.auth.js';

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const resumeParams = z.object({ resumeId: objectIdSchema });
const saveParams = resumeParams.extend({ sectionId: z.string().trim().min(1).max(50).regex(/^[a-zA-Z][a-zA-Z0-9 _-]*$/).transform(value => value.toLowerCase()) });
const saveBody = z.object({
  expectedVersion: version,
  bullets: z.array(BulletEditSchema.omit({ section: true })).max(200),
}).strict();
const restoreParams = resumeParams.extend({ version: z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).pipe(version) });

export const bulletRevisionRoutes = Router();
bulletRevisionRoutes.post('/diff-score', authenticateScoreDifferential, rateLimiters.resumeRead,
  validateContract({ body: scoreDifferentialSchema }, (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, data: scoreDifferentialService.compare(req.validBody) });
  }));
const user = (req: AuthenticatedRequest) => req.user!.id;
bulletRevisionRoutes.get('/:resumeId/revisions', authMiddleware, rateLimiters.resumeRead, validateContract({ params: resumeParams }, async (req, res) => {
  const { resumeId } = req.validParams;
  const data = await BulletRevisionService.history(user(req), resumeId);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ success: true, data });
}));

bulletRevisionRoutes.put('/:resumeId/sections/:sectionId/bullets', authMiddleware, rateLimiters.resume, validateContract({ params: saveParams, body: saveBody }, async (req, res) => {
  const { resumeId, sectionId } = req.validParams;
  const { expectedVersion, bullets } = req.validBody;
  const data = await BulletRevisionService.saveSection(user(req), resumeId, sectionId, bullets, expectedVersion);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ success: true, data });
}));

bulletRevisionRoutes.post('/:resumeId/revisions/:version/restore', authMiddleware, rateLimiters.resume, validateContract({ params: restoreParams, body: z.object({ expectedVersion: version }).strict() }, async (req, res) => {
  const { resumeId, version: revisionVersion } = req.validParams;
  const data = await BulletRevisionService.restore(user(req), resumeId, revisionVersion, req.validBody.expectedVersion);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ success: true, data });
}));
