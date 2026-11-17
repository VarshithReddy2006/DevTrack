import React from 'react';
import { PUBLICATION_SECTIONS, type PublicationSection, type PublicationSections } from '../../../services/publicationService';

export const SECTION_COPY: Record<PublicationSection, { label: string; description: string }> = {
  streak: { label: 'Streak', description: 'Current and longest streak, plus consistency scores.' },
  dsa: { label: 'DSA progress', description: 'Problems solved, topics covered and contest ratings.' },
  github: { label: 'GitHub', description: 'Contribution counts, languages and verified status.' },
  projects: { label: 'Projects', description: 'Your verified projects.' },
  activity: { label: 'Activity', description: 'Activity heatmap and active-day counts.' },
};

interface Props {
  sections: PublicationSections;
  onToggle: (section: PublicationSection, visible: boolean) => void;
  disabled?: boolean;
}

export const SectionToggles: React.FC<Props> = ({ sections, onToggle, disabled }) => (
  <fieldset className="flex flex-col gap-3" disabled={disabled}>
    <legend className="text-sm font-semibold text-slate-800">Sections on your public page</legend>
    <p className="text-xs text-slate-500">Everything starts hidden. Only the sections you switch on are shown.</p>
    <ul className="flex flex-col divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
      {PUBLICATION_SECTIONS.map((section) => {
        const id = `portfolio-section-${section}`;
        const on = sections[section];
        return (
          <li key={section} className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <label htmlFor={id} className="text-sm font-medium text-slate-800">{SECTION_COPY[section].label}</label>
              <p id={`${id}-hint`} className="text-xs text-slate-500">{SECTION_COPY[section].description}</p>
            </div>
            <button
              id={id}
              type="button"
              role="switch"
              aria-checked={on}
              aria-describedby={`${id}-hint`}
              onClick={() => onToggle(section, !on)}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50 ${on ? 'bg-indigo-600' : 'bg-slate-300'}`}
            >
              <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
              <span className="sr-only">{on ? 'Shown' : 'Hidden'}</span>
            </button>
          </li>
        );
      })}
    </ul>
  </fieldset>
);
