// Request schemas for profile publication. packages/contracts does not exist yet, so they live
// next to the controller; move them there once the shared contracts package lands.
import { z } from 'zod';
import { PUBLIC_PROFILE_SECTIONS } from '../../db/models/publicProfile.model.js';
import { SLUG_PATTERN } from '../../db/models/usernameReservation.model.js';

export const publishProfileSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(
    SLUG_PATTERN,
    'Use 3-30 lowercase letters, numbers or hyphens, starting and ending with a letter or number',
  ),
  // Every section is opt-in: anything not listed stays hidden.
  sections: z.object(
    Object.fromEntries(PUBLIC_PROFILE_SECTIONS.map(section => [section, z.boolean().optional()])),
  ).strict(),
  consentVersion: z.string().trim().regex(/^[A-Za-z0-9._-]{1,32}$/, 'Invalid consent version'),
  settings: z.object({
    theme: z.enum(['modern-dark', 'clean-minimal-light', 'monokai-hacker', 'terminal-monospace']),
    sectionOrder: z.array(z.enum(PUBLIC_PROFILE_SECTIONS)).length(PUBLIC_PROFILE_SECTIONS.length),
  }).refine(({ sectionOrder }) => new Set(sectionOrder).size === PUBLIC_PROFILE_SECTIONS.length, {
    message: 'Section order must contain each supported section exactly once',
    path: ['sectionOrder'],
  }).optional(),
});

export type PublishProfileInput = z.infer<typeof publishProfileSchema>;
