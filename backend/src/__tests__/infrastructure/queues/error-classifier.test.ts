import { describe, expect, it } from 'vitest';
import { ErrorClassifier, NonRetryableError, RetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
function named(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

describe('ErrorClassifier.classify', () => {
  describe('transient errors are retryable', () => {
    it.each([
      'fetch failed',
      'connect ECONNREFUSED 127.0.0.1:6379',
      'read ETIMEDOUT',
      'getaddrinfo EAI_AGAIN api.openai.com',
      'getaddrinfo ENOTFOUND api.github.com',
      'write EPIPE',
      'socket hang up',
      'Server selection timed out after 30000 ms',
      'Connection is closed.',
      'Job execution timed out after 5 minutes',
      'Operation timed out',
      'Request failed with status code 503',
      'Request failed with status code 429',
    ])('by message: %s', (message) => {
      expect(ErrorClassifier.classify(new Error(message))).toBeInstanceOf(RetryableError);
    });

    it.each([
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT',
    ])('by error.code %s even when the message says nothing useful', (code) => {
      expect(ErrorClassifier.classify(withCode('request failed', code))).toBeInstanceOf(RetryableError);
    });

    it('by error.cause.code, the way undici wraps socket errors in fetch failed', () => {
      const error = new TypeError('upstream call broke', { cause: withCode('connect failed', 'ECONNREFUSED') });
      expect(ErrorClassifier.classify(error)).toBeInstanceOf(RetryableError);
    });

    it('by a code two levels down the cause chain', () => {
      const root = withCode('socket closed', 'ECONNRESET');
      const middle = new Error('middle', { cause: root });
      expect(ErrorClassifier.classify(new Error('outer', { cause: middle }))).toBeInstanceOf(RetryableError);
    });

    it.each(['MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError', 'TimeoutError', 'AbortError'])(
      'by error.name %s',
      (name) => {
        expect(ErrorClassifier.classify(named(name, 'something generic'))).toBeInstanceOf(RetryableError);
      },
    );

    it('keeps the original message and error', () => {
      const original = new Error('fetch failed');
      const classified = ErrorClassifier.classify(original) as RetryableError;
      expect(classified.message).toBe('[Transient] fetch failed');
      expect(classified.originalError).toBe(original);
    });
  });

  describe('everything else stays fatal', () => {
    it.each([
      'Unexpected token < in JSON at position 0',
      'Validation failed: email is required',
      'Cannot read properties of undefined',
    ])('unknown message: %s', (message) => {
      expect(ErrorClassifier.classify(new Error(message))).toBeInstanceOf(NonRetryableError);
    });

    it('unknown code and name', () => {
      expect(ErrorClassifier.classify(withCode('bad input', 'ERR_INVALID_ARG_TYPE'))).toBeInstanceOf(NonRetryableError);
      expect(ErrorClassifier.classify(named('ValidationError', 'bad input'))).toBeInstanceOf(NonRetryableError);
    });

    it('does not choke on non-Error values', () => {
      expect(ErrorClassifier.classify(undefined)).toBeInstanceOf(NonRetryableError);
      expect(ErrorClassifier.classify(null)).toBeInstanceOf(NonRetryableError);
      expect(ErrorClassifier.classify('boom')).toBeInstanceOf(NonRetryableError);
    });

    it('terminates on a circular cause chain', () => {
      const a: any = new Error('a');
      a.cause = a;
      expect(ErrorClassifier.classify(a)).toBeInstanceOf(NonRetryableError);
    });
  });

  it('passes through errors that are already classified', () => {
    const retryable = new RetryableError('x');
    const fatal = new NonRetryableError('timed out but marked fatal');
    expect(ErrorClassifier.classify(retryable)).toBe(retryable);
    expect(ErrorClassifier.classify(fatal)).toBe(fatal);
  });
});
