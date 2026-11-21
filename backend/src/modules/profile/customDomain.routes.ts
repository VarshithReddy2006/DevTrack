// src/modules/profile/customDomain.routes.ts: custom portfolio domain endpoints (owner only).
//   POST /api/v2/portfolio/custom-domain          register a domain, returns the DNS records to add
//   POST /api/v2/portfolio/custom-domain/verify   queue an immediate DNS verification
//   GET  /api/v2/portfolio/custom-domain/status   current status, records and last error
// Auth is attached per route, not with router.use(), so GET /portfolio/custom-domain still
// reaches the public portfolio of a user whose handle is "custom-domain".

import { Router, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, asyncHandler, validateBody } from '../../middleware/index.js';
import { withAuth } from '../../shared/controllerUtils.js';
import { logger } from '../../shared/logger.js';
import { errorResponse, successResponse } from '../../shared/response.js';
import {
  CustomDomainError,
  findCustomDomainForVerification,
  getCustomDomain,
  registerCustomDomain,
} from './customDomain.service.js';
import { enqueueCustomDomainVerification } from './customDomainVerifier.worker.js';

export const customDomainDeps = {
  enqueueVerification: enqueueCustomDomainVerification,
};

const registerDomainSchema = z.object({ domain: z.string().trim().min(1).max(253) }).strict();

const ERROR_STATUS = { INVALID_DOMAIN: 400, DOMAIN_TAKEN: 409, NOT_FOUND: 404 } as const;

function handleDomainError(res: Response, error: unknown): boolean {
  if (!(error instanceof CustomDomainError)) return false;
  errorResponse(res, error.message, error.kind, ERROR_STATUS[error.kind]);
  return true;
}

const router = Router();

router.post('/', authMiddleware, validateBody(registerDomainSchema), asyncHandler(withAuth('[custom-domain]', 'register custom domain', async (userId, req, res) => {
  try {
    const domain = await registerCustomDomain(userId, req.body.domain);
    successResponse(res, domain, 'Add these DNS records, then request verification', 201);
  } catch (error) {
    if (!handleDomainError(res, error)) throw error;
  }
})));

router.post('/verify', authMiddleware, asyncHandler(withAuth('[custom-domain]', 'verify custom domain', async (userId, _req, res) => {
  let domain;
  try {
    domain = await findCustomDomainForVerification(userId);
  } catch (error) {
    if (handleDomainError(res, error)) return;
    throw error;
  }
  try {
    await customDomainDeps.enqueueVerification(domain.id);
  } catch (error) {
    logger.warn('[custom-domain] Could not queue verification', { event: 'custom_domain_enqueue_failed', domainId: domain.id, error: error instanceof Error ? error.message : String(error) });
    errorResponse(res, 'Verification is unavailable right now, try again in a few minutes', 'VERIFICATION_UNAVAILABLE', 503);
    return;
  }
  successResponse(res, { ...domain, verificationQueued: true }, 'Verification queued', 202);
})));

router.get('/status', authMiddleware, asyncHandler(withAuth('[custom-domain]', 'get custom domain', async (userId, _req, res) => {
  const domain = await getCustomDomain(userId);
  if (!domain) {
    errorResponse(res, 'No custom domain registered', 'NOT_FOUND', 404);
    return;
  }
  successResponse(res, domain);
})));

export default router;
