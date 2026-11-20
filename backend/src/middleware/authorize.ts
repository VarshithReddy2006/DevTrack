// src/middleware/authorize.ts — route guard backed by the central policy engine.
//
//   router.patch('/:id', authMiddleware, authorize('update', 'ResumeProfile', { load: loadResume }), handler)
//
// Role-only rules are decided without a lookup. Rules that depend on resource attributes call the
// supplied loader once with the id from the route, and the loaded attributes are left on
// req.authorizedResource so the handler does not fetch them again.
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { commonErrors } from '../shared/response.js';
import { policyEngine as defaultEngine, type Action, type PolicyEngine, type ResourceAttrs } from '../shared/auth/policyEngine.js';

export interface AuthorizeOptions {
  /** Loads resource attributes by id. Return null when it does not exist. */
  load?: (id: string, req: AuthenticatedRequest) => Promise<ResourceAttrs | null>;
  /** Route param holding the resource id. Defaults to 'id'. */
  param?: string;
  engine?: PolicyEngine;
  /** Called on every denial, for intrusion monitoring. Must not throw. */
  onDeny?: (info: { userId?: string; role?: string; action: Action; resource: string; resourceId?: string; reason: string; path: string }) => void;
}

export type AuthorizedRequest = AuthenticatedRequest & { authorizedResource?: ResourceAttrs };

export function authorize(action: Action, resource: string, options: AuthorizeOptions = {}) {
  const engine = options.engine ?? defaultEngine;
  const param = options.param ?? 'id';

  const deny = (req: AuthenticatedRequest, res: Response, reason: string, resourceId?: string): void => {
    try {
      options.onDeny?.({ userId: req.user?.id, role: req.user?.role, action, resource, resourceId, reason, path: req.originalUrl ?? req.url });
    } catch {
      // auditing must never turn a 403 into a 500
    }
    commonErrors.forbidden(res);
  };

  return async (req: AuthorizedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      commonErrors.unauthorized(res);
      return;
    }
    const raw = req.params?.[param];
    const resourceId = typeof raw === 'string' ? raw : undefined;

    try {
      let attrs: ResourceAttrs = {};
      if (engine.needsResource(req.user.role, action, resource) && options.load && resourceId) {
        const loaded = await options.load(resourceId, req);
        // Same answer for "missing" and "not yours", so ids cannot be probed.
        if (!loaded) return deny(req, res, 'resource_not_found', resourceId);
        attrs = loaded;
        req.authorizedResource = loaded;
      }
      const decision = engine.evaluate(req.user, action, resource, attrs);
      if (!decision.allowed) return deny(req, res, decision.reason, resourceId);
      next();
    } catch {
      deny(req, res, 'policy_error', resourceId);
    }
  };
}
