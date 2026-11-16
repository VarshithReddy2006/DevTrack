// infra/k6/helpers/auth.js
// Shared configuration and auth helpers for the DevTrack k6 scenarios.
//
// DevTrack verifies Clerk session JWTs on every protected route, so there is no way to mint a
// "mock" token locally. The scripts take real tokens from the environment instead:
//
//   TARGET_URL   Base URL of the backend (default http://localhost:3001, the backend's default PORT)
//   TEST_TOKEN   A valid Bearer token for the load-test user
//   TEST_TOKENS  Optional comma separated list of tokens. VUs are spread across them so the load is
//                not all on one user. Takes precedence over TEST_TOKEN.
//   TEST_USERNAME  Username of a public profile to read (default "loadtest")
//
// Clerk's default session tokens live for about a minute. For anything longer than a smoke run, use a
// Clerk JWT template with a long lifetime for the throwaway load-test user.

import http from 'k6/http';
import { check, fail } from 'k6';

const API_PREFIX = '/api/v1';

export const TARGET_URL = (__ENV.TARGET_URL || 'http://localhost:3001').replace(/\/+$/, '');
export const API = `${TARGET_URL}${API_PREFIX}`;
export const TEST_USERNAME = __ENV.TEST_USERNAME || 'loadtest';

function tokenPool() {
  const list = (__ENV.TEST_TOKENS || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (list.length > 0) return list;
  return __ENV.TEST_TOKEN ? [__ENV.TEST_TOKEN] : [];
}

const TOKENS = tokenPool();

/** Call from setup() so a missing token fails the run immediately instead of producing 401s. */
export function requireToken() {
  if (TOKENS.length === 0) {
    fail('Set TEST_TOKEN (or TEST_TOKENS) to a valid Bearer token for the load-test user.');
  }
}

/** Token for the current VU. Stable per VU, spread round-robin across TEST_TOKENS. */
export function tokenForVu() {
  return TOKENS[(__VU - 1) % TOKENS.length];
}

export function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${tokenForVu()}`, ...extra };
}

export function jsonAuthHeaders() {
  return authHeaders({ 'Content-Type': 'application/json' });
}

/**
 * Ask the backend for a single-use SSE handshake ticket (valid for 10 seconds, so use it right away).
 * Returns the ticket string, or null when the handshake failed.
 */
export function fetchSseTicket() {
  const res = http.post(`${API}/auth/sse-handshake`, null, {
    headers: authHeaders(),
    tags: { endpoint: 'sse_handshake' },
  });
  const ok = check(res, {
    'sse handshake returns 200': (r) => r.status === 200,
  });
  if (!ok) return null;
  const ticket = res.json('data.ticket');
  return typeof ticket === 'string' && ticket.length > 0 ? ticket : null;
}

/** Number from env with a default, so stages and rates can be scaled down for a smoke run. */
export function envNumber(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
