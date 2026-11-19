import { describe, expect, it } from 'vitest';
import { publishProfileSchema } from './publication.schemas.js';

const base = {
  slug: 'developer',
  sections: { streak: true },
  consentVersion: '2026-11',
};

describe('publishProfileSchema portfolio settings', () => {
  it('accepts all supported themes and a complete unique section order', () => {
    const result = publishProfileSchema.safeParse({
      ...base,
      settings: {
        theme: 'terminal-monospace',
        sectionOrder: ['activity', 'projects', 'github', 'dsa', 'streak'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown themes and duplicate or invalid section orders', () => {
    expect(publishProfileSchema.safeParse({
      ...base,
      settings: { theme: 'neon', sectionOrder: ['streak', 'dsa', 'github', 'projects', 'activity'] },
    }).success).toBe(false);
    expect(publishProfileSchema.safeParse({
      ...base,
      settings: { theme: 'modern-dark', sectionOrder: ['streak', 'streak', 'github', 'projects', 'activity'] },
    }).success).toBe(false);
    expect(publishProfileSchema.safeParse({
      ...base,
      settings: { theme: 'modern-dark', sectionOrder: ['streak', 'dsa', 'github', 'projects', 'other'] },
    }).success).toBe(false);
  });

  it('keeps settings optional for legacy publication payloads', () => {
    expect(publishProfileSchema.safeParse(base).success).toBe(true);
  });
});
