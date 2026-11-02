import { useState, useEffect, useRef } from 'react';
import { Play, Pause, RotateCcw, Activity, Clock, Target, ChevronDown, BarChart2, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';

import { ConfirmationModal } from '../ui/ConfirmationModal';
import { useRuntimeState, type RuntimeState } from '../../hooks/useRuntimeState';
import { activityService } from '../../services/activityService';
import type { FocusSessionState } from '../../services/activityService';
import { useQueryClient } from '@tanstack/react-query';
import { useMissionStore } from '../../store/missionStore';

// Web Audio API Synthesizer for high-fidelity notification sound
const playFocusChime = () => {
  try {
     
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    
    // Note 1: E5
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.frequency.value = 659.25; // E5
    osc1.type = 'sine';
    gain1.gain.setValueAtTime(0, ctx.currentTime);
    gain1.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.08);
    gain1.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.5);
    
    // Note 2: A5
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.frequency.value = 880.00; // A5
    osc2.type = 'sine';
    gain2.gain.setValueAtTime(0, ctx.currentTime + 0.18);
    gain2.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.26);
    gain2.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 2.0);
    
    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 1.5);
    osc2.start(ctx.currentTime + 0.18);
    osc2.stop(ctx.currentTime + 2.0);
  } catch (e) {
    console.error('Audio synthesizer error:', e);
  }
};

const SESSION_MODES = [
  { id: 'deep_work', label: 'Deep Work', color: 'text-violet-600', bg: 'bg-violet-500', hoverBg: 'hover:bg-violet-600', stroke: '#8b5cf6', dur: 90 },
  { id: 'backend', label: 'Backend Build', color: 'text-blue-600', bg: 'bg-blue-500', hoverBg: 'hover:bg-blue-600', stroke: '#3b82f6', dur: 50 },
  { id: 'dsa', label: 'DSA Sprint', color: 'text-emerald-600', bg: 'bg-emerald-500', hoverBg: 'hover:bg-emerald-600', stroke: '#10b981', dur: 45 },
  { id: 'debug', label: 'Debugging', color: 'text-amber-600', bg: 'bg-amber-500', hoverBg: 'hover:bg-amber-600', stroke: '#f59e0b', dur: 25 },
  { id: 'learn', label: 'Learning', color: 'text-rose-600', bg: 'bg-rose-500', hoverBg: 'hover:bg-rose-600', stroke: '#f43f5e', dur: 60 },
  { id: 'arch', label: 'Architecture', color: 'text-cyan-600', bg: 'bg-cyan-500', hoverBg: 'hover:bg-cyan-600', stroke: '#06b6d4', dur: 120 },
];

export function focusRemainingSeconds(session: FocusSessionState, now = Date.now()): number {
  const totalMs = (session.duration ?? 0) * 60_000;
  const activeMs = session.activeDurationMs ?? 0;
  const runningMs = session.status !== 'paused' && session.isActive
    ? Math.max(0, now - Date.parse(session.lastResumedAt ?? session.startedAt ?? '')) : 0;
  return Math.max(0, Math.ceil((totalMs - activeMs - (Number.isFinite(runningMs) ? runningMs : 0)) / 1000));
}

export const PomodoroTimer = () => {
  const { data: runtimeState } = useRuntimeState();
  const queryClient = useQueryClient();
  const getActiveMission = useMissionStore(state => state.getActiveMission);
  const activeMission = getActiveMission();

  const [activeMode, setActiveMode] = useState(SESSION_MODES[0]);
  const [selectedDuration, setSelectedDuration] = useState<number>(SESSION_MODES[0].dur);
  const [timeLeft, setTimeLeft] = useState<number>(SESSION_MODES[0].dur * 60);
  const [status, setStatus] = useState<'idle' | 'running' | 'paused' | 'finished'>('idle');
  const [changing, setChanging] = useState(false);
  
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  const [modeConfirmOpen, setModeConfirmOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<typeof SESSION_MODES[0] | null>(null);

  // Recovery logic: Sync with backend session state
  useEffect(() => {
    if (runtimeState?.sessionContext?.isActive) {
      const session = runtimeState.sessionContext;
      const remaining = focusRemainingSeconds(session);
      const modeId = session.mode;
      const mode = SESSION_MODES.find(m => m.id === modeId) || SESSION_MODES[0];
      
      setActiveMode(mode);
      setSelectedDuration(session.duration ?? mode.dur);
      setTimeLeft(remaining);
      setStatus(session.status === 'paused' ? 'paused' : remaining > 0 ? 'running' : 'finished');
    }
  }, [runtimeState]);

  const applySession = (session: FocusSessionState) => {
    queryClient.setQueryData<RuntimeState>(['runtime-state'], previous => previous
      ? { ...previous, sessionContext: { ...previous.sessionContext, ...session } } : previous);
    if (session.isActive) {
      setTimeLeft(focusRemainingSeconds(session));
      setStatus(session.status === 'paused' ? 'paused' : 'running');
    } else {
      setStatus('idle');
    }
  };

  const handleStartFocus = async () => {
    if (changing) return;
    setChanging(true);
    try {
      const response = await activityService.startFocusSession(selectedDuration, activeMode.id);
      applySession(response.data);
      void queryClient.invalidateQueries({ queryKey: ['runtime-state'] });
    } catch (err) {
      console.error('Failed to start focus session', err);
    } finally {
      setChanging(false);
    }
  };

  const handleStopFocus = async () => {
    try {
      await activityService.stopFocusSession();
      setStatus('idle');
      setTimeLeft(selectedDuration * 60);
      void queryClient.invalidateQueries({ queryKey: ['runtime-state'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (err) {
      console.error('Failed to stop focus session', err);
    }
  };

  const handleCancelFocus = async (): Promise<boolean> => {
    if (changing) return false;
    setChanging(true);
    try {
      await activityService.cancelFocusSession();
      setStatus('idle');
      setTimeLeft(selectedDuration * 60);
      void queryClient.invalidateQueries({ queryKey: ['runtime-state'] });
      return true;
    } catch (err) {
      console.error('Failed to cancel focus session', err);
      void queryClient.invalidateQueries({ queryKey: ['runtime-state'] });
      return false;
    } finally {
      setChanging(false);
    }
  };

  const handleFinished = () => {
    setStatus('finished');
    playFocusChime();
    
    // Log session to the active mission
    const currentMission = useMissionStore.getState().getActiveMission();
    if (currentMission) {
      // Pass duration in minutes and the mode ID
      useMissionStore.getState().logFocusSession(currentMission.id, selectedDuration, activeMode.id);
    }


    
    handleStopFocus();
  };

  useEffect(() => {
    if (status === 'running') {
      // Main timer
      timerRef.current = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            handleFinished();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      // Heartbeat for persistence recovery
      heartbeatRef.current = setInterval(() => {
        activityService.heartbeatFocusSession().catch(() => {});
      }, 30000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const handleStartPause = async () => {
    if (changing) return;
    if (status === 'idle') {
      await handleStartFocus();
    } else if (status === 'running' || status === 'paused') {
      setChanging(true);
      try {
        await queryClient.cancelQueries({ queryKey: ['runtime-state'] });
        const response = status === 'running'
          ? await activityService.pauseFocusSession()
          : await activityService.resumeFocusSession();
        applySession(response.data);
        void queryClient.invalidateQueries({ queryKey: ['runtime-state'] });
      } catch (err) {
        console.error('Failed to change focus session state', err);
        void queryClient.invalidateQueries({ queryKey: ['runtime-state'] });
      } finally {
        setChanging(false);
      }
    }
  };
  
  const handleReset = () => { 
    if (status !== 'idle') {
      void handleCancelFocus();
      return;
    }
    setStatus('idle'); 
    setTimeLeft(selectedDuration * 60); 
  };

  const selectMode = (mode: typeof SESSION_MODES[0]) => {
    if (status === 'idle') {
      setActiveMode(mode);
      setSelectedDuration(mode.dur);
      setStatus('idle');
      setTimeLeft(mode.dur * 60);
    } else {
      setPendingMode(mode);
      setModeConfirmOpen(true);
    }
  };

  const handleConfirmModeChange = async () => {
    if (!pendingMode) return;
    const mode = pendingMode;
    setModeConfirmOpen(false);
    setPendingMode(null);
    if (!await handleCancelFocus()) return;
    setActiveMode(mode);
    setSelectedDuration(mode.dur);
    setStatus('idle');
    setTimeLeft(mode.dur * 60);
  };

  const formatTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const totalSeconds = selectedDuration * 60;
  const progressPercent = ((totalSeconds - timeLeft) / totalSeconds) * 100;
  const radius = 110;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (progressPercent / 100) * circumference;

  return (
    <>
      <div className={`bg-white/60 backdrop-blur-3xl rounded-[40px] p-6 lg:p-8 relative overflow-hidden flex flex-col group transition-all duration-700 w-full shadow-[0_8px_40px_rgba(0,0,0,0.03)] hover:shadow-[0_20px_60px_rgba(0,0,0,0.08)] border border-white/60 shadow-inner ${status === 'running' ? 'ring-2 ring-white/50' : ''}`}>
        
        {/* Top Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10 mb-6">
          <div className="flex items-center gap-4">
            <div className={`w-14 h-14 rounded-[20px] bg-violet-50 flex items-center justify-center text-violet-600 shadow-sm border border-violet-100/50`}>
              <Sparkles size={24} className="opacity-90" />
            </div>
            <div>
              <h3 className="text-2xl font-black text-slate-800 tracking-tight leading-none mb-1">Focus Engine</h3>
              <p className="text-[12px] font-bold text-slate-400">Tactical Timer &bull; {activeMode.label} Mode</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <button 
              onClick={() => document.getElementById('mission-control-rail')?.scrollIntoView({ behavior: 'smooth' })}
              className="flex items-center gap-3 bg-white/50 backdrop-blur-xl border border-white/60 rounded-[20px] px-5 py-3 shadow-[0_2px_10px_rgba(15,23,42,0.02)] transition-all hover:bg-white/70 hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
            >
              <div className="w-8 h-8 rounded-full bg-violet-100/50 flex items-center justify-center border border-violet-200/50 shrink-0">
                <Target size={14} className="text-violet-600" />
              </div>
              <div className="flex flex-col pr-2 text-left">
                <span className="text-[9px] font-black text-violet-600 uppercase tracking-[0.2em]">Active Mission</span>
                <span className="text-[12px] font-bold text-slate-800 leading-tight truncate max-w-[200px]">{activeMission?.title ?? 'No Active Mission'}</span>
              </div>
            </button>
          </div>
        </div>

        {/* Main Grid Area */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-center relative z-10 mb-6">
          
          {/* Left Panel: LIVE INTELLIGENCE */}
          <motion.div 
            animate={{ backgroundColor: `${activeMode.stroke}05`, borderColor: `${activeMode.stroke}15` }}
            transition={{ duration: 0.5 }}
            className="hidden lg:flex lg:col-span-3 flex-col gap-5 rounded-[28px] p-6 border shadow-[0_2px_15px_rgba(15,23,42,0.02)] h-full bg-white/40 backdrop-blur-md"
          >
            <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.15em] flex items-center gap-2">
              <Activity size={14} className={activeMode.color} /> Live Intelligence
            </h4>
            
            <div className="flex flex-col gap-5">
              <div>
                <span className="text-[11px] font-bold text-slate-400 block mb-1">Peak Focus Window</span>
                <span className="text-[15px] font-black text-slate-800">10:00 - 12:30</span>
              </div>
              
              <div>
                <span className="text-[11px] font-bold text-slate-400 block mb-1.5">Focus Efficiency</span>
                <div className="flex items-center gap-3">
                  <span className="text-[15px] font-black text-emerald-500">92%</span>
                  <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                    <motion.div initial={{ width: 0 }} animate={{ width: '92%' }} transition={{ duration: 1, ease: 'easeOut' }} className="h-full bg-emerald-500 rounded-full" />
                  </div>
                </div>
              </div>
              
              <div>
                <span className="text-[11px] font-bold text-slate-400 block mb-1">Distraction Level</span>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
                  <span className="text-[14px] font-bold text-slate-700">Low</span>
                </div>
              </div>

              <div>
                <span className="text-[11px] font-bold text-slate-400 block mb-1">Session Consistency</span>
                <div className="flex items-center justify-between">
                  <span className={`text-[14px] font-bold ${activeMode.color}`}>Great</span>
                  <motion.svg animate={{ stroke: activeMode.stroke }} transition={{ duration: 0.5 }} width="60" height="20" viewBox="0 0 60 20" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M 0 15 Q 5 10, 10 12 T 20 8 T 30 14 T 40 5 T 50 10 T 60 2" />
                  </motion.svg>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Center Area: RADIAL TIMER */}
          <div className="col-span-1 lg:col-span-6 flex flex-col items-center justify-center">
             <div className="relative w-[280px] h-[280px] flex items-center justify-center mb-6 mt-2">
                {/* Ambient breathing glow when running */}
                {status === 'running' && (
                  <motion.div animate={{ scale: [1, 1.05, 1], opacity: [0.15, 0.25, 0.15] }} transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }} className={`absolute inset-0 rounded-full blur-2xl`} style={{ backgroundColor: activeMode.stroke }} />
                )}
                
                {/* SVG Radial Progress */}
                <svg className="w-full h-full transform -rotate-90 relative z-10 filter drop-shadow-[0_0_15px_rgba(15,23,42,0.05)]">
                  {/* Background Track */}
                  <circle cx="140" cy="140" r={radius} fill="transparent" stroke="#f1f5f9" strokeWidth="12" />
                  
                  {/* Animated Progress Ring */}
                  <motion.circle
                    cx="140" cy="140" r={radius} fill="transparent" stroke={activeMode.stroke} strokeWidth="12"
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    strokeLinecap="round"
                    className="transition-all duration-500"
                  />
                  
                  {/* Subtle orbit dots on the ring background */}
                  {Array.from({length: 12}).map((_, i) => (
                      <circle cx={140 + (radius + 20) * Math.cos(i * Math.PI / 6)} cy={140 + (radius + 20) * Math.sin(i * Math.PI / 6)} r="1.5" fill="#cbd5e1" key={i} />
                  ))}
                  
                  {/* Thumb indicator on the progress ring */}
                  <motion.circle 
                     cx={140 + radius * Math.cos(2 * Math.PI * (progressPercent / 100))}
                     cy={140 + radius * Math.sin(2 * Math.PI * (progressPercent / 100))}
                     r="8"
                     fill="white"
                     stroke={activeMode.stroke}
                     strokeWidth="4"
                     className="transition-all duration-500"
                  />
                </svg>

                {/* Center Content */}
                <div className="absolute inset-0 flex flex-col items-center justify-center z-20">
                  <button className={`flex items-center gap-1 text-[11px] font-black ${activeMode.color} mb-1 hover:opacity-80 transition-opacity`}>
                    {activeMode.label} <ChevronDown size={14} />
                  </button>
                  <motion.span 
                    animate={{ scale: status === 'running' ? [1, 1.02, 1] : 1 }} 
                    transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                    className="text-[4.5rem] font-black text-slate-800 tracking-tighter tabular-nums leading-none mb-1 filter drop-shadow-sm"
                  >
                    {formatTime(timeLeft)}
                  </motion.span>
                  <span className={`text-[11px] font-black uppercase tracking-[0.25em] ${status === 'running' ? activeMode.color : 'text-slate-400'}`}>
                    {status === 'running' ? 'In Progress' : status === 'paused' ? 'Paused' : status === 'finished' ? 'Complete' : 'Ready To Focus'}
                  </span>
                </div>
             </div>

             {/* Primary Controls */}
             <div className="flex items-center gap-3 w-full max-w-[280px] px-2">
               <button
                 onClick={handleStartPause}
                 disabled={changing || status === 'finished'}
                 className={`flex-1 py-3 px-6 rounded-[18px] text-[14px] font-black text-white flex items-center justify-center gap-2 transition-all duration-300 shadow-md ${
                   status === 'running' ? 'bg-amber-500 hover:bg-amber-600 hover:shadow-lg hover:-translate-y-0.5' : `${activeMode.bg} ${activeMode.hoverBg} hover:shadow-[0_10px_25px_rgba(15,23,42,0.15)] hover:-translate-y-0.5`
                 }`}
               >
                 {status === 'running' ? <><Pause size={16} fill="currentColor" /> Pause</> : <><Play size={16} fill="currentColor" /> {status === 'paused' ? 'Resume Focus' : 'Start Focus'}</>}
               </button>
               <button
                 onClick={handleReset} disabled={status === 'idle' || changing}
                 className="w-[50px] h-[50px] rounded-[18px] bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-slate-800 hover:shadow-md disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-300 shadow-sm"
               >
                 <RotateCcw size={16} />
               </button>
             </div>
          </div>

          {/* Right Panel: SESSION MEMORY */}
          <motion.div 
            animate={{ backgroundColor: `${activeMode.stroke}05`, borderColor: `${activeMode.stroke}15` }}
            transition={{ duration: 0.5 }}
            className="hidden lg:flex lg:col-span-3 flex-col gap-5 rounded-[28px] p-6 border shadow-[0_2px_15px_rgba(15,23,42,0.02)] h-full bg-white/40 backdrop-blur-md"
          >
             <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.15em] flex items-center gap-2">
               <Clock size={14} className={activeMode.color} /> Session Memory
             </h4>
             
             <div className="flex flex-col gap-4 flex-1">
               <div>
                 <span className="text-[11px] font-bold text-slate-400 block mb-1">Current Mode</span>
                 <span className="text-[14px] font-black text-slate-800 line-clamp-1">{activeMode.label}</span>
               </div>
               
               <div className="flex flex-col gap-3">
                 <div className="flex items-center justify-between">
                   <span className="text-[12px] font-bold text-slate-400">Duration</span>
                   <span className="text-[13px] font-black text-slate-800">{selectedDuration}m</span>
                 </div>
                 <div className="flex items-center justify-between">
                   <span className="text-[12px] font-bold text-slate-400">Session XP</span>
                   <span className="text-[13px] font-black text-emerald-500">+{runtimeState?.sessionContext?.xpThisSession ?? 0}</span>
                 </div>
                 <div className="flex items-center justify-between">
                   <span className="text-[12px] font-bold text-slate-400">Problems</span>
                   <span className="text-[13px] font-black text-slate-800">{runtimeState?.sessionContext?.problemsThisSession ?? 0}</span>
                 </div>
                 <div className="flex items-center justify-between">
                   <span className="text-[12px] font-bold text-slate-400">Focus Score</span>
                   <span className={`text-[13px] font-black ${
                     status === 'running' ? 'text-emerald-500 animate-pulse' : 'text-slate-400'
                   }`}>
                     {status === 'running' ? 'Active' : status === 'finished' ? '100%' : 'Ready'}
                   </span>
                 </div>
               </div>

                <motion.button 
                  animate={{ backgroundColor: `${activeMode.stroke}10`, color: activeMode.stroke, borderColor: `${activeMode.stroke}20` }}
                  whileHover={{ backgroundColor: `${activeMode.stroke}15` }}
                  className="mt-auto w-full py-3 rounded-[16px] font-bold text-[12px] flex items-center justify-center gap-2 transition-colors border shadow-sm"
                >
                 <BarChart2 size={14} /> View Session History
               </motion.button>
             </div>
          </motion.div>
        </div>

        {/* Bottom Mode Selector */}
        <div className="flex justify-center mt-4 relative z-10">
          <div className="flex flex-wrap items-center justify-center gap-2 bg-white/40 backdrop-blur-md border border-white/60 rounded-full px-2 py-2 shadow-inner">
            {SESSION_MODES.map(mode => {
              const isSelected = activeMode.id === mode.id;
              return (
                <button
                  key={mode.id}
                  onClick={() => selectMode(mode)}
                  className={`relative px-5 py-2.5 rounded-full text-[13px] font-bold transition-all duration-300 flex items-center gap-2 hover:-translate-y-0.5 ${
                    isSelected ? `bg-white shadow-[0_4px_12px_rgba(0,0,0,0.06)] ${mode.color}` : 'bg-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <div className={`w-1.5 h-1.5 rounded-full ${isSelected ? mode.bg : 'bg-transparent'}`} />
                  {mode.label}
                </button>
              );
            })}
          </div>
        </div>

      </div>

      <ConfirmationModal
        isOpen={modeConfirmOpen}
        title="Switch Session Mode"
        message={`Are you sure you want to switch to ${pendingMode?.label} mode? This will reset the current running timer.`}
        confirmLabel="Switch Mode"
        cancelLabel="Continue Focus"
        type="warning"
        onConfirm={handleConfirmModeChange}
        onCancel={() => {
          setModeConfirmOpen(false);
          setPendingMode(null);
        }}
      />
    </>
  );
};
