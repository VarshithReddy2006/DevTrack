import React from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { PUBLICATION_SECTIONS, type PublicationSection } from '../../../services/publicationService';
import { SECTION_COPY } from './SectionToggles';

interface Props {
  value: PublicationSection[];
  onChange: (order: PublicationSection[]) => void;
  disabled?: boolean;
}

export const SectionOrderCustomizer: React.FC<Props> = ({ value, onChange, disabled = false }) => {
  const order = value.length === PUBLICATION_SECTIONS.length ? value : [...PUBLICATION_SECTIONS];
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-3">
      <legend className="text-sm font-semibold text-slate-800">Public section order</legend>
      <p className="text-xs text-slate-500">Use the buttons to choose the order of supported public sections.</p>
      <ol className="flex flex-col divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
        {order.map((section, index) => (
          <li key={section} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm font-medium text-slate-800">{SECTION_COPY[section].label}</span>
            <span className="flex gap-1">
              <button type="button" aria-label={`Move ${SECTION_COPY[section].label} up`} disabled={index === 0} onClick={() => move(index, -1)} className="rounded-md p-2 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30">
                <ArrowUp size={15} aria-hidden="true" />
              </button>
              <button type="button" aria-label={`Move ${SECTION_COPY[section].label} down`} disabled={index === order.length - 1} onClick={() => move(index, 1)} className="rounded-md p-2 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30">
                <ArrowDown size={15} aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ol>
    </fieldset>
  );
};
