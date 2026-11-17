import type { Request, Response } from 'express';
import mongoose, { Types } from 'mongoose';
import multer from 'multer';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../middleware/error.js';

vi.mock('../../shared/monitoring.js', () => ({ reportError: vi.fn() }));

function handleError(error: Error) {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const response = { status, json } as unknown as Response;
  const request = { method: 'PATCH', path: '/test' } as Request;
  errorHandler(error, request, response, vi.fn());
  return { status, json };
}

describe('errorHandler ObjectId errors', () => {
  it('returns a safe 400 response for the actual BSON ObjectId constructor error', () => {
    try {
      new Types.ObjectId('invalid-id');
    } catch (error) {
      expect(error).toBeInstanceOf(mongoose.mongo.BSON.BSONError);
      const { status, json } = handleError(error as Error);
      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Invalid ID format',
      }));
      return;
    }
    throw new Error('Expected ObjectId construction to reject the invalid string');
  });

  it('preserves the existing Mongoose CastError response', () => {
    const error = new mongoose.Error.CastError('ObjectId', 'invalid-id', '_id');
    const { status, json } = handleError(error);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BAD_REQUEST', message: 'Invalid ID format' }));
  });

  it('does not classify an unrelated BSON serialization failure as a client error', () => {
    const error = new mongoose.mongo.BSON.BSONError('Cannot serialize an internal value');
    const { status, json } = handleError(error);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERNAL_ERROR', message: 'Internal server error' }));
  });

  it('keeps unexpected application failures as safe server errors', () => {
    const { status, json } = handleError(new Error('Private internal details'));
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERNAL_ERROR', message: 'Internal server error' }));
  });
});

describe('errorHandler multer errors', () => {
  it.each([
    ['LIMIT_FILE_SIZE', 413, 'FILE_TOO_LARGE'],
    ['LIMIT_FILE_COUNT', 400, 'TOO_MANY_FILES'],
    ['LIMIT_UNEXPECTED_FILE', 400, 'UNEXPECTED_FILE'],
    ['LIMIT_PART_COUNT', 400, 'UPLOAD_ERROR'],
    ['LIMIT_FIELD_VALUE', 400, 'UPLOAD_ERROR'],
  ] as const)('maps %s to %i %s using the real MulterError', (multerCode, statusCode, code) => {
    const { status, json } = handleError(new multer.MulterError(multerCode, 'resume'));
    expect(status).toHaveBeenCalledWith(statusCode);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code, statusCode }));
  });

  it('honours a statusCode set on a plain error, as the file filter error does', () => {
    const error = Object.assign(new Error('Unsupported file type.'), { statusCode: 415, code: 'UNSUPPORTED_FILE_TYPE' });
    const { status, json } = handleError(error);
    expect(status).toHaveBeenCalledWith(415);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNSUPPORTED_FILE_TYPE' }));
  });
});
