// src/shared/auth/roles.ts — roles and the declarative permission matrix.
//
// Each rule says: a subject with one of these roles may do this action on this resource type,
// optionally only when the condition holds. Rules only ever grant; anything not granted is denied.
import type { PolicyRule } from './policyEngine.js';

export const ROLES = ['user', 'contributor', 'mentor', 'recruiter', 'moderator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Anyone signed in can act as these. Roles above `user` keep the owner permissions too. */
const SIGNED_IN: Role[] = [...ROLES];

const owns = (s: { id: string }, r: Record<string, unknown>): boolean => typeof r.userId === 'string' && r.userId === s.id;

export const DEFAULT_RULES: PolicyRule[] = [
  // Candidates manage their own material.
  { roles: SIGNED_IN, actions: ['read', 'update', 'delete'], resource: 'ResumeProfile', when: owns },
  { roles: SIGNED_IN, actions: ['create'], resource: 'ResumeProfile' },
  { roles: SIGNED_IN, actions: ['read', 'update', 'delete'], resource: 'EvidenceClaim', when: owns },
  { roles: SIGNED_IN, actions: ['create'], resource: 'EvidenceClaim' },

  // Published profiles are readable by any signed-in user; unpublished ones only by their owner.
  { roles: SIGNED_IN, actions: ['read'], resource: 'PublicProfile', when: (_s, r) => r.isPublished === true },
  { roles: SIGNED_IN, actions: ['read', 'update'], resource: 'PublicProfile', when: owns },

  // Recruiters see verified dossiers only for people who opted in to recruiter discovery.
  { roles: ['recruiter'], actions: ['read'], resource: 'Dossier', when: (_s, r) => r.recruiterOptIn === true && r.isPublished === true },
  { roles: SIGNED_IN, actions: ['read'], resource: 'Dossier', when: owns },

  // Moderators review anti-gaming reports. They get no write access to user credentials.
  { roles: ['moderator', 'admin'], actions: ['read', 'moderate'], resource: 'ProfileAuditLog' },

  // Admins can do everything on these.
  { roles: ['admin'], actions: ['read', 'update', 'delete', 'create', 'moderate'], resource: 'UserCredential' },
];
