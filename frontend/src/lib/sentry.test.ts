import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react';
import type { Breadcrumb, ErrorEvent, Event } from '@sentry/react';
import {
  captureBoundaryError,
  initSentry,
  scrubBreadcrumb,
  scrubEvent,
  scrubFeedbackEvent,
  scrubString,
  scrubValue,
  sendCrashFeedback,
} from './sentry';

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  addEventProcessor: vi.fn(),
  isInitialized: vi.fn(() => false),
  captureReactException: vi.fn(() => 'evt-123'),
  captureFeedback: vi.fn(() => 'fb-1'),
}));

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJl';

beforeEach(() => {
  vi.mocked(Sentry.isInitialized).mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('scrubString', () => {
  it('masks bearer tokens whatever the casing', () => {
    expect(scrubString('Authorization: Bearer abc.def-123_xyz=')).toBe('Authorization: Bearer [redacted]');
    expect(scrubString('sent bearer abc123 to server')).toBe('sent Bearer [redacted] to server');
  });

  it('masks bare JWTs', () => {
    expect(scrubString('token was ' + JWT + ' at login')).toBe('token was [redacted] at login');
  });

  it('masks email addresses anywhere in the text', () => {
    expect(scrubString('failed for jane.doe+test@mail.example.com and bob@x.io!'))
      .toBe('failed for [redacted-email] and [redacted-email]!');
  });

  it('leaves ordinary text alone', () => {
    expect(scrubString('Cannot read properties of undefined (reading "map")'))
      .toBe('Cannot read properties of undefined (reading "map")');
    expect(scrubString('price is 5 @ 10')).toBe('price is 5 @ 10');
  });
});

describe('scrubValue', () => {
  it('redacts credential and resume text keys at any depth, in any key style', () => {
    const input = {
      headers: { Authorization: 'Bearer abc', 'Set-Cookie': 'sid=1', 'X-Request-ID': 'r1' },
      extra: { resumeText: 'Led a team of 5 at Acme', raw_text: 'more resume', accessToken: 'tok', csrfToken: 'c', password: 'p' },
      list: [{ rawText: 'x', ok: 'fine' }],
    };
    expect(scrubValue(input)).toEqual({
      headers: { Authorization: '[redacted]', 'Set-Cookie': '[redacted]', 'X-Request-ID': 'r1' },
      extra: { resumeText: '[redacted]', raw_text: '[redacted]', accessToken: '[redacted]', csrfToken: '[redacted]', password: '[redacted]' },
      list: [{ rawText: '[redacted]', ok: 'fine' }],
    });
  });

  it('does not modify its input', () => {
    const input = { headers: { Authorization: 'Bearer abc' }, note: 'me@example.com' };
    scrubValue(input);
    expect(input).toEqual({ headers: { Authorization: 'Bearer abc' }, note: 'me@example.com' });
  });

  it('keeps non-string values and survives circular references', () => {
    const node: Record<string, unknown> = { count: 3, flag: true, none: null };
    node.self = node;
    const clean = scrubValue(node);
    expect(clean).toMatchObject({ count: 3, flag: true, none: null, self: '[circular]' });
  });

  it('cuts off absurdly deep structures instead of recursing forever', () => {
    let deep: Record<string, unknown> = { leaf: 'me@example.com' };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    expect(JSON.stringify(scrubValue(deep))).toContain('[truncated]');
  });

  it('drops the query string and fragment from url-like values only', () => {
    expect(scrubValue({ url: 'https://app.test/p?token=opaque#frag', from: '/a?x=1', to: '/b', note: 'why? #1' }))
      .toEqual({ url: 'https://app.test/p', from: '/a', to: '/b', note: 'why? #1' });
    expect(scrubValue({ to: 'someone? maybe' })).toEqual({ to: 'someone? maybe' });
  });
});

describe('scrubEvent', () => {
  it('cleans the message, exception, request, user, extra and breadcrumbs of an error event', () => {
    const event = {
      type: undefined,
      message: 'Login failed for jane@example.com',
      exception: { values: [{ type: 'Error', value: 'Bearer abc.def rejected' }] },
      request: {
        url: 'https://app.test/dashboard?code=oauth-code',
        query_string: 'code=oauth-code',
        headers: { Authorization: 'Bearer abc.def', 'User-Agent': 'jsdom' },
        cookies: { sid: '1' },
      },
      user: { id: 'user_1', email: 'jane@example.com', ip_address: '10.0.0.1', username: 'jane' },
      extra: { resumeText: 'Senior engineer at Acme' },
      breadcrumbs: [{ category: 'console', message: 'saved ' + JWT }],
    } as unknown as ErrorEvent;

    const clean = scrubEvent(event) as unknown as Record<string, unknown>;
    expect(clean).toMatchObject({
      message: 'Login failed for [redacted-email]',
      exception: { values: [{ type: 'Error', value: 'Bearer [redacted] rejected' }] },
      request: {
        url: 'https://app.test/dashboard',
        query_string: '[redacted]',
        headers: { Authorization: '[redacted]', 'User-Agent': 'jsdom' },
        cookies: '[redacted]',
      },
      user: { id: 'user_1' },
      extra: { resumeText: '[redacted]' },
      breadcrumbs: [{ category: 'console', message: 'saved [redacted]' }],
    });
    expect(clean.user).toEqual({ id: 'user_1' });
    expect(JSON.stringify(clean)).not.toMatch(/jane|oauth-code|Senior engineer|eyJ/);
  });

  it('copes with an event that has no user', () => {
    expect(scrubEvent({ message: 'boom' } as ErrorEvent)).toEqual({ message: 'boom' });
  });
});

describe('scrubFeedbackEvent', () => {
  it('scrubs feedback events, which beforeSend never sees', () => {
    const feedback = {
      type: 'feedback',
      user: { id: 'u1', email: 'jane@example.com' },
      contexts: { resume: { resumeText: 'Senior engineer' }, feedback: { message: 'hi jane@example.com' } },
    } as unknown as Event;
    expect(scrubFeedbackEvent(feedback)).toEqual({
      type: 'feedback',
      user: { id: 'u1' },
      contexts: { resume: { resumeText: '[redacted]' }, feedback: { message: 'hi [redacted-email]' } },
    });
  });

  it('leaves other event types to beforeSend', () => {
    const error = { message: 'jane@example.com' } as Event;
    expect(scrubFeedbackEvent(error)).toBe(error);
  });
});

describe('scrubBreadcrumb', () => {
  it('cleans fetch and navigation breadcrumbs', () => {
    const fetchCrumb: Breadcrumb = {
      category: 'fetch',
      data: { url: 'https://api.test/api/users?email=jane@example.com&token=abc', method: 'GET', status_code: 401 },
    };
    expect(scrubBreadcrumb(fetchCrumb)).toEqual({
      category: 'fetch',
      data: { url: 'https://api.test/api/users', method: 'GET', status_code: 401 },
    });
    expect(scrubBreadcrumb({ category: 'navigation', data: { from: '/in?x=1', to: '/out?y=2' } }))
      .toEqual({ category: 'navigation', data: { from: '/in', to: '/out' } });
  });

  it('cleans console breadcrumbs', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'user jane@example.com sent Bearer abc' }))
      .toEqual({ category: 'console', message: 'user [redacted-email] sent Bearer [redacted]' });
  });
});

describe('initSentry', () => {
  it('does nothing without a DSN', () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    expect(initSentry()).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('initialises once with scrubbing hooks and optional data collection off when a DSN is set', () => {
    expect(initSentry('https://key@o0.ingest.sentry.io/1')).toBe(true);
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
    expect(options.dsn).toBe('https://key@o0.ingest.sentry.io/1');
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    });

    const sent = options.beforeSend!({ message: 'for jane@example.com' } as ErrorEvent, {});
    expect(sent).toEqual({ message: 'for [redacted-email]' });
    expect(options.beforeBreadcrumb!({ message: 'Bearer abc' })).toEqual({ message: 'Bearer [redacted]' });
    expect(Sentry.addEventProcessor).toHaveBeenCalledTimes(1);
  });

  it('reads the DSN from VITE_SENTRY_DSN by default', () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://key@o0.ingest.sentry.io/2');
    expect(initSentry()).toBe(true);
    expect(vi.mocked(Sentry.init).mock.calls[0][0]!.dsn).toBe('https://key@o0.ingest.sentry.io/2');
  });

  it('does not initialise a second time', () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    expect(initSentry('https://key@o0.ingest.sentry.io/1')).toBe(true);
    expect(Sentry.init).not.toHaveBeenCalled();
  });
});

describe('captureBoundaryError', () => {
  const info = { componentStack: '\n    at Broken' };

  it('is a no-op when Sentry is not running', () => {
    expect(captureBoundaryError(new Error('x'), info)).toBeUndefined();
    expect(Sentry.captureReactException).not.toHaveBeenCalled();
  });

  it('passes the error and component stack to Sentry and returns the event id', () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    const error = new Error('x');
    expect(captureBoundaryError(error, info)).toBe('evt-123');
    expect(Sentry.captureReactException).toHaveBeenCalledWith(error, info);
  });

  it('never throws if the SDK does', () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    vi.mocked(Sentry.captureReactException).mockImplementationOnce(() => { throw new Error('sdk down'); });
    expect(captureBoundaryError(new Error('x'), info)).toBeUndefined();
  });
});

describe('sendCrashFeedback', () => {
  it('sends a scrubbed note linked to the crash event', () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    expect(sendCrashFeedback('  I was editing, mail me at jane@example.com  ', 'evt-123')).toBe(true);
    expect(Sentry.captureFeedback).toHaveBeenCalledWith({
      message: 'I was editing, mail me at [redacted-email]',
      associatedEventId: 'evt-123',
    });
  });

  it('does not send an empty note or send when reporting is off', () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    expect(sendCrashFeedback('   ', 'evt-123')).toBe(false);
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    expect(sendCrashFeedback('hello', 'evt-123')).toBe(false);
    expect(Sentry.captureFeedback).not.toHaveBeenCalled();
  });

  it('reports failure instead of throwing when the SDK throws', () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    vi.mocked(Sentry.captureFeedback).mockImplementationOnce(() => { throw new Error('offline'); });
    expect(sendCrashFeedback('hello', 'evt-123')).toBe(false);
  });
});
