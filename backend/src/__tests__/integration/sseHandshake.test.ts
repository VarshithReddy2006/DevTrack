// src/__tests__/integration/sseHandshake.test.ts — Secure SSE Handshake Ticket Protocol Integration Test
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createApp } from '../../index.js';
import { orchestrator } from '../../shared/runtime/index.js';
import { User } from '../../db/models/index.js';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn().mockImplementation(async (token: string) => {
    if (token && token.startsWith('mock_valid_token_')) {
      const clerkId = token.replace('mock_valid_token_', '');
      return { sub: clerkId };
    }
    throw new Error('Invalid token');
  }),
}));

let server: Server;
let API_BASE: string;

async function registerAndLoginUser() {
  const clerkId = 'clerk_test_integration_user';
  let user = await User.findOne({ clerkId });
  if (!user) {
    user = await User.create({
      clerkId,
      email: 'test_integration@devtrack.app',
      username: 'test_integration',
      displayName: 'Test Integration User',
    });
  }
  return `mock_valid_token_${clerkId}`;
}

async function testSseConnection(ticket: string): Promise<number> {
  const controller = new AbortController();
  let status: number | null = null;
  try {
    const res = await fetch(`${API_BASE}/api/events?ticket=${ticket}`, {
      signal: controller.signal,
    });
    status = res.status;
    
    // Only abort 200 streams to avoid hanging active streams
    if (status === 200) {
      controller.abort();
    }
    return status;
  } catch {
    if (status !== null) {
      return status;
    }
    return -1;
  }
}

describe('Security: SSE Handshake Ticket Protocol', () => {
  let accessToken: string;

  beforeAll(async () => {
    const app = await createApp();
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    API_BASE = `http://localhost:${address.port}`;
    
    accessToken = await registerAndLoginUser();
  });

  afterAll(async () => {
    await orchestrator.shutdown(server);
  });

  it('should have successfully obtained a test access token', () => {
    expect(accessToken).toBeTruthy();
  });

  it('should generate a secure short-lived handshake ticket', async () => {
    expect(accessToken).toBeDefined();

    const res = await fetch(`${API_BASE}/api/auth/sse-handshake`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('ticket');
    expect(typeof body.data.ticket).toBe('string');
    expect(body.data.ticket.length).toBeGreaterThan(16);
  });

  it('should successfully establish an SSE connection using a valid ticket', async () => {
    expect(accessToken).toBeDefined();

    // Step 1: Generate ticket
    const genRes = await fetch(`${API_BASE}/api/auth/sse-handshake`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    const genBody = await genRes.json() as any;
    const ticket = genBody.data.ticket;

    // Step 2: Establish connection via EventSource with ticket
    const status = await testSseConnection(ticket);
    expect(status).toBe(200);
  });

  it('should enforce strict single-use constraint (fail on reuse)', async () => {
    expect(accessToken).toBeDefined();

    // Step 1: Generate ticket
    const genRes = await fetch(`${API_BASE}/api/auth/sse-handshake`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    const genBody = await genRes.json() as any;
    const ticket = genBody.data.ticket;

    // Step 2: Connect first time (should succeed)
    const status1 = await testSseConnection(ticket);
    expect(status1).toBe(200);

    // Step 3: Connect second time with same ticket (should fail immediately with 401)
    const status2 = await testSseConnection(ticket);
    expect(status2).toBe(401);
  });

  it('should reject invalid or forged tickets with 401', async () => {
    const fakeTicket = '00000000-0000-0000-0000-000000000000';
    const status = await testSseConnection(fakeTicket);
    expect(status).toBe(401);
  });

  it('delivers the shutdown event before ending the HTTP stream', async () => {
    const ticketResponse = await fetch(`${API_BASE}/api/auth/sse-handshake`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const { data } = await ticketResponse.json() as { data: { ticket: string } };
    const response = await fetch(`${API_BASE}/api/events?ticket=${data.ticket}`);
    expect(response.status).toBe(200);

    const [body] = await Promise.all([response.text(), orchestrator.shutdown(server)]);
    expect(body).toMatch(/event: server_shutdown\nretry: \d+\ndata: {"reconnectDelayMs":\d+}/);
    expect(server.listening).toBe(false);
  });
});
