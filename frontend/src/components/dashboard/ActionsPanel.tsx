import React from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../shared/Icon';

export const ActionsPanel: React.FC = () => {
  const unavailableActionsId = React.useId();

  return (
    <div className="flex flex-col gap-5 flex-1 bg-white/40 backdrop-blur-2xl border border-gray-300 rounded-[24px] p-7 shadow-[0_8px_30px_rgba(124,92,252,0.05)] hover:border-dt-primary/30 transition-all duration-500 relative overflow-hidden group">
      <div className="absolute top-0 right-0 p-4 opacity-[0.03] pointer-events-none transform translate-x-4 -translate-y-4 group-hover:scale-[1.3] group-hover:rotate-12 transition-transform duration-700">
        <Icon name="bolt" size={100} className="text-dt-text" />
      </div>

      <div className="flex items-center gap-4 mb-3 relative z-10">
        <div className="w-12 h-12 rounded-[16px] bg-white/60 flex items-center justify-center border border-dt-primary/10 shadow-sm group-hover:scale-110 transition-transform duration-500">
          <Icon name="bolt" size={22} className="text-dt-primary" />
        </div>
        <span className="text-[16px] font-black text-dt-text tracking-tight">Quick Actions</span>
      </div>

      <Link
        to="/projects?create=1"
        className={[
          'w-full bg-violet-600 hover:bg-violet-700 text-white rounded-[16px] py-4 font-black text-[14px]',
          'shadow-[0_4px_15px_rgba(124,58,237,0.3)] hover:shadow-[0_8px_25px_rgba(124,58,237,0.4)] cursor-pointer relative z-10',
          'hover:-translate-y-1',
          'active:scale-[0.98]',
          'transition-all duration-300 ease-out',
          'flex items-center justify-center gap-3',
        ].join(' ')}
        style={{ animation: 'dtFadeIn 600ms cubic-bezier(0.22, 1, 0.36, 1) 100ms both' }}
      >
        <Icon name="plus" size={20} className="text-white/90 drop-shadow-sm" />
        Create Project
      </Link>

      <button
        type="button"
        disabled
        aria-describedby={unavailableActionsId}
        className={[
          'group/btn w-full bg-white/80 backdrop-blur-md border border-slate-200/60 rounded-[16px] py-4 text-[14px] font-bold text-slate-600 shadow-sm',
          'cursor-not-allowed opacity-60 relative z-10',
          'transition-all duration-300 ease-out',
          'flex items-center justify-center gap-3',
        ].join(' ')}
        style={{ animation: 'dtFadeIn 600ms cubic-bezier(0.22, 1, 0.36, 1) 200ms both' }}
      >
        <Icon name="chart-bar" size={18} className="text-slate-400 group-hover/btn:text-slate-600 transition-colors" />
        Log Activity
      </button>

      <button
        type="button"
        disabled
        aria-describedby={unavailableActionsId}
        className={[
          'group/btn w-full bg-white/80 backdrop-blur-md border border-slate-200/60 rounded-[16px] py-4 text-[14px] font-bold text-slate-600 shadow-sm',
          'cursor-not-allowed opacity-60 relative z-10',
          'transition-all duration-300 ease-out',
          'flex items-center justify-center gap-3',
        ].join(' ')}
        style={{ animation: 'dtFadeIn 600ms cubic-bezier(0.22, 1, 0.36, 1) 300ms both' }}
      >
        <Icon name="eye" size={18} className="text-slate-400 group-hover/btn:text-slate-600 transition-colors" />
        Review Mistakes
      </button>
      <p id={unavailableActionsId} className="relative z-10 text-sm text-dt-textSecondary">
        Manual activity logging and mistake review are unavailable.
      </p>
    </div>
  );
};
