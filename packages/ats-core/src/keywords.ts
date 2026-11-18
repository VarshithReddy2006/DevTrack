import type { KeywordCoverage } from './types.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function checkKeywordCoverage(
  content: string,
  targetKeywords: readonly string[],
  { includeContext = true }: { includeContext?: boolean } = {},
): KeywordCoverage[] {
  return targetKeywords.map(keyword => {
    const keywordLower = keyword.toLowerCase();
    // \b does not work next to symbols (c++, c#, .net), so use lookarounds
    // that only reject neighbouring word characters.
    const regex = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(keywordLower)}(?![A-Za-z0-9_])`, 'gi');
    const matches = content.match(regex) || [];
    const frequency = matches.length;

    // Extract context (surrounding text)
    const context: string[] = [];
    if (includeContext) {
      const sentences = content.split(/[.!?]+/);
      sentences.forEach(sentence => {
        if (sentence.toLowerCase().includes(keywordLower)) {
          context.push(sentence.trim());
        }
      });
    }

    return {
      keyword,
      found: frequency > 0,
      frequency,
      context: context.slice(0, 3), // Top 3 contexts
    };
  });
}
