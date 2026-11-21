import { describe, expect, it, vi } from 'vitest';
import { PolicyEngine, policyEngine } from '../../../shared/auth/policyEngine.js';
import { ROLES } from '../../../shared/auth/roles.js';
import { authorize } from '../../../middleware/authorize.js';

const alice = { id: 'alice', role: 'user' };
const bob = { id: 'bob', role: 'user' };

describe('PolicyEngine', () => {
  it('lets owners manage their own resume and nobody else', () => {
    expect(policyEngine.can(alice, 'update', 'ResumeProfile', { userId: 'alice' })).toBe(true);
    expect(policyEngine.can(bob, 'update', 'ResumeProfile', { userId: 'alice' })).toBe(false);
    expect(policyEngine.can(bob, 'read', 'ResumeProfile', { userId: 'alice' })).toBe(false);
    expect(policyEngine.can(bob, 'delete', 'EvidenceClaim', { userId: 'alice' })).toBe(false);
  });

  it('denies cross-tenant access for every role without a specific rule (IDOR)', () => {
    for (const role of ROLES.filter((r) => r !== 'admin')) {
      expect(policyEngine.can({ id: 'mallory', role }, 'read', 'ResumeProfile', { userId: 'alice' })).toBe(false);
    }
  });

  it('only shows unpublished profiles to their owner', () => {
    expect(policyEngine.can(bob, 'read', 'PublicProfile', { userId: 'alice', isPublished: true })).toBe(true);
    expect(policyEngine.can(bob, 'read', 'PublicProfile', { userId: 'alice', isPublished: false })).toBe(false);
    expect(policyEngine.can(alice, 'read', 'PublicProfile', { userId: 'alice', isPublished: false })).toBe(true);
    expect(policyEngine.can(bob, 'read', 'PublicProfile', { userId: 'alice', isPublished: 'true' })).toBe(false);
  });

  it('gives recruiters dossiers only for opted-in, published candidates', () => {
    const recruiter = { id: 'r1', role: 'recruiter' };
    expect(policyEngine.can(recruiter, 'read', 'Dossier', { userId: 'alice', isPublished: true, recruiterOptIn: true })).toBe(true);
    expect(policyEngine.can(recruiter, 'read', 'Dossier', { userId: 'alice', isPublished: true, recruiterOptIn: false })).toBe(false);
    expect(policyEngine.can(recruiter, 'read', 'Dossier', { userId: 'alice', isPublished: false, recruiterOptIn: true })).toBe(false);
    expect(policyEngine.can(bob, 'read', 'Dossier', { userId: 'alice', isPublished: true, recruiterOptIn: true })).toBe(false);
  });

  it('keeps moderators out of credentials but lets them moderate audit logs', () => {
    const mod = { id: 'm1', role: 'moderator' };
    expect(policyEngine.can(mod, 'moderate', 'ProfileAuditLog')).toBe(true);
    expect(policyEngine.can(mod, 'update', 'UserCredential')).toBe(false);
    expect(policyEngine.can(alice, 'moderate', 'ProfileAuditLog')).toBe(false);
    expect(policyEngine.can({ id: 'a', role: 'admin' }, 'update', 'UserCredential')).toBe(true);
  });

  it('denies unknown roles, missing subjects, unknown resources and unknown actions', () => {
    expect(policyEngine.can({ id: 'x', role: 'superuser' }, 'read', 'PublicProfile', { isPublished: true })).toBe(false);
    expect(policyEngine.can(undefined, 'read', 'PublicProfile', { isPublished: true })).toBe(false);
    expect(policyEngine.can({ id: '', role: 'user' }, 'read', 'PublicProfile', { isPublished: true })).toBe(false);
    expect(policyEngine.can(alice, 'read', 'Mystery', {})).toBe(false);
    expect(policyEngine.evaluate(alice, 'read', 'Mystery').reason).toBe('no_matching_rule');
    expect(policyEngine.evaluate(bob, 'update', 'ResumeProfile', { userId: 'alice' }).reason).toBe('condition_failed');
  });

  it('treats a condition that throws as a denial', () => {
    const engine = new PolicyEngine([
      { roles: ['user'], actions: ['read'], resource: 'Boom', when: () => { throw new Error('bad attrs'); } },
    ]);
    expect(engine.can(alice, 'read', 'Boom', {})).toBe(false);
  });

  it('reports whether a lookup is needed', () => {
    expect(policyEngine.needsResource('user', 'update', 'ResumeProfile')).toBe(true);
    expect(policyEngine.needsResource('moderator', 'moderate', 'ProfileAuditLog')).toBe(false);
    expect(policyEngine.needsResource('user', 'create', 'ResumeProfile')).toBe(false);
    expect(policyEngine.roleCan('user', 'moderate', 'ProfileAuditLog')).toBe(false);
    expect(policyEngine.roleCan('nonsense', 'read', 'PublicProfile')).toBe(false);
  });
});

function run(mw: ReturnType<typeof authorize>, req: Record<string, unknown>) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  return mw(req as never, res as never, next).then(() => ({ res, next }));
}

describe('authorize middleware', () => {
  const load = vi.fn(async (id: string) => (id === 'r1' ? { userId: 'alice' } : null));

  it('returns 401 when nobody is signed in', async () => {
    const { res, next } = await run(authorize('update', 'ResumeProfile', { load }), { params: { id: 'r1' } });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets the owner through and exposes the loaded resource', async () => {
    const req: Record<string, unknown> = { user: alice, params: { id: 'r1' } };
    const { next } = await run(authorize('update', 'ResumeProfile', { load }), req);
    expect(next).toHaveBeenCalledOnce();
    expect(req.authorizedResource).toEqual({ userId: 'alice' });
  });

  it('returns 403 for someone else and reports the denial', async () => {
    const onDeny = vi.fn();
    const { res, next } = await run(authorize('update', 'ResumeProfile', { load, onDeny }), { user: bob, params: { id: 'r1' }, originalUrl: '/resumes/r1' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(onDeny).toHaveBeenCalledWith(expect.objectContaining({ userId: 'bob', action: 'update', resource: 'ResumeProfile', resourceId: 'r1', reason: 'condition_failed' }));
  });

  it('answers 403 (not 404) for a missing resource so ids cannot be probed', async () => {
    const { res } = await run(authorize('read', 'ResumeProfile', { load }), { user: alice, params: { id: 'nope' } });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('skips the lookup for role-only rules', async () => {
    const loader = vi.fn();
    const { next } = await run(authorize('moderate', 'ProfileAuditLog', { load: loader }), { user: { id: 'm1', role: 'moderator' }, params: { id: 'x' } });
    expect(next).toHaveBeenCalledOnce();
    expect(loader).not.toHaveBeenCalled();
  });

  it('fails closed when the loader throws, and a throwing onDeny does not change the answer', async () => {
    const mw = authorize('read', 'ResumeProfile', {
      load: async () => { throw new Error('db down'); },
      onDeny: () => { throw new Error('logger down'); },
    });
    const { res, next } = await run(mw, { user: alice, params: { id: 'r1' } });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('denies when an attribute rule has no id to load', async () => {
    const { res } = await run(authorize('update', 'ResumeProfile', { load }), { user: alice, params: {} });
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
