// src/modules/profile/dossier/dossier.service.ts — Verified Developer Dossier: request, render, status.
// renderDossierArtifact() is the render worker's job body. The API side only reads rows,
// queues jobs and signs download links.

import type { Types } from 'mongoose';
import { RenderArtifact } from '../../../db/models/renderArtifact.model.js';
import { logger } from '../../../shared/logger.js';
import { getObjectStorage, type ObjectStorage, type SignedUrl } from '../../../shared/storage/objectStorage.js';
import { renderExportPdf } from '../../resume/export/renderExportPdf.js';
import {
  DOSSIER_ARTIFACT_TYPE, dossierArtifactKey, findReadyDossier, loadDossierData, type DossierData,
} from './dossierData.js';
import { renderDossierHtml } from './dossierTemplate.js';

/** A rendered dossier is reusable for this long; its row (and TTL) is replaced by the next render. */
export const DOSSIER_TTL_MS = 24 * 60 * 60 * 1000;
/** A queued request that no worker picks up disappears after this. */
export const DOSSIER_PENDING_TTL_MS = 15 * 60 * 1000;

export type DossierPdfRenderer = (html: string, options: { singlePage: true }) => Promise<Buffer>;

export type DossierRenderOutcome =
  | { status: 'rendered' | 'cached'; contentHash: string; key: string }
  | { status: 'skipped'; reason: 'no_snapshot' | 'under_review' };

export interface DossierRenderDeps {
  render?: DossierPdfRenderer;
  storage?: ObjectStorage;
  now?: Date;
}

const storageKey = (userId: string, contentHash: string) => `dossiers/${userId}/${contentHash.slice(0, 32)}.pdf`;

/** Worker job body: rebuild the data from the database, reuse a current PDF, otherwise render one. */
export async function renderDossierArtifact(userId: Types.ObjectId | string, deps: DossierRenderDeps = {}): Promise<DossierRenderOutcome> {
  const { render = renderExportPdf, storage = getObjectStorage(), now = new Date() } = deps;
  const id = String(userId);
  const source = await loadDossierData(id);
  if (source.status !== 'ok') {
    await markFailed(id, source.reason);
    return { status: 'skipped', reason: source.reason };
  }

  const { contentHash, data } = source;
  const key = storageKey(id, contentHash);
  const existing = await findReadyDossier(id, contentHash, now);
  if (existing && await storage.exists(key)) return { status: 'cached', contentHash, key };

  const pdf = await render(renderDossierHtml(data, now.toISOString().slice(0, 10)), { singlePage: true });
  await storage.put(key, pdf);
  await RenderArtifact.findOneAndUpdate(
    { artifactKey: dossierArtifactKey(id) },
    {
      $set: {
        userId, type: DOSSIER_ARTIFACT_TYPE, contentHash, status: 'ready', storageUrl: key,
        contentType: 'application/pdf', byteLength: pdf.length, error: null, renderedAt: now,
        expiresAt: new Date(now.getTime() + DOSSIER_TTL_MS),
      },
    },
    { upsert: true },
  );
  // Older PDFs of this user are stale now; do not keep them around.
  const removed = await storage.deleteExcept(`dossiers/${id}`, key);
  logger.info('[dossier-render] Rendered dossier', { event: 'dossier_render_done', userId: id, bytes: pdf.length, removedStale: removed });
  return { status: 'rendered', contentHash, key };
}

/** Records a terminal failure so the owner's status call stops reporting "pending". */
export async function markFailed(userId: string, reason: string): Promise<void> {
  await RenderArtifact.updateOne(
    { artifactKey: dossierArtifactKey(userId), status: 'pending' },
    { $set: { status: 'failed', error: reason.slice(0, 200) } },
  );
}

export type DossierRequestResult =
  | { status: 'ready'; download: SignedUrl }
  | { status: 'pending' }
  | { status: 'unavailable'; reason: 'no_snapshot' | 'under_review' };

/**
 * Owner asks for a dossier. Unchanged content with a stored PDF is answered with a fresh signed
 * link and no job; otherwise a pending row is recorded and `enqueue` queues the render.
 */
export async function requestDossier(
  userId: Types.ObjectId | string,
  enqueue: (userId: string) => Promise<void>,
  storage: ObjectStorage = getObjectStorage(),
  now = new Date(),
): Promise<DossierRequestResult> {
  const id = String(userId);
  const source = await loadDossierData(id);
  if (source.status !== 'ok') return source;

  const ready = await findReadyDossier(id, source.contentHash, now);
  if (ready?.storageUrl && await storage.exists(ready.storageUrl)) {
    return { status: 'ready', download: storage.signUrl(ready.storageUrl, now.getTime()) };
  }

  await RenderArtifact.findOneAndUpdate(
    { artifactKey: dossierArtifactKey(id) },
    {
      $set: {
        userId, type: DOSSIER_ARTIFACT_TYPE, contentHash: source.contentHash, status: 'pending', storageUrl: null,
        contentType: 'application/pdf', byteLength: 0, error: null,
        expiresAt: new Date(now.getTime() + DOSSIER_PENDING_TTL_MS),
      },
    },
    { upsert: true },
  );
  await enqueue(id);
  return { status: 'pending' };
}

export type DossierStatus =
  | { status: 'none' }
  | { status: 'pending' }
  | { status: 'failed'; error: string | null }
  | { status: 'ready'; download: SignedUrl; byteLength: number };

/** Current state for the owner. A ready dossier gets a new 15 minute link on every call. */
export async function getDossierStatus(userId: Types.ObjectId | string, storage: ObjectStorage = getObjectStorage(), now = new Date()): Promise<DossierStatus> {
  const row = await RenderArtifact.findOne({ artifactKey: dossierArtifactKey(String(userId)), expiresAt: { $gt: now } })
    .select('status storageUrl byteLength error').lean();
  if (!row) return { status: 'none' };
  if (row.status === 'failed') return { status: 'failed', error: row.error };
  if (row.status === 'ready' && row.storageUrl && await storage.exists(row.storageUrl)) {
    return { status: 'ready', download: storage.signUrl(row.storageUrl, now.getTime()), byteLength: row.byteLength };
  }
  return { status: row.status === 'ready' ? 'none' : 'pending' };
}

export type { DossierData };
