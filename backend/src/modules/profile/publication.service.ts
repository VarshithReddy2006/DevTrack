import type { ClientSession, Types } from 'mongoose';
import { ProfileAuditLog } from '../../db/models/profileAuditLog.model.js';
import {
  DEFAULT_PUBLIC_PROFILE_THEME,
  PUBLIC_PROFILE_SECTIONS,
  PublicProfile,
  type IPublicProfile,
  type PublicProfileTheme,
} from '../../db/models/publicProfile.model.js';
import { RenderArtifact } from '../../db/models/renderArtifact.model.js';
import { RESERVED_SLUGS, SLUG_PATTERN, UsernameReservation } from '../../db/models/usernameReservation.model.js';
import { User } from '../../db/models/user.model.js';
import { createDomainEvent, type DomainEventType, type ProfilePublicationPayload } from '../../shared/events/eventContract.js';
import { runConsumersForEvent } from '../../shared/events/runConsumer.js';
import { logger } from '../../shared/logger.js';
import { escapeRegExp } from '../../shared/regex.js';
import type { PublishProfileInput } from './publication.schemas.js';
import { PublicProfileService } from './publicProfile.service.js';
import { invalidateCacheTag, portfolioTag } from '../../shared/redis/cacheTags.js';

export type PublicationErrorCode = 'INVALID_SLUG' | 'RESERVED_SLUG' | 'SLUG_TAKEN';

export class PublicationError extends Error {
  constructor(readonly code: PublicationErrorCode, message: string) {
    super(message);
    this.name = 'PublicationError';
  }
}

export interface PublicationStatus {
  published: boolean;
  slug: string | null;
  sections: Record<(typeof PUBLIC_PROFILE_SECTIONS)[number], boolean>;
  publicationVersion: number;
  consentVersion: string | null;
  publishedAt: Date | null;
  settings: {
    theme: PublicProfileTheme;
    sectionOrder: (typeof PUBLIC_PROFILE_SECTIONS)[number][];
  };
}

const hiddenSections = () => Object.fromEntries(PUBLIC_PROFILE_SECTIONS.map(section => [section, false])) as PublicationStatus['sections'];

type PublicationProfile = Pick<IPublicProfile, 'published' | 'slug' | 'sections' | 'publicationVersion' | 'publication'> & {
  settings?: IPublicProfile['settings'];
};

function toStatus(profile: PublicationProfile | null): PublicationStatus {
  const settings = profile?.settings;
  const sectionOrder = settings?.sectionOrder?.filter((section) => PUBLIC_PROFILE_SECTIONS.includes(section)) ?? [...PUBLIC_PROFILE_SECTIONS];
  const normalizedOrder = [...new Set(sectionOrder)];
  for (const section of PUBLIC_PROFILE_SECTIONS) {
    if (!normalizedOrder.includes(section)) normalizedOrder.push(section);
  }
  if (!profile) {
    return {
      published: false,
      slug: null,
      sections: hiddenSections(),
      publicationVersion: 0,
      consentVersion: null,
      publishedAt: null,
      settings: { theme: DEFAULT_PUBLIC_PROFILE_THEME, sectionOrder: [...PUBLIC_PROFILE_SECTIONS] },
    };
  }
  return {
    published: profile.published,
    slug: profile.published ? profile.slug : null,
    sections: Object.fromEntries(PUBLIC_PROFILE_SECTIONS.map(section => [section, profile.sections?.[section] === true])) as PublicationStatus['sections'],
    publicationVersion: profile.publicationVersion,
    consentVersion: profile.publication?.consentVersion ?? null,
    publishedAt: profile.publication?.publishedAt ?? null,
    settings: {
      theme: settings?.theme ?? DEFAULT_PUBLIC_PROFILE_THEME,
      sectionOrder: normalizedOrder as PublicationStatus['settings']['sectionOrder'],
    },
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 11000;
}

/** Events go out after the commit and are best effort: the state change already happened. */
async function dispatch(type: Extract<DomainEventType, 'profile.published' | 'profile.unpublished'>, userId: Types.ObjectId, payload: ProfilePublicationPayload) {
  try {
    await runConsumersForEvent(createDomainEvent(type, payload, { userId: String(userId) }));
  } catch (error) {
    logger.warn('[PublicationService] Event dispatch failed', { type, userId: String(userId), error });
  }
}

export class PublicationService {
  static async getStatus(userId: Types.ObjectId | string): Promise<PublicationStatus> {
    return toStatus(await PublicProfile.findOne({ userId }).lean() as PublicationProfile | null);
  }

  /**
   * Opt in to a public profile under a chosen handle. The handle reservation, the profile
   * update and the audit entry commit together or not at all.
   */
  static async publishProfile(userId: Types.ObjectId, input: PublishProfileInput): Promise<PublicationStatus> {
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) throw new PublicationError('INVALID_SLUG', 'Invalid handle');
    if (RESERVED_SLUGS.includes(slug)) throw new PublicationError('RESERVED_SLUG', 'This handle is reserved');
    // A handle equal to someone else's username is theirs, even if they never built a profile.
    if (await User.exists({ _id: { $ne: userId }, username: new RegExp(`^${escapeRegExp(slug)}$`, 'i') })) {
      throw new PublicationError('SLUG_TAKEN', 'This handle is already taken');
    }

    // Make sure there is a fresh snapshot to publish. A new document starts private.
    await PublicProfileService.computeProfile(userId);

    const sections = { ...hiddenSections(), ...input.sections };
    const existingSettings = await PublicProfile.findOne({ userId }).select('settings').lean() as { settings?: IPublicProfile['settings'] } | null;
    const settings = input.settings ?? existingSettings?.settings ?? {
      theme: DEFAULT_PUBLIC_PROFILE_THEME,
      sectionOrder: [...PUBLIC_PROFILE_SECTIONS],
    };
    const now = new Date();
    let profile: IPublicProfile;
    try {
      profile = await PublicProfile.db.transaction(async (session: ClientSession) => {
        await UsernameReservation.updateMany(
          { userId, status: 'active', slug: { $ne: slug } },
          { $set: { status: 'released' } },
          { session },
        );
        // Matches only this user's own reservation or a released one. If an active or
        // system reservation exists, the upsert insert hits the unique slug index.
        await UsernameReservation.findOneAndUpdate(
          { slug, $or: [{ userId }, { status: 'released' }] },
          { $set: { userId, status: 'active' } },
          { upsert: true, session },
        );
        const updated = await PublicProfile.findOneAndUpdate(
          { userId },
          {
            $set: {
              slug, published: true, visibility: 'public', sections,
              'publication.consentVersion': input.consentVersion, 'publication.publishedAt': now,
              settings,
            },
            $inc: { publicationVersion: 1 },
          },
          { new: true, session },
        );
        if (!updated) throw new Error('Public profile missing after rebuild');
        await ProfileAuditLog.create([{
          userId, eventType: 'visibility_changed', triggeredBy: 'user',
          details: { published: true, slug, sections, consentVersion: input.consentVersion, publicationVersion: updated.publicationVersion },
        }], { session });
        return updated;
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new PublicationError('SLUG_TAKEN', 'This handle is already taken');
      throw error;
    }

    await invalidateCacheTag(portfolioTag(String(userId)));
    await dispatch('profile.published', userId, { slug, publicationVersion: profile.publicationVersion });
    return toStatus(profile);
  }

  /** Takes effect on the next request: public reads check `published` on every call. */
  static async unpublishProfile(userId: Types.ObjectId): Promise<PublicationStatus> {
    const profile = await PublicProfile.db.transaction(async (session: ClientSession) => {
      const updated = await PublicProfile.findOneAndUpdate(
        { userId, published: true },
        { $set: { published: false, visibility: 'private' }, $inc: { publicationVersion: 1 } },
        { new: true, session },
      );
      if (updated) {
        await ProfileAuditLog.create([{
          userId, eventType: 'visibility_changed', triggeredBy: 'user',
          details: { published: false, slug: updated.slug, publicationVersion: updated.publicationVersion },
        }], { session });
      }
      return updated;
    });

    if (!profile) return this.getStatus(userId);
    await invalidateCacheTag(portfolioTag(String(userId)));
    // Public reads already 404; also drop the stored card so no image of a private profile is kept.
    await RenderArtifact.deleteMany({ userId, type: 'og_image' }).catch(error => {
      logger.warn('[PublicationService] Could not remove stored OG image', { userId: String(userId), error });
    });
    await dispatch('profile.unpublished', userId, { slug: profile.slug, publicationVersion: profile.publicationVersion });
    return toStatus(profile);
  }
}
