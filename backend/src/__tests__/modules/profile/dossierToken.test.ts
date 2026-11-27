import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response, type NextFunction } from 'express';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileAuditLog } from '../../../db/models/profileAuditLog.model.js';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { RenderArtifact } from '../../../db/models/renderArtifact.model.js';
import { User } from '../../../db/models/user.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import dossierDownloadRoutes, { dossierDownloadDeps } from '../../../modules/profile/dossierDownload.routes.js';
import {
  checkIpSlidingWindowRateLimit,
  computeDossierSignature,
  DOSSIER_IP_RATE_LIMIT_MAX_REQUESTS,
  DOSSIER_IP_RATE_LIMIT_WINDOW_MS,
  DOSSIER_TOKEN_TTL_MS,
  dossierRateLimiterDeps,
  generateDossierToken,
  getDossierSigningSecret,
  resetDossierRateLimitStore,
  verifyDossierToken,
} from '../../../modules/profile/dossierToken.service.js';
import { getObjectStorage } from '../../../shared/storage/objectStorage.js';
import { auditRowsFor, decryptChainedAuditEvent } from '../../../modules/audit/auditLedger.service.js';

const env = vi.hoisted(() => {
  process.env.UPLOAD_DIR = `${process.env.TMPDIR ?? '/tmp'}/devtrack-dossier-token-test-${process.pid}`;
  process.env.DOSSIER_SIGNING_SECRET = 'dossier-token-test-secret-0123456789';
  process.env.OBJECT_STORAGE_SIGNING_SECRET = 'dossier-token-test-secret-0123456789';
  return { uploadDir: process.env.UPLOAD_DIR };
});

const actor = vi.hoisted(() => ({ id: '', username: '' }));

vi.mock('../../../shared/tracing/tracing.js', () => ({
  getTraceMetadata: () => ({}),
  startTraceOperation: () => ({ end: () => {} }),
}));

vi.mock('../../../middleware/index.js', async original => {
  const actual = await original<typeof import('../../../middleware/index.js')>();
  return {
    ...actual,
    optionalAuthMiddleware: (req: Request, _res: Response, next: NextFunction) => {
      if (actor.id) {
        Object.assign(req, { user: { id: actor.id, username: actor.username } });
      }
      next();
    },
    authMiddleware: (req: Request, res: Response, next: NextFunction) => {
      if (!actor.id) {
        res.status(401).json({ success: false, code: 'UNAUTHORIZED' });
        return;
      }
      Object.assign(req, { user: { id: actor.id, username: actor.username } });
      next();
    },
  };
});

afterAll(async () => {
  await rm(env.uploadDir, { recursive: true, force: true });
});

describe('dossierToken.service unit tests', () => {
  const testUser = 'alice-developer';
  const secret = 'custom-test-secret-for-verification-1234';

  beforeEach(() => {
    resetDossierRateLimitStore();
  });

  it('generates a valid token bound to username and 15-minute TTL', () => {
    const fixedNow = 1_700_000_000_000;
    const result = generateDossierToken(testUser, { now: fixedNow, secret });

    expect(result.expires).toBe(fixedNow + DOSSIER_TOKEN_TTL_MS);
    expect(result.expiresAt.getTime()).toBe(fixedNow + DOSSIER_TOKEN_TTL_MS);
    expect(result.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(result.token).toBe(`${result.nonce}.${result.signature}`);
    expect(result.downloadUrl).toBe(
      `/api/v2/portfolio/${testUser}/dossier.pdf?token=${encodeURIComponent(result.token)}&expires=${result.expires}`
    );

    const valid = verifyDossierToken(testUser, { token: result.token, expires: result.expires }, { now: fixedNow, secret });
    expect(valid).toBe(true);
  });

  it('rejects expired tokens', () => {
    const start = 1_700_000_000_000;
    const tokenData = generateDossierToken(testUser, { now: start, secret });

    // 1ms past expiration
    const expiredNow = start + DOSSIER_TOKEN_TTL_MS + 1;
    const valid = verifyDossierToken(testUser, { token: tokenData.token, expires: tokenData.expires }, { now: expiredNow, secret });
    expect(valid).toBe(false);
  });

  it('rejects tampered signatures and modified parameters', () => {
    const fixedNow = 1_700_000_000_000;
    const tokenData = generateDossierToken(testUser, { now: fixedNow, secret });

    // Alter token signature
    const [nonce, sig] = tokenData.token.split('.');
    const tamperedSig = sig.replace(/^./, c => (c === 'A' ? 'B' : 'A'));
    expect(
      verifyDossierToken(testUser, { token: `${nonce}.${tamperedSig}`, expires: tokenData.expires }, { now: fixedNow, secret })
    ).toBe(false);

    // Alter expiration timestamp (e.g. extending expiry)
    expect(
      verifyDossierToken(testUser, { token: tokenData.token, expires: tokenData.expires + 60_000 }, { now: fixedNow, secret })
    ).toBe(false);

    // Alter username (Alice's token used for Bob)
    expect(
      verifyDossierToken('bob-developer', { token: tokenData.token, expires: tokenData.expires }, { now: fixedNow, secret })
    ).toBe(false);

    // Alter nonce
    const tamperedNonce = nonce.replace(/^./, c => (c === '0' ? '1' : '0'));
    expect(
      verifyDossierToken(testUser, { token: `${tamperedNonce}.${sig}`, expires: tokenData.expires }, { now: fixedNow, secret })
    ).toBe(false);

    // Malformed inputs
    expect(verifyDossierToken(testUser, { token: '', expires: tokenData.expires })).toBe(false);
    expect(verifyDossierToken(testUser, { token: 'invalid-token', expires: tokenData.expires })).toBe(false);
    expect(verifyDossierToken(testUser, { token: tokenData.token, expires: 'not-a-number' })).toBe(false);
  });

  it('enforces maximum 5 requests per hour sliding window per IP', () => {
    const ip = '192.168.1.100';
    const now = 1_700_000_000_000;

    for (let i = 0; i < 5; i++) {
      const res = checkIpSlidingWindowRateLimit(ip, now);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(4 - i);
    }

    // 6th request within the hour should be blocked
    const blocked = checkIpSlidingWindowRateLimit(ip, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBe(3600);

    // Different IP should still be allowed
    const differentIp = checkIpSlidingWindowRateLimit('192.168.1.101', now);
    expect(differentIp.allowed).toBe(true);
    expect(differentIp.remaining).toBe(4);

    // After 1 hour has elapsed, requests are allowed again
    const later = checkIpSlidingWindowRateLimit(ip, now + DOSSIER_IP_RATE_LIMIT_WINDOW_MS + 1000);
    expect(later.allowed).toBe(true);
  });
});

describe('dossierDownload.routes HTTP endpoints', () => {
  let server: Server;
  let base: string;
  let userCounter = 0;

  async function createCandidate(options: {
    published?: boolean;
    visibility?: 'public' | 'private';
    flagged?: boolean;
    hasSnapshot?: boolean;
  } = {}) {
    const { published = true, visibility = 'public', flagged = false, hasSnapshot = true } = options;
    const username = `candidate-${userCounter++}`;
    const user = await User.create({
      clerkId: `clerk-${username}`,
      username,
      email: `${username}@example.test`,
      displayName: `Candidate ${userCounter}`,
    });

    await UserSettings.create({
      userId: user._id,
      privacy: { profileVisibility: visibility },
    });

    await PublicProfile.create({
      userId: user._id,
      username,
      slug: username,
      published,
      visibility,
      antiGaming: { isFlagged: flagged },
      snapshot: hasSnapshot
        ? {
            version: 2,
            identity: { displayName: `Candidate ${userCounter}`, joinedAt: new Date('2025-01-01') },
            consistency: { currentStreak: 5, activeDaysLast365: 120 },
            dsa: { totalSolved: 350 },
            github: { isVerified: true, totalContributions: 1200 },
            projects: [],
            velocityIndicators: { trend: 'accelerating' },
          }
        : undefined,
    });

    return user;
  }

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v2/portfolio', dossierDownloadRoutes);

    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/portfolio`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  });

  beforeEach(() => {
    actor.id = '';
    actor.username = '';
    resetDossierRateLimitStore();
    vi.spyOn(dossierDownloadDeps, 'renderDossier').mockImplementation(async (userId: any) => {
      const storage = getObjectStorage();
      const key = `dossiers/${userId}/synthetic.pdf`;
      await storage.put(key, Buffer.from('%PDF-1.4 synthetic dossier content'));
      return { status: 'rendered', contentHash: 'a'.repeat(64), key };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/v2/portfolio/:username/dossier/token', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const candidate = await createCandidate();
      const res = await fetch(`${base}/${candidate.username}/dossier/token`, { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('allows authenticated owner to generate a token', async () => {
      const candidate = await createCandidate();
      actor.id = String(candidate._id);
      actor.username = candidate.username;

      const res = await fetch(`${base}/${candidate.username}/dossier/token`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.token).toBeDefined();
      expect(body.data.expires).toBeDefined();
      expect(body.data.downloadUrl).toContain(`/portfolio/${candidate.username}/dossier.pdf`);
    });

    it('allows authenticated non-owner to request token for a public portfolio', async () => {
      const candidate = await createCandidate({ published: true, visibility: 'public' });
      const recruiter = await createCandidate();
      actor.id = String(recruiter._id);
      actor.username = recruiter.username;

      const res = await fetch(`${base}/${candidate.username}/dossier/token`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.token).toBeDefined();
    });

    it('rejects non-owner request for a private portfolio with 403', async () => {
      const candidate = await createCandidate({ published: false, visibility: 'private' });
      const recruiter = await createCandidate();
      actor.id = String(recruiter._id);
      actor.username = recruiter.username;

      const res = await fetch(`${base}/${candidate.username}/dossier/token`, { method: 'POST' });
      expect(res.status).toBe(403);
    });

    it('returns 404 if target user does not exist', async () => {
      const recruiter = await createCandidate();
      actor.id = String(recruiter._id);
      actor.username = recruiter.username;

      const res = await fetch(`${base}/nonexistent-user-xyz/dossier/token`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('returns 409 if profile has no snapshot or is under review', async () => {
      const flagged = await createCandidate({ flagged: true });
      actor.id = String(flagged._id);
      actor.username = flagged.username;

      const res = await fetch(`${base}/${flagged.username}/dossier/token`, { method: 'POST' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('DOSSIER_UNAVAILABLE');
    });

    it('enforces maximum 5 token requests per hour per IP with 429', async () => {
      const candidate = await createCandidate();
      actor.id = String(candidate._id);
      actor.username = candidate.username;

      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${base}/${candidate.username}/dossier/token`, { method: 'POST' });
        expect(res.status).toBe(200);
      }

      const blocked = await fetch(`${base}/${candidate.username}/dossier/token`, { method: 'POST' });
      expect(blocked.status).toBe(429);
      const body = await blocked.json();
      expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(blocked.headers.get('retry-after')).toBeDefined();
    });
  });

  describe('GET /api/v2/portfolio/:username/dossier.pdf', () => {
    it('streams PDF binary with download headers for a valid token and records audit log', async () => {
      const candidate = await createCandidate();
      const tokenData = generateDossierToken(candidate.username);

      const res = await fetch(
        `${base}/${candidate.username}/dossier.pdf?token=${encodeURIComponent(tokenData.token)}&expires=${tokenData.expires}`
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="Candidate_Dossier.pdf"');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');

      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');

      // Verify audit log
      const audit = await ProfileAuditLog.findOne({
        ...await auditRowsFor(candidate._id),
        eventType: 'dossier_downloaded',
      });
      expect(audit).not.toBeNull();
      expect(audit?.userId).toBeNull();
      expect(await decryptChainedAuditEvent(audit!, candidate._id)).toMatchObject({ username: candidate.username });
    });

    it('rejects expired tokens with 403 Forbidden', async () => {
      const candidate = await createCandidate();
      const expiredNow = Date.now() - 20 * 60 * 1000;
      const expiredToken = generateDossierToken(candidate.username, { now: expiredNow });

      const res = await fetch(
        `${base}/${candidate.username}/dossier.pdf?token=${encodeURIComponent(expiredToken.token)}&expires=${expiredToken.expires}`
      );
      expect(res.status).toBe(403);
    });

    it('rejects tampered signature with 403 Forbidden', async () => {
      const candidate = await createCandidate();
      const tokenData = generateDossierToken(candidate.username);
      const [nonce, sig] = tokenData.token.split('.');
      const tampered = `${nonce}.${sig.replace(/^./, c => (c === 'A' ? 'B' : 'A'))}`;

      const res = await fetch(
        `${base}/${candidate.username}/dossier.pdf?token=${encodeURIComponent(tampered)}&expires=${tokenData.expires}`
      );
      expect(res.status).toBe(403);
    });

    it('rejects extended expires timestamp with 403 Forbidden', async () => {
      const candidate = await createCandidate();
      const tokenData = generateDossierToken(candidate.username);

      const res = await fetch(
        `${base}/${candidate.username}/dossier.pdf?token=${encodeURIComponent(tokenData.token)}&expires=${tokenData.expires + 3600000}`
      );
      expect(res.status).toBe(403);
    });

    it('rejects token issued for another candidate with 403 Forbidden', async () => {
      const candidate1 = await createCandidate();
      const candidate2 = await createCandidate();
      const tokenForCandidate1 = generateDossierToken(candidate1.username);

      const res = await fetch(
        `${base}/${candidate2.username}/dossier.pdf?token=${encodeURIComponent(tokenForCandidate1.token)}&expires=${tokenForCandidate1.expires}`
      );
      expect(res.status).toBe(403);
    });

    it('rejects missing token or expires query params with 403 Forbidden', async () => {
      const candidate = await createCandidate();
      expect((await fetch(`${base}/${candidate.username}/dossier.pdf`)).status).toBe(403);
      expect((await fetch(`${base}/${candidate.username}/dossier.pdf?token=abc`)).status).toBe(403);
      expect((await fetch(`${base}/${candidate.username}/dossier.pdf?expires=123`)).status).toBe(403);
    });
  });
});
