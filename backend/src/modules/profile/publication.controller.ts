import type { Response } from 'express';
import { Types } from 'mongoose';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { commonErrors, successResponse } from '../../shared/response.js';
import type { PublishProfileInput } from './publication.schemas.js';
import { PublicationError, PublicationService } from './publication.service.js';

export async function getPublication(req: AuthenticatedRequest, res: Response): Promise<void> {
  successResponse(res, await PublicationService.getStatus(req.user!.id), 'Publication status retrieved successfully');
}

export async function publishProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const status = await PublicationService.publishProfile(new Types.ObjectId(req.user!.id), req.body as PublishProfileInput);
    successResponse(res, status, 'Profile published successfully');
  } catch (error) {
    if (error instanceof PublicationError) {
      if (error.code === 'INVALID_SLUG') commonErrors.badRequest(res, error.message);
      else commonErrors.conflict(res, error.message);
      return;
    }
    throw error;
  }
}

export async function unpublishProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  const status = await PublicationService.unpublishProfile(new Types.ObjectId(req.user!.id));
  successResponse(res, status, 'Profile unpublished successfully');
}
