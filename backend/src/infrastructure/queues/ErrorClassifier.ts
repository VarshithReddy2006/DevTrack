// src/infrastructure/queues/ErrorClassifier.ts
export class RetryableError extends Error {
  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = 'RetryableError';
  }
}

export class NonRetryableError extends Error {
  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

// Node / undici / driver error codes that mean "try again later".
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_ERROR_NAMES = new Set([
  'MongoServerSelectionError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'TimeoutError',
  'AbortError',
]);

const TRANSIENT_MESSAGE_FRAGMENTS = [
  'timeout',
  'timed out',
  'rate limit',
  '429',
  '502',
  '503',
  '504',
  'econnreset',
  'econnrefused',
  'etimedout',
  'eai_again',
  'enotfound',
  'epipe',
  'network',
  'connection refused',
  'connection is closed',
  'fetch failed',
  'socket hang up',
  'topology is closed',
  'mongo', // Basic mongo transient catch
  'lock',
];

// fetch() wraps the real socket error in error.cause, so look a few levels down.
const MAX_CAUSE_DEPTH = 5;

function isTransient(error: any): boolean {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current.code === 'string' && TRANSIENT_ERROR_CODES.has(current.code.toUpperCase())) return true;
    if (typeof current.name === 'string' && TRANSIENT_ERROR_NAMES.has(current.name)) return true;
    const message = typeof current.message === 'string' ? current.message.toLowerCase() : '';
    if (TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))) return true;
    current = current.cause;
  }
  return false;
}

export class ErrorClassifier {
  /**
   * Classify standard generic errors based on their code, name, message and cause chain.
   * Unknown errors stay non-retryable so poison messages do not loop.
   */
  static classify(error: any): RetryableError | NonRetryableError {
    if (error instanceof RetryableError || error instanceof NonRetryableError) {
      return error;
    }

    if (isTransient(error)) {
      return new RetryableError(`[Transient] ${error?.message || error?.code || 'Unknown error'}`, error);
    }

    // Default everything else to non-retryable to prevent poison messages looping
    return new NonRetryableError(`[Fatal] ${error?.message || 'Unknown error'}`, error);
  }
}
