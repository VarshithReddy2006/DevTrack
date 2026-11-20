// src/shared/auth/policyEngine.ts — evaluates declarative authorization rules.
//
// Default deny. A request is allowed when at least one rule matches the subject's role, the action,
// the resource type, and its condition (if any) holds for the subject and the resource's attributes.
// Pure and synchronous: role-only checks never touch the database. Resource attributes are loaded
// once by the caller (see authorize.ts) and passed in.
import { DEFAULT_RULES, isRole, type Role } from './roles.js';

export type Action = 'create' | 'read' | 'update' | 'delete' | 'moderate';

export interface Subject {
  id: string;
  role: string;
}

export type ResourceAttrs = Record<string, unknown>;

export interface PolicyRule {
  roles: Role[];
  actions: Action[];
  /** Resource type, e.g. 'ResumeProfile'. */
  resource: string;
  /** Attribute condition. Omit for a rule that depends on role only. */
  when?: (subject: Subject, resource: ResourceAttrs) => boolean;
}

export interface Decision {
  allowed: boolean;
  /** The first rule that granted access, or why nothing did. */
  reason: 'granted' | 'unknown_role' | 'no_matching_rule' | 'condition_failed';
}

export class PolicyEngine {
  constructor(private readonly rules: PolicyRule[] = DEFAULT_RULES) {}

  /** True when this role could ever perform the action on the resource type, ignoring attributes. */
  roleCan(role: string, action: Action, resource: string): boolean {
    if (!isRole(role)) return false;
    return this.rules.some((r) => r.resource === resource && r.actions.includes(action) && r.roles.includes(role));
  }

  /** True when the role's matching rules all depend on attributes, so a resource must be loaded first. */
  needsResource(role: string, action: Action, resource: string): boolean {
    if (!isRole(role)) return false;
    const matching = this.rules.filter((r) => r.resource === resource && r.actions.includes(action) && r.roles.includes(role));
    return matching.length > 0 && matching.every((r) => r.when);
  }

  evaluate(subject: Subject | undefined, action: Action, resource: string, attrs: ResourceAttrs = {}): Decision {
    if (!subject || !subject.id || !isRole(subject.role)) return { allowed: false, reason: 'unknown_role' };
    const matching = this.rules.filter((r) => r.resource === resource && r.actions.includes(action) && r.roles.includes(subject.role as Role));
    if (matching.length === 0) return { allowed: false, reason: 'no_matching_rule' };
    for (const rule of matching) {
      let ok = true;
      if (rule.when) {
        try {
          ok = rule.when(subject, attrs) === true;
        } catch {
          ok = false; // a condition that throws never grants access
        }
      }
      if (ok) return { allowed: true, reason: 'granted' };
    }
    return { allowed: false, reason: 'condition_failed' };
  }

  can(subject: Subject | undefined, action: Action, resource: string, attrs: ResourceAttrs = {}): boolean {
    return this.evaluate(subject, action, resource, attrs).allowed;
  }
}

export const policyEngine = new PolicyEngine();
