import React from 'react';
import { PUBLIC_PORTFOLIO_THEMES, type PublicPortfolioTheme } from '../../../services/publicationService';

const THEME_COPY: Record<PublicPortfolioTheme, { label: string; description: string; swatch: string }> = {
  'modern-dark': { label: 'Modern Dark', description: 'Indigo accents on a deep, high-contrast surface.', swatch: 'bg-slate-950' },
  'clean-minimal-light': { label: 'Clean Minimal Light', description: 'Bright surfaces, quiet borders, and generous whitespace.', swatch: 'bg-white' },
  'monokai-hacker': { label: 'Monokai Hacker', description: 'Dark hacker palette with neon green and amber accents.', swatch: 'bg-[#272822]' },
  'terminal-monospace': { label: 'Terminal / Monospace', description: 'Terminal-inspired colors and code-like typography.', swatch: 'bg-black' },
};

interface Props {
  value: PublicPortfolioTheme;
  onChange: (theme: PublicPortfolioTheme) => void;
  disabled?: boolean;
}

export const PublicPortfolioThemeSwitcher: React.FC<Props> = ({ value, onChange, disabled = false }) => (
  <fieldset disabled={disabled} className="flex flex-col gap-3">
    <legend className="text-sm font-semibold text-slate-800">Portfolio theme</legend>
    <p className="text-xs text-slate-500">This changes your public portfolio only, not the DevTrack app theme.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      {PUBLIC_PORTFOLIO_THEMES.map((theme) => {
        const copy = THEME_COPY[theme];
        const selected = value === theme;
        return (
          <label key={theme} className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${selected ? 'border-indigo-500 ring-2 ring-indigo-100' : 'border-slate-200'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
            <input
              type="radio"
              name="portfolio-theme"
              value={theme}
              checked={selected}
              onChange={() => onChange(theme)}
              className="sr-only"
            />
            <span aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-white shadow ring-1 ring-slate-300 ${copy.swatch}`} />
            <span>
              <span className="block text-sm font-semibold text-slate-800">{copy.label}</span>
              <span className="block text-xs text-slate-500">{copy.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  </fieldset>
);
