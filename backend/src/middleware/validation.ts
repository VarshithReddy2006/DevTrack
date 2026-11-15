// src/middleware/validation.ts - Request validation & sanitization middleware
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { ErrorCodes, ObjectIdSchema, type ApiResponseEnvelope } from '@devtrack/contracts';
import { z, ZodSchema, ZodError } from 'zod';
import { commonErrors } from '../shared/response.js';

/**
 * Matches a 24-character hex MongoDB ObjectId string. Route params using this
 * schema fail with a 400 before handlers construct ObjectId from them.
 */
export const objectIdSchema = ObjectIdSchema;

/**
 * Mutates an object in-place to prevent NoSQL injection by deleting keys starting with $ or containing .
 */
function sanitizeMutate(obj: any): void {
  if (obj === null || typeof obj !== 'object') {
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach(sanitizeMutate);
    return;
  }
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
    } else {
      if (typeof obj[key] === 'object') {
        sanitizeMutate(obj[key]);
      }
    }
  }
}

export function sanitizeRequest(req: Request, res: Response, next: NextFunction): void {
  if (req.body) sanitizeMutate(req.body);
  if (req.query) sanitizeMutate(req.query);
  if (req.params) sanitizeMutate(req.params);
  next();
}

/**
 * Safer error serialization for validation details
 */
function serializeZodError(error: ZodError, part?: string): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  error.errors.forEach((err) => {
    const path = [part, ...err.path].filter(segment => segment !== undefined).join('.') || 'root';
    if (!details[path]) {
      details[path] = [];
    }
    // Remove potentially sensitive user input from error message
    const safeMessage = err.message.replace(/".*"/g, '"[REDACTED]"');
    details[path].push(safeMessage);
  });
  return details;
}

type ContractSchemas = { body?: z.ZodTypeAny; query?: z.ZodTypeAny; params?: z.ZodTypeAny };
type ValidPart<S> = S extends z.ZodTypeAny ? z.output<S> : undefined;

export type ValidatedContractRequest<S extends ContractSchemas> = Request & {
  validBody: ValidPart<S['body']>;
  validQuery: ValidPart<S['query']>;
  validParams: ValidPart<S['params']>;
};

declare global {
  namespace Express {
    interface Request {
      validBody?: unknown;
      validQuery?: unknown;
      validParams?: unknown;
    }
  }
}

function sanitizeContractInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeContractInput);
  if (!value || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return value;

  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !key.startsWith('$') && !key.includes('.') && !['__proto__', 'constructor', 'prototype'].includes(key))
    .map(([key, item]) => [key, sanitizeContractInput(item)]));
}

export function validateContract<S extends ContractSchemas>(
  schemas: S,
  handler?: (req: ValidatedContractRequest<S>, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => {
    const parts = [
      ['body', 'validBody'], ['query', 'validQuery'], ['params', 'validParams'],
    ] as const;
    const validated: Partial<Record<typeof parts[number][1], unknown>> = {};
    const details: Record<string, string[]> = {};
    for (const [part, field] of parts) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(sanitizeContractInput(req[part]));
      if (result.success) validated[field] = result.data;
      else Object.assign(details, serializeZodError(result.error, part));
    }
    if (Object.keys(details).length) {
      const response: ApiResponseEnvelope<never> = {
        success: false,
        error: { code: ErrorCodes.VALIDATION_ERROR, message: 'Validation failed', details },
        meta: { timestamp: new Date().toISOString(), requestId: req.context?.requestId },
      };
      res.status(400).json(response);
      return;
    }

    // Commit parsed values only after every configured input passes validation.
    req.validBody = validated.validBody;
    req.validQuery = validated.validQuery;
    req.validParams = validated.validParams;
    if (handler) return handler(req as ValidatedContractRequest<S>, res, next);
    next();
  };
}

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        commonErrors.validationError(res, serializeZodError(error));
      } else {
        next(error);
      }
    }
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req.query);
      // Copy properties back to avoid re-assigning req.query getter
      if (req.query) {
        Object.keys(req.query).forEach(k => delete req.query[k]);
        Object.assign(req.query, parsed);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        commonErrors.validationError(res, serializeZodError(error));
      } else {
        next(error);
      }
    }
  };
}

export function validateParams<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req.params);
      // Copy properties back to avoid re-assigning req.params getter
      if (req.params) {
        Object.keys(req.params).forEach(k => delete req.params[k]);
        Object.assign(req.params, parsed);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        commonErrors.validationError(res, serializeZodError(error));
      } else {
        next(error);
      }
    }
  };
}

export function validateRequest(schemas: { body?: ZodSchema<any>, query?: ZodSchema<any>, params?: ZodSchema<any> }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query);
        Object.keys(req.query).forEach(k => delete req.query[k]);
        Object.assign(req.query, parsed);
      }
      if (schemas.params) {
        const parsed = schemas.params.parse(req.params);
        Object.keys(req.params).forEach(k => delete req.params[k]);
        Object.assign(req.params, parsed);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        commonErrors.validationError(res, serializeZodError(error));
      } else {
        next(error);
      }
    }
  };
}