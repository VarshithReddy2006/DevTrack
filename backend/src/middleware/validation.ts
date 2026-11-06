// src/middleware/validation.ts - Request validation & sanitization middleware
import type { Request, Response, NextFunction } from 'express';
import { z, ZodSchema, ZodError } from 'zod';
import { commonErrors } from '../shared/response.js';

/**
 * Matches a 24-character hex MongoDB ObjectId string. Route params using this
 * schema fail with a 400 before handlers construct ObjectId from them.
 */
export const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ID format');

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
function serializeZodError(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  error.errors.forEach((err) => {
    const path = err.path.join('.') || 'root';
    if (!details[path]) {
      details[path] = [];
    }
    // Remove potentially sensitive user input from error message
    const safeMessage = err.message.replace(/".*"/g, '"[REDACTED]"');
    details[path].push(safeMessage);
  });
  return details;
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