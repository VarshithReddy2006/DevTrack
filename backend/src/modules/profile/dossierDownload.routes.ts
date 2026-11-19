// src/modules/profile/dossierDownload.routes.ts — Token-authorized candidate dossier PDF endpoints.
//   POST /api/v2/portfolio/:username/dossier/token -> generate signed, time-limited download URL
//   GET  /api/v2/portfolio/:username/dossier.pdf   -> verify HMAC signature and stream PDF binary

import { Router, type Request, type Response } from 'express';
import { User, UserSettings, PublicProfile, ProfileAuditLog } from '../../db/models/index.js';
import { asyncHandler, optionalAuthMiddleware, type AuthenticatedRequest } from '../../middleware/index.js';
import { logger } from '../../shared/logger.js';
import { commonErrors, errorResponse, successResponse } from '../../shared/response.js';
import { getObjectStorage } from '../../shared/storage/objectStorage.js';
import { renderDossierArtifact } from './dossier/dossier.service.js';
import { findReadyDossier, loadDossierData } from './dossier/dossierData.js';
import {
  dossierRateLimiter,
  generateDossierToken,
  verifyDossierToken,
} from './dossierToken.service.js';
import { canViewPublicProfile } from './publicProfile.service.js';

export const dossierDownloadDeps = {
  renderDossier: renderDossierArtifact,
};

const UNAVAILABLE_MESSAGE = {
  no_snapshot: 'Your profile snapshot is not ready yet. Try again after your platforms have synced.',
  under_review: 'This profile is under review, so a dossier cannot be issued.',
} as const;

export async function createDossierTokenHandler(req: Request, res: Response): Promise<void> {
  const rawUsername = req.params.username;
  const username = Array.isArray(rawUsername) ? rawUsername[0] : rawUsername;
  if (!username) {
    commonErrors.badRequest(res, 'Username parameter is required');
    return;
  }

  const requester = (req as AuthenticatedRequest).user;
  if (!requester?.id) {
    commonErrors.unauthorized(res);
    return;
  }

  const targetUser = await User.findOne({ username }).lean();
  if (!targetUser) {
    commonErrors.notFound(res, 'User');
    return;
  }

  const isOwner = requester.id === targetUser._id.toString();
  if (!isOwner) {
    const publicProfile = await PublicProfile.findOne({ userId: targetUser._id }).lean();
    const settings = await UserSettings.findOne({ userId: targetUser._id }).select('privacy').lean();
    if (!publicProfile || !canViewPublicProfile(publicProfile, settings?.privacy)) {
      commonErrors.forbidden(res);
      return;
    }
  }

  const source = await loadDossierData(targetUser._id);
  if (source.status !== 'ok') {
    errorResponse(res, UNAVAILABLE_MESSAGE[source.reason], 'DOSSIER_UNAVAILABLE', 409);
    return;
  }

  const generated = generateDossierToken(targetUser.username);
  successResponse(
    res,
    {
      token: generated.token,
      expires: generated.expires,
      expiresAt: generated.expiresAt.toISOString(),
      downloadUrl: generated.downloadUrl,
    },
    'Dossier download token generated'
  );
}

export async function downloadDossierPdfHandler(req: Request, res: Response): Promise<void> {
  const rawUsername = req.params.username;
  const username = Array.isArray(rawUsername) ? rawUsername[0] : rawUsername;
  if (!username) {
    commonErrors.forbidden(res);
    return;
  }
  const { token, expires, nonce } = req.query;

  if (typeof token !== 'string' || (typeof expires !== 'string' && typeof expires !== 'number')) {
    commonErrors.forbidden(res);
    return;
  }

  const valid = verifyDossierToken(username, {
    token,
    expires: expires as string,
    nonce: typeof nonce === 'string' ? nonce : undefined,
  });

  if (!valid) {
    commonErrors.forbidden(res);
    return;
  }

  const targetUser = await User.findOne({ username });
  if (!targetUser) {
    commonErrors.notFound(res, 'Candidate');
    return;
  }

  const source = await loadDossierData(targetUser._id);
  if (source.status !== 'ok') {
    errorResponse(res, UNAVAILABLE_MESSAGE[source.reason], 'DOSSIER_UNAVAILABLE', 409);
    return;
  }

  const storage = getObjectStorage();
  const ready = await findReadyDossier(String(targetUser._id), source.contentHash);
  let pdfBuffer: Buffer | null = null;

  if (ready?.storageUrl && (await storage.exists(ready.storageUrl))) {
    pdfBuffer = await storage.get(ready.storageUrl);
  }

  if (!pdfBuffer) {
    const outcome = await dossierDownloadDeps.renderDossier(targetUser._id, { storage });
    if (outcome.status === 'rendered' || outcome.status === 'cached') {
      pdfBuffer = await storage.get(outcome.key);
    }
  }

  if (!pdfBuffer) {
    commonErrors.internalError(res, 'Could not retrieve dossier PDF');
    return;
  }

  try {
    await ProfileAuditLog.create({
      userId: targetUser._id,
      eventType: 'dossier_downloaded',
      triggeredBy: (req as AuthenticatedRequest).user ? 'user' : 'system',
      details: {
        username: targetUser.username,
        ip: req.ip || req.socket?.remoteAddress,
        userAgent: req.get('user-agent'),
        downloadedAt: new Date(),
      },
    });
  } catch (auditErr) {
    logger.warn('Failed to record dossier download audit log', { error: String(auditErr) });
  }

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'attachment; filename="Candidate_Dossier.pdf"',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(pdfBuffer);
}

const router = Router();

router.post('/:username/dossier/token', dossierRateLimiter, optionalAuthMiddleware, asyncHandler(createDossierTokenHandler));
router.get('/:username/dossier.pdf', asyncHandler(downloadDossierPdfHandler));

export default router;
