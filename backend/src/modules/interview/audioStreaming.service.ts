// src/modules/interview/audioStreaming.service.ts
// Real-time audio chunk streaming pipeline and silence detection handler for Milestone 7 AI Mock Interview Studio.

import type { Redis } from 'ioredis';
import { getRedisClient } from '../../shared/redis/index.js';
import { logger } from '../../shared/logger.js';
import { enqueueInterviewTranscriptionJob } from './workers/interviewTranscription.worker.js';
import type { FinalTranscript, TranscriptionQueue } from './transcriptionQueue.js';

export interface AudioChunkMetadata {
  chunkIndex: number;
  isLast: boolean;
  durationMs?: number; // Slice duration, default 1500ms
}

export interface StoredAudioChunk {
  chunkIndex: number;
  buffer: Buffer;
  energy: number;
  isSilent: boolean;
  durationMs: number;
  receivedAt: number;
}

export interface SessionAudioMeta {
  sessionId: string;
  userId?: string;
  status: 'recording' | 'assembled' | 'transcribing' | 'completed';
  receivedIndices: number[];
  highestIndex: number;
  isLastReceived: boolean;
  lastChunkIndex: number | null;
  speechStarted: boolean;
  consecutiveSilenceMs: number;
  totalDurationMs: number;
  createdAt: number;
  updatedAt: number;
}

export interface IngestChunkResult {
  sessionId: string;
  chunkIndex: number;
  status: 'received' | 'duplicate_ignored' | 'speech_completed' | 'speech_ongoing';
  isSilent: boolean;
  energy: number;
  speechStarted: boolean;
  consecutiveSilenceMs: number;
  assembled: boolean;
  transcriptionEnqueued: boolean;
  missingChunks?: number[];
  assembledBuffer?: Buffer;
  totalDurationMs?: number;
  leadingTrimmedCount?: number;
  trailingTrimmedCount?: number;
  liveTranscriptionQueued?: boolean;
}

export interface LiveTranscriptionOptions {
  queue: TranscriptionQueue;
  onFinalTranscript?: (result: FinalTranscript) => void | Promise<void>;
}

export interface AudioStreamingConfig {
  silenceEnergyThreshold: number; // default: 0.015 (RMS amplitude threshold below which chunk is silent)
  silenceTimeoutMs: number; // default: 2500 (2.5s silence triggers completion)
  defaultChunkDurationMs: number; // default: 1500 (1.5s per slice)
  sessionTtlSeconds: number; // default: 900 (15 min auto-clean)
  maxChunkSizeBytes: number; // default: 2MB
}

export const DEFAULT_AUDIO_CONFIG: AudioStreamingConfig = {
  silenceEnergyThreshold: 0.015,
  silenceTimeoutMs: 2500,
  defaultChunkDurationMs: 1500,
  sessionTtlSeconds: 900,
  maxChunkSizeBytes: 2 * 1024 * 1024,
};

/**
 * Computes Root Mean Square (RMS) energy of an audio buffer.
 * Samples 16-bit signed values (normalized to [-1.0, 1.0]).
 * Zero/flat buffers return 0.0, silence returns < threshold.
 */
export function calculateAudioEnergy(buffer: Buffer): number {
  if (!buffer || buffer.length === 0) return 0;
  if (buffer.length < 16) return 0;

  let sumSquares = 0;
  let sampleCount = 0;
  const step = 2;
  const limit = buffer.length - (buffer.length % step);

  for (let i = 0; i < limit; i += step) {
    const sample = buffer.readInt16LE(i);
    const normalized = sample / 32768.0;
    sumSquares += normalized * normalized;
    sampleCount++;
  }

  if (sampleCount === 0) return 0;
  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Identifies missing chunk sequence indices between 0 and maxIndex.
 */
export function detectMissingChunks(receivedIndices: number[], maxIndex: number): number[] {
  const missing: number[] = [];
  for (let i = 0; i <= maxIndex; i++) {
    if (!receivedIndices.includes(i)) {
      missing.push(i);
    }
  }
  return missing;
}

/**
 * Trims leading and trailing silence chunks, assembling speech chunks in sequence.
 */
export function trimAndAssembleChunks(
  chunksMap: Map<number, StoredAudioChunk>,
  totalChunks: number,
): {
  buffer: Buffer;
  leadingTrimmedCount: number;
  trailingTrimmedCount: number;
  totalDurationMs: number;
} {
  const sorted: StoredAudioChunk[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunk = chunksMap.get(i);
    if (chunk) sorted.push(chunk);
  }

  if (sorted.length === 0) {
    return {
      buffer: Buffer.alloc(0),
      leadingTrimmedCount: 0,
      trailingTrimmedCount: 0,
      totalDurationMs: 0,
    };
  }

  // Find first non-silent chunk (leading speech boundary)
  let firstSpeechIndex = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (!sorted[i].isSilent) {
      firstSpeechIndex = i;
      break;
    }
  }

  // Find last non-silent chunk (trailing speech boundary)
  let lastSpeechIndex = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (!sorted[i].isSilent) {
      lastSpeechIndex = i;
      break;
    }
  }

  // Pure silence across entire answer
  if (firstSpeechIndex === -1 || lastSpeechIndex === -1) {
    return {
      buffer: Buffer.alloc(0),
      leadingTrimmedCount: sorted.length,
      trailingTrimmedCount: 0,
      totalDurationMs: 0,
    };
  }

  const leadingTrimmedCount = firstSpeechIndex;
  const trailingTrimmedCount = sorted.length - 1 - lastSpeechIndex;
  const speechSlices = sorted.slice(firstSpeechIndex, lastSpeechIndex + 1);
  const buffer = Buffer.concat(speechSlices.map(c => c.buffer));
  const totalDurationMs = speechSlices.reduce((acc, c) => acc + c.durationMs, 0);

  return {
    buffer,
    leadingTrimmedCount,
    trailingTrimmedCount,
    totalDurationMs,
  };
}

export class AudioStreamingService {
  private config: AudioStreamingConfig;
  private redisClient: Redis | null = null;
  private explicitRedis: boolean = false;
  // In-memory state store used as fallback when Redis is absent or in local unit test harnesses
  private inMemorySessions: Map<string, { meta: SessionAudioMeta; chunks: Map<number, StoredAudioChunk> }> = new Map();
  private enqueueJob: typeof enqueueInterviewTranscriptionJob;
  private liveTranscription: LiveTranscriptionOptions | null;

  constructor(
    options?: Partial<AudioStreamingConfig>,
    customRedis?: Redis | null,
    enqueueFn?: typeof enqueueInterviewTranscriptionJob,
    liveTranscription?: LiveTranscriptionOptions | null
  ) {
    this.config = { ...DEFAULT_AUDIO_CONFIG, ...options };
    this.explicitRedis = customRedis !== undefined;
    this.redisClient = customRedis !== undefined ? customRedis : null;
    this.enqueueJob = enqueueFn ?? enqueueInterviewTranscriptionJob;
    this.liveTranscription = liveTranscription ?? null;
  }

  /**
   * Routes a newly stored chunk through the rate-limited transcription queue. Silent chunks are
   * marked as empty so they never hold back later segments of the ordered transcript.
   */
  private queueLiveTranscription(sessionId: string, chunkIndex: number, buffer: Buffer, isSilent: boolean): boolean {
    const live = this.liveTranscription;
    if (!live) return false;
    try {
      if (isSilent) {
        live.queue.skipChunk(sessionId, chunkIndex);
        return false;
      }
      live.queue.submit(sessionId, chunkIndex, buffer.toString('base64')).catch((err: unknown) => {
        logger.warn('[audio-streaming] Live chunk transcription did not complete', {
          sessionId,
          chunkIndex,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return true;
    } catch (err) {
      logger.warn('[audio-streaming] Failed to queue live chunk transcription', { sessionId, chunkIndex, err });
      return false;
    }
  }

  private finalizeLiveTranscription(sessionId: string, lastChunkIndex: number): void {
    const live = this.liveTranscription;
    if (!live) return;
    void live.queue
      .finalizeSession(sessionId, lastChunkIndex)
      .then(async (result) => {
        if (!result.complete) {
          logger.warn('[audio-streaming] Live transcript finalized with gaps', {
            sessionId,
            failedChunks: result.failedChunks,
            missingChunks: result.missingChunks,
          });
        }
        await live.onFinalTranscript?.(result);
      })
      .catch((err: unknown) => {
        logger.error('[audio-streaming] Failed to finalize live transcript', { sessionId, err });
      });
  }

  private getRedis(): Redis | null {
    if (this.explicitRedis) {
      if (
        this.redisClient &&
        typeof this.redisClient.hset === 'function' &&
        typeof this.redisClient.expire === 'function' &&
        typeof this.redisClient.hexists === 'function'
      ) {
        return this.redisClient;
      }
      return null;
    }
    try {
      const client = getRedisClient();
      if (
        client &&
        typeof client.hset === 'function' &&
        typeof client.expire === 'function' &&
        typeof client.hexists === 'function' &&
        typeof client.hget === 'function' &&
        typeof client.del === 'function'
      ) {
        return client;
      }
    } catch {
      // Redis not configured or running in memory-only test mode
    }
    return null;
  }

  private redisSessionKey(sessionId: string): string {
    return `audio:session:${sessionId}`;
  }

  /**
   * Loads or creates session audio metadata.
   */
  async getSessionMeta(sessionId: string): Promise<SessionAudioMeta> {
    const redis = this.getRedis();
    if (redis) {
      const key = this.redisSessionKey(sessionId);
      const rawMeta = await redis.hget(key, 'meta');
      let meta: SessionAudioMeta | null = null;
      if (rawMeta) {
        try {
          meta = JSON.parse(rawMeta);
        } catch {
          // corrupted json, reinitialize
        }
      }

      // Sync receivedIndices from actual stored chunk keys in Redis hash to prevent index loss from concurrent writes
      if (typeof redis.hkeys === 'function') {
        const allKeys = await redis.hkeys(key);
        const storedIndices = allKeys
          .filter((k) => k.startsWith('chunk:') && !k.startsWith('chunkMeta:'))
          .map((k) => Number(k.replace('chunk:', '')))
          .filter((n) => !isNaN(n));

        if (meta) {
          if (storedIndices.length > 0) {
            const indexSet = new Set([...meta.receivedIndices, ...storedIndices]);
            meta.receivedIndices = Array.from(indexSet).sort((a, b) => a - b);
            meta.highestIndex = Math.max(meta.highestIndex, ...meta.receivedIndices);
          }
          return meta;
        } else if (storedIndices.length > 0) {
          const initial = this.createInitialMeta(sessionId);
          initial.receivedIndices = storedIndices.sort((a, b) => a - b);
          initial.highestIndex = Math.max(...initial.receivedIndices);
          return initial;
        }
      } else if (meta) {
        return meta;
      }
    }

    const inMem = this.inMemorySessions.get(sessionId);
    if (inMem) {
      // Sync receivedIndices from in-memory chunks map
      const storedIndices = Array.from(inMem.chunks.keys()).sort((a, b) => a - b);
      if (storedIndices.length > 0) {
        const indexSet = new Set([...inMem.meta.receivedIndices, ...storedIndices]);
        inMem.meta.receivedIndices = Array.from(indexSet).sort((a, b) => a - b);
        inMem.meta.highestIndex = Math.max(inMem.meta.highestIndex, ...inMem.meta.receivedIndices);
      }
      return inMem.meta;
    }

    return this.createInitialMeta(sessionId);
  }

  private createInitialMeta(sessionId: string): SessionAudioMeta {
    return {
      sessionId,
      status: 'recording',
      receivedIndices: [],
      highestIndex: -1,
      isLastReceived: false,
      lastChunkIndex: null,
      speechStarted: false,
      consecutiveSilenceMs: 0,
      totalDurationMs: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Ingests a single audio chunk slice into the streaming session buffer.
   */
  async ingestChunk(
    sessionId: string,
    metadata: AudioChunkMetadata,
    buffer: Buffer,
    userId?: string
  ): Promise<IngestChunkResult> {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Valid sessionId is required');
    }

    const chunkIndex = Number(metadata.chunkIndex);
    if (isNaN(chunkIndex) || chunkIndex < 0 || !Number.isInteger(chunkIndex)) {
      throw new Error(`Invalid chunkIndex: ${metadata.chunkIndex}`);
    }

    if (!buffer || buffer.length === 0) {
      throw new Error('Audio chunk payload cannot be empty');
    }

    if (buffer.length > this.config.maxChunkSizeBytes) {
      throw new Error(`Audio chunk size (${buffer.length} bytes) exceeds maximum limit (${this.config.maxChunkSizeBytes} bytes)`);
    }

    const durationMs = metadata.durationMs ?? this.config.defaultChunkDurationMs;
    const energy = calculateAudioEnergy(buffer);
    const isSilent = energy < this.config.silenceEnergyThreshold;

    const redis = this.getRedis();
    const redisKey = this.redisSessionKey(sessionId);

    // Check for duplicate chunk index
    if (redis) {
      const exists = await redis.hexists(redisKey, `chunk:${chunkIndex}`);
      if (exists) {
        logger.info('[audio-streaming] Duplicate chunk ignored', { sessionId, chunkIndex });
        const meta = await this.getSessionMeta(sessionId);
        return {
          sessionId,
          chunkIndex,
          status: 'duplicate_ignored',
          isSilent,
          energy,
          speechStarted: meta.speechStarted,
          consecutiveSilenceMs: meta.consecutiveSilenceMs,
          assembled: false,
          transcriptionEnqueued: false,
        };
      }
    } else {
      const session = this.inMemorySessions.get(sessionId);
      if (session && session.chunks.has(chunkIndex)) {
        logger.info('[audio-streaming] Duplicate chunk ignored (in-memory)', { sessionId, chunkIndex });
        return {
          sessionId,
          chunkIndex,
          status: 'duplicate_ignored',
          isSilent,
          energy,
          speechStarted: session.meta.speechStarted,
          consecutiveSilenceMs: session.meta.consecutiveSilenceMs,
          assembled: false,
          transcriptionEnqueued: false,
        };
      }
    }

    // Load current session state
    const meta = await this.getSessionMeta(sessionId);
    if (userId && !meta.userId) {
      meta.userId = userId;
    }

    // Update speech and silence tracking
    if (!isSilent) {
      meta.speechStarted = true;
      meta.consecutiveSilenceMs = 0;
    } else {
      meta.consecutiveSilenceMs += durationMs;
    }

    // Update indexing metadata
    if (!meta.receivedIndices.includes(chunkIndex)) {
      meta.receivedIndices.push(chunkIndex);
      meta.receivedIndices.sort((a, b) => a - b);
    }
    meta.highestIndex = Math.max(meta.highestIndex, chunkIndex);
    meta.totalDurationMs += durationMs;
    meta.updatedAt = Date.now();

    if (metadata.isLast) {
      meta.isLastReceived = true;
      meta.lastChunkIndex = chunkIndex;
    }

    const storedChunk: StoredAudioChunk = {
      chunkIndex,
      buffer,
      energy,
      isSilent,
      durationMs,
      receivedAt: Date.now(),
    };

    // Store chunk in Redis or Memory
    if (redis) {
      await redis.hset(redisKey, {
        [`chunk:${chunkIndex}`]: buffer.toString('base64'),
        [`chunkMeta:${chunkIndex}`]: JSON.stringify({
          chunkIndex,
          energy,
          isSilent,
          durationMs,
          receivedAt: storedChunk.receivedAt,
        }),
      });

      // Query actual stored chunk keys to guarantee complete index set despite any concurrent writes
      if (typeof redis.hkeys === 'function') {
        const allKeys = await redis.hkeys(redisKey);
        const storedIndices = allKeys
          .filter((k) => k.startsWith('chunk:') && !k.startsWith('chunkMeta:'))
          .map((k) => Number(k.replace('chunk:', '')))
          .filter((n) => !isNaN(n));

        const indexSet = new Set([...meta.receivedIndices, ...storedIndices, chunkIndex]);
        meta.receivedIndices = Array.from(indexSet).sort((a, b) => a - b);
        meta.highestIndex = Math.max(meta.highestIndex, ...meta.receivedIndices);
      }

      await redis.hset(redisKey, {
        meta: JSON.stringify(meta),
      });
      // Refresh session TTL for auto-clean of orphaned recordings
      await redis.expire(redisKey, this.config.sessionTtlSeconds);
    } else {
      let session = this.inMemorySessions.get(sessionId);
      if (!session) {
        session = { meta, chunks: new Map() };
        this.inMemorySessions.set(sessionId, session);
      }
      session.chunks.set(chunkIndex, storedChunk);
      const storedIndices = Array.from(session.chunks.keys()).sort((a, b) => a - b);
      const indexSet = new Set([...meta.receivedIndices, ...storedIndices, chunkIndex]);
      meta.receivedIndices = Array.from(indexSet).sort((a, b) => a - b);
      meta.highestIndex = Math.max(meta.highestIndex, ...meta.receivedIndices);
      session.meta = meta;
    }

    const liveTranscriptionQueued = this.queueLiveTranscription(sessionId, chunkIndex, buffer, isSilent);

    // Evaluate speech completion triggers:
    // Trigger 1: Explicit isLast = true or isLast received previously
    // Trigger 2: Silence > 2.5s detected AFTER speech has begun
    const isSilenceTimeout = meta.speechStarted && meta.consecutiveSilenceMs >= this.config.silenceTimeoutMs;
    const shouldAssemble = metadata.isLast || meta.isLastReceived || isSilenceTimeout;

    if (!shouldAssemble) {
      return {
        sessionId,
        chunkIndex,
        status: 'speech_ongoing',
        isSilent,
        energy,
        speechStarted: meta.speechStarted,
        consecutiveSilenceMs: meta.consecutiveSilenceMs,
        assembled: false,
        transcriptionEnqueued: false,
        liveTranscriptionQueued,
      };
    }

    // Attempt assembly
    const expectedCount = meta.isLastReceived && meta.lastChunkIndex !== null
      ? meta.lastChunkIndex + 1
      : meta.highestIndex + 1;

    const missingChunks = detectMissingChunks(meta.receivedIndices, expectedCount - 1);
    if (missingChunks.length > 0) {
      logger.warn('[audio-streaming] Cannot assemble yet: missing chunks in sequence', {
        sessionId,
        missingChunks,
        receivedCount: meta.receivedIndices.length,
      });

      return {
        sessionId,
        chunkIndex,
        status: 'speech_ongoing',
        isSilent,
        energy,
        speechStarted: meta.speechStarted,
        consecutiveSilenceMs: meta.consecutiveSilenceMs,
        assembled: false,
        transcriptionEnqueued: false,
        missingChunks,
        liveTranscriptionQueued,
      };
    }

    // Assemble and enqueue transcription
    const assemblyResult = await this.assembleAndEnqueue(sessionId, meta, expectedCount);

    return {
      sessionId,
      chunkIndex,
      status: 'speech_completed',
      isSilent,
      energy,
      speechStarted: meta.speechStarted,
      consecutiveSilenceMs: meta.consecutiveSilenceMs,
      assembled: true,
      transcriptionEnqueued: assemblyResult.transcriptionEnqueued,
      assembledBuffer: assemblyResult.assembledBuffer,
      totalDurationMs: assemblyResult.totalDurationMs,
      leadingTrimmedCount: assemblyResult.leadingTrimmedCount,
      trailingTrimmedCount: assemblyResult.trailingTrimmedCount,
      liveTranscriptionQueued,
    };
  }

  /**
   * Assembles all sequential chunks, trims silence, enqueues transcription, and cleans temporary buffers.
   */
  private async assembleAndEnqueue(
    sessionId: string,
    meta: SessionAudioMeta,
    totalExpectedChunks: number
  ): Promise<{
    assembledBuffer: Buffer;
    totalDurationMs: number;
    leadingTrimmedCount: number;
    trailingTrimmedCount: number;
    transcriptionEnqueued: boolean;
  }> {
    const chunksMap = new Map<number, StoredAudioChunk>();
    const redis = this.getRedis();
    const redisKey = this.redisSessionKey(sessionId);

    // Atomic locking: guarantee only one worker/chunk initiates assembly and transcription enqueue
    if (redis) {
      if (typeof redis.hsetnx === 'function') {
        const lockAcquired = await redis.hsetnx(redisKey, 'status:assembling', '1');
        if (lockAcquired !== 1) {
          logger.info('[audio-streaming] Assembly already in progress or completed; skipping duplicate assembly', { sessionId });
          return {
            assembledBuffer: Buffer.alloc(0),
            totalDurationMs: 0,
            leadingTrimmedCount: 0,
            trailingTrimmedCount: 0,
            transcriptionEnqueued: false,
          };
        }
      }
    } else {
      const session = this.inMemorySessions.get(sessionId);
      if (session) {
        if ((session as any).isAssembling || session.meta.status === 'assembled' || session.meta.status === 'transcribing') {
          logger.info('[audio-streaming] Assembly already in progress (in-memory); skipping duplicate assembly', { sessionId });
          return {
            assembledBuffer: Buffer.alloc(0),
            totalDurationMs: 0,
            leadingTrimmedCount: 0,
            trailingTrimmedCount: 0,
            transcriptionEnqueued: false,
          };
        }
        (session as any).isAssembling = true;
      }
    }

    if (redis) {
      const allFields = await redis.hgetall(redisKey);
      for (let i = 0; i < totalExpectedChunks; i++) {
        const rawBase64 = allFields[`chunk:${i}`];
        const rawChunkMeta = allFields[`chunkMeta:${i}`];
        if (rawBase64 && rawChunkMeta) {
          const parsedMeta = JSON.parse(rawChunkMeta);
          chunksMap.set(i, {
            chunkIndex: i,
            buffer: Buffer.from(rawBase64, 'base64'),
            energy: parsedMeta.energy,
            isSilent: parsedMeta.isSilent,
            durationMs: parsedMeta.durationMs,
            receivedAt: parsedMeta.receivedAt,
          });
        }
      }
    } else {
      const session = this.inMemorySessions.get(sessionId);
      if (session) {
        session.chunks.forEach((chunk, idx) => {
          chunksMap.set(idx, chunk);
        });
      }
    }

    // Trim leading/trailing silence and assemble
    const { buffer: assembledBuffer, leadingTrimmedCount, trailingTrimmedCount, totalDurationMs } =
      trimAndAssembleChunks(chunksMap, totalExpectedChunks);

    meta.status = 'assembled';
    this.finalizeLiveTranscription(sessionId, totalExpectedChunks - 1);

    // Enqueue transcription job if speech is present
    let transcriptionEnqueued = false;
    if (assembledBuffer.length > 0) {
      try {
        await this.enqueueJob({
          sessionId,
          userId: meta.userId,
          audioBase64: assembledBuffer.toString('base64'),
          durationMs: totalDurationMs,
          totalChunks: totalExpectedChunks,
          trimmedLeadingChunks: leadingTrimmedCount,
          trimmedTrailingChunks: trailingTrimmedCount,
          completedAt: new Date().toISOString(),
        });
        transcriptionEnqueued = true;
        meta.status = 'transcribing';
      } catch (err) {
        logger.error('[audio-streaming] Failed to enqueue transcription job', { sessionId, err });
      }
    } else {
      logger.info('[audio-streaming] Assembled audio is empty or pure silence; skipping transcription enqueue', { sessionId });
    }

    // Clean up temporary chunks from Redis as requested in acceptance criteria
    await this.clearAudioBuffers(sessionId);

    return {
      assembledBuffer,
      totalDurationMs,
      leadingTrimmedCount,
      trailingTrimmedCount,
      transcriptionEnqueued,
    };
  }

  /**
   * Explicitly cleans temporary audio buffers (used on session disconnect or after transcription).
   */
  async cleanSessionAudio(sessionId: string): Promise<void> {
    this.liveTranscription?.queue.cancelSession(sessionId);
    await this.clearAudioBuffers(sessionId);
  }

  private async clearAudioBuffers(sessionId: string): Promise<void> {
    const redis = this.getRedis();
    if (redis) {
      await redis.del(this.redisSessionKey(sessionId));
    }
    this.inMemorySessions.delete(sessionId);
    logger.info('[audio-streaming] Cleaned temporary audio buffers', { sessionId });
  }

  /**
   * Retrieves current streaming status and received indices for a session.
   */
  async getStatus(sessionId: string): Promise<{
    sessionId: string;
    meta: SessionAudioMeta;
    missingChunks: number[];
    liveTranscript?: string;
  }> {
    const meta = await this.getSessionMeta(sessionId);
    const expected = meta.highestIndex >= 0 ? meta.highestIndex + 1 : 0;
    const missingChunks = detectMissingChunks(meta.receivedIndices, expected - 1);

    return {
      sessionId,
      meta,
      missingChunks,
      ...(this.liveTranscription ? { liveTranscript: this.liveTranscription.queue.getTranscript(sessionId) } : {}),
    };
  }
}

export const audioStreamingService = new AudioStreamingService();
