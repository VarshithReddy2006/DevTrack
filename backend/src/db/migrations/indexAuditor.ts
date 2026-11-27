// src/db/migrations/indexAuditor.ts: Boot-time check that MongoDB has the indexes the schemas declare.
//
// For every registered Mongoose model it compares schema.indexes() with collection.indexes():
//   missing   declared but not in the database, built in the background
//   drift     same key or same name but different options (unique, TTL, partial filter, ...), reported only
//   orphaned  in the database but declared nowhere, reported only and never dropped
// The audit never drops or rewrites an index, so it cannot lose data or a unique guarantee.

import { isDeepStrictEqual } from 'node:util';
import mongoose from 'mongoose';
import { logger as sharedLogger } from '../../shared/logger.js';
import { PRODUCTION_INDEXES } from './index-setup.js';

type IndexKey = Record<string, unknown>;
type ExistingIndex = Awaited<ReturnType<mongoose.Collection['indexes']>>[number];
type AuditLogger = Pick<typeof sharedLogger, 'info' | 'warn' | 'error'>;

export interface DeclaredIndex {
  name: string;
  key: IndexKey;
  options: Record<string, unknown>;
}

export interface IndexDrift {
  name: string;
  key: IndexKey;
  existing: string;
  reasons: string[];
}

export interface OrphanedIndex {
  name: string;
  key: IndexKey;
  /** Operations that used the index since the mongod started ($indexStats), when available. */
  ops?: number;
}

export interface CollectionIndexAudit {
  collection: string;
  models: string[];
  missing: DeclaredIndex[];
  drift: IndexDrift[];
  orphaned: OrphanedIndex[];
  created: string[];
  failed: Array<{ name: string; error: string }>;
  /** Mongoose's own autoIndex run for one of the models rejected. */
  autoIndexError?: string;
}

export interface IndexAuditReport {
  collections: CollectionIndexAudit[];
  durationMs: number;
}

export interface IndexAuditOptions {
  /** Models to audit. Defaults to every model registered on the default connection. */
  models?: mongoose.Model<any>[];
  /** Build the missing indexes. Defaults to true. */
  build?: boolean;
  /** Indexes created outside the schemas that are expected to exist. Defaults to PRODUCTION_INDEXES. */
  knownIndexes?: ReadonlyArray<{ collection: string; key: IndexKey }>;
  logger?: AuditLogger;
}

const NAMESPACE_NOT_FOUND = 26;

// --- Declared indexes -------------------------------------------------------

function isTextKey(key: IndexKey): boolean {
  return Object.values(key).includes('text');
}

/** The name MongoDB gives an index created without one, e.g. `userId_1_createdAt_-1`. */
export function defaultIndexName(key: IndexKey): string {
  return Object.entries(key).map(([field, type]) => `${field}_${String(type)}`).join('_');
}

/** schema.indexes() normalized the way Mongoose passes them to createIndex(). */
export function declaredIndexes(model: mongoose.Model<any>): DeclaredIndex[] {
  const schemaCollation = model.schema.get('collation');
  return model.schema.indexes().map(([fields, indexOptions]) => {
    const key = { ...fields } as IndexKey;
    const options: Record<string, unknown> = { ...indexOptions };
    delete options._autoIndex;
    delete options.background;
    if (schemaCollation && options.collation == null && !isTextKey(key)) options.collation = schemaCollation;
    const name = typeof options.name === 'string' ? options.name : defaultIndexName(key);
    return { name, key, options };
  });
}

// --- Comparison ---------------------------------------------------------------

function isTextIndex(index: ExistingIndex): boolean {
  return index.textIndexVersion != null || index.key?._fts === 'text';
}

function sameKey(declared: IndexKey, existing: ExistingIndex): boolean {
  const existingEntries = Object.entries(existing.key ?? {});
  if (!isTextIndex(existing)) {
    const declaredEntries = Object.entries(declared);
    return declaredEntries.length === existingEntries.length
      && declaredEntries.every(([field, type], i) => existingEntries[i][0] === field && isDeepStrictEqual(existingEntries[i][1], type));
  }
  // MongoDB stores { a: 1, title: 'text' } as { a: 1, _fts: 'text', _ftsx: 1 } plus weights { title: 1 }.
  if (!isTextKey(declared)) return false;
  const declaredScalars = Object.entries(declared).filter(([, type]) => type !== 'text');
  const existingScalars = existingEntries.filter(([field]) => field !== '_fts' && field !== '_ftsx');
  const declaredText = Object.keys(declared).filter(field => declared[field] === 'text').sort();
  const existingText = Object.keys(existing.weights ?? {}).sort();
  return isDeepStrictEqual(declaredScalars, existingScalars) && isDeepStrictEqual(declaredText, existingText);
}

function show(value: unknown): string {
  return value === undefined ? 'unset' : JSON.stringify(value);
}

/** The options that make two indexes on the same key behave differently. Empty when they match. */
export function optionDifferences(declared: DeclaredIndex, existing: ExistingIndex): string[] {
  const reasons: string[] = [];
  const { options } = declared;
  for (const flag of ['unique', 'sparse'] as const) {
    if (Boolean(options[flag]) !== Boolean(existing[flag])) {
      reasons.push(`${flag}: declared ${Boolean(options[flag])}, found ${Boolean(existing[flag])}`);
    }
  }
  for (const option of ['partialFilterExpression', 'expireAfterSeconds'] as const) {
    if (!isDeepStrictEqual(options[option] ?? undefined, existing[option] ?? undefined)) {
      reasons.push(`${option}: declared ${show(options[option])}, found ${show(existing[option])}`);
    }
  }
  const declaredCollation = options.collation as Record<string, unknown> | undefined;
  const existingCollation = existing.collation as Record<string, unknown> | undefined;
  const collationDiffers = declaredCollation == null || existingCollation == null
    ? (declaredCollation == null) !== (existingCollation == null)
    : Object.keys(declaredCollation).some(field => !isDeepStrictEqual(declaredCollation[field], existingCollation[field]));
  if (collationDiffers) reasons.push(`collation: declared ${show(declaredCollation)}, found ${show(existingCollation)}`);
  if (isTextIndex(existing)) {
    const weights = (options.weights ?? {}) as Record<string, unknown>;
    for (const [field, weight] of Object.entries(existing.weights ?? {})) {
      if ((weights[field] ?? 1) !== weight) reasons.push(`weights.${field}: declared ${show(weights[field] ?? 1)}, found ${weight}`);
    }
    const language = options.default_language ?? 'english';
    if (language !== existing.default_language) {
      reasons.push(`default_language: declared ${show(language)}, found ${show(existing.default_language)}`);
    }
  }
  return reasons;
}

export interface IndexDiff {
  missing: DeclaredIndex[];
  drift: IndexDrift[];
  orphaned: OrphanedIndex[];
}

/** Pure diff of declared against existing indexes for one collection. */
export function diffIndexes(declared: DeclaredIndex[], existing: ExistingIndex[], known: IndexKey[] = []): IndexDiff {
  const unclaimed = existing.filter(index => index.name !== '_id_');
  const claim = (index: ExistingIndex) => unclaimed.splice(unclaimed.indexOf(index), 1);

  // Exact matches first, so a drifted declaration cannot take an index another declaration matches.
  const unmatched = declared.filter(index => {
    const match = unclaimed.find(candidate => sameKey(index.key, candidate) && optionDifferences(index, candidate).length === 0);
    if (match) claim(match);
    return !match;
  });

  const missing: DeclaredIndex[] = [];
  const drift: IndexDrift[] = [];
  for (const index of unmatched) {
    const byKey = unclaimed.find(candidate => sameKey(index.key, candidate));
    const byName = byKey ?? unclaimed.find(candidate => candidate.name === index.name);
    if (!byName) {
      missing.push(index);
      continue;
    }
    claim(byName);
    const reasons = byKey
      ? optionDifferences(index, byKey)
      : [`key: declared ${JSON.stringify(index.key)}, found ${JSON.stringify(byName.key)}`];
    drift.push({ name: index.name, key: index.key, existing: byName.name ?? defaultIndexName(byName.key), reasons });
  }

  const orphaned = unclaimed
    .filter(index => !known.some(key => sameKey(key, index)))
    .map(index => ({ name: index.name ?? defaultIndexName(index.key), key: index.key }));
  return { missing, drift, orphaned };
}

// --- Audit ----------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function listIndexes(collection: mongoose.Collection): Promise<ExistingIndex[]> {
  try {
    return await collection.indexes();
  } catch (error) {
    if ((error as { code?: number }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

async function attachUsage(collection: mongoose.Collection, orphaned: OrphanedIndex[]): Promise<void> {
  try {
    const stats = await collection.aggregate<{ name: string; accesses?: { ops?: number | bigint } }>([{ $indexStats: {} }]).toArray();
    for (const index of orphaned) {
      const ops = stats.find(stat => stat.name === index.name)?.accesses?.ops;
      if (ops != null) index.ops = Number(ops);
    }
  } catch {
    // $indexStats needs the indexStats privilege; usage is extra detail, the orphan is still reported.
  }
}

function defaultModels(): mongoose.Model<any>[] {
  return mongoose.modelNames().map(name => mongoose.model(name));
}

function defaultKnownIndexes(): Array<{ collection: string; key: IndexKey }> {
  return PRODUCTION_INDEXES.map(({ model, key }) => ({ collection: model.collection.collectionName, key }));
}

async function auditCollection(
  collection: mongoose.Collection,
  models: mongoose.Model<any>[],
  known: IndexKey[],
  build: boolean,
  log: AuditLogger,
): Promise<CollectionIndexAudit> {
  const name = collection.collectionName;
  const audit: CollectionIndexAudit = {
    collection: name, models: models.map(model => model.modelName), missing: [], drift: [], orphaned: [], created: [], failed: [],
  };

  // Let Mongoose's own autoIndex pass finish first so both do not build the same index at once.
  for (const model of models) {
    try {
      await model.init();
    } catch (error) {
      audit.autoIndexError = errorMessage(error);
      // The shared logger keeps the error name and code only: duplicate key messages carry document values.
      log.error('[index-audit] Mongoose autoIndex failed', error, { event: 'index_audit_autoindex_failed', collection: name, model: model.modelName });
    }
  }

  const declared = models.flatMap(declaredIndexes)
    .filter((index, i, all) => all.findIndex(other => other.name === index.name) === i);
  Object.assign(audit, diffIndexes(declared, await listIndexes(collection), known));

  for (const drift of audit.drift) {
    log.warn('[index-audit] Index differs from the schema declaration', { event: 'index_audit_drift', collection: name, ...drift });
  }
  if (audit.orphaned.length > 0) {
    await attachUsage(collection, audit.orphaned);
    for (const orphan of audit.orphaned) {
      log.warn('[index-audit] Index is not declared by any schema', { event: 'index_audit_orphaned', collection: name, ...orphan });
    }
  }

  for (const index of audit.missing) {
    log.warn('[index-audit] Declared index is missing', { event: 'index_audit_missing', collection: name, index: index.name, key: index.key, build });
    if (!build) continue;
    try {
      await collection.createIndex(index.key as mongoose.mongo.IndexSpecification, { ...index.options, name: index.name, background: true });
      audit.created.push(index.name);
      log.info('[index-audit] Built missing index', { event: 'index_audit_created', collection: name, index: index.name });
    } catch (error) {
      audit.failed.push({ name: index.name, error: errorMessage(error) });
      log.error('[index-audit] Failed to build missing index', error, { event: 'index_audit_build_failed', collection: name, index: index.name });
    }
  }
  return audit;
}

/**
 * Compares every model's declared indexes with the database, builds the missing ones and reports
 * drift and orphans. Never throws for a single collection: its error is logged and the audit moves on.
 */
export async function auditAndSyncIndexes(options: IndexAuditOptions = {}): Promise<IndexAuditReport> {
  const startedAt = Date.now();
  const log = options.logger ?? sharedLogger;
  const build = options.build ?? true;
  const known = options.knownIndexes ?? defaultKnownIndexes();

  // Models that share a collection are audited together.
  const byCollection = new Map<string, { collection: mongoose.Collection; models: mongoose.Model<any>[] }>();
  for (const model of options.models ?? defaultModels()) {
    if (model.baseModelName) continue; // Discriminators share the base model's collection and schema indexes.
    const groupKey = `${model.db.id}:${model.collection.collectionName}`;
    const group = byCollection.get(groupKey);
    if (group) group.models.push(model);
    else byCollection.set(groupKey, { collection: model.collection, models: [model] });
  }

  const collections: CollectionIndexAudit[] = [];
  for (const { collection, models } of byCollection.values()) {
    const name = collection.collectionName;
    try {
      const knownKeys = known.filter(index => index.collection === name).map(index => index.key);
      collections.push(await auditCollection(collection, models, knownKeys, build, log));
    } catch (error) {
      log.error('[index-audit] Could not audit collection', error, { event: 'index_audit_collection_failed', collection: name });
      collections.push({
        collection: name, models: models.map(model => model.modelName), missing: [], drift: [], orphaned: [], created: [],
        failed: [{ name: '*', error: errorMessage(error) }],
      });
    }
  }

  const report = { collections, durationMs: Date.now() - startedAt };
  const total = (field: 'missing' | 'drift' | 'orphaned' | 'created' | 'failed') =>
    collections.reduce((sum, audit) => sum + audit[field].length, 0);
  log.info('[index-audit] Index audit finished', {
    event: 'index_audit_complete',
    collections: collections.length,
    missing: total('missing'),
    created: total('created'),
    failed: total('failed'),
    drift: total('drift'),
    orphaned: total('orphaned'),
    durationMs: report.durationMs,
  });
  return report;
}

/**
 * Boot entry point: starts the audit without waiting for index builds. The returned promise never
 * rejects, so callers can fire and forget it.
 */
export function startIndexAudit(options: IndexAuditOptions = {}): Promise<IndexAuditReport | undefined> {
  const log = options.logger ?? sharedLogger;
  return auditAndSyncIndexes(options).catch((error: unknown) => {
    log.error('[index-audit] Index audit failed', error, { event: 'index_audit_failed' });
    return undefined;
  });
}
