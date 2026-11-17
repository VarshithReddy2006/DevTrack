import { z } from 'zod';
import { ObjectIdSchema } from '../common/ids.js';

export const FocusStartRequestSchema = z.object({
  mode: z.string().trim().min(1).max(80),
  plannedSec: z.number().int().safe().positive(),
}).strict();

// Heartbeats and completion are server-authoritative and use the route ID.
export const FocusHeartbeatRequestSchema = z.object({ id: ObjectIdSchema });
export const FocusCompleteRequestSchema = FocusHeartbeatRequestSchema;

export type FocusStartRequest = z.infer<typeof FocusStartRequestSchema>;
export type FocusHeartbeatRequest = z.infer<typeof FocusHeartbeatRequestSchema>;
export type FocusCompleteRequest = z.infer<typeof FocusCompleteRequestSchema>;
