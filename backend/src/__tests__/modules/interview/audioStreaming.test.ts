// src/__tests__/modules/interview/audioStreaming.test.ts
// Unit and integration tests for audio chunk streaming pipeline and silence detection handler.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AudioStreamingService,
  calculateAudioEnergy,
  detectMissingChunks,
  trimAndAssembleChunks,
  type StoredAudioChunk,
} from '../../../modules/interview/audioStreaming.service.js';
import { createInterviewRoutes } from '../../../modules/interview/interview.routes.js';
import { mountApiRoutes } from '../../../routes/mount.js';

/**
 * Creates synthetic 16-bit PCM audio chunks for deterministic testing.
 * Speech produces high RMS energy (> 0.1), silence produces zero RMS energy (0.0).
 */
function createMockAudioChunk(type: 'speech' | 'silence', byteLength = 2048): Buffer {
  const buf = Buffer.alloc(byteLength);
  if (type === 'silence') {
    // Zeroed buffer (digital silence)
    buf.fill(0);
    return buf;
  }

  // Generate synthetic sine-wave speech signal in 16-bit signed PCM
  for (let i = 0; i < byteLength - 1; i += 2) {
    const sample = Math.round(16000 * Math.sin(i / 10));
    buf.writeInt16LE(sample, i);
  }
  return buf;
}

describe('AudioStreamingService - Core Utility Functions', () => {
  describe('calculateAudioEnergy', () => {
    it('returns 0 for empty or tiny buffer', () => {
      expect(calculateAudioEnergy(Buffer.alloc(0))).toBe(0);
      expect(calculateAudioEnergy(Buffer.alloc(8))).toBe(0);
    });

    it('returns 0 for digital silence (all zeros)', () => {
      const silenceBuf = createMockAudioChunk('silence', 1024);
      expect(calculateAudioEnergy(silenceBuf)).toBe(0);
    });

    it('returns significant energy for active speech signal (> 0.05)', () => {
      const speechBuf = createMockAudioChunk('speech', 2048);
      const energy = calculateAudioEnergy(speechBuf);
      expect(energy).toBeGreaterThan(0.05);
    });
  });

  describe('detectMissingChunks', () => {
    it('returns empty array when all chunks in range 0..maxIndex are present', () => {
      const received = [0, 1, 2, 3];
      expect(detectMissingChunks(received, 3)).toEqual([]);
    });

    it('identifies missing chunks in non-consecutive sequences', () => {
      const received = [0, 2, 4];
      expect(detectMissingChunks(received, 4)).toEqual([1, 3]);
    });

    it('detects missing leading chunk when sequence starts after 0', () => {
      const received = [1, 2];
      expect(detectMissingChunks(received, 2)).toEqual([0]);
    });
  });

  describe('trimAndAssembleChunks', () => {
    it('trims leading and trailing silence chunks while preserving contiguous speech', () => {
      const chunk0: StoredAudioChunk = {
        chunkIndex: 0,
        buffer: Buffer.from('silence-0'),
        energy: 0.001,
        isSilent: true,
        durationMs: 1500,
        receivedAt: 100,
      };
      const chunk1: StoredAudioChunk = {
        chunkIndex: 1,
        buffer: Buffer.from('silence-1'),
        energy: 0.002,
        isSilent: true,
        durationMs: 1500,
        receivedAt: 200,
      };
      const chunk2: StoredAudioChunk = {
        chunkIndex: 2,
        buffer: Buffer.from('SPEECH-A'),
        energy: 0.25,
        isSilent: false,
        durationMs: 1500,
        receivedAt: 300,
      };
      const chunk3: StoredAudioChunk = {
        chunkIndex: 3,
        buffer: Buffer.from('SPEECH-B'),
        energy: 0.35,
        isSilent: false,
        durationMs: 1500,
        receivedAt: 400,
      };
      const chunk4: StoredAudioChunk = {
        chunkIndex: 4,
        buffer: Buffer.from('silence-4'),
        energy: 0.001,
        isSilent: true,
        durationMs: 1500,
        receivedAt: 500,
      };

      const map = new Map<number, StoredAudioChunk>([
        [0, chunk0],
        [1, chunk1],
        [2, chunk2],
        [3, chunk3],
        [4, chunk4],
      ]);

      const result = trimAndAssembleChunks(map, 5);

      expect(result.leadingTrimmedCount).toBe(2); // trimmed chunks 0, 1
      expect(result.trailingTrimmedCount).toBe(1); // trimmed chunk 4
      expect(result.totalDurationMs).toBe(3000); // 1500 + 1500
      expect(result.buffer.toString()).toBe('SPEECH-ASPEECH-B');
    });

    it('returns empty buffer when entire recording is silence', () => {
      const chunk0: StoredAudioChunk = {
        chunkIndex: 0,
        buffer: Buffer.from('silence-0'),
        energy: 0.0,
        isSilent: true,
        durationMs: 1000,
        receivedAt: 100,
      };
      const map = new Map<number, StoredAudioChunk>([[0, chunk0]]);
      const result = trimAndAssembleChunks(map, 1);

      expect(result.buffer.length).toBe(0);
      expect(result.leadingTrimmedCount).toBe(1);
      expect(result.trailingTrimmedCount).toBe(0);
    });
  });
});

describe('AudioStreamingService - Ingestion and Lifecycle', () => {
  let service: AudioStreamingService;
  let mockEnqueueJob: any;

  beforeEach(() => {
    mockEnqueueJob = vi.fn().mockResolvedValue(undefined);
    service = new AudioStreamingService(
      {
        silenceEnergyThreshold: 0.015,
        silenceTimeoutMs: 2500,
        defaultChunkDurationMs: 1000,
      },
      null, // uses in-memory store
      mockEnqueueJob
    );
  });

  it('ingests sequential audio chunks in order without corruption', async () => {
    const sessionId = 'session-seq-101';
    const chunk0 = createMockAudioChunk('speech', 1024);
    const chunk1 = createMockAudioChunk('speech', 1024);

    const res0 = await service.ingestChunk(sessionId, { chunkIndex: 0, isLast: false }, chunk0);
    expect(res0.status).toBe('speech_ongoing');
    expect(res0.assembled).toBe(false);
    expect(res0.speechStarted).toBe(true);

    const res1 = await service.ingestChunk(sessionId, { chunkIndex: 1, isLast: true }, chunk1);
    expect(res1.status).toBe('speech_completed');
    expect(res1.assembled).toBe(true);
    expect(res1.transcriptionEnqueued).toBe(true);

    // Verify binary integrity of assembled payload
    const expected = Buffer.concat([chunk0, chunk1]);
    expect(res1.assembledBuffer?.equals(expected)).toBe(true);
    expect(mockEnqueueJob).toHaveBeenCalledOnce();
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        totalChunks: 2,
        audioBase64: expected.toString('base64'),
      })
    );
  });

  it('handles out-of-order chunk arrivals gracefully and reassembles in sequence', async () => {
    const sessionId = 'session-ooo-102';
    const speechBuf0 = createMockAudioChunk('speech', 1024);
    const speechBuf1 = createMockAudioChunk('speech', 1024);
    const speechBuf2 = createMockAudioChunk('speech', 1024);

    // Arrives: 2 (marked isLast)
    const res2 = await service.ingestChunk(sessionId, { chunkIndex: 2, isLast: true }, speechBuf2);
    expect(res2.status).toBe('speech_ongoing');
    expect(res2.assembled).toBe(false);
    expect(res2.missingChunks).toEqual([0, 1]);

    // Arrives: 0
    const res0 = await service.ingestChunk(sessionId, { chunkIndex: 0, isLast: false }, speechBuf0);
    expect(res0.status).toBe('speech_ongoing');
    expect(res0.assembled).toBe(false);

    // Arrives: 1 (completes the sequence 0, 1, 2)
    const res1 = await service.ingestChunk(sessionId, { chunkIndex: 1, isLast: false }, speechBuf1);
    expect(res1.status).toBe('speech_completed');
    expect(res1.assembled).toBe(true);
    expect(res1.transcriptionEnqueued).toBe(true);

    // Verified correctly ordered assembly
    const expectedOrder = Buffer.concat([speechBuf0, speechBuf1, speechBuf2]);
    expect(res1.assembledBuffer?.equals(expectedOrder)).toBe(true);
  });

  it('drops duplicate chunk arrivals gracefully without corrupting state or duplicating jobs', async () => {
    const sessionId = 'session-dup-103';
    const chunk0 = createMockAudioChunk('speech', 1024);

    const res1 = await service.ingestChunk(sessionId, { chunkIndex: 0, isLast: false }, chunk0);
    expect(res1.status).toBe('speech_ongoing');

    // Duplicate delivery of chunk 0
    const resDup = await service.ingestChunk(sessionId, { chunkIndex: 0, isLast: false }, chunk0);
    expect(resDup.status).toBe('duplicate_ignored');
    expect(resDup.assembled).toBe(false);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('correctly detects end-of-speech silence (> 2.5s) and triggers automatic transcription', async () => {
    const sessionId = 'session-silence-104';
    const speechChunk = createMockAudioChunk('speech', 1024);
    const silenceChunk = createMockAudioChunk('silence', 1024);

    // Chunk 0: Speech (starts speech)
    const r0 = await service.ingestChunk(sessionId, { chunkIndex: 0, isLast: false, durationMs: 1000 }, speechChunk);
    expect(r0.speechStarted).toBe(true);
    expect(r0.consecutiveSilenceMs).toBe(0);

    // Chunk 1: Silence 1s (total silence: 1000ms < 2500ms)
    const r1 = await service.ingestChunk(sessionId, { chunkIndex: 1, isLast: false, durationMs: 1000 }, silenceChunk);
    expect(r1.isSilent).toBe(true);
    expect(r1.consecutiveSilenceMs).toBe(1000);
    expect(r1.assembled).toBe(false);

    // Chunk 2: Silence 1s (total silence: 2000ms < 2500ms)
    const r2 = await service.ingestChunk(sessionId, { chunkIndex: 2, isLast: false, durationMs: 1000 }, silenceChunk);
    expect(r2.consecutiveSilenceMs).toBe(2000);
    expect(r2.assembled).toBe(false);

    // Chunk 3: Silence 1s (total silence: 3000ms >= 2500ms -> Triggers Speech Completion!)
    const r3 = await service.ingestChunk(sessionId, { chunkIndex: 3, isLast: false, durationMs: 1000 }, silenceChunk);
    expect(r3.consecutiveSilenceMs).toBe(3000);
    expect(r3.status).toBe('speech_completed');
    expect(r3.assembled).toBe(true);
    expect(r3.transcriptionEnqueued).toBe(true);
    // Trailing silence chunks (1, 2, 3) are trimmed, leaving only speech chunk 0
    expect(r3.trailingTrimmedCount).toBe(3);
    expect(r3.assembledBuffer?.equals(speechChunk)).toBe(true);
    expect(mockEnqueueJob).toHaveBeenCalledOnce();
  });

  it('does not trigger silence completion if speech has never started (initial pause)', async () => {
    const sessionId = 'session-leading-pause-105';
    const silenceChunk = createMockAudioChunk('silence', 1024);

    // Ingest 4 seconds of silence before any speech
    for (let i = 0; i < 4; i++) {
      const res = await service.ingestChunk(sessionId, { chunkIndex: i, isLast: false, durationMs: 1000 }, silenceChunk);
      expect(res.speechStarted).toBe(false);
      expect(res.status).toBe('speech_ongoing');
      expect(res.assembled).toBe(false);
    }

    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('cleans temporary buffers after transcription and on explicit session disconnect', async () => {
    const sessionId = 'session-clean-106';
    const speechChunk = createMockAudioChunk('speech', 1024);

    await service.ingestChunk(sessionId, { chunkIndex: 0, isLast: false }, speechChunk);
    const beforeClean = await service.getStatus(sessionId);
    expect(beforeClean.meta.receivedIndices).toEqual([0]);

    // Explicit disconnect / cleanup
    await service.cleanSessionAudio(sessionId);

    // After cleanup, session state is empty / reinitialized
    const afterClean = await service.getStatus(sessionId);
    expect(afterClean.meta.receivedIndices).toEqual([]);
    expect(afterClean.meta.highestIndex).toBe(-1);
  });

  it('validates chunk parameters and rejects invalid inputs', async () => {
    const sessionId = 'session-val-107';
    const chunk = createMockAudioChunk('speech', 1024);

    // Negative index
    await expect(service.ingestChunk(sessionId, { chunkIndex: -1, isLast: false }, chunk)).rejects.toThrow('Invalid chunkIndex');

    // Empty buffer
    await expect(service.ingestChunk(sessionId, { chunkIndex: 0, isLast: false }, Buffer.alloc(0))).rejects.toThrow('payload cannot be empty');

    // Missing sessionId
    await expect(service.ingestChunk('', { chunkIndex: 0, isLast: false }, chunk)).rejects.toThrow('Valid sessionId is required');
  });
});

describe('AudioStreamingService - Redis Storage & TTL Verification', () => {
  it('stores chunk data in Redis hash and sets session TTL expiration', async () => {
    const hsetMock = vi.fn().mockResolvedValue(1);
    const hexistsMock = vi.fn().mockResolvedValue(0);
    const expireMock = vi.fn().mockResolvedValue(1);
    const delMock = vi.fn().mockResolvedValue(1);
    const hgetallMock = vi.fn().mockResolvedValue({});
    const hgetMock = vi.fn().mockResolvedValue(null);
    const hkeysMock = vi.fn().mockResolvedValue(['chunk:0']);
    const hsetnxMock = vi.fn().mockResolvedValue(1);

    const mockRedis = {
      hset: hsetMock,
      hexists: hexistsMock,
      expire: expireMock,
      del: delMock,
      hget: hgetMock,
      hgetall: hgetallMock,
      hkeys: hkeysMock,
      hsetnx: hsetnxMock,
    } as any;

    const service = new AudioStreamingService(
      { sessionTtlSeconds: 900 },
      mockRedis,
      vi.fn().mockResolvedValue(undefined)
    );

    const sessionId = 'session-redis-201';
    const chunk = createMockAudioChunk('speech', 512);

    await service.ingestChunk(sessionId, { chunkIndex: 0, isLast: false }, chunk);

    // Verify Redis calls
    expect(hexistsMock).toHaveBeenCalledWith(`audio:session:${sessionId}`, 'chunk:0');
    expect(hsetMock).toHaveBeenCalledWith(
      `audio:session:${sessionId}`,
      expect.objectContaining({
        'chunk:0': chunk.toString('base64'),
      })
    );
    expect(expireMock).toHaveBeenCalledWith(`audio:session:${sessionId}`, 900);

    // Explicit cleanup calls DEL
    await service.cleanSessionAudio(sessionId);
    expect(delMock).toHaveBeenCalledWith(`audio:session:${sessionId}`);
  });
});

describe('AudioStreamingService - Concurrency & Atomic Lock Verification', () => {
  it('handles concurrent chunk uploads without dropping chunk indices or reporting false missing chunks', async () => {
    const memoryStore: Record<string, Record<string, string>> = {};
    const mockRedis = {
      hexists: vi.fn(async (key: string, field: string) => (memoryStore[key]?.[field] ? 1 : 0)),
      hset: vi.fn(async (key: string, fields: Record<string, string>) => {
        if (!memoryStore[key]) memoryStore[key] = {};
        Object.assign(memoryStore[key], fields);
        return Object.keys(fields).length;
      }),
      hget: vi.fn(async (key: string, field: string) => memoryStore[key]?.[field] ?? null),
      hkeys: vi.fn(async (key: string) => Object.keys(memoryStore[key] ?? {})),
      hgetall: vi.fn(async (key: string) => memoryStore[key] ?? {}),
      hsetnx: vi.fn(async (key: string, field: string, val: string) => {
        if (!memoryStore[key]) memoryStore[key] = {};
        if (memoryStore[key][field] !== undefined) return 0;
        memoryStore[key][field] = val;
        return 1;
      }),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn(async (key: string) => {
        delete memoryStore[key];
        return 1;
      }),
    } as any;

    const mockEnqueue = vi.fn().mockResolvedValue(undefined);
    const service = new AudioStreamingService({}, mockRedis, mockEnqueue);
    const sessionId = 'session-concurrent-test';

    // Ingest chunks 0, 1, 2, 3 concurrently
    const chunkBuffers = [0, 1, 2, 3].map(() => createMockAudioChunk('speech', 512));
    await Promise.all(
      chunkBuffers.map((buf, idx) =>
        service.ingestChunk(sessionId, { chunkIndex: idx, isLast: idx === 3 }, buf)
      )
    );

    // Verify all chunks were registered and assembly succeeded with 1 enqueue
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it('guarantees only one transcription job is enqueued under concurrent assembly triggers', async () => {
    let assemblingFlag = 0;
    const mockRedis = {
      hexists: vi.fn().mockResolvedValue(0),
      hset: vi.fn().mockResolvedValue(1),
      hget: vi.fn().mockResolvedValue(null),
      hkeys: vi.fn().mockResolvedValue(['chunk:0', 'chunk:1']),
      hgetall: vi.fn().mockResolvedValue({
        'chunk:0': createMockAudioChunk('speech', 512).toString('base64'),
        'chunkMeta:0': JSON.stringify({ chunkIndex: 0, energy: 0.1, isSilent: false, durationMs: 1500, receivedAt: 100 }),
        'chunk:1': createMockAudioChunk('speech', 512).toString('base64'),
        'chunkMeta:1': JSON.stringify({ chunkIndex: 1, energy: 0.1, isSilent: false, durationMs: 1500, receivedAt: 200 }),
      }),
      hsetnx: vi.fn(async (_key: string, _field: string, _val: string) => {
        if (assemblingFlag === 1) return 0;
        assemblingFlag = 1;
        return 1;
      }),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    } as any;

    const mockEnqueue = vi.fn().mockResolvedValue(undefined);
    const service = new AudioStreamingService({}, mockRedis, mockEnqueue);
    const sessionId = 'session-race-assembly';

    // Two concurrent calls attempting to assemble
    const chunk0 = createMockAudioChunk('speech', 512);
    const chunk1 = createMockAudioChunk('speech', 512);
    const [res0, res1] = await Promise.all([
      service.ingestChunk(sessionId, { chunkIndex: 0, isLast: true }, chunk0),
      service.ingestChunk(sessionId, { chunkIndex: 1, isLast: true }, chunk1),
    ]);

    // Exactly one call should have enqueued the transcription job
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const enqueuedCount = [res0.transcriptionEnqueued, res1.transcriptionEnqueued].filter(Boolean).length;
    expect(enqueuedCount).toBe(1);
  });
});

describe('Interview Audio HTTP Routes Integration', () => {
  let app: express.Express;
  let server: Server;
  let baseUrl: string;
  let mockService: Partial<AudioStreamingService>;

  beforeEach(async () => {
    mockService = {
      ingestChunk: vi.fn().mockResolvedValue({
        sessionId: 'session-http-301',
        chunkIndex: 0,
        status: 'speech_ongoing',
        isSilent: false,
        energy: 0.12,
        speechStarted: true,
        consecutiveSilenceMs: 0,
        assembled: false,
        transcriptionEnqueued: false,
      }),
      getStatus: vi.fn().mockResolvedValue({
        sessionId: 'session-http-301',
        meta: {
          sessionId: 'session-http-301',
          status: 'recording',
          receivedIndices: [0],
          highestIndex: 0,
          isLastReceived: false,
          lastChunkIndex: null,
          speechStarted: true,
          consecutiveSilenceMs: 0,
          totalDurationMs: 1500,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        missingChunks: [],
      }),
      cleanSessionAudio: vi.fn().mockResolvedValue(undefined),
    };

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    const interviewRoutes = createInterviewRoutes({
      audioService: mockService as AudioStreamingService,
      auth: (req, _res, next) => {
        (req as any).user = { id: 'test-user-123' };
        next();
      },
    });

    const rootRouter = express.Router();
    rootRouter.use('/interview', interviewRoutes);
    mountApiRoutes(app, rootRouter);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('POST /api/v2/interview/:sessionId/audio/chunk accepts multipart/form-data with binary chunk', async () => {
    const chunkData = createMockAudioChunk('speech', 1024);
    const form = new FormData();
    form.append('chunkIndex', '0');
    form.append('isLast', 'false');
    form.append('durationMs', '1500');
    form.append('chunk', new Blob([new Uint8Array(chunkData)], { type: 'audio/webm' }), 'slice-0.webm');

    const res = await fetch(`${baseUrl}/api/v2/interview/session-http-301/audio/chunk`, {
      method: 'POST',
      body: form,
    });

    const json = await res.json() as any;
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('speech_ongoing');
    expect(mockService.ingestChunk).toHaveBeenCalledOnce();
  });

  it('POST /api/v2/interview/:sessionId/audio/chunk accepts base64 JSON payload', async () => {
    const chunkData = createMockAudioChunk('speech', 512);

    const res = await fetch(`${baseUrl}/api/v2/interview/session-http-301/audio/chunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chunkIndex: 0,
        isLast: false,
        chunk: chunkData.toString('base64'),
      }),
    });

    const json = await res.json() as any;
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockService.ingestChunk).toHaveBeenCalledOnce();
  });

  it('returns 400 Bad Request when chunk payload is missing', async () => {
    const form = new FormData();
    form.append('chunkIndex', '0');
    form.append('isLast', 'false');

    const res = await fetch(`${baseUrl}/api/v2/interview/session-http-301/audio/chunk`, {
      method: 'POST',
      body: form,
    });

    const json = await res.json() as any;
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 Bad Request when chunkIndex metadata is missing or invalid', async () => {
    const chunkData = createMockAudioChunk('speech', 512);
    const form = new FormData();
    form.append('chunkIndex', 'not-a-number');
    form.append('isLast', 'false');
    form.append('chunk', new Blob([new Uint8Array(chunkData)], { type: 'audio/webm' }), 'slice.webm');

    const res = await fetch(`${baseUrl}/api/v2/interview/session-http-301/audio/chunk`, {
      method: 'POST',
      body: form,
    });

    const json = await res.json() as any;
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
  });

  it('GET /api/v2/interview/:sessionId/audio/status returns buffering status', async () => {
    const res = await fetch(`${baseUrl}/api/v2/interview/session-http-301/audio/status`);
    const json = await res.json() as any;

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.meta.sessionId).toBe('session-http-301');
    expect(mockService.getStatus).toHaveBeenCalledWith('session-http-301');
  });

  it('DELETE /api/v2/interview/:sessionId/audio cleans temporary buffers', async () => {
    const res = await fetch(`${baseUrl}/api/v2/interview/session-http-301/audio`, {
      method: 'DELETE',
    });
    const json = await res.json() as any;

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockService.cleanSessionAudio).toHaveBeenCalledWith('session-http-301');
  });
});
