import type { mongo } from 'mongoose';
import { EVIDENCE_LEDGER_INDEX } from '../models/evidenceLedgerIndex.js';

const collectionName = 'resumeevidenceclaims';
const legacyKey = { $concat: ['legacy:', { $toString: '$_id' }] };

export async function migrateEvidenceLedger(db: mongo.Db): Promise<void> {
  const collection = db.collection(collectionName);
  await collection.updateMany(
    { subjectType: { $exists: false }, subjectKey: { $exists: false } },
    [{ $set: { subjectType: 'resume_claim', subjectKey: legacyKey } }],
  );
  await collection.createIndex(EVIDENCE_LEDGER_INDEX.key, EVIDENCE_LEDGER_INDEX.options);
}

export async function rollbackEvidenceLedger(db: mongo.Db): Promise<void> {
  const collection = db.collection(collectionName);
  try {
    await collection.dropIndex(EVIDENCE_LEDGER_INDEX.options.name);
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 26 && code !== 27) throw error;
  }

  // Only remove fields added by this migration. Keep newly written claims.
  await collection.updateMany(
    { subjectType: 'resume_claim', $expr: { $eq: ['$subjectKey', legacyKey] } },
    { $unset: { subjectType: '', subjectKey: '' } },
  );
}
