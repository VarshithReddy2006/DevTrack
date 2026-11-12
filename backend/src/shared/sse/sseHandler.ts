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

  let userId: string;
  const ticket = req.query.ticket as string | undefined;
  const token = req.query.token as string | undefined;

  if (ticket) {
    try {
      const { consumeHandshakeTicket } = await import('./ticketStore.js');
      const ticketUserId = await consumeHandshakeTicket(ticket);
      
      if (!ticketUserId) {
        logger.warn('[sse] Ticket handshake failed — expired or invalid ticket', { ticket, requestId });
        trackSseConnectionFailure('unknown', 'invalid_ticket');
        res.status(401).json({ error: 'Invalid or expired handshake ticket' });
        return;
      }

      userId = ticketUserId;
      logger.info('[sse] Handshake authenticated successfully via ticket', { userId, ticket, requestId });
      trackSseConnectionSuccess(userId);
    } catch (err) {
      logger.error('[sse] Ticket handshake error', err as Error, { ticket, requestId });
      res.status(500).json({ error: 'Internal Server Error' });
      return;
    }
  } else if (token) {
    try {
      const { verifyToken } = await import('@clerk/express');
      const verifiedToken = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
      const clerkUserId = verifiedToken.sub;
      
      if (!clerkUserId) {
        logger.warn('[sse] Token verification failed — no sub in payload', { token, requestId });
        trackSseConnectionFailure('unknown', 'invalid_token');
        res.status(401).json({ error: 'Invalid token payload' });
        return;
      }
      
      const { User } = await import('../../db/models/index.js');
      const { syncClerkUser } = await import('../../services/auth/ClerkUserSyncService.js');
      
      let dbUser = await User.findOne({ clerkId: clerkUserId });
      if (!dbUser) {
        logger.info('[sse] User not found locally for verified token, syncing...', { clerkUserId, requestId });
        const synced = await syncClerkUser(clerkUserId);
        userId = synced.id;
      } else {
        userId = dbUser._id.toString();
      }

      logger.info('[sse] Handshake authenticated successfully via fallback token', { userId, clerkUserId, requestId });
      trackSseConnectionSuccess(userId);
    } catch (err) {
      logger.error('[sse] Token verification fallback error', err as Error, { token, requestId });
      trackSseConnectionFailure('unknown', 'token_verification_failed');
      res.status(401).json({ error: 'Token verification failed' });
      return;
    }
  } else {
    logger.warn('[sse] Auth required — Handshake ticket and token missing', {
      event: 'sse_auth_required',
      requestId,
      ip: req.ip,
    });
    res.status(401).json({ error: 'Authentication required. SSE ticket or token must be provided.' });
    return;
  }

  const clientId = `sse-${userId}-${Date.now()}`;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Keep-Alive', 'timeout=120');
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
        eventBus.unregister(clientId);
      },
      abort(err) {
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