import { describe, expect, it } from 'vitest';
import { normalizeSlug, validateSlug } from './slug';

describe('validateSlug', () => {
  it.each(['abc', 'jane-doe', 'a1b', 'x'.repeat(30), '007'])('accepts %s', (slug) => {
    expect(validateSlug(slug)).toEqual({ valid: true });
  });

  it.each([
    ['', /Pick a handle/],
    ['ab', /at least 3/],
    ['x'.repeat(31), /at most 30/],
    ['-jane', /lowercase letters/],
    ['jane-', /lowercase letters/],
    ['jane_doe', /lowercase letters/],
    ['jane doe', /lowercase letters/],
    ['jané', /lowercase letters/],
  ])('rejects %j', (slug, message) => {
    const result = validateSlug(slug);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.message).toMatch(message);
  });

  it('lowercases and trims first, like the server does', () => {
    expect(normalizeSlug('  JaneDoe ')).toBe('janedoe');
    expect(validateSlug('  JaneDoe ')).toEqual({ valid: true });
  });
});
