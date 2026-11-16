// src/shared/sse/sseHandler.ts — SSE endpoint handler with correlation IDs
// Protected by auth middleware, userId-scoped, with heartbeat and cleanup.
// Supports Last-Event-ID reconnection with Redis stream backfill.

import { Request, Response } from 'express';

import { eventBus, SseClient } from './eventBus.js';
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

export async function replayMissedEvents(
  userId: string,
  lastEventId: string,
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<void> {
  const redis = getRedisClient();
  const streamKey = `sse:stream:${userId}`;
  
  try {
    // Last-Event-ID is a full `<ms>-<seq>` stream id. A malformed or foreign id (an older
    // client, a fallback id) cannot be placed in the stream, so skip replay and resend full state.
    const lastStreamId = parseStreamId(lastEventId);
    const lastSequence = lastStreamId;

    // Read only events strictly after that position
    const events = lastStreamId
      ? await redis.xrange(streamKey, `(${lastStreamId}`, '+', 'COUNT', 50)
      : [];
    
    if (events.length > 0) {
      logger.info('[sse] Replaying missed events', {
        userId,
        lastSequence,
        eventCount: events.length,
      });
      
      for (const event of events) {
        // event is [id, [field1, value1, field2, value2, ...]]
        const [id, fields] = event as [string, string[]];
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
      }
    } else {
      // If no events in stream or gap too large, send full state
      logger.info('[sse] No events to replay, sending full state', {
        userId,
        lastSequence,
      });
      
      // Import runtime state service to get full state
      const { unifiedRuntimeStateService } = await import('../../modules/runtime-state/unifiedRuntimeState.service.js');
      const state = await unifiedRuntimeStateService.getRuntimeState(userId);
      
      if (state) {
        const fullStateEvent = {
          id: `${userId}-full-${Date.now()}`,
          type: 'runtime_state_full' as const,
          sequence: 0,
          timestamp: new Date().toISOString(),
          userId,
          payload: { state: state.toObject() },
        };
        
        const payload = `id: ${fullStateEvent.id}\ndata: ${JSON.stringify(fullStateEvent)}\n\n`;
        controller.enqueue(new TextEncoder().encode(payload));
      }
    }
  } catch (error) {
    logger.warn('[sse] Failed to replay missed events', {
      userId,
      lastEventId,
      error,
    });
  }
}

function createSseStream(
  userId: string,
  clientId: string,
  requestId: string,
  lastEventId?: string
): ReadableStream<Uint8Array> {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;

      // Replay missed events if Last-Event-ID header present
      if (lastEventId) {
        await replayMissedEvents(userId, lastEventId, controller);
      }

      const client: SseClient = {
        id: clientId,
        userId,
        controller,
        connectedAt: Date.now(),
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
      }
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

  const stream = createSseStream(userId, clientId, requestId, lastEventId);

  stream.pipeTo(
    new WritableStream({
      write(chunk) {
        res.write(chunk);
      },
      close() {
        res.end();
        eventBus.unregister(clientId);
      },
      abort(err) {
        res.end();
        logger.warn('[sse] Stream aborted', {
          event: 'sse_stream_aborted',
          clientId,
          requestId,
          error: String(err),
        });
        eventBus.unregister(clientId);
      },
    })
  ).catch((err) => {
    logger.warn('[sse] Stream pipe error', {
      event: 'sse_pipe_error',
      clientId,
      requestId,
      error: String(err),
    });
    eventBus.unregister(clientId);
  });

  res.on('close', () => {
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