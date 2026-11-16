// src/modules/profile/ogImage.service.ts — OG card lookup and the cached render step.
// The API process only reads artifacts here. renderOgArtifact() is what the render worker runs.

import type { Types } from 'mongoose';
import { PublicProfile } from '../../db/models/publicProfile.model.js';
import { RenderArtifact } from '../../db/models/renderArtifact.model.js';
import { UserSettings } from '../../db/models/userSettings.model.js';
import { logger } from '../../shared/logger.js';
import { buildOgCard, hashOgCard, OG_ARTIFACT_TYPE, ogArtifactKey, type OgCard } from './og/ogCard.js';
import type { OgRenderer } from './og/ogRenderer.js';
import { canViewPublicProfile } from './publicProfile.service.js';

/** Rows expire on their own; a card that is still requested is simply rendered again. */
export const OG_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * satori and resvg load only when a render actually runs, so importing this module in the API
 * process (for lookups) never pulls the renderer into memory.
 */
const defaultRender: OgRenderer = async card => (await import('./og/ogRenderer.js')).renderOgPng(card);

export interface OgCardSnapshot {
  userId: Types.ObjectId;
  slug: string;
  card: OgCard;
  contentHash: string;
}

/**
 * The card for a published profile, or null. Unknown and unpublished handles are
 * indistinguishable, and nothing is built for a profile that is not publicly visible.
 */
export async function loadOgCard(filter: { slug: string } | { userId: Types.ObjectId | string }): Promise<OgCardSnapshot | null> {
  const profile = await PublicProfile.findOne({ ...filter, published: true, visibility: 'public' })
    .select('userId username slug published visibility sections snapshot.identity snapshot.consistency snapshot.dsa snapshot.github')
    .lean();
  if (!profile) return null;

  const settings = await UserSettings.findOne({ userId: profile.userId }).select('privacy').lean();
  if (!canViewPublicProfile(profile, settings?.privacy)) return null;

  const card = buildOgCard(profile, settings?.privacy);
  return { userId: profile.userId, slug: profile.slug, card, contentHash: hashOgCard(card) };
}

/** PNG bytes of the stored card, only when they were rendered from exactly this content. */
export async function findCachedOgImage(userId: Types.ObjectId | string, contentHash: string): Promise<Buffer | null> {
  const artifact = await RenderArtifact.findOne({
    artifactKey: ogArtifactKey(String(userId)),
    contentHash,
    status: 'ready',
    expiresAt: { $gt: new Date() },
  }).select('+content').lean();
  const bytes = artifact?.content;
  if (!bytes) return null;
  // lean() hands back a BSON Binary for Buffer fields.
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from((bytes as unknown as { buffer: Uint8Array }).buffer);
}

export type OgRenderOutcome =
  | { status: 'rendered' | 'cached'; contentHash: string }
  | { status: 'skipped'; reason: 'unpublished' };

/**
 * Worker job body. Rebuilds the card from the database (the job carries no content), skips
 * work when a current artifact already exists, and stores the PNG keyed by its content hash.
 */
export async function renderOgArtifact(
  userId: Types.ObjectId | string,
  render: OgRenderer = defaultRender,
  now = new Date(),
): Promise<OgRenderOutcome> {
  const artifactKey = ogArtifactKey(String(userId));
  const source = await loadOgCard({ userId });
  if (!source) {
    // Unpublished since the job was queued: do not keep an image of a private profile.
    await RenderArtifact.deleteOne({ artifactKey });
    return { status: 'skipped', reason: 'unpublished' };
  }

  const { contentHash } = source;
  if (await RenderArtifact.exists({ artifactKey, contentHash, status: 'ready', expiresAt: { $gt: now } })) {
    return { status: 'cached', contentHash };
  }

  const png = await render(source.card);
  await RenderArtifact.findOneAndUpdate(
    { artifactKey },
    {
      $set: {
        userId: source.userId,
        type: OG_ARTIFACT_TYPE,
        contentHash,
        status: 'ready',
        storageUrl: null,
        content: png,
        contentType: 'image/png',
        byteLength: png.length,
        error: null,
        renderedAt: now,
        expiresAt: new Date(now.getTime() + OG_ARTIFACT_TTL_MS),
      },
    },
    { upsert: true },
  );
  logger.info('[og-render] Rendered card', { event: 'og_render_done', userId: String(userId), bytes: png.length });
  return { status: 'rendered', contentHash };
}
