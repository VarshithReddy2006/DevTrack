// ============================================================================
// DashboardHeader.tsx — Premium Dashboard Header
// ============================================================================
import React, { useState, useEffect } from 'react';
import { Icon } from '../shared/Icon';
import { useUserStore } from '../../store/userStore';
import { useProfileStore } from '../../store/profileStore';
import { useDashboardData } from '../../hooks/useDashboardData';
import { useCoachingStore } from '../../store/coachingStore';

const MOTIVATIONAL_INSIGHTS = [
  "You're in the top 15% of active developers this week.",
  "Your algorithmic consistency is peaking. Keep pushing.",
  "Ecosystem sync complete. All systems nominal.",
  "Your problem-solving velocity is higher than your 30-day average."
];

interface DashboardHeaderProps {
  onOpenQuests: () => void;
}

export const DashboardHeader: React.FC<DashboardHeaderProps> = ({ onOpenQuests }) => {
  const displayName = useUserStore((s) => s.user?.displayName) || 'there';
  const fetchAllPlatforms = useProfileStore((s) => s.fetchAllPlatforms);
  const syncState = useProfileStore((s) => s.syncState);
  const { refetch } = useDashboardData();
  const { insights } = useCoachingStore();

  const handleSync = async () => {
    await fetchAllPlatforms();
    refetch();
  };

  const isSyncing = syncState === 'syncing';
  const now = new Date();
  const hour = now.getHours();

  const [insightIndex, setInsightIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setInsightIndex((prev) => (prev + 1) % MOTIVATIONAL_INSIGHTS.length);
    }, 8000);
    return () => clearInterval(interval);
  }, []);

  let greeting: string;
  let emoji: string;
  if (hour < 12) {
    greeting = 'Good morning';
    emoji = '☀️';
  } else if (hour < 17) {
    greeting = 'Good afternoon';
    emoji = '🌤️';
  } else {
    greeting = 'Good evening';
    emoji = '🌙';
  }

  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const handleStartFocus = () => {
    // Smooth scroll to pomodoro
    const focusSection = document.getElementById('focus-engine-section');
    if (focusSection) {
      focusSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    
    // Dispatch global event after a tiny delay for scroll to start
    setTimeout(() => {
      window.dispatchEvent(new Event('start-focus-session'));
    }, 300);
  };

  const emotionalState = insights?.emotionalState || 'calm';

  let bgGradient = 'from-indigo-500/10 via-purple-500/5 to-transparent';
  let textGradient = 'from-indigo-600 via-violet-500 to-rose-400';
  let pulseColor = 'bg-emerald-500';
  let pulseShadow = 'shadow-[0_0_8px_rgba(16,185,129,0.8)]';
  let badgeColor = 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20';

  if (emotionalState === 'streak_risk') {
    bgGradient = 'from-orange-500/15 via-red-500/10 to-transparent';
    textGradient = 'from-orange-600 via-red-500 to-rose-500';
    pulseColor = 'bg-orange-500';
    pulseShadow = 'shadow-[0_0_8px_rgba(249,115,22,0.8)]';
    badgeColor = 'bg-orange-500/10 text-orange-600 border-orange-500/20';
  } else if (emotionalState === 'burnout_risk') {
    bgGradient = 'from-teal-500/10 via-emerald-500/5 to-transparent';
    textGradient = 'from-teal-600 via-emerald-500 to-cyan-500';
    pulseColor = 'bg-teal-500';
    pulseShadow = 'shadow-[0_0_8px_rgba(20,184,166,0.8)]';
    badgeColor = 'bg-teal-500/10 text-teal-600 border-teal-500/20';
  } else if (emotionalState === 'high_momentum') {
    bgGradient = 'from-fuchsia-500/15 via-purple-500/10 to-transparent';
    textGradient = 'from-fuchsia-600 via-purple-500 to-pink-500';
    pulseColor = 'bg-fuchsia-500';
    pulseShadow = 'shadow-[0_0_8px_rgba(217,70,239,0.8)]';
    badgeColor = 'bg-fuchsia-500/10 text-fuchsia-600 border-fuchsia-500/20';
  }

  return (
    <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-dt-primary/10 relative overflow-hidden group">
      {/* Subtle cinematic atmosphere */}
      <div className="absolute inset-0 bg-gradient-to-r from-dt-primary/[0.03] via-transparent to-transparent pointer-events-none rounded-t-3xl -mx-4 px-4" />
      <div className={`absolute top-0 left-0 w-[500px] h-[500px] bg-gradient-to-br ${bgGradient} blur-[80px] rounded-full pointer-events-none -translate-x-1/2 -translate-y-1/2 group-hover:opacity-100 opacity-70 transition-colors duration-1000`} />
      
      <div className="flex flex-col gap-4 relative z-10">
        <h1 className="text-display text-4xl md:text-[3.5rem] text-dt-text leading-[1.05] tracking-tight relative drop-shadow-sm">
          {greeting}, <br />
          <span className={`text-transparent bg-clip-text bg-gradient-to-r ${textGradient} drop-shadow-[0_2px_10px_rgba(124,92,252,0.2)] transition-colors duration-1000`}>{displayName.split(' ')[0]}</span> <span className="text-3xl md:text-4xl align-middle ml-1 hover:animate-[wiggle_1s_ease-in-out_infinite] inline-block origin-bottom">{emoji}</span>
        </h1>

        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-4 text-[13px]">
            <span className="flex items-center gap-2 px-1">
              <Icon name="calendar" size={15} className="text-dt-primary/50" />
              <span className="font-semibold text-dt-textSecondary/90 tracking-tight">{dateStr}</span>
            </span>
            <div className="w-1 h-1 rounded-full bg-dt-textDisabled/30 hidden sm:inline" />
            <span className={`text-[9px] font-black tracking-[0.2em] uppercase flex items-center gap-2 px-2.5 py-1 rounded-md ${badgeColor} transition-all cursor-default`}>
              <span className="relative flex h-1.5 w-1.5">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${pulseColor} opacity-75`}></span>
                <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${pulseColor} ${pulseShadow}`}></span>
              </span>
              Neural Link Active
            </span>
          </div>

          <div className="flex items-center gap-2.5 text-dt-textSecondary/80 text-[12px] font-semibold h-5 overflow-hidden tracking-tight mt-1">
            <Icon name="sparkles" size={13} className="text-dt-primary/60 shrink-0" />
            <div className="relative w-full h-full">
              {MOTIVATIONAL_INSIGHTS.map((insight, idx) => (
                <div
                  key={idx}
                  className={['absolute inset-0 transition-all duration-700 ease-in-out flex items-center',
                    idx === insightIndex ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
                  ].join(' ')}
                >
                  {insight}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 relative z-10">
        <button
          type="button"
          onClick={onOpenQuests}
          aria-label="Open quests"
          className="rounded-xl border border-dt-primary/10 bg-white/40 p-2.5 text-dt-textSecondary shadow-sm transition hover:border-dt-primary/30 hover:text-dt-primary"
        >
          <Icon name="trophy" size={17} />
        </button>
        <button
          onClick={handleSync}
          disabled={isSyncing}
          className="group relative px-4 py-2 bg-white/40 hover:bg-white/60 backdrop-blur-md text-dt-text font-bold text-[13px] rounded-xl border border-dt-primary/10 shadow-sm hover:shadow-md hover:border-dt-primary/30 transition-all duration-300 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden"
        >
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/50 to-transparent -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]" />
          <Icon name="arrow-path" size={15} className={['relative z-10', isSyncing ? 'animate-spin text-dt-primary' : 'text-dt-textSecondary group-hover:text-dt-primary transition-colors'].join(' ')} />
          <span className="relative z-10">{isSyncing ? 'Syncing...' : 'Sync All'}</span>
        </button>
        <button 
          onClick={handleStartFocus}
          className="relative px-5 py-2 bg-gradient-to-br from-dt-primary via-[#7C5CFC] to-[#A78BFA] text-white font-bold text-[13px] rounded-xl shadow-[0_4px_15px_rgba(109,79,242,0.3)] hover:shadow-[0_8px_25px_rgba(109,79,242,0.4)] transition-all duration-300 transform hover:-translate-y-0.5 overflow-hidden group"
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.25),transparent_50%)] opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          <span className="relative z-10 flex items-center gap-2">
            <Icon name="lightning-bolt" size={15} className="animate-pulse" />
            Start Focus
          </span>
        </button>
      </div>
    </div>
  );
};
