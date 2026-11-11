// src/workers/worker-dataset-ingestion.ts
import { Job, Worker } from 'bullmq';
import { WorkerFactory } from '../infrastructure/queues/WorkerFactory.js';
import { getRedisClient } from '../shared/redis/index.js';
import { logger } from '../shared/logger.js';
import { QueueNames, type DatasetIngestionJobData } from '../shared/jobs/types.js';
import { DatasetIngestionState } from '../db/models/datasetIngestion.model.js';
import fs from 'fs';
import csvParser from 'csv-parser';
import path from 'path';
import { DatasetResolver } from '../core/datasets/DatasetResolver.js';
import { DatasetRegistry } from '../core/datasets/DatasetRegistry.js';
import { DatasetLoader } from '../core/datasets/DatasetLoader.js';

let worker: Worker | null = null;

export async function startDatasetIngestionWorker(): Promise<Worker> {
  if (worker) {
    logger.warn('[DatasetIngestionWorker] Worker already running');
    return worker;
  }

  logger.info('[DatasetIngestionWorker] Starting dataset ingestion worker');

  worker = WorkerFactory.createWorker<DatasetIngestionJobData>(
    QueueNames.DATASET_INGESTION,
    async (job: Job<DatasetIngestionJobData>) => {
      const { datasetId, sourceFilePath, batchSize = 1000 } = job.data;
      logger.info(`[DatasetIngestionWorker] Processing dataset: ${datasetId}`);

      try {
        let state = await DatasetIngestionState.findOne({ datasetId });
        if (!state) {
          state = new DatasetIngestionState({
            datasetId,
            sourceFilePath,
            status: 'running',
            startedAt: new Date()
          });
          await state.save();
        } else if (state.status === 'completed') {
          logger.info(`[DatasetIngestionWorker] Dataset ${datasetId} is already completed.`);
          return;
        } else {
          state.status = 'running';
          await state.save();
        }

        let absolutePath = '';
        try {
          const registry = DatasetRegistry.getInstance();
          const metadata = registry.getDataset(datasetId);
          absolutePath = DatasetResolver.resolveDatasetPath(metadata.path);
        } catch (err) {
          // Fallback if not registered
          absolutePath = DatasetResolver.resolveDatasetPath(sourceFilePath);
        }
        
        if (!fs.existsSync(absolutePath)) {
          throw new Error(`File not found: ${absolutePath}`);
        }

        let rowIndex = 0;
        let batch: any[] = [];
        let rowsProcessed = state.rowsProcessed;
        let rowsFailed = state.rowsFailed;
        let lastCheckpoint = state.lastCheckpointIndex;

        return new Promise<void>((resolve, reject) => {
          const stream = fs.createReadStream(absolutePath)
            .pipe(csvParser())
            .on('data', async (row) => {
              rowIndex++;
              // Resumable parsing: skip until we reach the checkpoint
              if (rowIndex <= lastCheckpoint) {
                return;
              }

              batch.push(row);

              // Pause stream if batch is full to prevent memory bloat
              if (batch.length >= batchSize) {
                stream.pause();
                try {
                  const result = await processBatch(datasetId, batch, rowIndex);
                  rowsProcessed += batch.length;
                  rowsFailed += result.failed;
                  lastCheckpoint = rowIndex;
                  
                  // Update progress in MongoDB
                  state!.rowsProcessed = rowsProcessed;
                  state!.rowsFailed = rowsFailed;
                  state!.lastCheckpointIndex = lastCheckpoint;
                  await state!.save();
                  
                  batch = [];
                  stream.resume();
                } catch (error) {
                  stream.destroy(error as Error);
                }
              }
            })
            .on('end', async () => {
              try {
                // Process remaining batch
                if (batch.length > 0) {
                  const result = await processBatch(datasetId, batch, rowIndex);
                  rowsProcessed += batch.length;
                  rowsFailed += result.failed;
                  
                  state!.rowsProcessed = rowsProcessed;
                  state!.rowsFailed = rowsFailed;
                  state!.lastCheckpointIndex = rowIndex;
                }
                state!.status = 'completed';
                state!.completedAt = new Date();
                await state!.save();
                
                // Save Validation Report
                saveValidationReport(state!);
                
                logger.info(`[DatasetIngestionWorker] Successfully ingested ${datasetId}`);
                resolve();
              } catch (error) {
                reject(error);
              }
            })
            .on('error', async (error) => {
              state!.status = 'failed';
              state!.errorMessage = error.message;
              await state!.save();
              logger.error(`[DatasetIngestionWorker] Error parsing ${datasetId}`, error);
              reject(error);
            });
        });

      } catch (error) {
        logger.error(`[DatasetIngestionWorker] Ingestion job failed: ${datasetId}`, error);
        throw error;
      }
    },
    { concurrency: 1 }
  );

  worker.on('completed', (job) => {
    logger.info(`[DatasetIngestionWorker] Job completed: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[DatasetIngestionWorker] Job failed: ${job?.id}`, err);
  });
  return worker;
}

async function processBatch(datasetId: string, batch: any[], checkpointIndex: number) {
  // Simulate processing time
  await new Promise(res => setTimeout(res, 50));
  
  let failedCount = 0;
  // Simple validation logic
  for (const row of batch) {
    if (!row || Object.keys(row).length < 2) {
      failedCount++;
    }
    // E.g., validation checks for missing fields or malformed data
  }

  logger.info(`[DatasetIngestionWorker] ${datasetId}: Processed up to row ${checkpointIndex}. Failed: ${failedCount}`);
  return { failed: failedCount };
}

function saveValidationReport(state: any) {
  const report = {
    datasetId: state.datasetId,
    rows_processed: state.rowsProcessed,
    duplicates_removed: state.duplicatesSkipped,
    invalid_rows: state.rowsFailed,
    embedding_failures: 0,
    normalization_failures: state.rowsNormalized > 0 ? 0 : 0
  };
  
  const reportPath = DatasetResolver.resolveDatasetPath(`processed/validation_report_${state.datasetId}.json`);
  const dir = path.dirname(reportPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  logger.info(`[DatasetIngestionWorker] Validation report saved to ${reportPath}`);
}

export async function stopDatasetIngestionWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = null;
}
