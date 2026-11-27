// indexAuditor.test.ts: boot-time index audit against mongodb-memory-server.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import {
  auditAndSyncIndexes,
  declaredIndexes,
  diffIndexes,
  startIndexAudit,
  type IndexAuditOptions,
} from '../../db/migrations/indexAuditor.js';
import { setupProductionIndexes } from '../../db/migrations/index-setup.js';
// Registers every model in src/db/models, for the no-false-positives check below.
import '../../db/models/index.js';
import { ActivityEvent } from '../../db/models/activityEvent.model.js';

const reviewSchema = new Schema({
  userId: { type: String, required: true },
  nextReviewAt: Date,
  email: String,
  expiresAt: Date,
});
reviewSchema.index({ userId: 1, nextReviewAt: 1 });
reviewSchema.index({ email: 1 }, { unique: true, sparse: true });
reviewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
const ReviewFixture = mongoose.model('IndexAuditReviewFixture', reviewSchema, 'index_audit_reviews');

// Production runs can have autoIndex off; this model leaves every index to the auditor.
const manualSchema = new Schema({ tier: String, weeklyXp: Number }, { autoIndex: false, autoCreate: false });
manualSchema.index({ tier: 1, weeklyXp: -1 });
const ManualFixture = mongoose.model('IndexAuditManualFixture', manualSchema, 'index_audit_manual');

const COMPOUND = 'userId_1_nextReviewAt_1';

function quietLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function audit(models: mongoose.Model<any>[] = [ReviewFixture], options: IndexAuditOptions = {}) {
  const logger = quietLogger();
  const report = await auditAndSyncIndexes({ models, logger, knownIndexes: [], ...options });
  return { report, audit: report.collections[0], logger };
}

async function indexNames(model: mongoose.Model<any>): Promise<string[]> {
  return (await model.collection.indexes()).map(index => index.name!).sort();
}

beforeEach(async () => {
  await ReviewFixture.init();
  await ReviewFixture.collection.dropIndexes();
  await ReviewFixture.createIndexes();
  await ManualFixture.collection.drop().catch(() => undefined);
});

describe('auditAndSyncIndexes', () => {
  it('reports nothing when the collection matches the schema', async () => {
    const { audit: result } = await audit();
    expect(result).toMatchObject({ collection: 'index_audit_reviews', missing: [], drift: [], orphaned: [], created: [], failed: [] });
  });

  it('rebuilds a compound index that was dropped from the database', async () => {
    await ReviewFixture.collection.dropIndex(COMPOUND);
    expect(await indexNames(ReviewFixture)).not.toContain(COMPOUND);

    const { audit: result, logger } = await audit();

    expect(result.missing.map(index => index.name)).toEqual([COMPOUND]);
    expect(result.created).toEqual([COMPOUND]);
    expect(await indexNames(ReviewFixture)).toContain(COMPOUND);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: 'index_audit_missing', index: COMPOUND }));
    expect((await audit()).audit.missing).toEqual([]);
  });

  it('creates the indexes of a collection that does not exist yet when autoIndex is off', async () => {
    const { audit: result } = await audit([ManualFixture]);
    expect(result.created).toEqual(['tier_1_weeklyXp_-1']);
    const index = (await ManualFixture.collection.indexes()).find(entry => entry.name === 'tier_1_weeklyXp_-1');
    expect(index?.key).toEqual({ tier: 1, weeklyXp: -1 });
  });

  it('only reports missing indexes on a dry run', async () => {
    await ReviewFixture.collection.dropIndex(COMPOUND);
    const { audit: result } = await audit([ReviewFixture], { build: false });
    expect(result.missing.map(index => index.name)).toEqual([COMPOUND]);
    expect(result.created).toEqual([]);
    expect(await indexNames(ReviewFixture)).not.toContain(COMPOUND);
  });

  it('keeps building the other indexes when one build fails, and leaves the data alone', async () => {
    await ReviewFixture.collection.dropIndex('email_1');
    await ReviewFixture.collection.dropIndex(COMPOUND);
    await ReviewFixture.collection.insertMany([{ userId: 'a', email: 'same@example.com' }, { userId: 'b', email: 'same@example.com' }]);

    const { audit: result, logger } = await audit();

    expect(result.failed).toEqual([{ name: 'email_1', error: expect.stringContaining('E11000') }]);
    expect(result.created).toEqual([COMPOUND]);
    expect(await ReviewFixture.countDocuments()).toBe(2);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ event: 'index_audit_build_failed' }));
  });

  it('reports an index with the declared key but different options as drift and keeps it', async () => {
    await ReviewFixture.collection.dropIndex('email_1');
    await ReviewFixture.collection.createIndex({ email: 1 }, { name: 'email_1' });

    const { audit: result, logger } = await audit();

    expect(result.missing).toEqual([]);
    expect(result.drift).toEqual([{
      name: 'email_1', key: { email: 1 }, existing: 'email_1',
      reasons: ['unique: declared true, found false', 'sparse: declared true, found false'],
    }]);
    const existing = (await ReviewFixture.collection.indexes()).find(index => index.name === 'email_1');
    expect(existing?.unique).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: 'index_audit_drift', name: 'email_1' }));
  });

  it('reports a changed TTL as drift', async () => {
    await ReviewFixture.collection.dropIndex('expiresAt_1');
    await ReviewFixture.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 60 });

    const { audit: result } = await audit();

    expect(result.drift).toEqual([expect.objectContaining({
      name: 'expiresAt_1', reasons: ['expireAfterSeconds: declared 3600, found 60'],
    })]);
  });

  it('reports a declared index name taken by another key as drift', async () => {
    await ReviewFixture.collection.dropIndex(COMPOUND);
    await ReviewFixture.collection.createIndex({ userId: 1 }, { name: COMPOUND });

    const { audit: result } = await audit();

    expect(result.missing).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.drift).toEqual([expect.objectContaining({
      name: COMPOUND, existing: COMPOUND,
      reasons: ['key: declared {"userId":1,"nextReviewAt":1}, found {"userId":1}'],
    })]);
  });

  it('flags indexes no schema declares and never drops them', async () => {
    await ReviewFixture.collection.createIndex({ nextReviewAt: -1 }, { name: 'legacy_review_due' });
    await ReviewFixture.find({ nextReviewAt: { $lt: new Date() } }).hint('legacy_review_due');

    const { audit: result, logger } = await audit();

    expect(result.orphaned).toEqual([{ name: 'legacy_review_due', key: { nextReviewAt: -1 }, ops: 1 }]);
    expect(await indexNames(ReviewFixture)).toContain('legacy_review_due');
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: 'index_audit_orphaned', name: 'legacy_review_due' }));
  });

  it('treats the indexes from setupProductionIndexes as expected', async () => {
    await setupProductionIndexes();
    await ActivityEvent.init();

    const strict = await audit([ActivityEvent]);
    expect(strict.audit.orphaned.map(index => index.name)).toContain('idx_userId_createdAt');

    const report = await auditAndSyncIndexes({ models: [ActivityEvent], logger: quietLogger() });
    expect(report.collections[0].orphaned).toEqual([]);
  });

  it('moves on to the next collection when one cannot be audited', async () => {
    await ReviewFixture.collection.dropIndex(COMPOUND);
    vi.spyOn(ManualFixture.collection, 'indexes').mockRejectedValueOnce(new Error('not authorized on devtrack'));

    const { report, logger } = await audit([ManualFixture, ReviewFixture]);

    expect(report.collections.map(entry => entry.collection)).toEqual(['index_audit_manual', 'index_audit_reviews']);
    expect(report.collections[0].failed).toEqual([{ name: '*', error: 'not authorized on devtrack' }]);
    expect(report.collections[1].created).toEqual([COMPOUND]);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.any(Error), expect.objectContaining({ event: 'index_audit_collection_failed' }));
  });

  it('finds no drift between the real schemas and the indexes Mongoose builds for them', async () => {
    const models = mongoose.modelNames()
      .filter(name => !name.startsWith('IndexAudit'))
      .map(name => mongoose.model(name));
    expect(models.length).toBeGreaterThan(40);
    await Promise.all(models.map(model => model.init()));

    const report = await auditAndSyncIndexes({ models, logger: quietLogger() });

    const problems = report.collections.flatMap(entry => [
      ...entry.missing.map(index => `${entry.collection} missing ${index.name}`),
      ...entry.drift.map(index => `${entry.collection} drift ${index.name}: ${index.reasons.join('; ')}`),
      ...entry.orphaned.map(index => `${entry.collection} orphaned ${index.name}`),
      ...entry.failed.map(index => `${entry.collection} failed ${index.name}: ${index.error}`),
      ...(entry.autoIndexError ? [`${entry.collection} autoIndex: ${entry.autoIndexError}`] : []),
    ]);
    expect(problems).toEqual([]);
  });
});

describe('startIndexAudit', () => {
  it('resolves instead of rejecting when the audit itself fails', async () => {
    const logger = quietLogger();
    logger.info.mockImplementation(() => { throw new Error('log sink closed'); });

    await expect(startIndexAudit({ models: [ReviewFixture], logger, knownIndexes: [] })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.any(Error), { event: 'index_audit_failed' });
  });
});

describe('diffIndexes', () => {
  const textModel = mongoose.model('IndexAuditTextFixture', new Schema({ userId: String, title: String, tags: [String] })
    .index({ userId: 1, title: 'text', tags: 'text' }, { weights: { title: 5 } }));
  const stored = {
    v: 2, name: 'userId_1_title_text_tags_text', key: { userId: 1, _fts: 'text' as const, _ftsx: 1 },
    weights: { tags: 1, title: 5 }, default_language: 'english', language_override: 'language', textIndexVersion: 3,
  };

  it('matches a compound text index against its stored _fts form', () => {
    expect(diffIndexes(declaredIndexes(textModel), [stored])).toEqual({ missing: [], drift: [], orphaned: [] });
  });

  it('reports changed text weights as drift', () => {
    const diff = diffIndexes(declaredIndexes(textModel), [{ ...stored, weights: { tags: 1, title: 1 } }]);
    expect(diff.drift).toEqual([expect.objectContaining({ reasons: ['weights.title: declared 5, found 1'] })]);
  });
});
