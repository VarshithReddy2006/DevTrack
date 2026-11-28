import { describe, it, expect, beforeEach } from 'vitest';
import { PromptSafetyLayer, MAX_INPUT_LENGTH } from '../safety/PromptSafetyLayer.js';

describe('PromptSafetyLayer adjacent spaced words', () => {
  beforeEach(() => {
    PromptSafetyLayer.resetPolicies();
  });

  it('collapses both words of "you w-i-l-l g-e-t into Google" and blocks it', () => {
    const text = 'you w-i-l-l g-e-t into Google';

    expect(PromptSafetyLayer.normalizeText(text)).toBe('you will get into Google');
    expect(PromptSafetyLayer.containsProhibitedPatterns(text)).toBe(true);
    for (const result of [PromptSafetyLayer.checkPrompt(text), PromptSafetyLayer.checkResponse(text)]) {
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('company-specific placement promises'))).toBe(true);
    }
  });

  it.each([
    ['g.u.a.r.a.n.t.e.e.d t.o g.e.t', 'guaranteed to get'],
    ['g_u_a_r_a_n_t_e_e_d s_a_l_a_r_y', 'guaranteed salary'],
    ['w-i-l-l d.e.f.i.n.i.t.e.l.y g_e_t', 'will definitely get'],
    ['g-u-a-r-a-n-t-e-e-d\nt-o\tg-e-t', 'guaranteed\nto\tget'],
    ['w i l l g-e-t', 'will get'],
  ])('keeps the word breaks in %j', (input, expected) => {
    expect(PromptSafetyLayer.normalizeText(input)).toBe(expected);
  });

  it('still detects one word split with a mix of spaces and punctuation', () => {
    expect(PromptSafetyLayer.checkPrompt('g-u a-r a-n-t-e-e-d to get it').safe).toBe(false);
  });

  it('leaves ordinary text with hyphens, dots and single letters unchanged', () => {
    const text = 'A well-designed API, e.g. a plan B for the v2.0 end-to-end tests (x-ray).';

    expect(PromptSafetyLayer.normalizeText(text)).toBe(text);
    expect(PromptSafetyLayer.checkPrompt(text)).toEqual({ safe: true, violations: [], warnings: [] });
    expect(PromptSafetyLayer.sanitizePrompt(text)).toBe(text);
  });

  it('does not treat a longer word starting with a company name as a promise', () => {
    expect(PromptSafetyLayer.checkPrompt('Here you will get into metaprogramming').safe).toBe(true);
  });

  it('keeps the company promise pattern after resetPolicies', () => {
    PromptSafetyLayer.resetPolicies();

    expect(PromptSafetyLayer.checkPrompt('You will get into Amazon').safe).toBe(false);
  });
});

describe('PromptSafetyLayer redaction of obfuscated phrases', () => {
  beforeEach(() => {
    PromptSafetyLayer.resetPolicies();
  });

  it.each([
    ['a Cyrillic homoglyph', 'You should f\u0435el proud'],
    ['combining diacritics', 'You should fe\u0301e\u0300l proud'],
    ['a Cyrillic homoglyph with a combining diacritic', 'You should f\u0435\u0300el pr\u043E\u0301ud'],
    ['a precomposed accented Cyrillic letter', 'You should f\u0450el proud'],
    ['full-width letters', 'You should ｆｅｅｌ proud'],
    ['zero-width characters', 'You should f\u200Be\u200Del pro\u2060ud'],
    ['spaced words', 'You s-h-o-u-l-d f-e-e-l p-r-o-u-d'],
    ['spaced letters', 'You should f e e l proud'],
    ['mixed separators', 'You should f-e e-l proud'],
  ])('filters a warning phrase hidden with %s', (_label, phrase) => {
    const result = PromptSafetyLayer.checkResponse(`Nice work. ${phrase} of this project.`);

    expect(result.warnings.some((w) => w.includes('emotional manipulation'))).toBe(true);
    expect(result.filteredContent).toBe('Nice work. [FILTERED] of this project.');
  });

  it('keeps the surrounding raw text, including emoji and accents, byte for byte', () => {
    const response = 'Café 🚀 plan: s-t-a-n-d out to recruiters | then ship it. Résumé 😀 done.';

    expect(PromptSafetyLayer.checkResponse(response).filteredContent).toBe(
      'Café 🚀 plan: [FILTERED] | then ship it. Résumé 😀 done.'
    );
  });

  it('redacts a trailing diacritic together with the phrase', () => {
    const result = PromptSafetyLayer.checkResponse('I am 100% certain\u0301!');

    expect(result.filteredContent).toBe('I am [FILTERED]!');
  });

  it('filters every occurrence, plain and obfuscated, across policies', () => {
    const result = PromptSafetyLayer.checkResponse(
      "Don't worry about it. D\u043En't w\u043Erry ab\u043Eut that. You are \u0435xp\u0435rt at Go."
    );

    expect(result.filteredContent).toBe('[FILTERED] it. [FILTERED] that. [FILTERED] Go.');
  });

  it('merges overlapping matches into one marker', () => {
    PromptSafetyLayer.addPolicy({
      id: 'overlap',
      description: 'Overlap',
      patterns: [/ship it now/gi, /it now please/gi],
      severity: 'warning',
      action: 'filter',
    });

    expect(PromptSafetyLayer.checkResponse('ok s-h-i-p it now please ok').filteredContent).toBe('ok [FILTERED] ok');
  });

  it('redacts everything when a matching pattern has no range to cut', () => {
    PromptSafetyLayer.addPolicy({
      id: 'lookahead-only',
      description: 'Zero-length match',
      patterns: [/(?=secret plan)/gi],
      severity: 'warning',
      action: 'filter',
    });

    expect(PromptSafetyLayer.checkResponse('the s-e-c-r-e-t p-l-a-n').filteredContent).toBe('[FILTERED]');
  });

  it('returns clean responses untouched', () => {
    const result = PromptSafetyLayer.checkResponse('Add an index on userId before shipping.');

    expect(result).toEqual({ safe: true, violations: [], warnings: [], filteredContent: undefined });
  });

  it('sanitizes obfuscated phrases in prompts and leaves the rest alone', () => {
    const prompt = 'Résumé note: you are gu\u0430rànteed t-o g-e-t it, so d\u043En\'t w-o-r-r-y about tests 🚀';
    const sanitized = PromptSafetyLayer.sanitizePrompt(prompt);

    expect(sanitized).toBe('Résumé note: you are [FILTERED] it, so [FILTERED] tests 🚀');
  });

  it('sanitizes adjacent spaced words', () => {
    expect(PromptSafetyLayer.sanitizePrompt('Trust me, you w-i-l-l g-e-t into Google.')).toBe(
      'Trust me, [FILTERED].'
    );
  });

  it('handles a maximum-length obfuscated input quickly', () => {
    const input = 'a-b-c d '.repeat(MAX_INPUT_LENGTH / 8);
    const startTime = performance.now();

    PromptSafetyLayer.checkResponse(input);
    PromptSafetyLayer.sanitizePrompt(input);

    expect(performance.now() - startTime).toBeLessThan(1000);
  });
});
