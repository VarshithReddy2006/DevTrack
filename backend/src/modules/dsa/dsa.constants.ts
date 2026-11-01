// Platform sync owns these summary names. Trimming is only for the collision
// check; ordinary stored category names retain their existing spelling.
export const RESERVED_PLATFORM_TOPIC_NAMES = new Set([
  'LeetCode Problems',
  'Competitive Programming',
  'CodeChef Problems',
  'General',
]);

export function isReservedPlatformTopic(category: string): boolean {
  return RESERVED_PLATFORM_TOPIC_NAMES.has(category.trim());
}
