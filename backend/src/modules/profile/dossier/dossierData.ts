// src/modules/profile/dossier/dossierData.ts — What the Verified Developer Dossier certifies.
// Built from the owner's stored profile snapshot (platform ratings, verified repositories and
// focus consistency). Nothing here is fetched from outside and nothing is computed on request.

import { createHash } from 'node:crypto';
import type { Types } from 'mongoose';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { RenderArtifact } from '../../../db/models/renderArtifact.model.js';

export const DOSSIER_ARTIFACT_TYPE = 'pdf_dossier';
/** Bump when the template changes so cached PDFs are rendered again. */
export const DOSSIER_TEMPLATE_VERSION = 'dossier-v1';

export const dossierArtifactKey = (userId: string) => `${DOSSIER_ARTIFACT_TYPE}:${userId}`;

const MAX_PLATFORMS = 6;
const MAX_PROJECTS = 6;
const MAX_LANGUAGES = 6;

export interface DossierData {
  displayName: string;
  username: string;
  levelName: string;
  joinedOn: string | null;
  platforms: { platform: string; solved: number; rating: number | null }[];
  totalSolved: number;
  contestsParticipated: number;
  bestContestRating: number | null;
  github: { verified: boolean; totalContributions: number; contributionsLast365: number; languages: string[] };
  projects: { name: string; repo: string; language: string; stars: number; verifiedOn: string | null }[];
  consistency: {
    currentStreak: number; longestStreak: number;
    activeDaysLast30: number; activeDaysLast90: number; activeDaysLast365: number;
    weeklyScore: number; monthlyScore: number; trend: string;
  };
}

export type DossierSource =
  | { status: 'ok'; data: DossierData; contentHash: string }
  | { status: 'unavailable'; reason: 'no_snapshot' | 'under_review' };

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const day = (value: unknown) => {
  const date = value ? new Date(value as string | number | Date) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
};

export function hashDossier(data: DossierData): string {
  return createHash('sha256').update(JSON.stringify([DOSSIER_TEMPLATE_VERSION, data])).digest('hex');
}

export async function loadDossierData(userId: Types.ObjectId | string): Promise<DossierSource> {
  const profile = await PublicProfile.findOne({ userId })
    .select('username antiGaming.isFlagged snapshot.version snapshot.identity snapshot.consistency snapshot.dsa snapshot.github snapshot.projects snapshot.velocityIndicators.trend')
    .lean();
  if (!profile?.snapshot?.identity) return { status: 'unavailable', reason: 'no_snapshot' };
  // A profile the anti-gaming audit distrusts must not be certified.
  if (profile.antiGaming?.isFlagged === true) return { status: 'unavailable', reason: 'under_review' };

  const { identity, consistency, dsa, github, projects, velocityIndicators } = profile.snapshot;
  const data: DossierData = {
    displayName: text(identity.displayName, 60) || profile.username,
    username: profile.username,
    levelName: text(identity.levelName, 30) || 'Engineer',
    joinedOn: day(identity.joinedAt),
    platforms: (dsa?.platformBreakdown ?? []).slice(0, MAX_PLATFORMS).map(entry => ({
      platform: text(entry.platform, 30), solved: num(entry.solved), rating: entry.rating ?? null,
    })),
    totalSolved: num(dsa?.totalSolved),
    contestsParticipated: num(dsa?.contestsParticipated),
    bestContestRating: dsa?.bestContestRating ?? null,
    github: {
      verified: github?.isVerified === true,
      totalContributions: num(github?.totalContributions),
      contributionsLast365: num(github?.contributionsLast365),
      languages: (github?.primaryLanguages ?? []).slice(0, MAX_LANGUAGES).map(language => text(language, 24)).filter(Boolean),
    },
    // Snapshot projects are verified by construction; the status check keeps that explicit.
    projects: (projects ?? [])
      .filter(project => project?.verification?.status === 'verified')
      .slice(0, MAX_PROJECTS)
      .map(project => ({
        name: text(project.name, 60),
        repo: text(project.repoFullName, 80),
        language: text(project.metrics?.primaryLanguage, 24),
        stars: num(project.metrics?.stars),
        verifiedOn: day(project.verification?.verifiedAt),
      })),
    consistency: {
      currentStreak: num(consistency?.currentStreak),
      longestStreak: num(consistency?.longestStreak),
      activeDaysLast30: num(consistency?.activeDaysLast30),
      activeDaysLast90: num(consistency?.activeDaysLast90),
      activeDaysLast365: num(consistency?.activeDaysLast365),
      weeklyScore: num(consistency?.weeklyConsistencyScore),
      monthlyScore: num(consistency?.monthlyConsistencyScore),
      trend: text(velocityIndicators?.trend, 20) || 'inactive',
    },
  };
  return { status: 'ok', data, contentHash: hashDossier(data) };
}

/** The stored dossier for exactly this content, if it is still usable. */
export function findReadyDossier(userId: string, contentHash: string, now = new Date()) {
  return RenderArtifact.findOne({
    artifactKey: dossierArtifactKey(userId), contentHash, status: 'ready', expiresAt: { $gt: now },
  }).select('storageUrl expiresAt').lean();
}
