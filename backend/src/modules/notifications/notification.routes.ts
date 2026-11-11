// src/modules/notifications/notification.routes.ts — Notification API routes
import { Router } from 'express';
import { z } from 'zod';
import { notificationController } from './notification.controller.js';
import { authMiddleware, asyncHandler, validateBody } from '../../middleware/index.js';

const router = Router();

// Apply authMiddleware globally to all notification routes
router.use(authMiddleware);

const updatePreferencesSchema = z.object({
  enableInApp: z.boolean().optional(),
  enablePush: z.boolean().optional(),
  digestFrequency: z.enum(['realtime', 'daily', 'weekly', 'none']).optional(),
  types: z.record(z.string(), z.boolean()).optional(),
});

/**
 * GET /api/notifications - Get user notifications
 * Query params: limit, offset, unreadOnly
 */
router.get('/', asyncHandler(notificationController.getNotifications.bind(notificationController)));

/**
 * DELETE /api/notifications - Clear notifications (query params: readOnly, default true)
 */
router.delete('/', asyncHandler(notificationController.clearNotifications.bind(notificationController)));

/**
 * GET /api/notifications/unread-count - Get unread notification count
 */
router.get('/unread-count', asyncHandler(notificationController.getUnreadCount.bind(notificationController)));

/**
 * GET /api/notifications/preferences - Get notification preferences
 */
router.get('/preferences', asyncHandler(notificationController.getPreferences.bind(notificationController)));

/**
 * PATCH /api/notifications/preferences - Update notification preferences
 */
router.patch('/preferences', validateBody(updatePreferencesSchema), asyncHandler(notificationController.updatePreferences.bind(notificationController)));

/**
 * PUT /api/notifications/preferences - Update notification preferences
 */
router.put('/preferences', validateBody(updatePreferencesSchema), asyncHandler(notificationController.updatePreferences.bind(notificationController)));

/**
 * POST /api/notifications/read-all - Mark all notifications as read
 */
router.post('/read-all', asyncHandler(notificationController.markAllAsRead.bind(notificationController)));

/**
 * POST /api/notifications/:id/read - Mark notification as read
 */
router.post('/:id/read', asyncHandler(notificationController.markAsRead.bind(notificationController)));

/**
 * DELETE /api/notifications/:id - Delete a specific notification
 */
router.delete('/:id', asyncHandler(notificationController.deleteNotification.bind(notificationController)));

export default router;
