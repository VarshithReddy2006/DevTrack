// src/modules/xp/rules.ts — Centralized XP reward rules
// Deterministic, configurable, easily extensible reward table.
// All XP calculations MUST go through this module.

export type DifficultyLevel = 'easy' | 'medium' | 'hard';

// ─── Level thresholds (XP required to reach each level) ───────────────────

export const MAX_LEVEL = 15;

export const XP_LEVEL_THRESHOLDS: Record<number, number> = {
  1: 0,
  2: 100,
  3: 250,
  4: 500,
  5: 850,
  6: 1250,
  7: 1750,
  8: 2400,
  9: 3150,
  10: 4000,
  11: 5000,
  12: 6200,
  13: 7600,
  14: 9200,
  15: 11000,
};

// ─── XP rewards by source ─────────────────────────────────────────────────

export const XP_REWARDS = {
  // DSA problem rewards
  dsaAccepted: {
    easy: 10,
    medium: 25,
    hard: 50,
  },

  // Contest participation
  contestParticipated: 40,

  // Streak rewards
  dailyStreak: 15,
  weeklyStreak: 75,

  // Sync milestone rewards
  syncCompleted: 5,
  firstPlatformSync: 50,

  // Spaced repetition review rewards
  revisionReview: 5,

  // Milestone bonuses (problem counts)
  milestone: {
    10: 25,   // 10 problems solved
    25: 50,   // 25 problems solved
    50: 100,  // 50 problems solved
    100: 200, // 100 problems solved
    200: 400, // 200 problems solved
    500: 1000, // 500 problems solved
  },
} as const;

// ─── Level helpers ─────────────────────────────────────────────────────────

export interface XpLevelInfo {
  level: number;
  xpToNextLevel: number;
  xpInCurrentLevel: number;
  progressPercent: number;
  isMaxLevel: boolean;
}

export function calculateLevel(totalXp: number): number {
  let level = 1;
  for (const [lvl, threshold] of Object.entries(XP_LEVEL_THRESHOLDS)) {
    if (totalXp >= threshold) {
      level = parseInt(lvl, 10);
    } else {
      break;
    }
  }
  return Math.min(level, MAX_LEVEL);
}

export function getXpLevelInfo(totalXp: number): XpLevelInfo {
  const currentLevel = calculateLevel(totalXp);
  const isMaxLevel = currentLevel >= MAX_LEVEL;
  
  const thresholds = Object.entries(XP_LEVEL_THRESHOLDS).sort((a, b) => Number(a[0]) - Number(b[0]));
  const prevLevelEntry = thresholds.find(([lvl]) => Number(lvl) === currentLevel - 1);
  const currentThreshold = prevLevelEntry ? Number(prevLevelEntry[1]) : 0;
  const nextLevelEntry = thresholds.find(([lvl]) => Number(lvl) === currentLevel + 1);
  
  const xpInCurrentLevel = Math.max(0, totalXp - currentThreshold);
  const xpToNextLevel = isMaxLevel ? 0 : (nextLevelEntry ? Math.max(0, Number(nextLevelEntry[1]) - totalXp) : 0);
  
  const progressPercent = isMaxLevel ? 100 : (() => {
    if (!nextLevelEntry) return 100;
    const nextThreshold = Number(nextLevelEntry[1]);
    const range = nextThreshold - currentThreshold;
    if (range <= 0) return 100;
    return Math.min(100, Math.round(((totalXp - currentThreshold) / range) * 100));
  })();

  return {
    level: currentLevel,
    xpToNextLevel,
    xpInCurrentLevel,
    progressPercent,
    isMaxLevel,
  };
}

export function xpToNextLevel(currentXp: number, currentLevel: number): number {
  const isMaxLevel = currentLevel >= MAX_LEVEL;
  if (isMaxLevel) return 0;
  
  const thresholds = Object.entries(XP_LEVEL_THRESHOLDS).sort((a, b) => Number(a[0]) - Number(b[0]));
  const nextLevelEntry = thresholds.find(([lvl]) => Number(lvl) === currentLevel + 1);
  if (!nextLevelEntry) return 0; // max level
  const nextThreshold = Number(nextLevelEntry[1]);
  return Math.max(0, nextThreshold - currentXp);
}

export function xpInCurrentLevel(totalXp: number, currentLevel: number): number {
  const thresholds = Object.entries(XP_LEVEL_THRESHOLDS).sort((a, b) => Number(a[0]) - Number(b[0]));
  const prevLevelEntry = thresholds.find(([lvl]) => Number(lvl) === currentLevel - 1);
  const currentThreshold = prevLevelEntry ? Number(prevLevelEntry[1]) : 0;
  return Math.max(0, totalXp - currentThreshold);
}

export function xpProgressPercent(totalXp: number, currentLevel: number): number {
  const thresholds = Object.entries(XP_LEVEL_THRESHOLDS).sort((a, b) => Number(a[0]) - Number(b[0]));
  const prevLevelEntry = thresholds.find(([lvl]) => Number(lvl) === currentLevel - 1);
  const currentThreshold = prevLevelEntry ? Number(prevLevelEntry[1]) : 0;
  const nextLevelEntry = thresholds.find(([lvl]) => Number(lvl) === currentLevel + 1);
  if (!nextLevelEntry) return 100;
  const nextThreshold = Number(nextLevelEntry[1]);
  const range = nextThreshold - currentThreshold;
  if (range <= 0) return 100;
  return Math.min(100, Math.round(((totalXp - currentThreshold) / range) * 100));
}

export function calculateMilestoneXp(totalSolved: number): number {
  let milestoneXp = 0;
  const milestones = Object.keys(XP_REWARDS.milestone)
    .map(Number)
    .sort((a, b) => b - a);
  for (const milestone of milestones) {
    if (totalSolved >= milestone) {
      milestoneXp = XP_REWARDS.milestone[milestone as keyof typeof XP_REWARDS.milestone];
      break;
    }
  }
  return milestoneXp;
}

// ─── Difficulty helper ──────────────────────────────────────────────────────

export function xpForDifficulty(difficulty: DifficultyLevel | null | undefined): number {
  if (!difficulty) return XP_REWARDS.dsaAccepted.medium;
  return XP_REWARDS.dsaAccepted[difficulty] ?? XP_REWARDS.dsaAccepted.medium;
}

// ─── Streak bonus calculator ────────────────────────────────────────────────

export function calculateStreakBonus(currentStreak: number): number {
  if (currentStreak < 7) return 0; // No bonus for streaks under 7 days

  // Weekly milestone bonuses
  const weeklyBonus = Math.floor(currentStreak / 7) * XP_REWARDS.weeklyStreak;
  return weeklyBonus;
}

export function calculateStreakMultiplier(currentStreak: number): number {
  // Base multiplier + bonus per week of streak
  const baseMultiplier = 1.0;
  const weeklyBonus = Math.floor(currentStreak / 7) * 0.1; // 10% per week
  return Math.min(baseMultiplier + weeklyBonus, 2.0); // Cap at 2x
}