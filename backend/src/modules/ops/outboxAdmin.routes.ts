// src/modules/ops/outboxAdmin.routes.ts: /ops/outbox/dlq: dead-lettered outbox events (admin only).
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { OutboxAuditActor } from '../../db/models/outboxAuditLog.model.js';
import { adminMiddleware, authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { validateContract } from '../../middleware/validation.js';
import { paginatedResponse, successResponse } from '../../shared/response.js';
import {
  archiveDeadLetter,
  DLQ_BATCH_LIMIT,
  DLQ_STATUSES,
  editDeadLetterPayload,
  getDeadLetter,
  listDeadLetters,
  retryDeadLetter,
  retryDeadLetters,
} from './outboxDlq.service.js';

const eventIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/, 'Invalid event id');
const eventTypeSchema = z.string().trim().min(1).max(200);
const note = z.string().trim().min(1).max(500).optional();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(DLQ_STATUSES).default('dead'),
  type: eventTypeSchema.optional(),
});
const eventParams = z.object({ eventId: eventIdSchema });
const noteBody = z.object({ note }).strict().default({});
const batchBody = z.object({
  eventIds: z.array(eventIdSchema).min(1).max(DLQ_BATCH_LIMIT).optional(),
  type: eventTypeSchema.optional(),
  /** Retry everything that is dead. Has to be explicit so an empty body never does that. */
  all: z.literal(true).optional(),
  limit: z.number().int().min(1).max(DLQ_BATCH_LIMIT).optional(),
  note,
}).strict().refine(body => body.eventIds || body.type || body.all, 'Pass eventIds, type or all: true');
const editBody = z.object({ payload: z.record(z.unknown()), note }).strict();

function actorOf(req: Request): OutboxAuditActor {
  const { id, username, role } = (req as AuthenticatedRequest).user!;
  return { userId: id, username, role, via: 'api' };
}

export const outboxAdminRoutes = Router();
outboxAdminRoutes.use(authMiddleware, adminMiddleware);

outboxAdminRoutes.get('/', validateContract({ query: listQuery }, async (req, res) => {
  const { status, type, page, pageSize } = req.validQuery;
  const { items, pagination } = await listDeadLetters({ status, type }, { page, pageSize });
  paginatedResponse(res, items, pagination);
}));

outboxAdminRoutes.post('/retry', validateContract({ body: batchBody }, async (req, res) => {
  const { eventIds, type, limit, note: reason } = req.validBody;
  successResponse(res, await retryDeadLetters({ eventIds, type, limit }, actorOf(req), reason));
}));

outboxAdminRoutes.get('/:eventId', validateContract({ params: eventParams }, async (req, res) => {
  successResponse(res, await getDeadLetter(req.validParams.eventId));
}));

outboxAdminRoutes.post('/:eventId/retry', validateContract({ params: eventParams, body: noteBody }, async (req, res) => {
  successResponse(res, await retryDeadLetter(req.validParams.eventId, actorOf(req), req.validBody.note));
}));

outboxAdminRoutes.patch('/:eventId', validateContract({ params: eventParams, body: editBody }, async (req, res) => {
  const { payload, note: reason } = req.validBody;
  successResponse(res, await editDeadLetterPayload(req.validParams.eventId, payload, actorOf(req), reason));
}));

outboxAdminRoutes.delete('/:eventId', validateContract({ params: eventParams, body: noteBody }, async (req, res) => {
  successResponse(res, await archiveDeadLetter(req.validParams.eventId, actorOf(req), req.validBody.note));
}));
