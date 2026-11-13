// src/modules/auth/auth.controller.ts
import type { Request, Response } from 'express';
import { successResponse } from '../../shared/response.js';
import { logger } from '../../shared/logger.js';
import { syncClerkUser } from '../../services/auth/ClerkUserSyncService.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';

export async function getMe(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  
  // We can just return the local user profile
  const user = await syncClerkUser(req.user.clerkId);
  successResponse(res, user, 'User retrieved successfully');
}

export async function sseHandshake(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  
  const { createHandshakeTicket } = await import('../../shared/sse/ticketStore.js');
  const ticket = await createHandshakeTicket(req.user.id);

  logger.info('[sse] Generated secure short-lived handshake ticket', { userId: req.user.id });
  successResponse(res, { ticket }, 'SSE Handshake ticket generated');
}