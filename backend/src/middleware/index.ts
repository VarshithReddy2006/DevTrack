// src/middleware/index.ts - Middleware barrel export
export {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  type AppError,
} from './error.js';

export {
  authMiddleware,
  optionalAuthMiddleware,
  adminMiddleware,
  opsAuditorMiddleware,
  type AuthenticatedRequest,
} from './auth.js';

export { validateBody, validateQuery, validateParams, validateContract, type ValidatedContractRequest } from './validation.js';

export { rateLimit } from './rateLimit.js';

export {
  idempotency,
  idempotencyMiddleware,
  createIdempotencyMiddleware,
  type IdempotencyOptions,
  type StoredIdempotencyPayload,
} from './idempotency.js';

export {
  originValidation,
  originMatches,
  parseAllowedOrigins,
  DEFAULT_EXEMPT_PREFIXES,
  type OriginValidationOptions,
} from './originValidation.js';
