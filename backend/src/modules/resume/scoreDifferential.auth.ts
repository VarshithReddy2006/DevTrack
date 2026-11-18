import { verifyToken } from '@clerk/backend';
import type { RequestHandler } from 'express';
import { commonErrors } from '../../shared/response.js';

// This endpoint accepts only caller-provided text and needs no local user record.
// Keep normal Clerk session verification without the Mongo user lookup/sync.
export const authenticateScoreDifferential: RequestHandler = async (req, res, next) => {
  const match = req.get('authorization')?.match(/^Bearer (\S+)$/);
  const jwtKey = process.env.CLERK_JWT_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!match || (!jwtKey && !secretKey)) { commonErrors.unauthorized(res); return; }
  try {
    const parties = process.env.CORS_ORIGIN?.split(',').map(origin => origin.trim()).filter(Boolean);
    const payload = await verifyToken(match[1], {
      ...(jwtKey ? { jwtKey } : { secretKey }),
      ...(parties?.length ? { authorizedParties: parties } : {}),
    });
    if (!payload.sub || !payload.sid) { commonErrors.unauthorized(res); return; }
  } catch {
    commonErrors.unauthorized(res);
    return;
  }
  next();
};
