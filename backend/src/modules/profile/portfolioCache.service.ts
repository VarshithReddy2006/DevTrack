import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PublicProfile, type IPublicProfile } from '../../db/models/publicProfile.model.js';
import type { Types } from 'mongoose';
import { UserSettings, type IUserSettings } from '../../db/models/userSettings.model.js';
import { SLUG_PATTERN } from '../../db/models/usernameReservation.model.js';
import { discardTaggedCacheKey, portfolioTag, readTaggedCache, writeTaggedCache } from '../../shared/redis/cacheTags.js';
import { logger } from '../../shared/logger.js';
import { mapToPublicProfileDTO } from './profile.dto.js';
import { canViewPublicProfile, PublicProfileService } from './publicProfile.service.js';

export const PORTFOLIO_TTL_SECONDS = 3600;
export const PORTFOLIO_REFRESH_MS = 300_000;
export const portfolioCacheKey = (slug: string) => `portfolio:view:${slug}`;
const FORMAT_VERSION = 1;
const metadataFields = 'userId slug username published visibility publicationVersion sections snapshot.version snapshot.computedAt antiGaming.isFlagged isIndexable seo';
const metadataProjection = Object.fromEntries(metadataFields.split(' ').map(field => [field, 1]));
type Metadata = Pick<IPublicProfile, 'userId' | 'slug' | 'username' | 'published' | 'visibility' | 'publicationVersion' | 'sections' | 'snapshot' | 'antiGaming' | 'isIndexable' | 'seo'>;

const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
function fingerprint(profile: Metadata, privacy?: Partial<IUserSettings['privacy']>): string {
  return digest(JSON.stringify([
    FORMAT_VERSION, String(profile.userId), profile.slug, profile.username, profile.published,
    profile.visibility, profile.publicationVersion, profile.sections, profile.snapshot.version,
    profile.snapshot.computedAt, profile.antiGaming?.isFlagged, profile.isIndexable, profile.seo,
    privacy ?? null,
  ]));
}

async function publicSource(slug: string) {
  // One indexed MongoDB round trip for both publication and privacy, including on hot reads.
  const [profile] = await PublicProfile.aggregate<Metadata & {
    _id: Types.ObjectId; settings: Array<{ privacy?: Partial<IUserSettings['privacy']> }>;
  }>([
    { $match: { slug, published: true, visibility: 'public' } },
    { $limit: 1 },
    { $lookup: { from: UserSettings.collection.name, localField: 'userId', foreignField: 'userId', as: 'settings' } },
    { $project: { ...metadataProjection, 'settings.privacy': 1 } },
  ]);
  if (!profile) return null;
  const privacy = profile.settings[0]?.privacy;
  if (!canViewPublicProfile(profile, privacy)) return null;
  return { profile, privacy, fingerprint: fingerprint(profile, privacy) };
}

const entrySchema = z.object({
  format: z.literal(FORMAT_VERSION), fingerprint: z.string(), generation: z.string(),
  body: z.string(), etag: z.string(), refreshedAt: z.number().finite(),
});
type Entry = z.infer<typeof entrySchema>;
type Source = NonNullable<Awaited<ReturnType<typeof publicSource>>>;
const pending = new Map<string, Promise<Entry | null>>();

/** Coalescing is per process; Redis generations fence fills against mutations in other processes. */
function fill(slug: string, source: Source, generation: string | null): Promise<Entry | null> {
  const pendingKey = JSON.stringify([slug, source.fingerprint, generation]);
  const existing = pending.get(pendingKey);
  if (existing) return existing;
  const promise = (async () => {
    const profile = await PublicProfile.findOne({ _id: source.profile._id, slug, published: true, visibility: 'public' });
    if (!profile) return null;
    if (profile.snapshot.version < 2) {
      await PublicProfileService.computeProfile(profile.userId);
      return null; // Re-read the new snapshot's metadata and generation before filling it.
    }
    const current = await publicSource(slug);
    if (!current || current.fingerprint !== source.fingerprint
      || fingerprint(profile, current.privacy) !== current.fingerprint) return null;
    const body = JSON.stringify({
      success: true, data: mapToPublicProfileDTO(profile, current.privacy),
      message: 'Public profile retrieved successfully', timestamp: profile.snapshot.computedAt.toISOString(),
    });
    const entry: Entry = {
      format: FORMAT_VERSION, fingerprint: current.fingerprint, generation: generation ?? 'bypass',
      body, etag: '"' + digest(body) + '"', refreshedAt: Date.now(),
    };
    if (generation !== null) await writeTaggedCache(portfolioCacheKey(slug), portfolioTag(String(profile.userId)), generation, JSON.stringify(entry), PORTFOLIO_TTL_SECONDS);
    return entry;
  })().finally(() => { if (pending.get(pendingKey) === promise) pending.delete(pendingKey); });
  pending.set(pendingKey, promise);
  return promise;
}

/** Publication/privacy are checked in MongoDB before EVERY cache hit and conditional 304. */
export async function getCachedPortfolio(username: string): Promise<Pick<Entry, 'body' | 'etag'> | null> {
  const slug = username.toLowerCase();
  if (!SLUG_PATTERN.test(slug)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const source = await publicSource(slug);
    if (!source) { await discardTaggedCacheKey(portfolioCacheKey(slug)); return null; }
    const cached = await readTaggedCache(portfolioCacheKey(slug), portfolioTag(String(source.profile.userId)));
    if (cached?.value) {
      try {
        const parsed = entrySchema.safeParse(JSON.parse(cached.value));
        if (parsed.success && parsed.data.fingerprint === source.fingerprint && parsed.data.generation === cached.generation
          && parsed.data.etag === '"' + digest(parsed.data.body) + '"') {
          if (Date.now() - parsed.data.refreshedAt >= PORTFOLIO_REFRESH_MS) {
            void fill(slug, source, cached.generation).catch(error => logger.warn('[portfolio-cache] Background refresh failed', { error }));
          }
          return parsed.data;
        }
      } catch { /* Corrupt or incompatible cache entries are misses. */ }
      await discardTaggedCacheKey(portfolioCacheKey(slug));
    }
    const entry = await fill(slug, source, cached?.generation ?? null);
    if (entry) return entry;
  }
  // Continuous concurrent changes should not return a representation checked against old privacy.
  throw Object.assign(new Error('Portfolio changed during read; retry'), { statusCode: 503 });
}
