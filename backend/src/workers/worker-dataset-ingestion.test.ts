import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetIngestedRow, DatasetIngestionState } from '../db/models/datasetIngestion.model.js';
import { ingestDataset } from './worker-dataset-ingestion.js';

vi.mock('../core/datasets/DatasetRegistry.js', () => ({
  DatasetRegistry: { getInstance: () => ({ getDataset: (id: string) => ({ path: id }) }) },
}));
vi.mock('../core/datasets/DatasetResolver.js', () => ({
  DatasetResolver: { resolveDatasetPath: (file: string) => path.join(fixtureDir, file) },
}));

let fixtureDir: string;
beforeEach(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'devtrack-ingestion-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(fixtureDir, { recursive: true, force: true });
});

const getState = (datasetId: string) => DatasetIngestionState.findOne({ datasetId }).lean();
const data = (datasetId: string, batchSize: number) => ({ datasetId, sourceFilePath: datasetId, batchSize });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}

describe('dataset ingestion', () => {
  it('waits for each CSV batch and counts malformed rows and normalized duplicates', async () => {
    const datasetId = 'large.csv';
    const rows = Array.from({ length: 2301 }, (_, i) => `${i},"row, ${i}"`);
    await writeFile(path.join(fixtureDir, datasetId), ['\uFEFFid, text', ...rows, 'bad', 'extra,columns,here', '0,"row, 0 "'].join('\r\n'));

    const bulkWrite = DatasetIngestedRow.bulkWrite.bind(DatasetIngestedRow);
    const gate = deferred();
    const firstBatch = deferred();
    const writes = vi.spyOn(DatasetIngestedRow, 'bulkWrite').mockImplementationOnce(async operations => {
      firstBatch.resolve();
      await gate.promise;
      return bulkWrite(operations);
    });

    const running = ingestDataset(data(datasetId, 1000));
    try {
      await Promise.race([firstBatch.promise, running]);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(await getState(datasetId)).toMatchObject({ status: 'running', lastCheckpointIndex: 0 });
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      await running;
    }

    expect(writes).toHaveBeenCalledTimes(3);
    expect(await getState(datasetId)).toMatchObject({
      status: 'completed', rowsProcessed: 2304, rowsFailed: 2, rowsNormalized: 2301,
      duplicatesSkipped: 1, lastCheckpointIndex: 2304,
    });
    expect(await DatasetIngestedRow.countDocuments({ datasetId })).toBe(2301);
    const reportPath = path.join(fixtureDir, 'processed', `validation_report_${datasetId}.json`);
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
      rows_processed: 2304, duplicates_removed: 1, invalid_rows: 2,
    });
  });

  it.each(['csv', 'jsonl'])('records a %s stream error and resumes from the last committed batch', async extension => {
    const datasetId = `interrupted.${extension}`;
    const prefix = extension === 'csv'
      ? 'id,text\n1,one\n2,two\n'
      : '{"id":"1","text":"one"}\n{"id":"2","text":"two"}\n';
    const suffix = extension === 'csv'
      ? '2,two\n3,three\n'
      : '{"text":"two","id":"2"}\n{"id":"3","text":"three"}\n';
    await writeFile(path.join(fixtureDir, datasetId), prefix + suffix);
    const brokenSource = Readable.from((async function* () {
      yield Buffer.from(prefix);
      await vi.waitFor(async () => {
        expect((await getState(datasetId))?.lastCheckpointIndex).toBe(2);
      });
      throw new Error('injected source failure');
    })());
    vi.spyOn(fs, 'createReadStream').mockReturnValueOnce(brokenSource as unknown as fs.ReadStream);

    await expect(ingestDataset(data(datasetId, 2))).rejects.toThrow('injected source failure');
    expect(await getState(datasetId)).toMatchObject({
      status: 'failed', lastCheckpointIndex: 2, rowsProcessed: 2, errorMessage: 'injected source failure',
    });

    await ingestDataset(data(datasetId, 3));
    expect(await getState(datasetId)).toMatchObject({
      status: 'completed', lastCheckpointIndex: 4, rowsNormalized: 3, duplicatesSkipped: 1, errorMessage: null,
    });
    expect(await DatasetIngestedRow.countDocuments({ datasetId })).toBe(3);
  });

  it('replays uncheckpointed row writes without treating them as duplicates', async () => {
    const datasetId = 'replay.jsonl';
    await writeFile(path.join(fixtureDir, datasetId), [
      '{"id":1,"text":" one "}', '{"text":"one","id":1}', 'broken', '{"id":2,"text":"two"}',
    ].join('\n'));
    vi.spyOn(DatasetIngestedRow, 'countDocuments').mockRejectedValueOnce(new Error('injected failure after row writes'));

    await expect(ingestDataset(data(datasetId, 3))).rejects.toThrow('injected failure after row writes');
    expect(await getState(datasetId)).toMatchObject({ status: 'failed', lastCheckpointIndex: 0 });
    expect(await DatasetIngestedRow.countDocuments({ datasetId })).toBe(1);

    await ingestDataset(data(datasetId, 2));
    expect(await getState(datasetId)).toMatchObject({
      status: 'completed', rowsProcessed: 4, rowsNormalized: 2, duplicatesSkipped: 1, rowsFailed: 1,
    });
    expect(await DatasetIngestedRow.countDocuments({ datasetId })).toBe(2);
    expect(await DatasetIngestedRow.findOne({ datasetId, firstRowIndex: 1 }).lean()).toMatchObject({
      data: { id: 1, text: 'one' },
    });
  });

  it('rebuilds legacy completed checkpoints and skips a repeat of the persisted import', async () => {
    const datasetId = 'legacy.csv';
    await writeFile(path.join(fixtureDir, datasetId), 'id,text\n1,one\n2,two\n');
    await DatasetIngestionState.create({
      datasetId, sourceFilePath: datasetId, status: 'completed', rowsProcessed: 2, lastCheckpointIndex: 2,
    });

    await ingestDataset(data(datasetId, 1));
    const completed = await getState(datasetId);
    expect(completed).toMatchObject({ status: 'completed', rowsProcessed: 2, rowsNormalized: 2 });
    await ingestDataset(data(datasetId, 1));
    expect(await getState(datasetId)).toMatchObject({ completedAt: completed?.completedAt, rowsProcessed: 2 });
    expect(await DatasetIngestedRow.countDocuments({ datasetId })).toBe(2);
  });

  it('stops at a committed batch when the optional malformed-row limit is exceeded', async () => {
    const datasetId = 'failure-limit.jsonl';
    await writeFile(path.join(fixtureDir, datasetId), 'invalid\n{"id":1,"text":"one"}\n{"id":2,"text":"two"}\n');
    await expect(ingestDataset({ ...data(datasetId, 2), maxFailedRows: 0 })).rejects.toThrow('configured limit');
    expect(await getState(datasetId)).toMatchObject({
      status: 'failed', lastCheckpointIndex: 2, rowsFailed: 1, rowsNormalized: 1,
    });
    await ingestDataset({ ...data(datasetId, 2), maxFailedRows: 1 });
    expect(await getState(datasetId)).toMatchObject({
      status: 'completed', lastCheckpointIndex: 3, rowsFailed: 1, rowsNormalized: 2,
    });
  });

  it('keeps a superseded attempt from overwriting the newer attempt’s progress', async () => {
    const datasetId = 'concurrent.csv';
    await writeFile(path.join(fixtureDir, datasetId), 'id,text\n1,one\n2,two\n1,one\n');
    const bulkWrite = DatasetIngestedRow.bulkWrite.bind(DatasetIngestedRow);
    const gate = deferred();
    const firstBatch = deferred();
    vi.spyOn(DatasetIngestedRow, 'bulkWrite').mockImplementationOnce(async operations => {
      firstBatch.resolve();
      await gate.promise;
      return bulkWrite(operations);
    });

    const olderAttempt = ingestDataset(data(datasetId, 1));
    try {
      await Promise.race([firstBatch.promise, olderAttempt]);
      await ingestDataset(data(datasetId, 2));
    } finally {
      gate.resolve();
      await expect(olderAttempt).rejects.toThrow('superseded');
    }

    expect(await getState(datasetId)).toMatchObject({
      status: 'completed', lastCheckpointIndex: 3, rowsNormalized: 2, duplicatesSkipped: 1, errorMessage: null,
    });
    expect(await DatasetIngestedRow.countDocuments({ datasetId })).toBe(2);
  });
});
