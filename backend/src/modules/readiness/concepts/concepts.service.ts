import {
  UserConceptProgress,
  type ConceptConfidence,
  type ConceptDomain,
} from '../../../db/models/userConceptProgress.model.js';
import type {
  ConceptDefinition,
  ConceptWithProgress,
  ConceptWorkspaceResponse,
  ConceptWorkspaceSummary,
} from './concepts.types.js';
import { SYSTEM_DESIGN_CATALOG } from './systemDesignCatalog.js';
import { CS_CONCEPTS_CATALOG } from './csConceptsCatalog.js';

export class ConceptsError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
  }
}

export function getCatalogForDomain(domain: ConceptDomain): ConceptDefinition[] {
  return domain === 'system-design' ? SYSTEM_DESIGN_CATALOG : CS_CONCEPTS_CATALOG;
}

export function buildConceptSummary(
  concepts: ConceptWithProgress[]
): ConceptWorkspaceSummary {
  const coreConcepts = concepts.filter((c) => !c.isOptional);
  const optionalConcepts = concepts.filter((c) => c.isOptional);

  const totalConcepts = concepts.length;
  const completedConcepts = concepts.filter((c) => c.completed).length;
  const coreTotal = coreConcepts.length;
  const coreCompleted = coreConcepts.filter((c) => c.completed).length;
  const optionalTotal = optionalConcepts.length;
  const optionalCompleted = optionalConcepts.filter((c) => c.completed).length;

  let latestMs = 0;
  for (const item of concepts) {
    if (!item.updatedAt) continue;
    const ms = new Date(item.updatedAt).getTime();
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
    }
  }

  return {
    totalConcepts,
    completedConcepts,
    progressPercent:
      totalConcepts > 0 ? Math.round((completedConcepts / totalConcepts) * 100) : 0,
    coreTotal,
    coreCompleted,
    coreProgressPercent:
      coreTotal > 0 ? Math.round((coreCompleted / coreTotal) * 100) : 0,
    optionalTotal,
    optionalCompleted,
    optionalProgressPercent:
      optionalTotal > 0 ? Math.round((optionalCompleted / optionalTotal) * 100) : 0,
    gotItCount: concepts.filter((c) => c.confidence === 'got_it').length,
    reviseAgainCount: concepts.filter((c) => c.confidence === 'revise_again').length,
    lastUpdatedAt: latestMs > 0 ? new Date(latestMs).toISOString() : null,
  };
}

export async function getConceptWorkspace(
  userId: string,
  domain: ConceptDomain
): Promise<ConceptWorkspaceResponse> {
  const catalog = getCatalogForDomain(domain);
  const rows = await UserConceptProgress.find({ userId, domain }).lean();
  const byConceptId = new Map(rows.map((r) => [r.conceptId, r]));

  const concepts: ConceptWithProgress[] = catalog.map((item) => {
    const row = byConceptId.get(item.id);
    return {
      ...item,
      completed: Boolean(row?.completed),
      confidence: row?.confidence ?? null,
      updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    };
  });

  return {
    domain,
    summary: buildConceptSummary(concepts),
    concepts,
  };
}

export async function updateConceptProgress(
  userId: string,
  domain: ConceptDomain,
  conceptId: string,
  patch: {
    completed?: boolean;
    confidence?: ConceptConfidence | null;
  }
): Promise<ConceptWorkspaceResponse> {
  const catalog = getCatalogForDomain(domain);
  const exists = catalog.some((c) => c.id === conceptId);
  if (!exists) {
    throw new ConceptsError(`Unknown concept "${conceptId}" for ${domain}`, 404, 'CONCEPT_NOT_FOUND');
  }

  const updateFields: {
    completed?: boolean;
    confidence?: ConceptConfidence | null;
  } = {};
  if (patch.completed !== undefined) {
    updateFields.completed = patch.completed;
  }
  if (patch.confidence !== undefined) {
    updateFields.confidence = patch.confidence;
  }

  await UserConceptProgress.findOneAndUpdate(
    { userId, domain, conceptId },
    {
      $set: updateFields,
      $setOnInsert: { userId, domain, conceptId },
    },
    { upsert: true, new: true }
  );

  return getConceptWorkspace(userId, domain);
}

export interface RadarConceptSignals {
  systemDesignConcept: {
    mastered: number;
    total: number;
    masteredTitles: string[];
    lastUpdatedAt: Date | null;
  };
  coreCsConcept: {
    mastered: number;
    total: number;
    masteredTitles: string[];
    optionalMastered: number;
    optionalTotal: number;
    lastUpdatedAt: Date | null;
  };
}

export async function getRadarConceptSignals(userId: string): Promise<RadarConceptSignals> {
  const rows = await UserConceptProgress.find({ userId, completed: true })
    .select({ domain: 1, conceptId: 1, updatedAt: 1 })
    .lean();

  const sdCompletedIds = new Set<string>();
  const csCompletedIds = new Set<string>();
  let sdLatest: Date | null = null;
  let csLatest: Date | null = null;

  for (const row of rows) {
    const dt = row.updatedAt ? new Date(row.updatedAt) : null;
    if (row.domain === 'system-design') {
      sdCompletedIds.add(row.conceptId);
      if (dt && (!sdLatest || dt > sdLatest)) sdLatest = dt;
    } else if (row.domain === 'cs-concepts') {
      csCompletedIds.add(row.conceptId);
      if (dt && (!csLatest || dt > csLatest)) csLatest = dt;
    }
  }

  const sdMasteredItems = SYSTEM_DESIGN_CATALOG.filter((c) => sdCompletedIds.has(c.id));

  // Strictly score Core CS Fundamentals only; Distributed Systems stays optional bonus
  const coreCsCatalog = CS_CONCEPTS_CATALOG.filter((c) => !c.isOptional);
  const optionalDsCatalog = CS_CONCEPTS_CATALOG.filter((c) => c.isOptional);
  const coreMasteredItems = coreCsCatalog.filter((c) => csCompletedIds.has(c.id));
  const optionalMasteredItems = optionalDsCatalog.filter((c) => csCompletedIds.has(c.id));

  return {
    systemDesignConcept: {
      mastered: sdMasteredItems.length,
      total: SYSTEM_DESIGN_CATALOG.length,
      masteredTitles: sdMasteredItems.map((c) => c.title),
      lastUpdatedAt: sdLatest,
    },
    coreCsConcept: {
      mastered: coreMasteredItems.length,
      total: coreCsCatalog.length,
      masteredTitles: coreMasteredItems.map((c) => c.title),
      optionalMastered: optionalMasteredItems.length,
      optionalTotal: optionalDsCatalog.length,
      lastUpdatedAt: csLatest,
    },
  };
}
