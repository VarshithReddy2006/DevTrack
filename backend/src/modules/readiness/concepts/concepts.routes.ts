import { Router, type Response } from 'express';
import { z } from 'zod';
import { withAuth } from '../../../shared/controllerUtils.js';
import { ApiResponse, errorResponse } from '../../../shared/response.js';
import {
  ConceptsError,
  getConceptWorkspace,
  updateConceptProgress,
} from './concepts.service.js';

const domainSchema = z.enum(['system-design', 'cs-concepts']);

const updateBodySchema = z
  .object({
    completed: z.boolean().optional(),
    confidence: z.enum(['got_it', 'revise_again']).nullable().optional(),
  })
  .refine((val) => val.completed !== undefined || val.confidence !== undefined, {
    message: 'At least one of "completed" or "confidence" must be provided',
  });

async function respond(res: Response, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof ConceptsError)) throw err;
    errorResponse(res, err.message, err.code, err.status);
  }
}

const router = Router();

router.get(
  '/:domain',
  withAuth('[concepts]', 'get concept workspace', async (userId, req, res) => {
    const parsedDomain = domainSchema.safeParse(req.params.domain);
    if (!parsedDomain.success) {
      ApiResponse.badRequest(res, 'Invalid concept domain. Expected "system-design" or "cs-concepts"');
      return;
    }
    await respond(res, async () => {
      const data = await getConceptWorkspace(userId, parsedDomain.data);
      ApiResponse.success(res, data);
    });
  })
);

router.patch(
  '/:domain/:conceptId',
  withAuth('[concepts]', 'update concept progress', async (userId, req, res) => {
    const parsedDomain = domainSchema.safeParse(req.params.domain);
    if (!parsedDomain.success) {
      ApiResponse.badRequest(res, 'Invalid concept domain. Expected "system-design" or "cs-concepts"');
      return;
    }
    const conceptId = typeof req.params.conceptId === 'string' ? req.params.conceptId.trim() : '';
    if (!conceptId || conceptId.length > 80) {
      ApiResponse.badRequest(res, 'Invalid conceptId');
      return;
    }
    const parsedBody = updateBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      ApiResponse.badRequest(
        res,
        parsedBody.error.issues[0]?.message || 'Invalid concept progress payload'
      );
      return;
    }
    await respond(res, async () => {
      const updated = await updateConceptProgress(userId, parsedDomain.data, conceptId, parsedBody.data);
      ApiResponse.success(res, updated);
    });
  })
);

export default router;
