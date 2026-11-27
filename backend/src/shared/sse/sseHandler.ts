// src/shared/sse/sseHandler.ts — SSE endpoint handler with correlation IDs
// Protected by auth middleware, userId-scoped, with heartbeat and cleanup.
// Supports Last-Event-ID reconnection with Redis stream backfill.

import { Request, Response } from 'express';

import { eventBus, SseClient } from './eventBus.js';

export const SSE_DRAIN_TIMEOUT_MS = 10_000;
export const SSE_MAX_REPLAY_HOLDBACK_EVENTS = 50;
export const SSE_MAX_REPLAY_HOLDBACK_BYTES = 256 * 1024;
import { logger } from '../logger.js';
import { env } from '../../config/env.js';
import { getRedisClient } from '../redis/client.js';
import { trackSseConnectionSuccess, trackSseConnectionFailure, trackSseDisconnection } from '../monitoring.js';

const encoder = new TextEncoder();

/** Error code returned when the handshake ticket is missing, expired, already used or unknown. */
export const SSE_TICKET_ERROR_CODE = 'INVALID_OR_MISSING_TICKET';

/** A Redis Stream ID is `<ms>-<seq>`, both unsigned integers. Anything else is not a stream position. */
export function parseStreamId(lastEventId: string | undefined | null): string | null {
  const match = /^(\d+)-(\d+)$/.exec((lastEventId || '').trim());
  return match ? `${match[1]}-${match[2]}` : null;
}

/** Entries read from the Redis stream per XRANGE call. */
export const REPLAY_PAGE_SIZE = 50;

/**
 * Most missed events a reconnect will replay. The stream is trimmed to about 100 entries
 * (see eventBus.ts), so a client further behind than this has lost part of its history
 * anyway and gets the full state instead of a partial replay.
 */
export const MAX_REPLAY_EVENTS = 100;

type StreamEntry = [string, string[]];

/**
 * Pages through the stream after `afterId` until it is exhausted. Returns null when more than
 * MAX_REPLAY_EVENTS entries are waiting, so the caller can fall back to full state instead of
 * replaying a prefix and silently dropping the rest.
 */
async function readMissedEvents(
  redis: ReturnType<typeof getRedisClient>,
  streamKey: string,
  afterId: string
): Promise<StreamEntry[] | null> {
  const events: StreamEntry[] = [];
  let cursor = afterId;

  for (;;) {
    // `(` makes the start exclusive, so the next page never repeats the last entry of this one.
    const page = (await redis.xrange(streamKey, `(${cursor}`, '+', 'COUNT', REPLAY_PAGE_SIZE)) as StreamEntry[];
    events.push(...page);
    if (events.length > MAX_REPLAY_EVENTS) return null;
    if (page.length < REPLAY_PAGE_SIZE) return events;
    cursor = page[page.length - 1][0];
  }
}

function isInitializedRuntimeState(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;

  const value = state as Record<string, unknown>;
  if (value.lastCalculatedAt === null || value.lastCalculatedAt === undefined) return false;

  return Number.isFinite(new Date(value.lastCalculatedAt as string | number | Date).getTime())
    && typeof value.xp === 'number'
    && typeof value.level === 'number'
    && Boolean(value.sessionContext && typeof value.sessionContext === 'object');
}

function normalizeStatePayload(state: unknown): unknown {
  if (state && typeof state === 'object') {
    const toObject = (state as { toObject?: unknown }).toObject;
    if (typeof toObject === 'function') return toObject.call(state);
  }
  return state;
}

async function sendFullState(
  userId: string,
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<void> {
  try {
    const { unifiedRuntimeStateService } = await import('../../modules/runtime-state/unifiedRuntimeState.service.js');
    let state = await unifiedRuntimeStateService.getRuntimeState(userId);
    if (!isInitializedRuntimeState(state)) {
      state = await unifiedRuntimeStateService.getRuntimeStateFresh(userId);
    }
    if (!isInitializedRuntimeState(state)) throw new Error('Runtime state is unavailable or incomplete');

    const fullStateEvent = {
      id: `${userId}-full-${Date.now()}`,
      type: 'runtime_state_full' as const,
      sequence: 0,
      timestamp: new Date().toISOString(),
      userId,
      payload: { state: normalizeStatePayload(state) },
    };

    const payload = `id: ${fullStateEvent.id}\ndata: ${JSON.stringify(fullStateEvent)}\n\n`;
    controller.enqueue(encoder.encode(payload));
  } catch (error) {
    logger.warn('[sse] Failed to send initial runtime state', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    const errorEvent = {
      id: `${userId}-initial-error-${Date.now()}`,
      type: 'INITIAL_STATE_ERROR',
      sequence: 0,
      timestamp: new Date().toISOString(),
      userId,
      payload: { error: 'Unable to load initial runtime state' },
    };
    try {
      controller.enqueue(encoder.encode(`id: ${errorEvent.id}\ndata: ${JSON.stringify(errorEvent)}\n\n`));
    } catch {
      // Stream already closed before error event could be sent
    }
  }
}

/**
 * Replays what the client missed while it was disconnected. Returns the ids of the events it
 * sent, so the caller can drop live copies of the same events.
 */
export async function replayMissedEvents(
  userId: string,
  lastEventId: string,
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<Set<string>> {
  const redis = getRedisClient();
  const streamKey = `sse:stream:${userId}`;
  const replayedIds = new Set<string>();

  try {
    // Last-Event-ID is a full `<ms>-<seq>` stream id. A malformed or foreign id (an older
    // client, a fallback id) cannot be placed in the stream, so skip replay and resend full state.
    const lastStreamId = parseStreamId(lastEventId);
    const lastSequence = lastStreamId;

    // Read every event strictly after that position, a page at a time
    const events = lastStreamId ? await readMissedEvents(redis, streamKey, lastStreamId) : [];

    if (events === null) {
      logger.info('[sse] Gap too large to replay, sending full state', {
        userId,
        lastSequence,
        maxReplayEvents: MAX_REPLAY_EVENTS,
      });
      await sendFullState(userId, controller);
    } else if (events.length > 0) {
      logger.info('[sse] Replaying missed events', {
        userId,
        lastSequence,
        eventCount: events.length,
      });

      for (const event of events) {
        // event is [id, [field1, value1, field2, value2, ...]]
        const [id, fields] = event;
        const fieldsObj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          fieldsObj[fields[i]] = fields[i + 1];
        }

        const envelope = {
          id,
          type: fieldsObj.type as string,
          sequence: parseInt(fieldsObj.sequence, 10),
          timestamp: fieldsObj.timestamp,
          userId,
          payload: JSON.parse(fieldsObj.payload),
        };

        const payload = `id: ${envelope.id}\ndata: ${JSON.stringify(envelope)}\n\n`;
        controller.enqueue(new TextEncoder().encode(payload));
        replayedIds.add(id);
      }
    } else {
      // Nothing in the stream after that position (or no usable position): send full state
      logger.info('[sse] No events to replay, sending full state', {
        userId,
        lastSequence,
      });
      await sendFullState(userId, controller);
    }
  } catch (error) {
    logger.warn('[sse] Failed to replay missed events', {
      userId,
      lastEventId,
      error,
    });
  }

  return replayedIds;
}

export interface SseStreamOptions {
  isBackpressured?: () => boolean;
  terminate?: () => void;
}

export function createSseStream(
  userId: string,
  clientId: string,
  requestId: string,
  lastEventId?: string,
  options?: SseStreamOptions
): ReadableStream<Uint8Array> {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;

      // The event bus writes straight to client.controller. While the initial state or replay is
      // being read, this controller holds writes back so live events are delivered afterward.
      let replaying = true;
      let closeRequested = false;
      const heldBack: Uint8Array[] = [];
      let heldBackBytes = 0;
      const gatedController = {
        enqueue(chunk: Uint8Array) {
          if (replaying) {
            if (
              heldBack.length + 1 > SSE_MAX_REPLAY_HOLDBACK_EVENTS ||
              heldBackBytes + chunk.byteLength > SSE_MAX_REPLAY_HOLDBACK_BYTES
            ) {
              logger.warn('[sse] Disconnecting slow reconnecting client: holdback buffer exceeded', {
                event: 'sse_replay_holdback_overflow',
                clientId,
                userId,
                requestId,
                heldBackEvents: heldBack.length,
                heldBackBytes,
              });
              replaying = false;
              heldBack.length = 0;
              heldBackBytes = 0;
              closeRequested = true;
              options?.terminate?.();
              try {
                controller.close();
              } catch {
                // Stream already closed
              }
              eventBus.unregister(clientId);
              return;
            }
            heldBack.push(chunk);
            heldBackBytes += chunk.byteLength;
          } else {
            controller.enqueue(chunk);
          }
        },
        close: () => {
          if (replaying) closeRequested = true;
          else controller.close();
        },
        error: (reason?: unknown) => controller.error(reason),
        get desiredSize() {
          return controller.desiredSize;
        },
      } as ReadableStreamDefaultController<Uint8Array>;

      const client: SseClient = {
        id: clientId,
        userId,
        controller: gatedController,
        connectedAt: Date.now(),
        isBackpressured: options?.isBackpressured,
        terminate: options?.terminate,
        emit(event) {
          if (!controllerRef) return;
          try {
            let payload = '';
            if (event.id) {
              payload += `id: ${event.id}\n`;
            }
            payload += `data: ${JSON.stringify(event)}\n\n`;
            controllerRef.enqueue(encoder.encode(payload));
          } catch {
            // Stream closed
          }
        },
        destroy() {
          controllerRef = null;
        },
      };

      // Register before reading the stream: an event published after the read but before
      // registration used to be neither replayed nor delivered.
      try {
        eventBus.register(client);
      } catch (err) {
        logger.error('[sse] Failed to register client', err as Error, {
          requestId,
          clientId,
          error: err instanceof Error ? err.message : String(err),
          event: 'sse_register_failed',
        });
        controller.error(err);
        return;
      }

      // Replay missed events or send the initial full state before releasing live events.
      let replayedIds = new Set<string>();
      if (lastEventId) replayedIds = await replayMissedEvents(userId, lastEventId, controller);
      else await sendFullState(userId, controller);
      replaying = false;
      // An event written just before the read can be both replayed and held back.
      const decoder = new TextDecoder();
      for (const chunk of heldBack) {
        const id = /^id: (.+)$/m.exec(decoder.decode(chunk))?.[1];
        if (id && replayedIds.has(id)) continue;
        try {
          controller.enqueue(chunk);
        } catch {
          // Stream closed while replaying
          break;
        }
      }
      heldBack.length = 0;
      heldBackBytes = 0;
      if (closeRequested) {
        try {
          controller.close();
        } catch {
          // Stream already closed
        }
      }
    },
    pull() {
      eventBus.notifyClientDrain?.(clientId);
    },
    cancel() {
      eventBus.unregister(clientId);
      logger.info('[sse] Stream cancelled', {
        event: 'sse_stream_cancelled',
        clientId,
        userId,
        requestId,
      });
    },
  });

  return stream;
}

export interface SseSinkController {
  writable: WritableStream<Uint8Array>;
  isBackpressured: () => boolean;
  terminate: () => void;
}

/**
 * Builds a backpressure-aware WritableStream sink over Express's ServerResponse.
 * Pauses stream pulling whenever `res.write(chunk)` returns false, resumes on `drain`,
 * and terminates the stalled socket if `drain` does not arrive within `drainTimeoutMs`.
 */
export function createSseWritableSink(
  res: Response,
  clientId: string,
  requestId: string,
  options?: {
    drainTimeoutMs?: number;
    onDrain?: () => void;
    onUnregister?: () => void;
  }
): SseSinkController {
  const drainTimeoutMs = options?.drainTimeoutMs ?? SSE_DRAIN_TIMEOUT_MS;
  const unregister = options?.onUnregister ?? (() => eventBus.unregister(clientId));
  let backpressured = false;
  let terminated = false;
  let cancelPendingDrain: ((reason: Error) => void) | null = null;

  const terminate = () => {
    if (terminated) return;
    terminated = true;
    backpressured = false;
    cancelPendingDrain?.(new Error('SSE connection terminated due to backpressure'));
    cancelPendingDrain = null;
    try {
      if (!res.writableEnded) {
        res.end();
      }
    } catch {
      // Response already closed
    }
  };

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (terminated || res.writableEnded || res.destroyed) {
        throw new Error('SSE response stream is closed');
      }

      const ok = res.write(chunk);
      if (ok) {
        backpressured = false;
        return;
      }

      backpressured = true;
      return new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          clearTimeout(timer);
          res.off('drain', onDrain);
          res.off('close', onClose);
          res.off('error', onError);
          if (cancelPendingDrain === abortDrain) {
            cancelPendingDrain = null;
          }
        };

        const onDrain = () => {
          if (settled) return;
          settled = true;
          backpressured = false;
          cleanup();
          options?.onDrain?.();
          resolve();
        };

        const onClose = () => {
          if (settled) return;
          settled = true;
          backpressured = false;
          cleanup();
          reject(new Error('SSE response closed before drain'));
        };

        const onError = (err: Error) => {
          if (settled) return;
          settled = true;
          backpressured = false;
          cleanup();
          reject(err);
        };

        const abortDrain = (reason: Error) => {
          if (settled) return;
          settled = true;
          backpressured = false;
          cleanup();
          reject(reason);
        };

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          backpressured = false;
          cleanup();
          logger.warn('[sse] Client failed to drain within timeout; terminating stalled connection', {
            event: 'sse_drain_timeout',
            clientId,
            requestId,
            drainTimeoutMs,
          });
          terminate();
          unregister();
          reject(new Error('SSE client drain timeout exceeded'));
        }, drainTimeoutMs);
        timer.unref?.();

        cancelPendingDrain = abortDrain;
        res.once('drain', onDrain);
        res.once('close', onClose);
        res.once('error', onError);
      });
    },
    close() {
      terminate();
      unregister();
    },
    abort(err) {
      logger.warn('[sse] Stream aborted', {
        event: 'sse_stream_aborted',
        clientId,
        requestId,
        error: String(err),
      });
      terminate();
      unregister();
    },
  });

  return {
    writable,
    isBackpressured: () => backpressured,
    terminate,
  };
}

export async function handleSseRequest(req: Request, res: Response): Promise<void> {
  const requestId = req.context?.requestId ?? `sse-${Date.now()}`;
  const lastEventId = (req.headers['last-event-id'] || req.headers['Last-Event-ID'] || req.query.lastEventId) as string | undefined;

  // Ticket-only handshake: the client first exchanges its auth token for a short-lived,
  // single-use ticket (POST /auth/sse-handshake). A raw JWT in the query string is never
  // accepted, since query strings end up in access logs, proxies and browser history.
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : undefined;

  if (!ticket) {
    logger.warn('[sse] Handshake rejected: ticket missing', {
      event: 'sse_ticket_required',
      requestId,
      ip: req.ip,
      legacyTokenParam: req.query.token !== undefined,
    });
    trackSseConnectionFailure('unknown', 'ticket_required');
    res.status(401).json({
      error: 'A handshake ticket is required. Request one from POST /auth/sse-handshake.',
      code: SSE_TICKET_ERROR_CODE,
    });
    return;
  }

  let userId: string;
  try {
    const { consumeHandshakeTicket } = await import('./ticketStore.js');
    const ticketUserId = await consumeHandshakeTicket(ticket);

    if (!ticketUserId) {
      logger.warn('[sse] Ticket handshake failed: expired, used or invalid ticket', { requestId });
      trackSseConnectionFailure('unknown', 'invalid_ticket');
      res.status(401).json({ error: 'Invalid or expired handshake ticket', code: SSE_TICKET_ERROR_CODE });
      return;
    }

    userId = ticketUserId;
    logger.info('[sse] Handshake authenticated successfully via ticket', { userId, requestId });
    trackSseConnectionSuccess(userId);
  } catch (err) {
    logger.error('[sse] Ticket handshake error', err as Error, { requestId });
    res.status(500).json({ error: 'Internal Server Error' });
    return;
  }

  const clientId = `sse-${userId}-${Date.now()}`;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  // The stream stays open until drained. Close its socket when the response ends.
  res.setHeader('Connection', 'close');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Request-ID', requestId);

  res.flushHeaders();

  eventBus.startHeartbeat();

  const sink = createSseWritableSink(res, clientId, requestId, {
    onDrain: () => eventBus.notifyClientDrain(clientId),
  });

  const stream = createSseStream(userId, clientId, requestId, lastEventId, {
    isBackpressured: sink.isBackpressured,
    terminate: sink.terminate,
  });

  stream.pipeTo(sink.writable).catch((err) => {
    logger.warn('[sse] Stream pipe error', {
      event: 'sse_pipe_error',
      clientId,
      requestId,
      error: String(err),
    });
    sink.terminate();
    eventBus.unregister(clientId);
  });

  res.on('close', () => {
    sink.terminate();
    eventBus.unregister(clientId);
    trackSseDisconnection(userId);
    logger.info('[sse] Response closed', {
      event: 'sse_response_closed',
      clientId,
      userId,
      requestId,
    });
  });

  logger.info('[sse] SSE connection opened', {
    event: 'sse_connection_opened',
    clientId,
    userId,
    requestId,
    lastEventId,
  });
}