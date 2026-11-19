import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/error.js';
import { commonErrors, successResponse } from '../../shared/response.js';
import type { GuardedInterviewSession } from './interviewGuard.schema.js';
import type { InterviewGuardService } from './interviewGuard.service.js';

/** Bind after authMiddleware in the owning #347 turn route; validate before reserving a turn. */
export function createGuardedInterviewTurnHandler<T>(
  guard: InterviewGuardService,
  validateAnswer: (body: unknown) => T,
  writeAnswer: (session: GuardedInterviewSession, answer: T, transaction: ClientSession) => Promise<unknown>,
) {
  return asyncHandler(async (req: AuthenticatedRequest, res) => {
    if (!req.user?.id) return commonErrors.unauthorized(res);
    const { stateVersion } = z.object({ stateVersion: z.number().int().nonnegative() }).parse(req.body);
    const answer = validateAnswer(req.body);
    const result = await guard.acceptTurn({
      sessionId: z.string().parse(req.params.sessionId), userId: req.user.id, stateVersion,
    }, (session, transaction) => writeAnswer(session, answer, transaction));
    successResponse(res, result);
  });
}
