// src/__tests__/infrastructure/production-startup-ai.test.ts — Production startup simulation without AI credentials
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { aiCredentialAction } from '../../config/aiCredentials.js';
import { createApp } from '../../index.js';

describe('Production Startup Simulation without AI credentials', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    vi.unstubAllEnvs();
  });

  it('evaluates aiCredentialAction to "warn" (not "exit") when AI keys are missing in HTTPS production', () => {
    const action = aiCredentialAction({
      isProd: true,
      corsOrigin: 'https://devtrack-x5f5.onrender.com',
      hasOpenAi: false,
      hasGemini: false,
      requireAi: false,
    });

    expect(action).toBe('warn');
  });

  it('only exits when REQUIRE_AI_KEYS is explicitly true', () => {
    const action = aiCredentialAction({
      isProd: true,
      corsOrigin: 'https://devtrack-x5f5.onrender.com',
      hasOpenAi: false,
      hasGemini: false,
      requireAi: true,
    });

    expect(action).toBe('exit');
  });

  it('successfully creates app, binds to configured port, and serves HTTP requests without AI keys', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ORIGIN', 'https://devtrack-x5f5.onrender.com');
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.REQUIRE_AI_KEYS;

    const app = await createApp();
    expect(app).toBeDefined();

    // Bind to 0.0.0.0 and port 0 (dynamic port) or test port
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '0.0.0.0', () => {
        resolve();
      });
      server.on('error', reject);
    });

    expect(server).toBeDefined();
    expect(server!.listening).toBe(true);

    const addr = server!.address() as AddressInfo;
    expect(addr.port).toBeGreaterThan(0);
    expect(addr.address).toBe('0.0.0.0');

    // Verify root endpoint
    const rootRes = await fetch(`http://127.0.0.1:${addr.port}/`);
    expect(rootRes.status).toBe(200);
    const rootJson = await rootRes.json();
    expect(rootJson.message).toBe('DevTrack API Server is running');

    // Verify liveness probe
    const liveRes = await fetch(`http://127.0.0.1:${addr.port}/health/live`);
    expect(liveRes.status).toBe(200);
    const liveJson = await liveRes.json();
    expect(liveJson.status).toBe('ok');
  });
});
