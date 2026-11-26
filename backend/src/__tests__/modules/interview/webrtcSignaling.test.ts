// src/__tests__/modules/interview/webrtcSignaling.test.ts — WebRTC signaling gateway integration tests
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { WebRTCSignalingGateway, ICE_TIMEOUT_MS, SIGNALING_SESSION_TTL_MS, type SignalingSession } from '../../../modules/interview/webrtcSignaling.gateway.js';

vi.mock('../../../shared/sse/eventBus.js', () => ({
  eventBus: { publishEnvelope: vi.fn() },
}));
vi.mock('../../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const OFFER_SDP = [
  'v=0',
  'o=- 1 2 IN IP4 0.0.0.0',
  's=DevTrack Audio',
  't=0 0',
  'm=audio 9 RTP/AVP 111',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:111 opus/48000/2',
  'a=sendrecv',
].join('\r\n') + '\r\n';

const INVALID_SDP = 'not a valid session description';

const ICE_CANDIDATE = {
  type: 'ice-candidate' as const,
  candidate: 'candidate:1 1 udp 2113937151 1.2.3.4 9 typ host',
  sdpMLineIndex: 0,
  sdpMid: '0',
};

function buildGateway(overrides: { turnSecret?: string; iceTimeoutMs?: number; now?: () => number; onFallback?: (sessionId: string) => void } = {}) {
  return new WebRTCSignalingGateway({
    turnSecret: overrides.turnSecret ?? 'test-turn-secret',
    iceTimeoutMs: overrides.iceTimeoutMs ?? ICE_TIMEOUT_MS,
    now: overrides.now ?? (() => Date.now()),
    onFallback: overrides.onFallback,
  });
}

describe('webrtc signaling gateway', () => {
  let gateway: WebRTCSignalingGateway;

  beforeEach(() => {
    gateway = buildGateway();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes SDP offer/answer negotiation', async () => {
    const response = await gateway.handleSignal('session-1', 'user-1', { type: 'offer', sdp: OFFER_SDP });

    expect(response.type).toBe('answer');
    expect(response.sdp).toContain('v=0');
    expect(response.sdp).toContain('o=- 1 2 IN IP4 0.0.0.0');
    expect(response.sdp).toContain('m=audio 9 RTP/AVP 111');
    expect(response.sdp).toContain('a=rtpmap:111 opus/48000/2');
    expect(response.sdp).toContain('a=ice-ufrag:');
    expect(response.sdp).toContain('a=ice-pwd:');
    expect(response.sdp).toContain('a=fingerprint:sha-256');
    expect(response.sdp).toContain('a=setup:actpass');

    expect(response.iceServers).toHaveLength(1);
    const iceServers = response.iceServers!;
    expect(iceServers[0].urls.some(u => u.startsWith('stun:'))).toBe(true);
    expect(iceServers[0].urls.some(u => u.startsWith('turn:'))).toBe(true);
    expect(iceServers[0].username).toMatch(/^\d+:/);
    expect(iceServers[0].credential).toBeTruthy();
    expect(iceServers[0].realm).toBe('devtrack');

    const session = gateway.getSession('session-1')!;
    expect(session.state).toBe('ANSWER_SENT');
    expect(session.offerSdp).toBe(OFFER_SDP);
  });

  it('rejects an offer with invalid SDP', async () => {
    const response = await gateway.handleSignal('session-1', 'user-1', { type: 'offer', sdp: INVALID_SDP });

    expect(response.type).toBe('error');
    expect(response.code).toBe('BAD_REQUEST');
    expect(response.message).toContain('Invalid offer SDP');

    const session = gateway.getSession('session-1')!;
    expect(session.state).toBe('FAILED');
  });

  it('rejects an offer missing SDP', async () => {
    const response = await gateway.handleSignal('session-1', 'user-1', { type: 'offer' });

    expect(response.type).toBe('error');
    expect(response.code).toBe('BAD_REQUEST');
    expect(response.message).toContain('Offer SDP is required');
  });

  it('routes ICE candidates between client and backend media handler', async () => {
    await gateway.handleSignal('session-1', 'user-1', { type: 'offer', sdp: OFFER_SDP });

    const first = await gateway.handleSignal('session-1', 'user-1', ICE_CANDIDATE);
    expect(first.type).toBe('ice-candidate');
    expect(first.candidate?.candidate).toContain('candidate:');
    expect(first.candidate?.sdpMLineIndex).toBe(0);

    const second = await gateway.handleSignal('session-1', 'user-1', {
      ...ICE_CANDIDATE,
      candidate: 'candidate:2 1 tcp 1 5.6.7.8 9 typ srflx raddr 1.2.3.4 rport 9',
    });
    expect(second.type).toBe('ice-candidate');

    const session = gateway.getSession('session-1')!;
    expect(session.iceCandidates).toHaveLength(2);
    expect(session.remoteIceCandidates).toHaveLength(2);
  });

  it('transitions to CONNECTED when the answer is received', async () => {
    await gateway.handleSignal('session-1', 'user-1', { type: 'offer', sdp: OFFER_SDP });

    const response = await gateway.handleSignal('session-1', 'user-1', { type: 'answer', sdp: OFFER_SDP });
    expect(response.type).toBe('ice-candidate');

    const session = gateway.getSession('session-1')!;
    expect(session.state).toBe('CONNECTED');
  });

  it('rejects an answer before an offer', async () => {
    const response = await gateway.handleSignal('session-1', 'user-1', { type: 'answer', sdp: OFFER_SDP });
    expect(response.type).toBe('error');
    expect(response.code).toBe('BAD_REQUEST');
  });

  it('issues valid short-lived TURN credentials for NAT traversal', () => {
    const secret = 'hmac-test-secret';
    const gw = buildGateway({ turnSecret: secret });
    const creds = gw.getTurnCredentials('user-1');

    expect(creds.urls).toContain('stun:stun.l.google.com:19302');
    expect(creds.urls.some(u => u.startsWith('turn:'))).toBe(true);
    expect(creds.username).toMatch(/^\d+:user-1$/);
    expect(creds.realm).toBe('devtrack');

    const expected = createHmac('sha1', secret).update(creds.username).digest('base64');
    expect(creds.credential).toBe(expected);

    const now = Date.now();
    expect(creds.expiresAt).toBeGreaterThan(now);
    expect(creds.expiresAt - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('tears down the signaling session on bye', async () => {
    await gateway.handleSignal('session-1', 'user-1', { type: 'offer', sdp: OFFER_SDP });
    expect(gateway.getSession('session-1')).toBeDefined();

    const response = await gateway.handleSignal('session-1', 'user-1', { type: 'bye' });
    expect(response.type).toBe('closed');
    expect(gateway.getSession('session-1')).toBeUndefined();
  });

  it('returns not found when tearing down an unknown session', async () => {
    const response = await gateway.handleSignal('missing-session', 'user-1', { type: 'bye' });
    expect(response.type).toBe('error');
    expect(response.code).toBe('NOT_FOUND');
  });

  it('rejects cross-user signals and teardown without mutating the owner session', async () => {
    await gateway.handleSignal('session-1', 'user-1', { type: 'offer', sdp: OFFER_SDP });
    const session = gateway.getSession('session-1')!;
    const originalUpdatedAt = session.updatedAt;

    const signal = await gateway.handleSignal('session-1', 'user-2', ICE_CANDIDATE);
    expect(signal).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
    expect(session.iceCandidates).toHaveLength(0);
    expect(session.updatedAt).toBe(originalUpdatedAt);

    const teardown = await gateway.handleSignal('session-1', 'user-2', { type: 'bye' });
    expect(teardown).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
    expect(gateway.getSession('session-1')).toBe(session);
  });

  it('evicts stale sessions on access and clears their ICE timers', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_700_000_000_000;
      const gw = buildGateway({ now: () => now });
      await gw.handleSignal('stale-session', 'user-1', { type: 'offer', sdp: OFFER_SDP });
      expect(gw.getSession('stale-session')?.iceTimer).not.toBeNull();

      now += SIGNALING_SESSION_TTL_MS;
      expect(gw.getSession('stale-session')).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to HTTP chunk ingestion when ICE negotiation times out', async () => {
    vi.useFakeTimers();
    try {
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const onFallback = vi.fn();
      const gw = buildGateway({ now: () => Date.now(), iceTimeoutMs: ICE_TIMEOUT_MS, onFallback });

      await gw.handleSignal('session-1', 'user-1', { type: 'offer', sdp: OFFER_SDP });
      expect(onFallback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(ICE_TIMEOUT_MS + 1);
      expect(onFallback).toHaveBeenCalledOnce();

      const session = gw.getSession('session-1')! as SignalingSession & { fallbackUrl?: string };
      expect(session.state).toBe('FAILED');
      expect(session.fallbackUrl).toContain('/session-1/audio/chunks');
      expect(session.fallbackUrl).toContain('audio/chunks');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fall back when ICE completes before the timeout', async () => {
    vi.useFakeTimers();
    try {
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const onFallback = vi.fn();
      const gw = buildGateway({ now: () => Date.now(), iceTimeoutMs: ICE_TIMEOUT_MS, onFallback });

      await gw.handleSignal('session-1', 'user-1', { type: 'offer', sdp: OFFER_SDP });
      await gw.handleSignal('session-1', 'user-1', { type: 'answer', sdp: OFFER_SDP });
      expect(onFallback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(ICE_TIMEOUT_MS + 1);
      expect(onFallback).not.toHaveBeenCalled();

      const session = gw.getSession('session-1')!;
      expect(session.state).toBe('CONNECTED');
    } finally {
      vi.useRealTimers();
    }
  });
});
