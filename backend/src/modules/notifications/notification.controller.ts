// src/modules/notifications/notification.controller.ts — Notification API endpoints
// GET /api/notifications, POST /api/notifications/:id/read

import { notificationService } from './notification.service.js';
import { ApiResponse } from '../../shared/response.js';
import { withAuth } from '../../shared/controllerUtils.js';
import { getPushPublicKey, subscribePush, unsubscribePush } from './pushNotification.service.js';

export const notificationController = {
  getPushKey: withAuth('[notifications]', 'get push key', async (_userId, _req, res) => {
    const publicKey = getPushPublicKey();
    if (!publicKey) {
      res.status(503).json({ success: false, message: 'Web Push is not configured' });
      return;
    }
    res.json({ publicKey });
  }),

  subscribePush: withAuth('[notifications]', 'subscribe push', async (userId, req, res) => {
    const result = await subscribePush(userId, req.body);
    if (result === 'unavailable') {
      res.status(503).json({ success: false, message: 'Web Push is not configured' });
      return;
    }
    if (result === 'conflict') {
      res.status(409).json({ success: false, message: 'Subscription belongs to another account or uses an outdated VAPID key' });
      return;
    }
    res.status(201).json({ success: true });
  }),

  unsubscribePush: withAuth('[notifications]', 'unsubscribe push', async (userId, req, res) => {
    await unsubscribePush(userId, req.body.endpoint);
    res.json({ success: true });
  }),

  getNotifications: withAuth('[notifications]', 'get notifications', async (userId, req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const unreadOnly = req.query.unreadOnly === 'true';

    const result = await notificationService.getNotifications(userId, limit, offset, unreadOnly);
    res.json(result);
  }),

  markAsRead: withAuth('[notifications]', 'mark as read', async (userId, req, res) => {
    const notificationId = req.params.id as string;
    if (!notificationId) {
      ApiResponse.badRequest(res, 'Notification ID required');
      return;
    }

    await notificationService.markAsRead(userId, notificationId);
    res.json({ success: true });
  }),

  markAllAsRead: withAuth('[notifications]', 'mark all as read', async (userId, _req, res) => {
    await notificationService.markAllAsRead(userId);
    res.json({ success: true });
  }),

  getUnreadCount: withAuth('[notifications]', 'get unread count', async (userId, _req, res) => {
    const count = await notificationService.getUnreadCount(userId);
    res.json({ unread: count });
  }),

  getPreferences: withAuth('[notifications]', 'get preferences', async (userId, _req, res) => {
    const preferences = await notificationService.getPreferences(userId);
    res.json(preferences);
  }),

  updatePreferences: withAuth('[notifications]', 'update preferences', async (userId, req, res) => {
    const preferences = await notificationService.updatePreferences(userId, req.body);
    res.json(preferences);
  }),

  deleteNotification: withAuth('[notifications]', 'delete notification', async (userId, req, res) => {
    const notificationId = req.params.id as string;
    if (!notificationId) {
      ApiResponse.badRequest(res, 'Notification ID required');
      return;
    }

    const deleted = await notificationService.deleteNotification(userId, notificationId);
    if (!deleted) {
      ApiResponse.notFound(res, 'Notification not found');
      return;
    }

    res.json({ success: true });
  }),

  clearNotifications: withAuth('[notifications]', 'clear notifications', async (userId, req, res) => {
    const readOnly = req.query.readOnly !== 'false';
    const deletedCount = await notificationService.clearNotifications(userId, readOnly);
    res.json({ success: true, deletedCount });
  }),
};
