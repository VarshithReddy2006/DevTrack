import { topicLabel } from '../topics';

interface TopicFilterChipsProps {
  topics: string[];
  selected: string | null;
  onSelect: (topic: string | null) => void;
}

const chipClass = 'rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dt-primary';
const activeClass = 'border-dt-primary bg-dt-primary text-white';
const idleClass = 'border-dt-primary/20 bg-dt-surface text-dt-textSecondary hover:border-dt-primary/50 hover:text-dt-text';

export function TopicFilterChips({ topics, selected, onSelect }: TopicFilterChipsProps) {
  if (topics.length === 0) return null;
  return (
    <div role="group" aria-label="Filter review by topic" className="flex flex-wrap gap-2">
      <button type="button" aria-pressed={selected === null} onClick={() => onSelect(null)} className={`${chipClass} ${selected === null ? activeClass : idleClass}`}>
        All topics
      </button>
      {topics.map((topic) => (
        <button
          key={topic}
          type="button"
          aria-pressed={selected === topic}
          onClick={() => onSelect(selected === topic ? null : topic)}
          className={`${chipClass} ${selected === topic ? activeClass : idleClass}`}
        >
          {topicLabel(topic)}
        </button>
      ))}
    </div>
  );
}
