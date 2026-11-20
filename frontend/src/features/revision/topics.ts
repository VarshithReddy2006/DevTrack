import type { RevisionCard } from '../../services/revisionService';

/** Pattern name the analytics API uses for cards without tags. */
export const UNTAGGED_TOPIC = 'untagged';

export type RetentionLevel = 'critical' | 'at-risk' | 'steady' | 'mastered';

export const retentionLevels: Array<{ level: RetentionLevel; label: string; min: number }> = [
  { level: 'mastered', label: 'Mastered', min: 85 },
  { level: 'steady', label: 'Steady', min: 70 },
  { level: 'at-risk', label: 'At risk', min: 50 },
  { level: 'critical', label: 'Critical', min: 0 },
];

export function retentionLevel(percentage: number): RetentionLevel {
  return (retentionLevels.find(({ min }) => percentage >= min) ?? retentionLevels[retentionLevels.length - 1]).level;
}

export function retentionLabel(level: RetentionLevel): string {
  return retentionLevels.find((entry) => entry.level === level)?.label ?? level;
}

export function topicLabel(topic: string): string {
  return topic === UNTAGGED_TOPIC ? 'Untagged' : topic;
}

export function cardMatchesTopic(card: Pick<RevisionCard, 'tags'>, topic: string): boolean {
  const tags = card.tags.map((tag) => tag.trim()).filter(Boolean);
  return topic === UNTAGGED_TOPIC ? tags.length === 0 : tags.includes(topic);
}

/** Cards due before the start of the current UTC day, matching the analytics API's day boundary. */
export function countOverdue(cards: Array<Pick<RevisionCard, 'dueAt'>>, now = new Date()): number {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return cards.filter((card) => new Date(card.dueAt).getTime() < startOfDay).length;
}
