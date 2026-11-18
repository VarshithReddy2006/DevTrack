import { z } from 'zod';

/** Plain text a model may return: bounded, non-blank, no control characters and no angle brackets (so no echoed delimiters). */
export function boundedText(max: number) {
  return z.string().min(1).max(max)
    .refine(value => value.trim().length > 0, 'must not be blank')
    .refine(value => !/[<>]/.test(value), 'angle brackets are not allowed')
    .refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), 'control characters are not allowed');
}

export type ModelOutputResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'invalid_json' | 'schema_violation'; issues: string[] };

const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i;

/**
 * Parses a model reply against a strict schema. The only normalisation is removing one
 * surrounding code fence, which models add even when told not to. Anything else that is not
 * plain JSON is rejected, and so is any object that does not satisfy the schema: nothing is
 * repaired, coerced or filled in. Issue messages carry paths and rule names, never the
 * offending values, so untrusted text does not leak into logs.
 */
export function parseModelOutput<T>(schema: z.ZodType<T>, raw: unknown): ModelOutputResult<T> {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_json', issues: ['reply is not text'] };
  const trimmed = raw.trim();
  const body = FENCE.exec(trimmed)?.[1] ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'invalid_json', issues: ['reply is not valid JSON'] };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    reason: 'schema_violation',
    issues: parsed.error.issues.slice(0, 10).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.code}`),
  };
}
