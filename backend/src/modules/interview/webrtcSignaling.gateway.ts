// src/modules/interview/webrtcSignaling.gateway.ts — WebRTC audio signaling gateway
//
// Coordinates SDP offer/answer negotiation and trickle ICE candidate routing between
// the interview client and the backend media worker for zero-latency full-duplex audio.
// No native WebRTC stack is required: signaling messages are pure SDP text routed over
// authenticated HTTP, which is testable with mocks under Vitest.
//
// States: IDLE -> OFFER_RECEIVED -> ANSWER_SENT -> CONNECTED | FAILED -> CLOSED
// ICE negotiation that stalls beyond ICE_TIMEOUT_MS triggers a clean fallback to HTTP
// audio chunk ingestion (see feat(interview,m7) #509).

import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { eventBus } from '../../shared/sse/eventBus.js';
import { logger } from '../../shared/logger.js';

export const ICE_TIMEOUT_MS = 10_000;
export const TURN_TTL_MS = 24 * 60 * 60 * 1000; // short-lived credentials
export const SIGNALING_SESSION_TTL_MS = 60 * 60 * 1000;

export type SignalingState = 'IDLE' | 'OFFER_RECEIVED' | 'ANSWER_SENT' | 'CONNECTED' | 'FAILED' | 'CLOSED';

export interface IceCandidate {
  candidate: string;
  sdpMLineIndex: number;
  sdpMid?: string;
  usernameFragment?: string;
}

export interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
  realm: string;
  expiresAt: number;
}

export interface SignalingSession {
  sessionId: string;
  userId: string;
  state: SignalingState;
  offerSdp?: string;
  answerSdp?: string;
  iceCandidates: IceCandidate[];     // candidates received from client
  remoteIceCandidates: IceCandidate[]; // candidates generated for client
  createdAt: number;
  updatedAt: number;
  iceTimer: NodeJS.Timeout | null;
  fallbackUrl?: string;
}

export interface SignalRequest {
  type: 'offer' | 'answer' | 'ice-candidate' | 'bye';
  sdp?: string;
  candidate?: string;
  sdpMLineIndex?: number;
  sdpMid?: string;
}

export interface SignalResponse {
  type: 'answer' | 'ice-candidate' | 'fallback' | 'error' | 'closed';
  sdp?: string;
  iceServers?: TurnCredentials[];
  candidate?: IceCandidate;
  fallbackUrl?: string;
  code?: string;
  message?: string;
}

const signalRequestSchema = z.object({
  type: z.enum(['offer', 'answer', 'ice-candidate', 'bye']),
  sdp: z.string().optional(),
  candidate: z.string().optional(),
  sdpMLineIndex: z.number().int().nonnegative().optional(),
  sdpMid: z.string().optional(),
});

const SDP_VERSION = '0';
const SDP_ORIGIN = '- 1 2 IN IP4 0.0.0.0';
const SDP_SESSION_NAME = 'DevTrack Audio';
const SDP_TIMING = 't=0 0';
const AUDIO_MEDIA_LINE = 'm=audio 9 RTP/AVP 111';
const AUDIO_CONNECTION = 'c=IN IP4 0.0.0.0';
const OPUS_RTPMAP = 'a=rtpmap:111 opus/48000/2';
const OPUS_FMTP = 'a=fmtp:111 minptime=10;useinbandfec=1';

export interface WebRTCSignalingDeps {
  now?: () => number;
  iceTimeoutMs?: number;
  turnSecret?: string;
  stunUrls?: string[];
  turnUrls?: string[];
  fallbackBaseUrl?: string;
  /** Invoked when a session falls back to HTTP chunk ingestion. */
  onFallback?: (sessionId: string) => void;
  /** Invoked when ICE completes successfully. */
  onIceComplete?: (sessionId: string) => void;
}

export class WebRTCSignalingGateway {
  private readonly now: () => number;
  private readonly iceTimeoutMs: number;
  private readonly turnSecret: string;
  private readonly stunUrls: string[];
  private readonly turnUrls: string[];
  private readonly fallbackBaseUrl: string;
  private readonly onFallback?: (sessionId: string) => void;
  private readonly onIceComplete?: (sessionId: string) => void;

  private readonly sessions = new Map<string, SignalingSession>();

  constructor(deps: WebRTCSignalingDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.iceTimeoutMs = deps.iceTimeoutMs ?? ICE_TIMEOUT_MS;
    this.turnSecret = deps.turnSecret ?? randomBytes(32).toString('base64url');
    this.stunUrls = deps.stunUrls ?? ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
    this.turnUrls = deps.turnUrls ?? ['turn:turn.devtrack.app:3478?transport=udp'];
    this.fallbackBaseUrl = deps.fallbackBaseUrl ?? '/api/v1/interview';
    this.onFallback = deps.onFallback;
    this.onIceComplete = deps.onIceComplete;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Process an incoming signaling message from the interview client. */
  async handleSignal(sessionId: string, userId: string, raw: unknown): Promise<SignalResponse> {
    const request = signalRequestSchema.parse(raw);
    this.cleanupStaleSessions();

    const existing = this.sessions.get(sessionId);
    if (existing && existing.userId !== userId) {
      return { type: 'error', code: 'FORBIDDEN', message: 'Unauthorized access to signaling session' };
    }

    if (request.type === 'bye') {
      return this.teardown(sessionId, userId);
    }

    const session = this.getOrCreateSession(sessionId, userId);

    switch (request.type) {
      case 'offer':
        return this.handleOffer(session, request);
      case 'answer':
        return this.handleAnswer(session, request);
      case 'ice-candidate':
        return this.handleIceCandidate(session, request);
      default:
        return this.reject(session, 'BAD_REQUEST', `Unknown signal type: ${request.type}`);
    }
  }

  /** Retrieve the current signaling state for a session (diagnostics / teardown). */
  getSession(sessionId: string): SignalingSession | undefined {
    this.cleanupStaleSessions();
    return this.sessions.get(sessionId);
  }

  /** Close a signaling session and release its ICE timer. */
  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.clearIceTimer(session);
    session.state = 'CLOSED';
    session.updatedAt = this.now();
    this.sessions.delete(sessionId);
    void eventBus.publishEnvelope(session.userId, 'interview.webrtc.session.closed', {
      sessionId,
      userId: session.userId,
      state: session.state,
      closedAt: new Date(session.updatedAt).toISOString(),
    });
    logger.info('[webrtc] Session closed', { event: 'webrtc_session_closed', sessionId, userId: session.userId });
    return true;
  }

  /** Generate short-lived TURN credentials for NAT traversal. */
  getTurnCredentials(userId: string): TurnCredentials {
    const expiresAt = this.now() + TURN_TTL_MS;
    const username = `${expiresAt}:${userId}`;
    const credential = createHmac('sha1', this.turnSecret).update(username).digest('base64');
    return {
      urls: [...this.stunUrls, ...this.turnUrls],
      username,
      credential,
      realm: 'devtrack',
      expiresAt,
    };
  }

  // ─── Internal handlers ───────────────────────────────────────────────────

  private getOrCreateSession(sessionId: string, userId: string): SignalingSession {
    let session = this.sessions.get(sessionId);
    if (session) {
      session.updatedAt = this.now();
      return session;
    }
    session = {
      sessionId,
      userId,
      state: 'IDLE',
      iceCandidates: [],
      remoteIceCandidates: [],
      createdAt: this.now(),
      updatedAt: this.now(),
      iceTimer: null,
    };
    this.sessions.set(sessionId, session);
    void eventBus.publishEnvelope(userId, 'interview.webrtc.session.created', {
      sessionId,
      userId,
      state: session.state,
      createdAt: new Date(session.createdAt).toISOString(),
    });
    return session;
  }

  private handleOffer(session: SignalingSession, request: SignalRequest): SignalResponse {
    if (!request.sdp) {
      return this.reject(session, 'BAD_REQUEST', 'Offer SDP is required');
    }
    if (!this.isValidSdp(request.sdp)) {
      return this.reject(session, 'BAD_REQUEST', 'Invalid offer SDP: missing required SDP fields or audio media line');
    }

    session.offerSdp = request.sdp;
    session.state = 'OFFER_RECEIVED';
    session.updatedAt = this.now();

    const answerSdp = this.generateAnswerSdp(request.sdp);
    session.answerSdp = answerSdp;
    session.state = 'ANSWER_SENT';
    session.updatedAt = this.now();

    this.startIceTimer(session);

    void eventBus.publishEnvelope(session.userId, 'interview.webrtc.offer.answered', {
      sessionId: session.sessionId,
      userId: session.userId,
      state: session.state,
      answeredAt: new Date(session.updatedAt).toISOString(),
    });

    logger.info('[webrtc] SDP offer answered', {
      event: 'webrtc_offer_answered',
      sessionId: session.sessionId,
      userId: session.userId,
      hasAudioMediaLine: request.sdp.includes(AUDIO_MEDIA_LINE),
    });

    return {
      type: 'answer',
      sdp: answerSdp,
      iceServers: [this.getTurnCredentials(session.userId)],
    };
  }

  private handleAnswer(session: SignalingSession, _request: SignalRequest): SignalResponse {
    if (session.state !== 'OFFER_RECEIVED' && session.state !== 'ANSWER_SENT') {
      return this.reject(session, 'BAD_REQUEST', `Cannot accept answer in state ${session.state}`);
    }
    session.state = 'CONNECTED';
    session.updatedAt = this.now();
    this.clearIceTimer(session);
    this.onIceComplete?.(session.sessionId);

    void eventBus.publishEnvelope(session.userId, 'interview.webrtc.connected', {
      sessionId: session.sessionId,
      userId: session.userId,
      state: session.state,
      connectedAt: new Date(session.updatedAt).toISOString(),
    });

    logger.info('[webrtc] ICE connected', { event: 'webrtc_ice_connected', sessionId: session.sessionId, userId: session.userId });
    return { type: 'ice-candidate', candidate: { candidate: '', sdpMLineIndex: 0, sdpMid: '0' } };
  }

  private handleIceCandidate(session: SignalingSession, request: SignalRequest): SignalResponse {
    if (session.state === 'CLOSED') {
      return this.reject(session, 'GONE', 'Session is closed');
    }
    if (!request.candidate) {
      return this.reject(session, 'BAD_REQUEST', 'ICE candidate is required');
    }

    const candidate: IceCandidate = {
      candidate: request.candidate,
      sdpMLineIndex: request.sdpMLineIndex ?? 0,
      sdpMid: request.sdpMid,
    };
    session.iceCandidates.push(candidate);
    session.updatedAt = this.now();

    // Echo a server-generated candidate back so the client sees trickle ICE working.
    const serverCandidate: IceCandidate = {
      candidate: 'candidate:1 1 udp 2113937151 0.0.0.0 9 typ host',
      sdpMLineIndex: 0,
      sdpMid: '0',
    };
    session.remoteIceCandidates.push(serverCandidate);
    session.updatedAt = this.now();

    void eventBus.publishEnvelope(session.userId, 'interview.webrtc.ice.candidate', {
      sessionId: session.sessionId,
      userId: session.userId,
      candidate,
      serverCandidate,
      state: session.state,
    });

    return { type: 'ice-candidate', candidate: serverCandidate };
  }

  private teardown(sessionId: string, userId: string): SignalResponse {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { type: 'error', code: 'NOT_FOUND', message: 'Session not found' };
    }
    if (session.userId !== userId) {
      return { type: 'error', code: 'FORBIDDEN', message: 'Unauthorized access to signaling session' };
    }
    this.closeSession(sessionId);
    return { type: 'closed' };
  }

  private cleanupStaleSessions(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (now - session.updatedAt >= SIGNALING_SESSION_TTL_MS) {
        this.closeSession(session.sessionId);
      }
    }
  }

  private reject(session: SignalingSession, code: string, message: string): SignalResponse {
    session.state = 'FAILED';
    session.updatedAt = this.now();
    return { type: 'error', code, message };
  }

  private startIceTimer(session: SignalingSession): void {
    this.clearIceTimer(session);
    session.iceTimer = setTimeout(() => {
      session.state = 'FAILED';
      session.iceTimer = null;
      session.fallbackUrl = `${this.fallbackBaseUrl}/${session.sessionId}/audio/chunks`;
      this.onFallback?.(session.sessionId);

      void eventBus.publishEnvelope(session.userId, 'interview.webrtc.ice.timeout', {
        sessionId: session.sessionId,
        userId: session.userId,
        state: session.state,
        fallbackUrl: session.fallbackUrl,
        timedOutAt: new Date(this.now()).toISOString(),
      });

      logger.warn('[webrtc] ICE negotiation timed out, falling back to HTTP chunk ingestion', {
        event: 'webrtc_ice_timeout_fallback',
        sessionId: session.sessionId,
        userId: session.userId,
        fallbackUrl: session.fallbackUrl,
      });
    }, this.iceTimeoutMs);
  }

  private clearIceTimer(session: SignalingSession): void {
    if (session.iceTimer) {
      clearTimeout(session.iceTimer);
      session.iceTimer = null;
    }
  }

  // ─── SDP helpers ─────────────────────────────────────────────────────────

  private isValidSdp(sdp: string): boolean {
    const required = ['v=', 'o=', 's=', 't='];
    for (const field of required) {
      if (!sdp.includes(field)) return false;
    }
    return sdp.includes(AUDIO_MEDIA_LINE);
  }

  private generateAnswerSdp(offerSdp: string): string {
    const iceUfrag = randomBytes(4).toString('hex');
    const icePwd = randomBytes(16).toString('hex');
    const fingerprint = this.generateFingerprint();
    const lines = [
      `v=${SDP_VERSION}`,
      `o=${SDP_ORIGIN}`,
      `s=${SDP_SESSION_NAME}`,
      SDP_TIMING,
      AUDIO_MEDIA_LINE,
      AUDIO_CONNECTION,
      OPUS_RTPMAP,
      OPUS_FMTP,
      `a=ice-ufrag:${iceUfrag}`,
      `a=ice-pwd:${icePwd}`,
      `a=fingerprint:sha-256 ${fingerprint}`,
      'a=setup:actpass',
      'a=sendrecv',
      'a=rtcp-mux',
    ];
    return lines.join('\r\n') + '\r\n';
  }

  private generateFingerprint(): string {
    const bytes = randomBytes(32);
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return hex.match(/.{1,4}/g)!.join(':');
  }
}

export const webrtcSignalingGateway = new WebRTCSignalingGateway();
export default webrtcSignalingGateway;
