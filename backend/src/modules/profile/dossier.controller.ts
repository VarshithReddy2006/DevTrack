// src/modules/profile/dossier.controller.ts — Verified Developer Dossier endpoints.
//   POST /profile/dossier            owner requests a PDF (202 while the render pool works on it)
//   GET  /profile/dossier            owner reads status; a ready PDF comes with a 15 minute signed link
//   GET  /profile/dossier/download   the signed link itself (no session needed, the signature is the proof)

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/index.js';
import { env } from '../../config/env.js';
import { commonErrors, errorResponse, successResponse } from '../../shared/response.js';
import { getObjectStorage, type SignedUrl } from '../../shared/storage/objectStorage.js';
import { getDossierStatus, requestDossier } from './dossier/dossier.service.js';
import { enqueueDossierRender } from './workers/dossierRender.worker.js';

/** Seam for tests: how a render is queued. */
export const dossierDeps = { enqueue: enqueueDossierRender };

const UNAVAILABLE_MESSAGE = {
  no_snapshot: 'Your profile snapshot is not ready yet. Try again after your platforms have synced.',
  under_review: 'This profile is under review, so a dossier cannot be issued.',
} as const;

const toDownload = ({ url, expiresAt }: SignedUrl) => ({
  url: env.PUBLIC_API_URL ? env.PUBLIC_API_URL.replace(/\/$/, '') + url : url,
  expiresAt: expiresAt.toISOString(),
});

export async function requestDossierPdf(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) { commonErrors.unauthorized(res); return; }

  const result = await requestDossier(userId, dossierDeps.enqueue);
  if (result.status === 'unavailable') {
    errorResponse(res, UNAVAILABLE_MESSAGE[result.reason], 'DOSSIER_UNAVAILABLE', 409);
    return;
  }
  if (result.status === 'ready') {
    successResponse(res, { status: 'ready', download: toDownload(result.download) }, 'Dossier ready');
    return;
  }
  successResponse(res, { status: 'pending' }, 'Dossier is being generated', 202);
}

export async function getDossierPdfStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) { commonErrors.unauthorized(res); return; }

  const status = await getDossierStatus(userId);
  res.set('Cache-Control', 'no-store');
  if (status.status === 'ready') {
    successResponse(res, { status: 'ready', byteLength: status.byteLength, download: toDownload(status.download) });
    return;
  }
  successResponse(res, status);
}

export async function downloadDossierPdf(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { key, expires, sig } = req.query;
  const storage = getObjectStorage();
  // Missing, tampered, wrong-key and expired links all look the same from outside.
  if (typeof key !== 'string' || typeof expires !== 'string' || typeof sig !== 'string'
      || !key.startsWith('dossiers/') || !storage.verifySignedUrl({ key, expires, signature: sig })) {
    commonErrors.forbidden(res);
    return;
  }
  const body = await storage.get(key);
  if (!body) { commonErrors.notFound(res, 'Dossier'); return; }
  res.set({
    'Cache-Control': 'private, no-store',
    'Content-Disposition': 'attachment; filename="devtrack-verified-dossier.pdf"',
    'X-Content-Type-Options': 'nosniff',
  });
  res.type('application/pdf').send(body);
}
