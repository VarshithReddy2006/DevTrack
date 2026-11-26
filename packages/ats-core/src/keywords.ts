import type { KeywordCoverage } from './types.js';

export const MAX_KEYWORD_LENGTH = 64;
export const MAX_KEYWORD_COUNT = 100;

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeKeywords(
  keywords: readonly string[],
  { maxLength = MAX_KEYWORD_LENGTH, maxCount = MAX_KEYWORD_COUNT }: { maxLength?: number; maxCount?: number } = {},
): string[] {
  const sanitized: string[] = [];
  for (const raw of keywords) {
    if (sanitized.length >= maxCount) break;
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > maxLength) continue;
    sanitized.push(trimmed);
  }
  return sanitized;
}

function isWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    code === 95 ||                // _
    (code >= 97 && code <= 122)   // a-z
  );
}

// Linear substring scan with ASCII word-char boundaries avoids dynamic RegExp compilation and backtracking.
function countBoundedOccurrences(lowerContent: string, lowerKeyword: string): number {
  const len = lowerKeyword.length;
  if (len === 0) return 0;
  let count = 0;
  let pos = 0;
  while (pos <= lowerContent.length - len) {
    const idx = lowerContent.indexOf(lowerKeyword, pos);
    if (idx === -1) break;
    const leftOk = idx === 0 || !isWordChar(lowerContent.charCodeAt(idx - 1));
    const rightIdx = idx + len;
    const rightOk = rightIdx === lowerContent.length || !isWordChar(lowerContent.charCodeAt(rightIdx));
    if (leftOk && rightOk) {
      count++;
      pos = rightIdx;
    } else {
      pos = idx + 1;
    }
  }
  return count;
}

export function checkKeywordCoverage(
  content: string,
  targetKeywords: readonly string[],
  { includeContext = true }: { includeContext?: boolean } = {},
): KeywordCoverage[] {
  const boundedKeywords = targetKeywords.slice(0, MAX_KEYWORD_COUNT);
  const lowerContent = content.toLowerCase();
  const sentences = includeContext
    ? content.split(/[.!?]+/).map(sentence => ({ raw: sentence.trim(), lower: sentence.toLowerCase() }))
    : [];

  return boundedKeywords.map(keyword => {
    const trimmed = typeof keyword === 'string' ? keyword.trim() : '';
    if (!trimmed || trimmed.length > MAX_KEYWORD_LENGTH) {
      return {
        keyword: typeof keyword === 'string' ? keyword : '',
        found: false,
        frequency: 0,
        context: [],
      };
    }

    const keywordLower = trimmed.toLowerCase();
    const frequency = countBoundedOccurrences(lowerContent, keywordLower);

    const context: string[] = [];
    if (includeContext) {
      for (const sentence of sentences) {
        if (sentence.lower.includes(keywordLower)) {
          context.push(sentence.raw);
          if (context.length >= 3) break;
        }
      }
    }

    return {
      keyword,
      found: frequency > 0,
      frequency,
      context,
    };
  });
}
