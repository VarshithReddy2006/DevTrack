// src/modules/interview/interview.controller.ts — HTTP layer of the mock interview (/api/v1/interviews).
import type { Response } from 'express';
import { z } from 'zod';
import { INTERVIEW_ANSWER_MAX_LENGTH } from '../../db/models/interviewSession.model.js';
import { asyncHandler } from '../../middleware/error.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { InterviewGuardError } from './interviewGuard.service.js';
import { commonErrors, errorResponse, successResponse } from '../../shared/response.js';
import { getInterviewService, OpenSessionExistsError, type InterviewService } from './interview.service.js';
import { INTERVIEW_ROLES } from './questionBank/index.js';
import { InterviewError } from './stateMachine.js';

const stateVersion = z.number().int().nonnegative();
const turnIndex = z.coerce.number().int().min(0).max(4);

const startSchema = z.object({ role: z.enum(INTERVIEW_ROLES) }).strict();
const answerSchema = z.object({
  answer: z.string().trim().min(1, 'Answer cannot be empty').max(INTERVIEW_ANSWER_MAX_LENGTH),
  code: z.string().max(16_000).nullish(),
  stateVersion,
}).strict();
const versionSchema = z.object({ stateVersion }).strict();

function validationFailure(res: Response, error: z.ZodError): void {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) (details[issue.path.join('.') || '_root'] ??= []).push(issue.message);
  commonErrors.validationError(res, details);
}

/** Domain errors become their own status and code; everything else goes to the error middleware. */
function respondWithDomainError(res: Response, error: unknown): boolean {
  if (error instanceof OpenSessionExistsError) {
    // 409 that also carries the open session, so the client can resume it.
    res.status(409).json({
      success: false, message: error.message, code: error.code.toUpperCase(), statusCode: 409,
      timestamp: new Date().toISOString(), data: error.data,
    });
    return true;
  }
  if (error instanceof InterviewError || error instanceof InterviewGuardError) {
    errorResponse(res, error.message, error.code.toUpperCase(), error.statusCode);
    return true;
  }
  return false;
}

export function createInterviewController(service: () => InterviewService = getInterviewService) {
  const handle = (
    action: (req: AuthenticatedRequest, res: Response, userId: string) => Promise<void>,
  ) => asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return commonErrors.unauthorized(res);
    try {
      await action(req, res, userId);
    } catch (error) {
      if (error instanceof z.ZodError) return validationFailure(res, error);
      if (!respondWithDomainError(res, error)) throw error;
    }
  });

  return {
    start: handle(async (req, res, userId) => {
      const { role } = startSchema.parse(req.body);
      successResponse(res, await service().createSession(userId, role), 'Interview started', 201);
    }),
    current: handle(async (_req, res, userId) => {
      successResponse(res, await service().getCurrentSession(userId), 'Current interview retrieved');
    }),
    get: handle(async (req, res, userId) => {
      successResponse(res, await service().getSession(userId, String(req.params.sessionId)), 'Interview retrieved');
    }),
    answer: handle(async (req, res, userId) => {
      const body = answerSchema.parse(req.body);
      const view = await service().submitAnswer(userId, String(req.params.sessionId), {
        turnIndex: turnIndex.parse(req.params.turnIndex), answer: body.answer, code: body.code, stateVersion: body.stateVersion,
      });
      successResponse(res, view, 'Answer accepted', 202);
    }),
    hint: handle(async (req, res, userId) => {
      const body = versionSchema.parse(req.body);
      const view = await service().requestHint(userId, String(req.params.sessionId), {
        turnIndex: turnIndex.parse(req.params.turnIndex), stateVersion: body.stateVersion,
      });
      successResponse(res, view, 'Hint revealed');
    }),
    finish: handle(async (req, res, userId) => {
      const body = versionSchema.parse(req.body);
      successResponse(res, await service().finishSession(userId, String(req.params.sessionId), body), 'Interview finished');
    }),
  };
}
