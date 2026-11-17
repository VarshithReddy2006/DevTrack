// src/modules/readiness/consumers/readinessInputs.ts: Shared helpers for the domain-readiness consumers.
// Day buckets, the rolling 7-day summary and the evidence claim upsert live here so the three
// consumers and ReadinessSnapshotService agree on one definition of the window.
import { Types, type ClientSession } from 'mongoose';
import { ReadinessInput, type IReadinessInput } from '../../../db/models/readinessInput.model.js';
import {
  ResumeEvidenceClaim,
  type EvidenceSource,
  type EvidenceSubjectType,
  type VerificationStatus,
} from '../../../db/models/resumeEvidenceClaim.model.js';

export const READINESS_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

export type FocusConsistencyTier = 'none' | 'emerging' | 'steady' | 'strong';

export interface ReadinessInputsView {
  windowDays: number;
  focus: {
    qualifiedSessions7d: number;
    focusMinutes7d: number;
    activeDays7d: number;
    consistencyTier: FocusConsistencyTier;
  };
  revision: {
    cardsReviewed7d: number;
    lapses7d: number;
    /** Share of reviews in the window that were not rated "failed", or null with no reviews. */
    retentionRate7d: number | null;
  };
  jobTargets: {
    activeTargetsCount: number;
    latestTarget: {
      jobTargetId: string;
      targetRole: string | null;
      company: string | null;
      requiredSkills: string[];
      analysisMode: 'ai' | 'taxonomy_only' | null;
      parsedAt: string;
    } | null;
  };
}

/** UTC calendar day, the bucket key. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** First day (inclusive) of the rolling window that ends on `now`'s day. */
export function windowStartKey(now: Date): string {
  return dayKey(new Date(now.getTime() - (READINESS_WINDOW_DAYS - 1) * DAY_MS));
}

/** True when `day` falls inside the window ending on `now`'s day. */
export function isInWindow(day: string, now: Date): boolean {
  return day >= windowStartKey(now) && day <= dayKey(now);
}

export function toObjectId(userId: string): Types.ObjectId | null {
  return userId && Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : null;
}

/** Parses an ISO timestamp from a payload, falling back to the envelope timestamp. */
export function eventTime(primary: unknown, fallback: string): Date | null {
  for (const candidate of [primary, fallback]) {
    if (typeof candidate !== 'string') continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

export function focusConsistencyTier(activeDays: number): FocusConsistencyTier {
  if (activeDays >= 5) return 'strong';
  if (activeDays >= 3) return 'steady';
  if (activeDays >= 1) return 'emerging';
  return 'none';
}

type DayMap<T> = Map<string, T> | undefined;

function inWindow<T>(days: DayMap<T>, now: Date): [string, T][] {
  return days ? [...days.entries()].filter(([day]) => isInWindow(day, now)) : [];
}

/** Pure projection of the stored buckets onto the rolling window. Old buckets stop counting without a write. */
export function summarizeInputs(doc: Pick<IReadinessInput, 'focusDays' | 'revisionDays' | 'jobTargets'> | null, now: Date): ReadinessInputsView {
  const focusDays = inWindow(doc?.focusDays, now);
  const revisionDays = inWindow(doc?.revisionDays, now);

  const qualifiedSessions7d = focusDays.reduce((sum, [, b]) => sum + b.qualifiedSessions, 0);
  const focusMinutes7d = focusDays.reduce((sum, [, b]) => sum + b.qualifiedMinutes, 0);
  const activeDays7d = focusDays.filter(([, b]) => b.qualifiedSessions > 0).length;
  const cardsReviewed7d = revisionDays.reduce((sum, [, b]) => sum + b.reviews, 0);
  const lapses7d = revisionDays.reduce((sum, [, b]) => sum + b.lapses, 0);

  const latest = doc?.jobTargets?.latest;
  return {
    windowDays: READINESS_WINDOW_DAYS,
    focus: {
      qualifiedSessions7d,
      focusMinutes7d: Math.round(focusMinutes7d),
      activeDays7d,
      consistencyTier: focusConsistencyTier(activeDays7d),
    },
    revision: {
      cardsReviewed7d,
      lapses7d,
      retentionRate7d: cardsReviewed7d > 0 ? (cardsReviewed7d - lapses7d) / cardsReviewed7d : null,
    },
    jobTargets: {
      activeTargetsCount: doc?.jobTargets?.targetIds?.length ?? 0,
      latestTarget: latest
        ? {
            jobTargetId: latest.jobTargetId,
            targetRole: latest.targetRole ?? null,
            company: latest.company ?? null,
            requiredSkills: [...(latest.requiredSkills ?? [])],
            analysisMode: latest.analysisMode ?? null,
            parsedAt: latest.parsedAt.toISOString(),
          }
        : null,
    },
  };
}

/** Loads the user's inputs document, or null when no consumer has written one yet. */
export function loadReadinessInput(userId: Types.ObjectId, session?: ClientSession) {
  return ReadinessInput.findOne({ userId }).session(session ?? null);
}

/** Drops buckets that fell out of the window so the document stays at most a week wide. */
export async function pruneExpiredDays(doc: IReadinessInput, now: Date, session?: ClientSession): Promise<void> {
  const unset: Record<string, ''> = {};
  for (const day of doc.focusDays?.keys() ?? []) if (!isInWindow(day, now)) unset[`focusDays.${day}`] = '';
  for (const day of doc.revisionDays?.keys() ?? []) if (!isInWindow(day, now)) unset[`revisionDays.${day}`] = '';
  if (Object.keys(unset).length === 0) return;
  await ReadinessInput.updateOne({ _id: doc._id }, { $unset: unset }, { session });
}

export interface EvidenceClaimInput {
  subjectType: EvidenceSubjectType;
  subjectKey: string;
  source: EvidenceSource;
  claimText: string;
  verificationStatus: VerificationStatus;
  confidence: number;
}

/**
 * Upserts the single evidence claim for (userId, subjectType, subjectKey). The ledger has a
 * unique index on that triple, so two consumers racing on a first insert resolve to one row.
 */
export async function upsertEvidenceClaim(
  userId: Types.ObjectId,
  claim: EvidenceClaimInput,
  now: Date,
  session?: ClientSession,
): Promise<void> {
  const filter = { userId, subjectType: claim.subjectType, subjectKey: claim.subjectKey };
  const update = {
    $set: {
      source: claim.source,
      claimText: claim.claimText,
      verificationStatus: claim.verificationStatus,
      confidence: Math.max(0, Math.min(100, Math.round(claim.confidence))),
      generatedBy: 'deterministic' as const,
      fetchedAt: now,
      staleAfter: new Date(now.getTime() + READINESS_WINDOW_DAYS * DAY_MS),
      'metadata.lastVerifiedAt': now,
    },
    $setOnInsert: { variantId: null, evidenceSources: [], provenance: [] },
  };
  try {
    await ResumeEvidenceClaim.updateOne(filter, update, { upsert: true, session });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    await ResumeEvidenceClaim.updateOne(filter, update, { upsert: false, session });
  }
}
