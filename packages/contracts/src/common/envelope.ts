import { z } from 'zod';
import { ApiErrorSchema } from './errors.js';
import { IsoDateTimeSchema } from './ids.js';

export const ApiResponseMetaSchema = z.object({
  timestamp: IsoDateTimeSchema,
  requestId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
});

export function apiResponseEnvelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    success: z.boolean(),
    data: data.optional(),
    error: ApiErrorSchema.optional(),
    meta: ApiResponseMetaSchema.optional(),
  });
}

export type ApiResponseEnvelope<T> = z.infer<ReturnType<typeof apiResponseEnvelopeSchema<z.ZodType<T>>>>;
