import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Worker } from 'bullmq';
import csvParser from 'csv-parser';
import { DatasetRegistry } from '../core/datasets/DatasetRegistry.js';
import { DatasetResolver } from '../core/datasets/DatasetResolver.js';
import {
  DatasetIngestedRow,
  DatasetIngestionState,
  type IDatasetIngestionState,
} from '../db/models/datasetIngestion.model.js';
import { WorkerFactory } from '../infrastructure/queues/WorkerFactory.js';
import { MAX_DATASET_INGESTION_BATCH_SIZE, QueueNames, type DatasetIngestionJobData } from '../shared/jobs/types.js';
import { logger } from '../shared/logger.js';

let worker: Worker | null = null;
const maxCsvRowBytes = 1024 * 1024;

export async function startDatasetIngestionWorker(): Promise<Worker> {
  if (worker) {
    logger.warn('[DatasetIngestionWorker] Worker already running');
    return worker;
  }

  logger.info('[DatasetIngestionWorker] Starting dataset ingestion worker');
  worker = WorkerFactory.createWorker<DatasetIngestionJobData>(
    QueueNames.DATASET_INGESTION,
    job => ingestDataset(job.data),
    // A timer racing the processor would fail the job while it was still committing rows.
    { concurrency: 1, jobTimeoutMs: null }
  );

  worker.on('completed', job => {
    logger.info(`[DatasetIngestionWorker] Job completed: ${job.id}`);
  });
  worker.on('failed', (job, err) => {
    logger.error(`[DatasetIngestionWorker] Job failed: ${job?.id}`, err);
  });
  return worker;
}

export async function stopDatasetIngestionWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = null;
}

export async function ingestDataset({
  datasetId, sourceFilePath, batchSize = 1000, maxFailedRows,
}: DatasetIngestionJobData): Promise<void> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_DATASET_INGESTION_BATCH_SIZE) {
    throw new Error(`Dataset batch size must be an integer between 1 and ${MAX_DATASET_INGESTION_BATCH_SIZE}`);
  }
  if (maxFailedRows !== undefined && (!Number.isSafeInteger(maxFailedRows) || maxFailedRows < 0)) {
    throw new Error('Dataset failure limit must be a nonnegative integer');
  }

  await DatasetIngestionState.init();
  await DatasetIngestedRow.init();
  await DatasetIngestionState.updateOne({ datasetId }, { $setOnInsert: { sourceFilePath } }, { upsert: true });

  const attemptId = randomUUID();
  const claimedState = await DatasetIngestionState.findOneAndUpdate(
    { datasetId, $or: [{ status: { $ne: 'completed' } }, { sourceVersion: { $exists: false } }] },
    { $set: { attemptId, status: 'running', startedAt: new Date(), completedAt: null, errorMessage: null } },
    { new: true }
  );
  if (!claimedState) return;
  const state = claimedState;

  const activeAttempt = { _id: state._id, attemptId };
  async function updateState(changes: Partial<IDatasetIngestionState>): Promise<void> {
    const result = await DatasetIngestionState.updateOne(activeAttempt, { $set: changes });
    if (!result.matchedCount) throw new Error('Dataset ingestion was superseded by another attempt');
  }

  try {
    let registeredPath: string;
    try {
      registeredPath = DatasetRegistry.getInstance().getDataset(datasetId).path;
    } catch {
      registeredPath = sourceFilePath;
    }
    const absolutePath = DatasetResolver.resolveDatasetPath(registeredPath);
    const file = await stat(absolutePath);
    if (!file.isFile()) throw new Error('Dataset source must be a regular file');

    const sourceVersion = sha256(JSON.stringify([registeredPath, file.size, file.mtimeMs]));
    if (state.sourceVersion && state.sourceVersion !== sourceVersion) {
      throw new Error('Dataset source changed since ingestion started. Use a new dataset ID for the changed source.');
    }
    if (!state.sourceVersion) {
      // The previous worker checkpointed simulated rows without persisting them.
      const initialProgress = {
        sourceVersion,
        sourceFilePath: registeredPath,
        rowsProcessed: 0,
        rowsFailed: 0,
        rowsNormalized: 0,
        duplicatesSkipped: 0,
        lastCheckpointIndex: 0,
      };
      await updateState(initialProgress);
      state.set(initialProgress);
    }

    let rowIndex = 0;
    let batch: unknown[] = [];
    function checkFailureLimit(): void {
      if (maxFailedRows !== undefined && state.rowsFailed > maxFailedRows) {
        throw new Error(`Dataset exceeded the configured limit of ${maxFailedRows} malformed rows`);
      }
    }

    async function commitBatch(): Promise<void> {
      const progress = await persistBatch(datasetId, batch, rowIndex - batch.length);
      const counters = {
        rowsProcessed: state.rowsProcessed + batch.length,
        rowsFailed: state.rowsFailed + progress.failed,
        rowsNormalized: state.rowsNormalized + progress.normalized,
        duplicatesSkipped: state.duplicatesSkipped + progress.duplicates,
        lastCheckpointIndex: rowIndex,
      };
      await updateState(counters);
      state.set(counters);
      batch = [];
      checkFailureLimit();
    }

    checkFailureLimit();
    for await (const row of readRows(absolutePath)) {
      rowIndex++;
      if (rowIndex <= state.lastCheckpointIndex) continue;
      batch.push(row);
      if (batch.length === batchSize) await commitBatch();
    }
    if (batch.length) await commitBatch();

    await saveValidationReport(state);
    const result = await DatasetIngestionState.updateOne(
      activeAttempt,
      { $set: { status: 'completed', completedAt: new Date() }, $unset: { attemptId: 1 } }
    );
    if (!result.matchedCount) throw new Error('Dataset ingestion was superseded by another attempt');
    logger.info(`[DatasetIngestionWorker] Successfully ingested ${datasetId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    try {
      await DatasetIngestionState.updateOne(
        activeAttempt,
        { $set: { status: 'failed', errorMessage }, $unset: { attemptId: 1 } }
      );
    } catch (stateError) {
      logger.error(`[DatasetIngestionWorker] Could not record failure for ${datasetId}`, stateError);
    }
    throw error;
  }
}

async function* readRows(absolutePath: string): AsyncGenerator<unknown> {
  const extension = path.extname(absolutePath).toLowerCase();
  if (extension === '.jsonl' || extension === '.ndjson') {
    const source = fs.createReadStream(absolutePath);
    const lines = createInterface({ input: source, crlfDelay: Infinity });
    let readError: Error | undefined;
    lines.on('error', error => { readError = error; });
    try {
      for await (const line of lines) {
        let row: unknown;
        try {
          row = JSON.parse(line.replace(/^\uFEFF/, ''));
        } catch {
          row = null;
        }
        yield row;
      }
      if (readError) throw readError;
    } finally {
      lines.close();
      source.destroy();
    }
    return;
  }

  if (extension !== '.csv') throw new Error(`Unsupported dataset file format: ${extension}`);
  let headers: string[] = [];
  const parser = csvParser({
    maxRowBytes: maxCsvRowBytes,
    mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim(),
  }).on('headers', (value: string[]) => { headers = value; });

  const source = fs.createReadStream(absolutePath);
  source.on('error', error => parser.destroy(error));
  try {
    for await (const row of source.pipe(parser)) {
      const widthMatches = Object.keys(row).length === headers.length &&
        headers.every(header => header && Object.hasOwn(row, header));
      yield widthMatches ? row : null;
    }
  } finally {
    source.destroy();
    parser.destroy();
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function canonicalize(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  }
  return value;
}

async function persistBatch(datasetId: string, batch: unknown[], checkpoint: number) {
  const uniqueRows = new Map<string, { firstRowIndex: number; data: Record<string, unknown> }>();
  let failed = 0;
  batch.forEach((row, offset) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length < 2) {
      failed++;
      return;
    }
    const canonical = JSON.stringify(row, canonicalize);
    const id = sha256(JSON.stringify([datasetId, canonical]));
    if (!uniqueRows.has(id)) {
      uniqueRows.set(id, { firstRowIndex: checkpoint + offset + 1, data: JSON.parse(canonical) });
    }
  });

  if (!uniqueRows.size) return { failed, normalized: 0, duplicates: 0 };

  // A retry can encounter rows written just before a failed checkpoint update.
  // Count them by original position, so replay preserves both counters and records.
  await DatasetIngestedRow.bulkWrite([...uniqueRows].map(([_id, { firstRowIndex, data }]) => ({
    updateOne: {
      filter: { _id },
      update: { $setOnInsert: { datasetId, data }, $min: { firstRowIndex } },
      upsert: true,
    },
  })));
  const normalized = await DatasetIngestedRow.countDocuments({
    _id: { $in: [...uniqueRows.keys()] },
    firstRowIndex: { $gt: checkpoint },
  });
  return { failed, normalized, duplicates: batch.length - failed - normalized };
}

async function saveValidationReport(state: IDatasetIngestionState): Promise<void> {
  const report = {
    datasetId: state.datasetId,
    rows_processed: state.rowsProcessed,
    duplicates_removed: state.duplicatesSkipped,
    invalid_rows: state.rowsFailed,
    embedding_failures: 0,
    normalization_failures: 0,
  };
  const filename = `validation_report_${encodeURIComponent(state.datasetId)}.json`;
  const reportPath = DatasetResolver.resolveDatasetPath(`processed/${filename}`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}
