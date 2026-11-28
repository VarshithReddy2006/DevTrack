import { logger } from '../../../shared/logger.js';

export interface SafetyCheckResult {
  safe: boolean;
  violations: string[];
  warnings: string[];
  filteredContent?: string;
}

export interface SafetyPolicy {
  id: string;
  description: string;
  patterns: RegExp[];
  severity: 'critical' | 'warning' | 'info';
  action: 'block' | 'filter' | 'warn';
}

/** Maximum safe input length before regex processing to prevent ReDoS / event loop starvation */
export const MAX_INPUT_LENGTH = 50_000;

/** Regular expression for stripping zero-width, non-printing, and invisible formatting characters */
const INVISIBLE_AND_ZERO_WIDTH_REGEX = /[\u200B-\u200D\uFEFF\u00AD\u2060\u200E\u200F\u202A-\u202E\u2061-\u2064]/;

/** Combining diacritics left over after NFKD decomposition */
const COMBINING_DIACRITICS_REGEX = /[\u0300-\u036f]/g;

/** Homoglyph substitution map for Cyrillic, Greek, and other script lookalikes */
export const HOMOGLYPH_MAP: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic lowercase
  '\u0430': 'a', // Cyrillic Small Letter A
  '\u0435': 'e', // Cyrillic Small Letter Ie
  '\u043E': 'o', // Cyrillic Small Letter O
  '\u0440': 'p', // Cyrillic Small Letter Er
  '\u0441': 'c', // Cyrillic Small Letter Es
  '\u0443': 'y', // Cyrillic Small Letter U
  '\u0445': 'x', // Cyrillic Small Letter Ha
  '\u0455': 's', // Cyrillic Small Letter Dze
  '\u0456': 'i', // Cyrillic Small Letter Byelorussian-Ukrainian I
  '\u0458': 'j', // Cyrillic Small Letter Je
  '\u0501': 'd', // Cyrillic Small Letter Komi De
  '\u051B': 'q', // Cyrillic Small Letter Qa
  '\u051D': 'w', // Cyrillic Small Letter We
  '\u04BB': 'h', // Cyrillic Small Letter Shha
  '\u044A': 'b', // Cyrillic Small Letter Hard Sign

  // Cyrillic uppercase
  '\u0410': 'A', // Cyrillic Capital Letter A
  '\u0412': 'B', // Cyrillic Capital Letter Ve
  '\u0421': 'C', // Cyrillic Capital Letter Es
  '\u0415': 'E', // Cyrillic Capital Letter Ie
  '\u041D': 'H', // Cyrillic Capital Letter En
  '\u0406': 'I', // Cyrillic Capital Letter Byelorussian-Ukrainian I
  '\u0408': 'J', // Cyrillic Capital Letter Je
  '\u041A': 'K', // Cyrillic Capital Letter Ka
  '\u041C': 'M', // Cyrillic Capital Letter Em
  '\u041E': 'O', // Cyrillic Capital Letter O
  '\u0420': 'P', // Cyrillic Capital Letter Er
  '\u0422': 'T', // Cyrillic Capital Letter Te
  '\u0423': 'Y', // Cyrillic Capital Letter U
  '\u0425': 'X', // Cyrillic Capital Letter Ha
  '\u0405': 'S', // Cyrillic Capital Letter Dze

  // Greek lowercase
  '\u03B1': 'a', // Greek Small Letter Alpha
  '\u03B2': 'b', // Greek Small Letter Beta
  '\u03B5': 'e', // Greek Small Letter Epsilon
  '\u03F5': 'e', // Greek Lunate Epsilon Symbol
  '\u03B9': 'i', // Greek Small Letter Iota
  '\u03BA': 'k', // Greek Small Letter Kappa
  '\u03BF': 'o', // Greek Small Letter Omicron
  '\u03C1': 'p', // Greek Small Letter Rho
  '\u03C4': 't', // Greek Small Letter Tau
  '\u03C5': 'u', // Greek Small Letter Upsilon
  '\u03C7': 'x', // Greek Small Letter Chi
  '\u03BD': 'v', // Greek Small Letter Nu

  // Greek uppercase
  '\u0391': 'A', // Greek Capital Letter Alpha
  '\u0392': 'B', // Greek Capital Letter Beta
  '\u0395': 'E', // Greek Capital Letter Epsilon
  '\u0397': 'H', // Greek Capital Letter Eta
  '\u0399': 'I', // Greek Capital Letter Iota
  '\u039A': 'K', // Greek Capital Letter Kappa
  '\u039C': 'M', // Greek Capital Letter Mu
  '\u039D': 'N', // Greek Capital Letter Nu
  '\u039F': 'O', // Greek Capital Letter Omicron
  '\u03A1': 'P', // Greek Capital Letter Rho
  '\u03A4': 'T', // Greek Capital Letter Tau
  '\u03A5': 'Y', // Greek Capital Letter Upsilon
  '\u03A7': 'X', // Greek Capital Letter Chi
  '\u0396': 'Z', // Greek Capital Letter Zeta
});

/**
 * Words spelled with punctuation between the letters (w-i-l-l g-e-t). Neighbouring words are
 * matched as one chain, and the whitespace between them stays as the word break.
 */
const PUNCTUATED_WORD_CHAIN_REGEX =
  /(?<![a-zA-Z0-9])[a-zA-Z](?:[-_.][a-zA-Z])+(?![a-zA-Z0-9])(?:\s+[a-zA-Z](?:[-_.][a-zA-Z])+(?![a-zA-Z0-9]))*/g;

/** Letters spaced out with whitespace (g u a r a n t e e d) */
const SPACED_LETTERS_REGEX = /(?<![a-zA-Z0-9])[a-zA-Z](?:\s[a-zA-Z]){2,}(?![a-zA-Z0-9])/g;

/** Any mix of separators, for a single word split like g-u a-r */
const MIXED_SEPARATOR_REGEX = /(?<![a-zA-Z0-9])[a-zA-Z](?:[-_.\s][a-zA-Z]){2,}(?![a-zA-Z0-9])/g;

/** Normalized text, with the raw [start, end) range behind each of its characters */
interface MappedText {
  text: string;
  starts: number[];
  ends: number[];
}

/**
 * Strips invisible characters, applies NFKD, drops diacritics and maps homoglyphs one
 * code point at a time, so every output character can be traced back to the input.
 */
function foldCharacters(raw: string): MappedText {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;

  for (const char of raw) {
    const start = offset;
    offset += char.length;

    let folded = '';
    if (!INVISIBLE_AND_ZERO_WIDTH_REGEX.test(char)) {
      folded = char.normalize('NFKD').replace(COMBINING_DIACRITICS_REGEX, '');
    }

    if (!folded) {
      // A dropped character belongs to the one before it, so redaction takes it too
      for (let i = ends.length - 1; i >= 0 && starts[i] === starts[starts.length - 1]; i--) {
        ends[i] = offset;
      }
      continue;
    }

    for (let i = 0; i < folded.length; i++) {
      chars.push(HOMOGLYPH_MAP[folded[i]] ?? folded[i]);
      starts.push(start);
      ends.push(offset);
    }
  }

  return { text: chars.join(''), starts, ends };
}

/** Removes the matched separator characters from every run the pattern finds */
function removeSeparators(
  source: MappedText,
  runPattern: RegExp,
  separator: RegExp,
  shouldCollapse: (run: string) => boolean = () => true,
): MappedText {
  const removed = new Set<number>();
  for (const match of source.text.matchAll(runPattern)) {
    if (!shouldCollapse(match[0])) continue;
    for (let i = 0; i < match[0].length; i++) {
      if (separator.test(match[0][i])) removed.add(match.index + i);
    }
  }
  if (removed.size === 0) return source;

  const kept = (_: unknown, i: number) => !removed.has(i);
  return {
    text: source.text.split('').filter(kept).join(''),
    starts: source.starts.filter(kept),
    ends: source.ends.filter(kept),
  };
}

/**
 * Two readings of obfuscated text: one keeps the breaks between words, the other joins
 * everything for words split with mixed separators. Policies are checked against both.
 */
function normalizedVariants(raw: string): [MappedText, MappedText] {
  const folded = foldCharacters(raw);
  // A chain of only two-letter pieces (e-g a-b) is left alone
  const punctuated = removeSeparators(folded, PUNCTUATED_WORD_CHAIN_REGEX, /[-_.]/, (chain) =>
    chain.split(/\s+/).some((word) => word.length >= 5),
  );
  return [
    removeSeparators(punctuated, SPACED_LETTERS_REGEX, /\s/),
    removeSeparators(folded, MIXED_SEPARATOR_REGEX, /[-_.\s]/),
  ];
}

/**
 * Replaces every match of the patterns with [FILTERED] in the raw text, including matches
 * that only show up in a normalized variant.
 */
function redactMatches(raw: string, variants: MappedText[], patterns: RegExp[]): string {
  const spans: Array<[number, number]> = [];

  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, '')}g`);
    const before = spans.length;

    for (const match of raw.matchAll(global)) {
      if (match[0]) spans.push([match.index, match.index + match[0].length]);
    }
    for (const { text, starts, ends } of variants) {
      for (const match of text.matchAll(global)) {
        if (match[0]) spans.push([starts[match.index], ends[match.index + match[0].length - 1]]);
      }
    }

    // Matched but with no range to cut (zero-length custom pattern): redact everything
    if (spans.length === before && [raw, ...variants.map((v) => v.text)].some((t) => t.search(pattern) !== -1)) {
      spans.push([0, raw.length]);
    }
  }

  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // Overlapping ranges become a single [FILTERED]
  let result = '';
  let redactedUpTo = 0;
  for (const [start, end] of spans) {
    if (start >= redactedUpTo) {
      result += `${raw.slice(redactedUpTo, start)}[FILTERED]`;
    }
    redactedUpTo = Math.max(redactedUpTo, end);
  }
  return result + raw.slice(redactedUpTo);
}

class PromptSafetyLayerClass {
  private policies: SafetyPolicy[] = [
    {
      id: 'no-hiring-guarantees',
      description: 'Prohibit hiring/placement guarantees',
      patterns: [
        /will definitely get/gi,
        /guaranteed to get/gi,
        /guarantee you (will|get)/gi,
        /definitely (get|land|secure)/gi,
        /certain to (get|land|secure)/gi,
        /you will (definitely|surely|certainly) (get|land|secure)/gi,
      ],
      severity: 'critical',
      action: 'block',
    },
    {
      id: 'no-salary-guarantees',
      description: 'Prohibit salary guarantees',
      patterns: [
        /guaranteed \d+ LPA/gi,
        /guarantee \d+ LPA/gi,
        /will (definitely|surely) get \d+ LPA/gi,
        /certain to get \d+ LPA/gi,
        /guaranteed (salary|package)/gi,
      ],
      severity: 'critical',
      action: 'block',
    },
    {
      id: 'no-company-specific-promises',
      description: 'Prohibit company-specific placement promises',
      patterns: [
        /will definitely get (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
        /guaranteed (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
        /definitely (land|get into) (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
        /you will get into (Google|Amazon|Microsoft|Meta|Apple|Netflix)\b/gi,
      ],
      severity: 'critical',
      action: 'block',
    },
    {
      id: 'no-personality-analysis',
      description: 'Prohibit personality analysis claims',
      patterns: [
        /personality (type|trait|analysis)/gi,
        /you (are|have) (a|an) (extrovert|introvert|ambivert)/gi,
        /personality (score|assessment|test)/gi,
      ],
      severity: 'critical',
      action: 'block',
    },
    {
      id: 'no-emotional-manipulation',
      description: 'Prohibit emotional manipulation',
      patterns: [
        /you (must|should) feel (proud|confident|excited)/gi,
        /don't worry about/gi,
        /everything will be (fine|great|perfect)/gi,
        /believe in yourself and you'll (succeed|get)/gi,
      ],
      severity: 'warning',
      action: 'filter',
    },
    {
      id: 'no-hallucinated-claims',
      description: 'Prohibit hallucinated engineering claims without evidence',
      patterns: [
        /you (are|have) (expert|master|guru) at/gi,
        /you (know|understand) (everything|all) about/gi,
        /you (are|have) the (best|top|greatest) at/gi,
      ],
      severity: 'warning',
      action: 'filter',
    },
    {
      id: 'no-fake-confidence',
      description: 'Prohibit fake confidence claims',
      patterns: [
        /100% (certain|sure|confident)/gi,
        /absolutely (certain|sure|confident)/gi,
        /completely (certain|sure|confident)/gi,
      ],
      severity: 'warning',
      action: 'filter',
    },
    {
      id: 'no-recruiter-summaries',
      description: 'Prohibit unsupported recruiter summaries',
      patterns: [
        /recruiters (will|definitely) (love|want)/gi,
        /recruiters (are|will be) (impressed|amazed)/gi,
        /stand out to recruiters/gi,
      ],
      severity: 'warning',
      action: 'filter',
    },
  ];

  /**
   * Pre-normalization pipeline:
   * 1. Strip invisible/zero-width formatting characters
   * 2. Unicode compatibility decomposition (NFKD) and strip combining diacritics
   * 3. Map lookalike homoglyphs (Cyrillic, Greek) to ASCII equivalents
   * 4. Collapse spaced-out single letters / intra-word punctuation tricks (e.g. g-u-a-r-a-n-t-e-e-d)
   */
  public normalizeText(text: string): string {
    if (!text || typeof text !== 'string') {
      return '';
    }

    return normalizedVariants(text)[0].text;
  }

  /**
   * Check prompt for safety violations
   */
  checkPrompt(prompt: string): SafetyCheckResult {
    if (!prompt || typeof prompt !== 'string') {
      return { safe: true, violations: [], warnings: [] };
    }

    // Guard against oversized inputs to prevent ReDoS and event loop starvation
    if (prompt.length > MAX_INPUT_LENGTH) {
      const violation = `Payload length exceeds maximum safe limit (${prompt.length} > ${MAX_INPUT_LENGTH} characters)`;
      logger.warn('[PromptSafetyLayer] Prompt safety violation: input exceeds max length', {
        length: prompt.length,
        maxLength: MAX_INPUT_LENGTH,
      });
      return {
        safe: false,
        violations: [violation],
        warnings: [],
      };
    }

    const candidates = [prompt, ...normalizedVariants(prompt).map((v) => v.text)];
    const violations: string[] = [];
    const warnings: string[] = [];
    
    for (const policy of this.policies) {
      for (const pattern of policy.patterns) {
        pattern.lastIndex = 0;
        if (candidates.some((text) => text.search(pattern) !== -1)) {
          if (policy.severity === 'critical') {
            violations.push(`${policy.description}: Matched pattern "${pattern}"`);
          } else if (policy.severity === 'warning') {
            warnings.push(`${policy.description}: Matched pattern "${pattern}"`);
          }
        }
      }
    }
    
    const safe = violations.length === 0;
    
    if (!safe) {
      logger.warn('[PromptSafetyLayer] Prompt safety violation detected', { violations });
    }
    
    return {
      safe,
      violations,
      warnings,
    };
  }

  /**
   * Check AI response for safety violations
   */
  checkResponse(response: string): SafetyCheckResult {
    if (!response || typeof response !== 'string') {
      return { safe: true, violations: [], warnings: [] };
    }

    // Guard against oversized outputs to prevent ReDoS and event loop starvation
    if (response.length > MAX_INPUT_LENGTH) {
      const violation = `Response length exceeds maximum safe limit (${response.length} > ${MAX_INPUT_LENGTH} characters)`;
      logger.warn('[PromptSafetyLayer] Response safety violation: response exceeds max length', {
        length: response.length,
        maxLength: MAX_INPUT_LENGTH,
      });
      return {
        safe: false,
        violations: [violation],
        warnings: [],
        filteredContent: undefined,
      };
    }

    const variants = normalizedVariants(response);
    const candidates = [response, ...variants.map((v) => v.text)];
    const violations: string[] = [];
    const warnings: string[] = [];
    const patternsToFilter: RegExp[] = [];
    
    for (const policy of this.policies) {
      for (const pattern of policy.patterns) {
        pattern.lastIndex = 0;
        if (candidates.some((text) => text.search(pattern) !== -1)) {
          if (policy.severity === 'critical') {
            violations.push(`${policy.description}: Matched pattern "${pattern}"`);
          } else if (policy.severity === 'warning') {
            warnings.push(`${policy.description}: Matched pattern "${pattern}"`);
            
            if (policy.action === 'filter') {
              patternsToFilter.push(pattern);
            }
          }
        }
      }
    }
    
    const safe = violations.length === 0;
    
    if (!safe) {
      logger.warn('[PromptSafetyLayer] Response safety violation detected', { violations });
    }
    
    if (warnings.length > 0) {
      logger.info('[PromptSafetyLayer] Response safety warnings', { warnings });
    }
    
    return {
      safe,
      violations,
      warnings,
      filteredContent: warnings.length > 0 ? redactMatches(response, variants, patternsToFilter) : undefined,
    };
  }

  /**
   * Sanitize prompt by removing unsafe content
   */
  sanitizePrompt(prompt: string): string {
    if (!prompt || typeof prompt !== 'string') {
      return prompt;
    }

    if (prompt.length > MAX_INPUT_LENGTH) {
      logger.warn('[PromptSafetyLayer] Truncating oversized prompt during sanitization', {
        length: prompt.length,
        maxLength: MAX_INPUT_LENGTH,
      });
      prompt = prompt.slice(0, MAX_INPUT_LENGTH);
    }

    const patterns = this.policies
      .filter((policy) => policy.action === 'filter' || policy.action === 'block')
      .flatMap((policy) => policy.patterns);

    return redactMatches(prompt, normalizedVariants(prompt), patterns);
  }

  /**
   * Add safety guardrails to system prompt
   */
  addGuardrails(systemPrompt: string): string {
    let guardrails = `\n\nSTRICT SAFETY GUARDRAILS:\n`;
    guardrails += `- You MUST NOT make hiring, placement, or salary guarantees\n`;
    guardrails += `- You MUST NOT promise specific company placements\n`;
    guardrails += `- You MUST NOT analyze personality traits\n`;
    guardrails += `- You MUST NOT use emotional manipulation or motivational fluff\n`;
    guardrails += `- You MUST NOT make engineering claims without evidence\n`;
    guardrails += `- You MUST NOT express 100% certainty or absolute confidence\n`;
    guardrails += `- You MUST NOT make unsupported recruiter summaries\n`;
    guardrails += `- You MUST remain technical, factual, and evidence-aware\n`;
    guardrails += `- You MUST acknowledge uncertainty honestly\n`;
    guardrails += `- You MUST focus on engineering progression, not motivation\n`;
    
    return systemPrompt + guardrails;
  }

  /**
   * Check if content contains prohibited patterns
   */
  containsProhibitedPatterns(content: string): boolean {
    if (!content || typeof content !== 'string') {
      return false;
    }

    if (content.length > MAX_INPUT_LENGTH) {
      return true; // Fail-safe: oversized content is rejected as prohibited
    }

    const candidates = [content, ...normalizedVariants(content).map((v) => v.text)];
    for (const policy of this.policies) {
      if (policy.severity === 'critical') {
        for (const pattern of policy.patterns) {
          pattern.lastIndex = 0;
          if (candidates.some((text) => text.search(pattern) !== -1)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Get all safety policies
   */
  getPolicies(): SafetyPolicy[] {
    return this.policies;
  }

  /**
   * Add custom safety policy
   */
  addPolicy(policy: SafetyPolicy): void {
    this.policies.push(policy);
    logger.info('[PromptSafetyLayer] Custom safety policy added', { policyId: policy.id });
  }

  /**
   * Remove safety policy by ID
   */
  removePolicy(policyId: string): void {
    this.policies = this.policies.filter(p => p.id !== policyId);
    logger.info('[PromptSafetyLayer] Safety policy removed', { policyId });
  }

  /**
   * Clear all custom policies (reset to defaults)
   */
  resetPolicies(): void {
    this.policies = [
      {
        id: 'no-hiring-guarantees',
        description: 'Prohibit hiring/placement guarantees',
        patterns: [
          /will definitely get/gi,
          /guaranteed to get/gi,
          /guarantee you (will|get)/gi,
          /definitely (get|land|secure)/gi,
          /certain to (get|land|secure)/gi,
          /you will (definitely|surely|certainly) (get|land|secure)/gi,
        ],
        severity: 'critical',
        action: 'block',
      },
      {
        id: 'no-salary-guarantees',
        description: 'Prohibit salary guarantees',
        patterns: [
          /guaranteed \d+ LPA/gi,
          /guarantee \d+ LPA/gi,
          /will (definitely|surely) get \d+ LPA/gi,
          /certain to get \d+ LPA/gi,
          /guaranteed (salary|package)/gi,
        ],
        severity: 'critical',
        action: 'block',
      },
      {
        id: 'no-company-specific-promises',
        description: 'Prohibit company-specific placement promises',
        patterns: [
          /will definitely get (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
          /guaranteed (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
          /definitely (land|get into) (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
          /you will get into (Google|Amazon|Microsoft|Meta|Apple|Netflix)\b/gi,
        ],
        severity: 'critical',
        action: 'block',
      },
      {
        id: 'no-personality-analysis',
        description: 'Prohibit personality analysis claims',
        patterns: [
          /personality (type|trait|analysis)/gi,
          /you (are|have) (a|an) (extrovert|introvert|ambivert)/gi,
          /personality (score|assessment|test)/gi,
        ],
        severity: 'critical',
        action: 'block',
      },
      {
        id: 'no-emotional-manipulation',
        description: 'Prohibit emotional manipulation',
        patterns: [
          /you (must|should) feel (proud|confident|excited)/gi,
          /don't worry about/gi,
          /everything will be (fine|great|perfect)/gi,
          /believe in yourself and you'll (succeed|get)/gi,
        ],
        severity: 'warning',
        action: 'filter',
      },
      {
        id: 'no-hallucinated-claims',
        description: 'Prohibit hallucinated engineering claims without evidence',
        patterns: [
          /you (are|have) (expert|master|guru) at/gi,
          /you (know|understand) (everything|all) about/gi,
          /you (are|have) the (best|top|greatest) at/gi,
        ],
        severity: 'warning',
        action: 'filter',
      },
      {
        id: 'no-fake-confidence',
        description: 'Prohibit fake confidence claims',
        patterns: [
          /100% (certain|sure|confident)/gi,
          /absolutely (certain|sure|confident)/gi,
          /completely (certain|sure|confident)/gi,
        ],
        severity: 'warning',
        action: 'filter',
      },
      {
        id: 'no-recruiter-summaries',
        description: 'Prohibit unsupported recruiter summaries',
        patterns: [
          /recruiters (will|definitely) (love|want)/gi,
          /recruiters (are|will be) (impressed|amazed)/gi,
          /stand out to recruiters/gi,
        ],
        severity: 'warning',
        action: 'filter',
      },
    ];
    
    logger.info('[PromptSafetyLayer] Policies reset to defaults');
  }
}

export const PromptSafetyLayer = new PromptSafetyLayerClass();
