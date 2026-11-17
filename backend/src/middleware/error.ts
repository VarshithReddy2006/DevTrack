// src/middleware/error.ts - Error handling middleware
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { errorResponse, commonErrors } from '../shared/response.js';
import { reportError } from '../shared/monitoring.js';

const MAX_UPLOAD_MB = 10;

// Multer errors carry no HTTP status, so without this they fall through to a 500.
function multerErrorResponse(err: AppError & { field?: string }): { message: string; code: string; statusCode: number } {
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return { message: `File is too large. Maximum size is ${MAX_UPLOAD_MB} MB.`, code: 'FILE_TOO_LARGE', statusCode: 413 };
    case 'LIMIT_FILE_COUNT':
      return { message: 'Too many files. Upload one file at a time.', code: 'TOO_MANY_FILES', statusCode: 400 };
    case 'LIMIT_UNEXPECTED_FILE':
      return { message: `Unexpected file field${err.field ? ` "${err.field}"` : ''}.`, code: 'UNEXPECTED_FILE', statusCode: 400 };
    default:
      return { message: 'The upload could not be processed.', code: 'UPLOAD_ERROR', statusCode: 400 };
  }
}

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: Record<string, string[]>;
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Report to monitoring
  reportError(err, {
    path: req.path,
    method: req.method,
    metadata: {
      code: err.code,
      statusCode: err.statusCode,
    },
  });

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const details: Record<string, string[]> = {};
    err.errors.forEach((error) => {
      const path = error.path.join('.');
      if (!details[path]) {
        details[path] = [];
      }
      details[path].push(error.message);
    });
    commonErrors.validationError(res, details);
    return;
  }

  // Handle MongoDB duplicate key error
  if (err.name === 'MongoServerError' && (err as unknown as { code: number }).code === 11000) {
    const keyValue = (err as unknown as { keyValue: Record<string, unknown> }).keyValue;
    const field = Object.keys(keyValue)[0];
    commonErrors.conflict(res, `${field} already exists`);
    return;
  }

  // Handle Mongoose validation errors
  if (err.name === 'ValidationError') {
    const validationError = err as unknown as {
      errors: Record<string, { message: string }>;
    };
    const details: Record<string, string[]> = {};
    Object.entries(validationError.errors).forEach(([field, error]) => {
      details[field] = [error.message];
    });
    commonErrors.validationError(res, details);
    return;
  }

  // BSONError also covers server-side serialization faults, so only translate
  // the ObjectId constructor's invalid-string error into a client error.
  const isInvalidObjectId = err.name === 'BSONError' &&
    err.message.startsWith('input must be a 24 character hex string');
  if (err.name === 'CastError' || isInvalidObjectId) {
    commonErrors.badRequest(res, 'Invalid ID format');
    return;
  }



  // Multer upload errors (file too large, unexpected field, ...) are client errors
  if (err.name === 'MulterError') {
    const { message, code, statusCode } = multerErrorResponse(err);
    errorResponse(res, message, code, statusCode);
    return;
  }

  // Handle custom AppErrors
  if (err.statusCode) {
    errorResponse(res, err.message, err.code || 'ERROR', err.statusCode, err.details);
    return;
  }

  // Default to internal server error
  commonErrors.internalError(res);
}

// Not found middleware
export function notFoundHandler(req: Request, res: Response): void {
  errorResponse(res, `Route ${req.method} ${req.path} not found`, 'ROUTE_NOT_FOUND', 404);
}

// Async handler wrapper
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
