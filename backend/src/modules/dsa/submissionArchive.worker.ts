// src/modules/dsa/submissionArchive.worker.ts — Cold archival for aged DSA submissions.
// Moves submissions older than 180 days out of the hot dsa_submissions collection into
// the compressed dsa_submissions_archive collection, in transactional batches of 500.
// Safe by construction: a batch is deleted from the hot collection only after it has been
// durably inserted into the cold collection within the same client session/transaction.

import mongoose, { type ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { logger } from '../../shared/logger.js';
import { DsaSubmission, DsaSubmissionArchive } from '../../db/models/index.js';

/** Submissions older than this are candidates for cold archival. */
export const ARCHIVAL_AGE_DAYS = 180;
/** Number of records migrated per transactional batch. */
export const BATCH_SIZE = 500;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Archive eligible submissions in batches until none remain older than the cutoff.
 * Each batch runs inside its own MongoDB transaction: the cold insert and the hot delete
 * commit together, so a failed cold insert leaves the hot record untouched.
 *
 * @returns total number of records migrated across all batches.
 */
export async function runSubmissionArchive(options: {
  batchSize?: number;
  ageDays?: number;
  now?: Date;
} = {}): Promise<{ migrated: number; batches: number }> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const ageDays = options.ageDays ?? ARCHIVAL_AGE_DAYS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - ageDays * MS_PER_DAY);

  let totalMigrated = 0;
  let batches = 0;
  let keepGoing = true;

  while (keepGoing) {
    const session: ClientSession = await mongoose.startSession();
    let batchMigrated = 0;
    try {
      batchMigrated = await session.withTransaction(async () => {
        // Cursor pagination: oldest eligible first, stable ordering by createdAt then _id.
        const candidates = await DsaSubmission.find({
          createdAt: { $lt: cutoff },
        })
          .sort({ createdAt: 1, _id: 1 })
          .limit(batchSize)
          .session(session)
          .lean();

        if (!candidates.length) return 0;

        const archiveDocs = candidates.map((doc) => {
          const plain = doc.toObject ? doc.toObject() : doc;
          return {
            ...plain,
            _id: new Types.ObjectId(plain._id),
            archivedAt: plain.archivedAt ?? new Date(),
          };
        });

        // Cold insert first. If this fails the transaction aborts and the hot delete never runs.
        await DsaSubmissionArchive.insertMany(archiveDocs, { session, ordered: false });

        const ids = candidates.map((doc) => doc._id);
        const deleteResult = await DsaSubmission.deleteMany(
          { _id: { $in: ids } },
          { session }
        );

        return deleteResult.deletedCount;
      });
    } finally {
      await session.endSession();
    }

    batches += 1;
    totalMigrated += batchMigrated;
    keepGoing = batchMigrated === batchSize;
  }

  logger.info('[submissionArchive] Archival sweep completed', {
    migrated: totalMigrated,
    batches,
    cutoff: cutoff.toISOString(),
  });

  return { migrated: totalMigrated, batches };
}

/**
 * BullMQ-compatible job handler for the maintenance queue.
 */
export async function handleSubmissionArchiveJob(): Promise<void> {
  const { migrated, batches } = await runSubmissionArchive();
  logger.info('[submissionArchive] Maintenance job finished', { migrated, batches });
}
