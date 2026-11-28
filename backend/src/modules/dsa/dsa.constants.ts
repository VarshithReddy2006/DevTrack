// Topic summary written for each DSA platform during sync.
export const PLATFORM_TOPIC_NAMES = {
  leetcode: 'LeetCode Problems',
  codeforces: 'Competitive Programming',
  codechef: 'CodeChef Problems',
} as const;

// Platform sync owns these summary names. Trimming is only for the collision
// check; ordinary stored category names retain their existing spelling.
export const RESERVED_PLATFORM_TOPIC_NAMES = new Set<string>([
  ...Object.values(PLATFORM_TOPIC_NAMES),
  'General',
]);

export function isReservedPlatformTopic(category: string): boolean {
  return RESERVED_PLATFORM_TOPIC_NAMES.has(category.trim());
}
