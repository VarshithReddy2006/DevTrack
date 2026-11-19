// Suggestions are choices, not evidence of leadership or achievements.
// Keep exactly three alternatives and preserve prepositions where they are needed.
export const verbDictionary = [
  { phrase: 'worked on', suggestions: ['Developed', 'Improved', 'Contributed to'] },
  { phrase: 'helped with', suggestions: ['Supported', 'Contributed to', 'Collaborated on'] },
  { phrase: 'responsible for', suggestions: ['Managed', 'Maintained', 'Delivered'] },
  { phrase: 'was involved in', suggestions: ['Contributed to', 'Supported', 'Collaborated on'] },
  { phrase: 'participated in', suggestions: ['Contributed to', 'Collaborated on', 'Supported'] },
] as const;

export function suggestionsFor(phrase: string): readonly string[] {
  const normalized = phrase.toLowerCase().replace(/[ \t]+/g, ' ');
  const alternatives = verbDictionary.find(entry => entry.phrase === normalized)?.suggestions ?? [];
  return alternatives.map(value => phrase === phrase.toUpperCase() ? value.toUpperCase()
    : phrase[0] === phrase[0].toLowerCase() ? value[0].toLowerCase() + value.slice(1) : value);
}
