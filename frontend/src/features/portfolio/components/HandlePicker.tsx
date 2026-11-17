import React, { useEffect, useState } from 'react';
import { normalizeSlug, validateSlug } from '../utils/slug';

export const HANDLE_DEBOUNCE_MS = 300;

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Answer from the last publish attempt (reserved or taken); cleared as soon as the user edits. */
  serverError?: string | null;
  disabled?: boolean;
}

/**
 * Format feedback runs 300ms after the last keystroke. Whether a handle is free is only known
 * when publishing: the server answers 409 for reserved or taken handles.
 */
export const HandlePicker: React.FC<Props> = ({ value, onChange, serverError, disabled }) => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), HANDLE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);

  const check = validateSlug(settled);
  const pending = settled !== value;
  const showFormat = !pending && settled.trim() !== '';
  const message = serverError ?? (showFormat && !check.valid ? check.message : null);
  const looksGood = !serverError && showFormat && check.valid;
  const slug = normalizeSlug(value);

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="portfolio-handle" className="text-sm font-semibold text-slate-800">Public handle</label>
      <div className="flex items-center overflow-hidden rounded-xl border border-slate-300 bg-white focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-200">
        <span className="select-none bg-slate-50 px-3 py-2 text-sm text-slate-500">/u/</span>
        <input
          id="portfolio-handle"
          type="text"
          value={value}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={40}
          aria-invalid={!!message}
          aria-describedby="portfolio-handle-feedback"
          onChange={(event) => onChange(event.target.value)}
          className="w-full px-2 py-2 text-sm text-slate-800 focus:outline-none disabled:bg-slate-50"
          placeholder="your-handle"
        />
      </div>
      <p id="portfolio-handle-feedback" aria-live="polite" className={`min-h-[1.25rem] text-xs ${message ? 'text-rose-700' : 'text-emerald-700'}`}>
        {message ?? (looksGood ? `Format looks good. Your page would live at /u/${slug}.` : '')}
      </p>
    </div>
  );
};
