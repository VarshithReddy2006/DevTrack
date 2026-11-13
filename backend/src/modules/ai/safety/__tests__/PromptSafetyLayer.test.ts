import { describe, it, expect, beforeEach } from 'vitest';
import {
  PromptSafetyLayer,
  MAX_INPUT_LENGTH,
  HOMOGLYPH_MAP,
} from '../PromptSafetyLayer.js';

describe('PromptSafetyLayer - Security & Normalization Hardening', () => {
  beforeEach(() => {
    PromptSafetyLayer.resetPolicies();
  });

  describe('normalizeText', () => {
    it('returns empty string for null, undefined, or empty input', () => {
      // @ts-expect-error testing invalid inputs
      expect(PromptSafetyLayer.normalizeText(null)).toBe('');
      // @ts-expect-error testing invalid inputs
      expect(PromptSafetyLayer.normalizeText(undefined)).toBe('');
      expect(PromptSafetyLayer.normalizeText('')).toBe('');
    });

    it('strips zero-width and invisible characters', () => {
      const zeroWidth = 'g\u200Bu\u200Car\u200Da\uFEFFnteed';
      expect(PromptSafetyLayer.normalizeText(zeroWidth)).toBe('guaranteed');

      const softHyphen = 'def\u00ADinitely';
      expect(PromptSafetyLayer.normalizeText(softHyphen)).toBe('definitely');

      const bidiAndJoiners = '\u202Ayou\u202C \u200Ewill\u200F \u2060get';
      expect(PromptSafetyLayer.normalizeText(bidiAndJoiners)).toBe('you will get');
    });

    it('normalizes Unicode NFKC forms including full-width characters', () => {
      const fullWidth = 'ｇｕａｒａｎｔｅｅｄ';
      expect(PromptSafetyLayer.normalizeText(fullWidth)).toBe('guaranteed');
    });

    it('maps Cyrillic homoglyphs to standard ASCII equivalents', () => {
      // Cyrillic 'а' (\u0430) and 'е' (\u0435)
      const cyrillicWord = 'gu\u0430r\u0430nt\u0435\u0435d';
      expect(PromptSafetyLayer.normalizeText(cyrillicWord)).toBe('guaranteed');

      // Cyrillic 'о' (\u043E) and 'с' (\u0441)
      const cyrillicGoogle = 'G\u043E\u043Egle';
      expect(PromptSafetyLayer.normalizeText(cyrillicGoogle)).toBe('Google');
    });

    it('maps Greek homoglyphs to standard ASCII equivalents', () => {
      // Greek alpha (\u03B1) and epsilon (\u03B5)
      const greekWord = 'gu\u03B1r\u03B1nt\u03B5\u03B5d';
      expect(PromptSafetyLayer.normalizeText(greekWord)).toBe('guaranteed');
    });

    it('decomposes accented variants and strips diacritics', () => {
      const accented = 'guàràntèèd to gét';
      expect(PromptSafetyLayer.normalizeText(accented)).toBe('guaranteed to get');

      const frenchAccent = 'définitely sêcure';
      expect(PromptSafetyLayer.normalizeText(frenchAccent)).toBe('definitely secure');
    });

    it('collapses intra-word punctuation tricks (hyphens, dots, underscores, spaces)', () => {
      expect(PromptSafetyLayer.normalizeText('g-u-a-r-a-n-t-e-e-d')).toBe('guaranteed');
      expect(PromptSafetyLayer.normalizeText('g.u.a.r.a.n.t.e.e.d')).toBe('guaranteed');
      expect(PromptSafetyLayer.normalizeText('g_u_a_r_a_n_t_e_e_d')).toBe('guaranteed');
      expect(PromptSafetyLayer.normalizeText('g u a r a n t e e d to get')).toBe('guaranteed to get');
    });

    it('preserves valid multi-character words with hyphens and legitimate sentences', () => {
      const normalSentence = 'I built a well-designed full-stack application using React and TypeScript.';
      expect(PromptSafetyLayer.normalizeText(normalSentence)).toBe(normalSentence);
    });
  });

  describe('Adversarial Bypass Detection in checkPrompt', () => {
    it('detects zero-width space bypasses in hiring guarantees', () => {
      const prompt = 'You are g\u200Bu\u200Car\u200Da\uFEFFnteed to get the job';
      const result = PromptSafetyLayer.checkPrompt(prompt);
      expect(result.safe).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]).toContain('Prohibit hiring/placement guarantees');
    });

    it('detects Cyrillic homoglyph bypasses in salary promises', () => {
      // 'а' in guaranteed is Cyrillic \u0430
      const prompt = 'gu\u0430r\u0430nteed 20 LPA package';
      const result = PromptSafetyLayer.checkPrompt(prompt);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('Prohibit salary guarantees'))).toBe(true);
    });

    it('detects Greek homoglyph bypasses in company placement promises', () => {
      // 'о' in Google is Greek omicron \u03BF
      const prompt = 'You will definitely get G\u03BF\u03BFgle';
      const result = PromptSafetyLayer.checkPrompt(prompt);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('Prohibit company-specific placement promises'))).toBe(true);
    });

    it('detects accented character bypasses in guarantees', () => {
      const prompt = 'You are cèrtàin to lànd Google';
      const result = PromptSafetyLayer.checkPrompt(prompt);
      expect(result.safe).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    it('detects intra-word punctuation bypasses', () => {
      const prompt = 'You will d-e-f-i-n-i-t-e-l-y get the position';
      const result = PromptSafetyLayer.checkPrompt(prompt);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('Prohibit hiring/placement guarantees'))).toBe(true);
    });

    it('passes legitimate developer questions and portfolio text', () => {
      const safePrompt = 'How should I structure my Redis distributed cache project to showcase system design?';
      const result = PromptSafetyLayer.checkPrompt(safePrompt);
      expect(result.safe).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('Adversarial Bypass Detection in checkResponse', () => {
    it('detects homoglyphs and blocks unsafe model responses', () => {
      const response = 'You will d\u0435finitely l\u0430nd Amazon next month.';
      const result = PromptSafetyLayer.checkResponse(response);
      expect(result.safe).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    it('filters warning-level policies with homoglyphs in response', () => {
      // Cyrillic 'е' in 'feel'
      const response = 'You should f\u0435el proud of your work!';
      const result = PromptSafetyLayer.checkResponse(response);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Prohibit emotional manipulation');
    });
  });

  describe('Oversized Payload & ReDoS Guards', () => {
    it('rejects oversized prompts exceeding MAX_INPUT_LENGTH before regex processing', () => {
      const oversizedPrompt = 'a'.repeat(MAX_INPUT_LENGTH + 100);
      const result = PromptSafetyLayer.checkPrompt(oversizedPrompt);

      expect(result.safe).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain('Payload length exceeds maximum safe limit');
    });

    it('rejects oversized responses exceeding MAX_INPUT_LENGTH before regex processing', () => {
      const oversizedResponse = 'b'.repeat(MAX_INPUT_LENGTH + 500);
      const result = PromptSafetyLayer.checkResponse(oversizedResponse);

      expect(result.safe).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain('Response length exceeds maximum safe limit');
      expect(result.filteredContent).toBeUndefined();
    });

    it('treats oversized content as prohibited in containsProhibitedPatterns', () => {
      const oversizedContent = 'c'.repeat(MAX_INPUT_LENGTH + 1);
      expect(PromptSafetyLayer.containsProhibitedPatterns(oversizedContent)).toBe(true);
    });

    it('truncates oversized prompts in sanitizePrompt', () => {
      const oversizedPrompt = 'safe content '.repeat(5000);
      expect(oversizedPrompt.length).toBeGreaterThan(MAX_INPUT_LENGTH);

      const sanitized = PromptSafetyLayer.sanitizePrompt(oversizedPrompt);
      expect(sanitized.length).toBeLessThanOrEqual(MAX_INPUT_LENGTH);
    });

    it('evaluates large strings under the limit within bounded performance budgets', () => {
      const largeSafeText = 'Experienced in TypeScript, Node.js, and cloud platforms. '.repeat(500);
      expect(largeSafeText.length).toBeLessThan(MAX_INPUT_LENGTH);

      const startTime = performance.now();
      const result = PromptSafetyLayer.checkPrompt(largeSafeText);
      const durationMs = performance.now() - startTime;

      expect(result.safe).toBe(true);
      // Processing 28,000 chars should take well under 100ms
      expect(durationMs).toBeLessThan(150);
    });
  });

  describe('containsProhibitedPatterns', () => {
    it('identifies critical prohibited patterns with homoglyph obfuscation', () => {
      const obfuscated = 'You are gu\u0430r\u0430nteed to get a job';
      expect(PromptSafetyLayer.containsProhibitedPatterns(obfuscated)).toBe(true);
    });

    it('returns false for safe technical text', () => {
      const safeText = 'Implemented Redis Pub/Sub for distributed cache synchronization';
      expect(PromptSafetyLayer.containsProhibitedPatterns(safeText)).toBe(false);
    });

    it('handles null, undefined, and empty string safely', () => {
      // @ts-expect-error testing invalid inputs
      expect(PromptSafetyLayer.containsProhibitedPatterns(null)).toBe(false);
      // @ts-expect-error testing invalid inputs
      expect(PromptSafetyLayer.containsProhibitedPatterns(undefined)).toBe(false);
      expect(PromptSafetyLayer.containsProhibitedPatterns('')).toBe(false);
    });
  });

  describe('Guardrails and Policy Management', () => {
    it('appends strict guardrails to system prompts', () => {
      const systemPrompt = 'Base system prompt instructions.';
      const promptWithGuardrails = PromptSafetyLayer.addGuardrails(systemPrompt);

      expect(promptWithGuardrails).toContain('STRICT SAFETY GUARDRAILS:');
      expect(promptWithGuardrails).toContain('You MUST NOT make hiring, placement, or salary guarantees');
      expect(promptWithGuardrails.startsWith(systemPrompt)).toBe(true);
    });

    it('allows adding and removing custom policies', () => {
      PromptSafetyLayer.addPolicy({
        id: 'no-secret-keys',
        description: 'Prohibit secret keys',
        patterns: [/secret-api-key-[0-9]+/gi],
        severity: 'critical',
        action: 'block',
      });

      const check = PromptSafetyLayer.checkPrompt('My token is secret-api-key-999');
      expect(check.safe).toBe(false);
      expect(check.violations.some((v) => v.includes('Prohibit secret keys'))).toBe(true);

      PromptSafetyLayer.removePolicy('no-secret-keys');
      const checkAfterRemoval = PromptSafetyLayer.checkPrompt('My token is secret-api-key-999');
      expect(checkAfterRemoval.safe).toBe(true);
    });

    it('resets policies to default list', () => {
      PromptSafetyLayer.addPolicy({
        id: 'temp-policy',
        description: 'Temp',
        patterns: [/test-forbidden/gi],
        severity: 'critical',
        action: 'block',
      });
      expect(PromptSafetyLayer.getPolicies().some((p) => p.id === 'temp-policy')).toBe(true);

      PromptSafetyLayer.resetPolicies();
      expect(PromptSafetyLayer.getPolicies().some((p) => p.id === 'temp-policy')).toBe(false);
      expect(PromptSafetyLayer.getPolicies()).toHaveLength(8);
    });
  });
});
