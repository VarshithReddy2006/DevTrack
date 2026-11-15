import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { commonErrors, errorResponse } from '../../shared/response.js';
import { isFlagEnabled } from './flags.service.js';

export function requireFlag(flagKey: string) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) return commonErrors.unauthorized(res);
    if (!await isFlagEnabled(flagKey, req.user.id)) {
      return errorResponse(res, 'Feature disabled', 'FEATURE_DISABLED', 404);
    }
    next();
  };
}
