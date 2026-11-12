import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '../store/userStore';
import { useUIStore } from '../store/uiStore';
import { applyTheme } from '../store/appStateStore';
import { useSse } from '../hooks/useSse';
import { useUserObservation } from '../hooks/useUserObservation';
import { initTelemetry } from '../lib/telemetry';
import { telemetry } from '../lib/telemetry/analytics';
import { handleSseEvent } from '../features/realtime/eventHandlers';
import { RealtimeLayer } from './RealtimeLayer';
import { RuntimeDebugPanel } from '../features/debug/RuntimeDebugPanel';
import { LevelUpOverlay } from '../features/gamification/overlays/LevelUpOverlay';
import { StreakMilestoneOverlay } from '../features/gamification/overlays/StreakMilestoneOverlay';
import { AchievementUnlockOverlay } from '../features/gamification/overlays/AchievementUnlockOverlay';
import { ChallengeCompletedOverlay } from '../features/gamification/overlays/ChallengeCompletedOverlay';
import { useXpState } from '../features/gamification/hooks/useXpState';

interface AppProvidersProps {
  children: React.ReactNode;
}

function getRarityTheme(level: number) {
  if (level >= 13) return { color: '#EC4899', rgb: '236, 72, 153' }; // Legendary
  if (level >= 10) return { color: '#F59E0B', rgb: '245, 158, 11' }; // Epic
  if (level >= 7)  return { color: '#8B5CF6', rgb: '139, 92, 246' }; // Rare
  if (level >= 4)  return { color: '#3B82F6', rgb: '59, 130, 246' }; // Uncommon
  return { color: '#94A3B8', rgb: '148, 163, 184' }; // Common
}

/** Wires theme, SSE, and lightweight telemetry for authenticated sessions */
export function AppProviders({ children }: AppProvidersProps) {
  const isAuthenticated = useUserStore((s) => s.isAuthenticated);
  const telemetryUserId = useUserStore((s) => s.user?.id);
  const queryClient = useQueryClient();
  const { liveLevel } = useXpState();

  const setLastSseEvent = useUIStore((s) => (s as any).setLastSseEvent);

  useSse({
    enabled: isAuthenticated,
    onEvent: (event) => {
      // Persist latest SSE event for lightweight UI consumers (avoid duplicating EventSource subscriptions)
      try {
        setLastSseEvent?.(event);
      } catch {
        // ignore
      }
      handleSseEvent(event, queryClient);
    },
  });

  useUserObservation(isAuthenticated);

  const theme = useUIStore((s) => s.theme);

  // Mount-only initialization
  useEffect(() => {
    initTelemetry();
  }, []);

  // Theme application and system media query listener
  useEffect(() => {
    applyTheme(theme);
    const mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mediaQuery) return;

    const handleSystemChange = () => {
      if (useUIStore.getState().theme === 'system') {
        applyTheme('system');
      }
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleSystemChange);
      return () => mediaQuery.removeEventListener('change', handleSystemChange);
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(handleSystemChange);
      return () => mediaQuery.removeListener(handleSystemChange);
    }
  }, [theme]);

  useEffect(() => {
    if (!isAuthenticated || !telemetryUserId) return;

    telemetry.initialize();
    return () => telemetry.destroy();
  }, [isAuthenticated, telemetryUserId]);

  useEffect(() => {
    const levelToUse = isAuthenticated ? liveLevel : 1;
    const theme = getRarityTheme(levelToUse);
    document.documentElement.style.setProperty('--level-color', theme.color);
    document.documentElement.style.setProperty('--level-color-rgb', theme.rgb);
  }, [liveLevel, isAuthenticated]);


  return (
    <>
      {children}
      <RealtimeLayer />
      <RuntimeDebugPanel />
      {/* Gamification celebration overlays — rendered above everything */}
      <LevelUpOverlay />
      <StreakMilestoneOverlay />
      <AchievementUnlockOverlay />
      <ChallengeCompletedOverlay />
    </>
  );
}
