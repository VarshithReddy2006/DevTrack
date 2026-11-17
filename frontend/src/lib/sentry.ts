// ============================================================================
// sentry.ts — Error reporting setup and PII scrubbing
// ============================================================================
// Sentry only starts when VITE_SENTRY_DSN is set. Everything that leaves the
// browser goes through the scrubbers below first: bearer tokens, JWTs, email
// addresses, credential-like keys, resume text fields and URL query strings.
// ============================================================================

import * as Sentry from '@sentry/react';
import type { Breadcrumb, ErrorEvent, Event } from '@sentry/react';
import type { ErrorInfo } from 'react';

const REDACTED = '[redacted]';
const REDACTED_EMAIL = '[redacted-email]';
const MAX_DEPTH = 12;

const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// Matched against the lower-cased key with everything but letters removed, so
// "Set-Cookie", "set_cookie" and "setCookie" are the same key.
const SENSITIVE_KEYS = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'cookies', 'setcookie', 'querystring',
  'resumetext', 'resumecontent', 'rawtext', 'extractedtext', 'parsedtext',
]);
const SENSITIVE_SUFFIXES = ['token', 'password', 'secret', 'apikey'];

// Keys whose string value is a URL (request.url, navigation breadcrumbs); the
// query string and fragment can carry opaque tokens no pattern would recognise.
const URL_KEYS = new Set(['url', 'from', 'to']);
const LOOKS_LIKE_URL = /^(?:https?:\/\/|\/)/;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** Masks bearer tokens, JWTs and email addresses inside a string. */
export function scrubString(value: string): string {
  let result = value.replace(BEARER_TOKEN, 'Bearer ' + REDACTED).replace(JWT, REDACTED);
  if (result.includes('@')) result = result.replace(EMAIL, REDACTED_EMAIL);
  return result;
}

function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function scrubNode(value: unknown, key: string | undefined, seen: WeakSet<object>, depth: number): unknown {
  if (key !== undefined && isSensitiveKey(key)) return REDACTED;
  if (typeof value === 'string') {
    const isUrl = key !== undefined && URL_KEYS.has(key) && LOOKS_LIKE_URL.test(value);
    return scrubString(isUrl ? stripQuery(value) : value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const next = depth + 1;
  const result = Array.isArray(value)
    ? value.map((item) => scrubNode(item, undefined, seen, next))
    : Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [childKey, scrubNode(child, childKey, seen, next)]),
      );
  seen.delete(value);
  return result;
}

/** Deep-copies any value with the scrubbing rules applied; the input is not modified. */
export function scrubValue<T>(value: T): T {
  return scrubNode(value, undefined, new WeakSet(), 0) as T;
}

/** Sentry `beforeBreadcrumb` hook. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return scrubValue(breadcrumb);
}

/** Sentry `beforeSend` hook: scrubs the whole event and drops identifying user fields. */
export function scrubEvent<T extends Event>(event: T): T {
  const clean = scrubValue(event);
  if (clean.user) {
    delete clean.user.email;
    delete clean.user.ip_address;
    delete clean.user.username;
  }
  return clean;
}

/**
 * `beforeSend` only runs for error events, so feedback events (which carry the
 * scope's user and contexts) get the same scrubbing through an event processor.
 */
export function scrubFeedbackEvent(event: Event): Event {
  return event.type === 'feedback' ? scrubEvent(event) : event;
}

/**
 * Starts Sentry when a DSN is configured. Returns whether reporting is on, so
 * a missing DSN (local dev, forks, previews) is a plain no-op.
 */
export function initSentry(dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN): boolean {
  if (!dsn) return false;
  if (Sentry.isInitialized()) return true;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Collect nothing optional by default; the scrubbers below are a second layer.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    beforeSend: (event: ErrorEvent) => scrubEvent(event),
    beforeBreadcrumb: scrubBreadcrumb,
  });
  Sentry.addEventProcessor(scrubFeedbackEvent);
  return true;
}

/**
 * Reports an error caught by a React error boundary, with the component stack
 * attached. Returns the Sentry event id, or undefined when reporting is off.
 * Never throws, so a reporting failure cannot take the fallback UI down with it.
 */
export function captureBoundaryError(error: Error, info: ErrorInfo): string | undefined {
  try {
    if (!Sentry.isInitialized()) return undefined;
    return Sentry.captureReactException(error, info);
  } catch {
    return undefined;
  }
}

/** Sends the user's note about a crash, linked to the event it describes. */
export function sendCrashFeedback(message: string, eventId: string): boolean {
  const text = scrubString(message).trim();
  if (!text) return false;
  try {
    if (!Sentry.isInitialized()) return false;
    Sentry.captureFeedback({ message: text, associatedEventId: eventId });
    return true;
  } catch {
    return false;
  }
}
