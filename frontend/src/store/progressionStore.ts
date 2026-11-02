import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

// ---------------------------------------------------------------------------
// Gamification Types
// ---------------------------------------------------------------------------
export const LEVEL_NAMES: Record<number, { name: string; title: string; color: string }> = {
  1:  { name: 'Newcomer',       title: 'Just getting started',    color: '#94A3B8' },
  2:  { name: 'Initiate',       title: 'Building the habit',      color: '#64748B' },
  3:  { name: 'Apprentice',     title: 'Consistency forming',     color: '#3B82F6' },
  4:  { name: 'Developer',      title: 'Solving real problems',   color: '#06B6D4' },
  5:  { name: 'Engineer',       title: 'Thinking in systems',     color: '#8B5CF6' },
  6:  { name: 'Senior Dev',     title: 'Patterns recognized',     color: '#7C5CFC' },
  7:  { name: 'Tech Lead',      title: 'Mentoring through code',  color: '#6D28D9' },
  8:  { name: 'Architect',      title: 'Designing at scale',      color: '#F59E0B' },
  9:  { name: 'Principal',      title: 'Shaping the roadmap',     color: '#F97316' },
  10: { name: 'Staff Engineer', title: 'Multiplying impact',      color: '#EF4444' },
  11: { name: 'Distinguished',  title: 'Industry recognized',     color: '#EC4899' },
  12: { name: 'Fellow',         title: 'Defining the craft',      color: '#10B981' },
  13: { name: 'Legend',         title: 'Inspiring thousands',     color: '#F59E0B' },
  14: { name: 'Grandmaster',    title: 'Beyond the algorithm',    color: '#8B5CF6' },
  15: { name: 'Mythic',         title: 'The 0.1%',                color: '#7C5CFC' },
};

const MAX_LEVEL = 15;

export function getLevelInfo(level: number): { name: string; title: string; color: string } {
  if (level <= MAX_LEVEL) {
    return LEVEL_NAMES[level] ?? LEVEL_NAMES[1]!;
  }
  const mythic = LEVEL_NAMES[MAX_LEVEL]!;
  return {
    name: `Mythic (Lvl ${level})`,
    title: mythic.title,
    color: mythic.color,
  };
}

export function isMaxLevel(level: number): boolean {
  return level >= MAX_LEVEL;
}

export interface AchievementPayload {
  id: string;
  name: string;
  description: string;
  icon: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
}

export interface LevelUpData {
  newLevel: number;
  totalXp: number;
}

export interface ChallengeCompletedPayload {
  challengeId: string;
  title: string;
  xpReward: number;
}

export type OverlayType = 'level_up' | 'streak_milestone' | 'achievement_unlocked' | 'challenge_completed';

export interface OverlayItem {
  type: OverlayType;
  data: LevelUpData | { days: number } | AchievementPayload | ChallengeCompletedPayload;
}

const OVERLAY_PRIORITY: Record<OverlayType, number> = {
  level_up: 0,
  streak_milestone: 1,
  challenge_completed: 2,
  achievement_unlocked: 3,
};

const OVERLAY_GAP_MS = 500;

// ---------------------------------------------------------------------------
// Mission Types
// ---------------------------------------------------------------------------
export type MissionStatus = 'planned' | 'active' | 'accelerating' | 'stable' | 'blocked' | 'completed' | 'archived';
export type MissionPriority = 'critical' | 'high' | 'medium' | 'low';
export type MissionCategory = 'frontend' | 'backend' | 'architecture' | 'learning' | 'bugfix' | 'dsa' | 'other';

export interface MissionSession {
  id: string;
  type: string;
  durationMinutes: number;
  contributionScore: number;
  timestamp: string;
  quality: string;
}

export interface Mission {
  id: string;
  title: string;
  description: string;
  status: MissionStatus;
  priority: MissionPriority;
  category: MissionCategory;
  progress: number;
  executionConfidence: number;
  velocity: number;
  linkedTasks: number;
  completedTasks: number;
  focusSessions: number;
  focusHours: number;
  deepWorkHours: number;
  createdAt: string;
  updatedAt: string;
  deadline?: string;
  estimatedHours: number;
  actualHours: number;
  tags: string[];
  aiInsight: string;
  health: 'healthy' | 'at-risk' | 'critical';
  blocked: boolean;
  streakContribution: number;
  notes: string;
  sessions: MissionSession[];
}

const defaultMissions: Mission[] = [
  {
    id: 'm1',
    title: 'DevTrack Runtime Stabilization',
    description: 'Stabilize core runtime systems and improve focus synchronization.',
    status: 'active',
    priority: 'high',
    category: 'backend',
    progress: 45,
    executionConfidence: 72,
    velocity: 92,
    linkedTasks: 7,
    completedTasks: 3,
    focusSessions: 24,
    focusHours: 18,
    deepWorkHours: 14,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    estimatedHours: 40,
    actualHours: 18,
    tags: ['runtime', 'stability', 'focus-engine'],
    aiInsight: 'Focus consistency improving delivery velocity.',
    health: 'healthy',
    blocked: false,
    streakContribution: 12,
    notes: '',
    sessions: []
  },
  {
    id: 'm2',
    title: 'AI Telemetry Engine',
    description: 'Build neural coaching analytics and telemetry aggregation.',
    status: 'accelerating',
    priority: 'critical',
    category: 'architecture',
    progress: 80,
    executionConfidence: 88,
    velocity: 105,
    linkedTasks: 12,
    completedTasks: 9,
    focusSessions: 18,
    focusHours: 12.5,
    deepWorkHours: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    estimatedHours: 15,
    actualHours: 12.5,
    tags: ['ai', 'analytics', 'telemetry'],
    aiInsight: 'Recent burst of deep work accelerated completion timeline.',
    health: 'healthy',
    blocked: false,
    streakContribution: 8,
    notes: '',
    sessions: []
  }
];

// ---------------------------------------------------------------------------
// Combined Progression Interface
// ---------------------------------------------------------------------------
interface ProgressionState {
  // --- Live Gamification metrics ---
  liveXp: number | null;
  liveLevel: number | null;
  liveStreak: number | null;
  liveFocusStreak: number | null;
  pendingXpGain: number | null;
  pendingXpReason: string | null;
  xpRevealQueue: Array<{ gain: number; reason: string | null }>;
  isRevealingXp: boolean;
  sessionXpTotal: number;
  overlayQueue: OverlayItem[];
  activeOverlay: OverlayItem | null;

  setLiveXp: (xp: number) => void;
  setLiveLevel: (level: number) => void;
  setLiveStreak: (streak: number) => void;
  setLiveFocusStreak: (streak: number) => void;
  setPendingXpGain: (gain: number | null, reason?: string | null) => void;
  enqueueXpReveal: (gain: number, reason: string | null) => void;
  triggerNextXpReveal: () => void;
  resetSessionXpTotal: () => void;
  triggerLevelUp: (newLevel: number, totalXp: number) => void;
  triggerStreakMilestone: (days: number) => void;
  triggerAchievementUnlock: (payload: AchievementPayload) => void;
  triggerChallengeCompleted: (payload: ChallengeCompletedPayload) => void;
  dismissCurrentOverlay: () => void;
  resetGamification: () => void;

  // --- Missions Section ---
  missions: Mission[];
  activeMissionId: string | null;
  setActiveMission: (id: string) => void;
  getActiveMission: () => Mission | undefined;
  createMission: (missionData: Partial<Mission>) => void;
  updateMission: (id: string, updates: Partial<Mission>) => void;
  deleteMission: (id: string) => void;
  archiveMission: (id: string) => void;
  completeMission: (id: string) => void;
  updateMissionNotes: (id: string, notes: string) => void;
  logFocusSession: (missionId: string, durationMinutes: number, mode: string) => void;
}

// Helper for gamification overlays
function enqueueOverlay(state: any, item: OverlayItem): Partial<ProgressionState> {
  if (state.activeOverlay === null) {
    return { activeOverlay: item };
  }
  const newQueue = [...state.overlayQueue, item].sort(
    (a: OverlayItem, b: OverlayItem) => OVERLAY_PRIORITY[a.type] - OVERLAY_PRIORITY[b.type]
  );
  return { overlayQueue: newQueue };
}

// ---------------------------------------------------------------------------
// Unified Store with Persistent Missions
// ---------------------------------------------------------------------------
export const useProgressionStore = create<ProgressionState>()(
  devtools(
    persist(
      (set, get) => ({
        // --- Gamification initial values ---
        liveXp: null,
        liveLevel: null,
        liveStreak: null,
        liveFocusStreak: null,
        pendingXpGain: null,
        pendingXpReason: null,
        xpRevealQueue: [],
        isRevealingXp: false,
        sessionXpTotal: 0,
        overlayQueue: [],
        activeOverlay: null,

        setLiveXp: (xp) => set({ liveXp: xp }),
        setLiveLevel: (level) => set({ liveLevel: level }),
        setLiveStreak: (streak) => set({ liveStreak: streak }),
        setLiveFocusStreak: (streak) => set({ liveFocusStreak: streak }),
        setPendingXpGain: (gain, reason) => set({ pendingXpGain: gain, pendingXpReason: reason || null }),

        enqueueXpReveal: (gain, reason) => {
          set((state) => {
            const xpRevealQueue = [...state.xpRevealQueue, { gain, reason }];
            const sessionXpTotal = state.sessionXpTotal + gain;
            return { xpRevealQueue, sessionXpTotal };
          });
          if (!get().isRevealingXp) {
            set({ isRevealingXp: true });
            get().triggerNextXpReveal();
          }
        },

        triggerNextXpReveal: () => {
          const { xpRevealQueue, sessionXpTotal } = get();
          if (xpRevealQueue.length === 0) {
            if (sessionXpTotal > 0) {
              set({
                pendingXpGain: sessionXpTotal,
                pendingXpReason: 'Total XP Gained',
                isRevealingXp: false,
                sessionXpTotal: 0,
              });
            } else {
              set({ isRevealingXp: false });
            }
            return;
          }
          const [nextItem, ...remainingQueue] = xpRevealQueue;
          set({
            xpRevealQueue: remainingQueue,
            pendingXpGain: nextItem.gain,
            pendingXpReason: nextItem.reason,
          });
          setTimeout(() => {
            set({ pendingXpGain: null, pendingXpReason: null });
            setTimeout(() => {
              get().triggerNextXpReveal();
            }, 300);
          }, 1200);
        },

        resetSessionXpTotal: () => {
          set({
            sessionXpTotal: 0,
            xpRevealQueue: [],
            isRevealingXp: false,
            pendingXpGain: null,
            pendingXpReason: null,
          });
        },

        triggerLevelUp: (newLevel, totalXp) =>
          set((state) => ({
            ...enqueueOverlay(state, { type: 'level_up', data: { newLevel, totalXp } }),
            liveLevel: newLevel,
          })),

        triggerStreakMilestone: (days) =>
          set((state) => ({
            ...enqueueOverlay(state, { type: 'streak_milestone', data: { days } }),
            liveStreak: days,
          })),

        triggerAchievementUnlock: (payload) =>
          set((state) => enqueueOverlay(state, { type: 'achievement_unlocked', data: payload })),

        triggerChallengeCompleted: (payload) =>
          set((state) => enqueueOverlay(state, { type: 'challenge_completed', data: payload })),

        dismissCurrentOverlay: () => {
          const { overlayQueue } = get();
          if (overlayQueue.length > 0) {
            const [next, ...rest] = overlayQueue;
            setTimeout(() => {
              set({ activeOverlay: next, overlayQueue: rest });
            }, OVERLAY_GAP_MS);
            set({ activeOverlay: null });
          } else {
            set({ activeOverlay: null });
          }
        },

        resetGamification: () => set({
          liveXp: null,
          liveLevel: null,
          liveStreak: null,
          liveFocusStreak: null,
          pendingXpGain: null,
          pendingXpReason: null,
          xpRevealQueue: [],
          isRevealingXp: false,
          sessionXpTotal: 0,
          overlayQueue: [],
          activeOverlay: null,
        }),

        // --- Missions ---
        missions: defaultMissions,
        activeMissionId: defaultMissions[0].id,
        setActiveMission: (id: string) => set({ activeMissionId: id }),
        getActiveMission: () => {
          const { missions, activeMissionId } = get();
          return missions.find(m => m.id === activeMissionId);
        },

        createMission: (missionData) => set((state) => {
          const newMission: Mission = {
            id: `m-${Date.now()}`,
            title: missionData.title || 'Untitled Mission',
            description: missionData.description || '',
            status: missionData.status || 'planned',
            priority: missionData.priority || 'medium',
            category: missionData.category || 'other',
            progress: missionData.progress || 0,
            executionConfidence: missionData.executionConfidence || 50,
            velocity: missionData.velocity || 0,
            linkedTasks: missionData.linkedTasks || 0,
            completedTasks: missionData.completedTasks || 0,
            focusSessions: missionData.focusSessions || 0,
            focusHours: missionData.focusHours || 0,
            deepWorkHours: missionData.deepWorkHours || 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deadline: missionData.deadline,
            estimatedHours: missionData.estimatedHours || 10,
            actualHours: missionData.actualHours || 0,
            tags: missionData.tags || [],
            aiInsight: missionData.aiInsight || 'Mission initialized. Awaiting execution data.',
            health: missionData.health || 'healthy',
            blocked: missionData.blocked || false,
            streakContribution: missionData.streakContribution || 0,
            notes: missionData.notes || '',
            sessions: missionData.sessions || [],
          };
          return { missions: [newMission, ...state.missions], activeMissionId: newMission.id };
        }),

        updateMission: (id, updates) => set((state) => ({
          missions: state.missions.map(m => m.id === id ? { ...m, ...updates, updatedAt: new Date().toISOString() } : m)
        })),

        deleteMission: (id) => set((state) => ({
          missions: state.missions.filter(m => m.id !== id),
          activeMissionId: state.activeMissionId === id ? (state.missions.find(m => m.id !== id)?.id || null) : state.activeMissionId
        })),

        archiveMission: (id) => set((state) => ({
          missions: state.missions.map(m => m.id === id ? { ...m, status: 'archived', updatedAt: new Date().toISOString() } : m)
        })),

        completeMission: (id) => set((state) => ({
          missions: state.missions.map(m => m.id === id ? { ...m, status: 'completed', progress: 100, updatedAt: new Date().toISOString() } : m)
        })),

        updateMissionNotes: (id, notes) => set((state) => ({
          missions: state.missions.map(m => m.id === id ? { ...m, notes, updatedAt: new Date().toISOString() } : m)
        })),

        logFocusSession: (missionId, durationMinutes, mode) => set((state) => {
          const hours = durationMinutes / 60;
          return {
            missions: state.missions.map(m => {
              if (m.id !== missionId) return m;
              let confMultiplier = 1;
              let velMultiplier = 1;
              if (mode === 'deep_work') confMultiplier = 2.5;
              if (mode === 'debug') velMultiplier = 2.0;
              if (mode === 'learn') confMultiplier = 0.5;

              const newFocusHours = m.focusHours + hours;
              const newDeepWorkHours = mode === 'deep_work' ? m.deepWorkHours + hours : m.deepWorkHours;
              const newActualHours = m.actualHours + hours;
              const newConfidence = Math.min(100, (m.executionConfidence || 0) + (hours * 5 * confMultiplier));
              const newVelocity = Math.min(200, (m.velocity || 0) + (hours * 10 * velMultiplier));
              const score = Math.round(hours * 10 * confMultiplier);
              
              const newSession: MissionSession = {
                id: `sess-${Date.now()}`,
                type: mode === 'deep_work' ? 'Deep Work' : mode === 'debug' ? 'Debugging' : mode === 'learn' ? 'Learning' : 'Standard',
                durationMinutes,
                contributionScore: score,
                timestamp: new Date().toISOString(),
                quality: score > 15 ? 'Excellent' : score > 5 ? 'Good' : 'Standard',
              };

              let generatedInsight = m.aiInsight;
              if (newConfidence > 80 && newVelocity > 80) {
                generatedInsight = 'High focus quality correlates with delivery acceleration. Momentum is strong.';
              } else if (newVelocity > (m.velocity || 0) + 15) {
                generatedInsight = 'Velocity spike detected following intense execution blocks.';
              } else if (newConfidence > (m.executionConfidence || 0) + 10) {
                generatedInsight = 'Execution consistency is visibly improving confidence levels.';
              } else if (hours > 2 && mode !== 'deep_work') {
                generatedInsight = 'Prolonged shallow work detected. Consider a deep work block next.';
              } else if (score > 10) {
                generatedInsight = 'Solid operational focus. Target progressing smoothly.';
              }

              return {
                ...m,
                focusSessions: (m.focusSessions || 0) + 1,
                focusHours: Number(newFocusHours.toFixed(2)),
                deepWorkHours: Number(newDeepWorkHours.toFixed(2)),
                actualHours: Number(newActualHours.toFixed(2)),
                executionConfidence: Math.round(newConfidence),
                velocity: Math.round(newVelocity),
                streakContribution: (m.streakContribution || 0) + 1,
                aiInsight: generatedInsight,
                sessions: [newSession, ...(m.sessions || [])].slice(0, 50),
                updatedAt: new Date().toISOString(),
              };
            })
          };
        }),
      }),
      {
        name: 'mission-storage',
        skipHydration: true,
        partialize: (state) => ({
          missions: state.missions,
          activeMissionId: state.activeMissionId,
        }),
      }
    ),
    { name: 'ProgressionStore' }
  )
);
