import { z } from 'zod';

export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  FOCUS_SESSION_ALREADY_OPEN: 'FOCUS_SESSION_ALREADY_OPEN',
  HEARTBEAT_TOO_FREQUENT: 'HEARTBEAT_TOO_FREQUENT',
  REVISION_CARD_STALE: 'REVISION_CARD_STALE',
} as const;

export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.array(z.string())).optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
