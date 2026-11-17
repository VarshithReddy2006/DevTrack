import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { RevisionCard } from '../../../services/revisionService';

interface FlashcardProps { card: RevisionCard }

const hintNames = ['Intuition', 'Approach', 'Key Code Line'] as const;

function noteHints(notes: string | undefined): string[] {
  if (!notes?.trim()) return ['', '', ''];
  // Existing cards have only a free-form notes field. Recognize labelled notes
  // without inventing earlier hints or exposing the solution too soon.
  const labels = /(?:^|\n)\s*(?:Intuition|Approach|Key Code Line)\s*:/gi;
  const matches = [...notes.matchAll(labels)];
  if (matches.length === 0) return ['', '', notes.trim()];
  const result = ['', '', ''];
  matches.forEach((match, index) => {
    const name = match[0].trim().replace(/:$/, '').toLowerCase();
    const hintIndex = hintNames.findIndex((hint) => hint.toLowerCase() === name);
    if (hintIndex >= 0) result[hintIndex] = notes.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index).trim();
  });
  return result;
}

export function Flashcard({ card }: FlashcardProps) {
  const [revealed, setRevealed] = useState(0);
  const hints = noteHints(card.notes);
  const platform = card.problemKey.split(':')[0] || 'Problem';

  return (
    <article className="rounded-2xl border border-dt-primary/10 bg-dt-surface p-6 shadow-dt-floating" aria-label={`Review ${card.title}`}>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-dt-textSecondary">
        <span>{platform}</span><span aria-hidden="true">·</span><span>{card.difficulty}</span>
      </div>
      <h2 className="text-2xl font-bold text-dt-text">{card.title}</h2>
      {card.tags.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{card.tags.map((tag) => <span key={tag} className="rounded-full bg-dt-primary/10 px-2.5 py-1 text-xs font-medium text-dt-primary">{tag}</span>)}</div>}
      <p className="mt-6 text-sm text-dt-textSecondary">Recall your solution before revealing the hints.</p>
      <div className="mt-5 space-y-3">
        {hintNames.map((name, index) => (
          <div key={name} className="rounded-xl border border-dt-primary/10 bg-dt-bg/60 p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold text-dt-text">{index + 1}. {name}</h3>
              {revealed < index + 1 && <button type="button" onClick={() => setRevealed(index + 1)} disabled={revealed !== index} className="dt-btn dt-btn-secondary dt-btn-sm disabled:opacity-40">Reveal</button>}
            </div>
            <AnimatePresence initial={false}>
              {revealed >= index + 1 && <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mt-3 whitespace-pre-wrap text-sm text-dt-textSecondary">{hints[index] || 'No hint saved for this stage.'}</motion.p>}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </article>
  );
}
