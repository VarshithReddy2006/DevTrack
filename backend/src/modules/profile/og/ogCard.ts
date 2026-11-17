// src/modules/profile/og/ogCard.ts — The data an OG card is drawn from, and its fingerprint.
// The card only ever contains what the public profile API would show for the same viewer:
// sections go through visibleSections(), so a hidden section can never leak into an image.

import { createHash } from 'node:crypto';
import type { IPublicProfile } from '../../../db/models/publicProfile.model.js';
import type { IUserSettings } from '../../../db/models/userSettings.model.js';
import { visibleSections } from '../visibility.js';

/** Bump when the template changes so cached artifacts are rendered again. */
export const OG_TEMPLATE_VERSION = 'og-v1';
export const OG_ARTIFACT_TYPE = 'og_image';

export const ogArtifactKey = (userId: string) => `${OG_ARTIFACT_TYPE}:${userId}`;

export interface OgCardStat {
  label: string;
  value: string;
}

export interface OgCard {
  displayName: string;
  username: string;
  levelName: string;
  stats: OgCardStat[];
  languages: string[];
}

export type OgCardSource = Pick<IPublicProfile, 'username' | 'sections'> & {
  snapshot: Pick<IPublicProfile['snapshot'], 'identity' | 'consistency' | 'dsa' | 'github'>;
};

const MAX_NAME = 40;
const MAX_LANGUAGES = 5;
const MAX_LANGUAGE_LENGTH = 20;

// The bundled font is a Latin subset. Anything outside it would render as an empty box,
// so those characters are dropped (a name with none left falls back to the handle).
const UNSUPPORTED_GLYPHS = /[^ -~ -ÿ‐-‧]/g;

export function printable(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(UNSUPPORTED_GLYPHS, '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function count(value: unknown): string {
  const n = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function buildOgCard(profile: OgCardSource, privacy?: Partial<IUserSettings['privacy']>): OgCard {
  const show = visibleSections(profile, privacy);
  const { identity, consistency, dsa, github } = profile.snapshot;
  const username = printable(profile.username, 30);
  const stats: OgCardStat[] = [];
  if (show.streak) stats.push({ label: 'Day streak', value: count(consistency.currentStreak) });
  if (show.dsa) stats.push({ label: 'Problems solved', value: count(dsa.totalSolved) });
  if (show.github) stats.push({ label: 'Contributions / yr', value: count(github.contributionsLast365) });
  if (show.projects) stats.push({ label: 'Verified projects', value: count(github.verifiedProjectCount) });

  return {
    displayName: printable(identity.displayName, MAX_NAME) || username,
    username,
    levelName: printable(identity.levelName, 20) || 'Engineer',
    stats,
    languages: show.github
      ? (github.primaryLanguages ?? []).map(language => printable(language, MAX_LANGUAGE_LENGTH)).filter(Boolean).slice(0, MAX_LANGUAGES)
      : [],
  };
}

export function hashOgCard(card: OgCard): string {
  return createHash('sha256').update(JSON.stringify([OG_TEMPLATE_VERSION, card])).digest('hex');
}

/** Site-relative path of a profile's card. The version only busts caches in link previews. */
export function ogImagePath(slug: string, version?: string): string {
  const path = `/api/v1/profile/public/${encodeURIComponent(slug)}/og.png`;
  return version ? `${path}?v=${encodeURIComponent(version)}` : path;
}

export function ogImageVersion(profile: { publicationVersion?: number; snapshot?: { computedAt?: Date | null } }): string | undefined {
  const computedAt = profile.snapshot?.computedAt;
  if (!computedAt) return undefined;
  return `${profile.publicationVersion ?? 0}-${new Date(computedAt).getTime().toString(36)}`;
}
