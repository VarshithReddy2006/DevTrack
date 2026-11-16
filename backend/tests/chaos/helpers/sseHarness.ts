// tests/chaos/helpers/sseHarness.ts — Drives the real handleSseRequest with fake
// Express req/res objects, so Last-Event-ID replay, ticket handshake and client
// registration all run through production code without opening a socket.

import type { Request, Response } from 'express';
import { vi } from 'vitest';
import { handleSseRequest } from '../../../src/shared/sse/sseHandler.js';
import { createHandshakeTicket } from '../../../src/shared/sse/ticketStore.js';

export interface SseFrame {
  id?: string;
  event?: string;
  data?: Record<string, any>;
  comment?: string;
}

export interface SseConnection {
  userId: string;
  status: number;
  frames: SseFrame[];
  /** The id a browser EventSource would send as Last-Event-ID on its next reconnect. */
  lastEventId(): string | undefined;
  dataFrames(): SseFrame[];
  disconnect(): void;
}

export function parseFrames(raw: string): SseFrame[] {
  return raw
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const frame: SseFrame = {};
      for (const line of chunk.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4);
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
        else if (line.startsWith(': ')) frame.comment = line.slice(2);
      }
      return frame;
    });
}

/** Let the stream pipe and any pending microtasks run. */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

export async function connectSse(userId: string, lastEventId?: string): Promise<SseConnection> {
  const ticket = await createHandshakeTicket(userId);
  const frames: SseFrame[] = [];
  const closeHandlers: Array<() => void> = [];
  let status = 200;

  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: (chunk: Uint8Array | string) => {
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      frames.push(...parseFrames(text));
      return true;
    },
    end: vi.fn(),
    status(code: number) {
      status = code;
      return res;
    },
    json: vi.fn(),
    on(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler);
      return res;
    },
  };
  const req = {
    headers: lastEventId ? { 'last-event-id': lastEventId } : {},
    query: { ticket },
    context: { requestId: `chaos-${userId}` },
    ip: '127.0.0.1',
  };

  await handleSseRequest(req as unknown as Request, res as unknown as Response);
  await settle();

  return {
    userId,
    get status() {
      return status;
    },
    frames,
    lastEventId: () => [...frames].reverse().find((f) => f.id)?.id,
    dataFrames: () => frames.filter((f) => f.data),
    disconnect: () => closeHandlers.forEach((handler) => handler()),
  };
}
