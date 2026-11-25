// Telemetry and analytics system for product validation
// Tracks user behavior, engagement quality, and identifies friction points
import { useUserStore } from '../../store/userStore';
import { envConfig } from '../../utils/envCheck';

type TelemetryEvent =
  | 'session_start'
  | 'session_end'
  | 'page_view'
  | 'dsa_problem_view'
  | 'dsa_problem_solve'
  | 'dsa_problem_attempt'
  | 'goal_complete'
  | 'streak_milestone'
  | 'achievement_unlock'
  | 'notification_click'
  | 'search_query'
  | 'keyboard_shortcut'
  | 'navigation_click'
  | 'realtime_sync'
  | 'error_occurred'
  | 'onboarding_step_complete'
  | 'onboarding_step_skip'
  | 'onboarding_complete'
  | 'hesitation'
  | 'abandonment'
  | 'onboarding_confusion'
  | 'notification_dismissal'
  | 'workspace_interruption'
  | 'streak_preservation'
  | 'recovery_success'
  | 'burnout_signal'
  | 'insight_view'
  | 'insight_dismiss'
  | 'suggestion_click'
  | 'challenge_attempt'
  | 'retention_banner_view'
  | 'retention_banner_dismiss';

interface TelemetryPayload {
  event: TelemetryEvent;
  timestamp: number;
  properties: Record<string, unknown>;
  context: {
    page: string;
    viewport: { width: number; height: number };
    userAgent: string;
  };
}

const MAX_QUEUED_EVENTS = 100;
const MAX_KEEPALIVE_BYTES = 60 * 1024;

interface TelemetrySession {
  id: string;
  userId: string;
  clerkSessionId?: string;
  token?: string;
  startedAt: number;
  started: boolean;
  flushing: boolean;
}

async function postObservation(path: string, body: string, token: string, keepalive = false) {
  const response = await fetch(`${envConfig.VITE_API_BASE_URL.replace(/\/$/, '')}/observation/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
    keepalive,
  });
  if (!response.ok) throw new Error(`Observation request failed (${response.status})`);
}

class TelemetryManager {
  private queue: TelemetryPayload[] = [];
  private session?: TelemetrySession;
  private flushInterval?: number;

  initialize() {
    const { user, isAuthenticated } = useUserStore.getState();
    if (this.session || !isAuthenticated || !user) return;

    this.session = {
      id: crypto.randomUUID(),
      userId: user.id,
      startedAt: Date.now(),
      started: false,
      flushing: false,
    };
    this.enqueue(this.makeEvent('session_start', {
      referrer: document.referrer,
      entryPage: window.location.pathname,
    }));
    this.flushInterval = window.setInterval(() => void this.flush(), 30_000);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    void this.flush();
  }

  track(event: TelemetryEvent, properties: Record<string, unknown> = {}) {
    if (this.session && !this.isCurrentUser(this.session)) return;
    this.enqueue(this.makeEvent(event, properties));

    if (import.meta.env.DEV) {
      console.debug('[Telemetry Tracked]', event, properties);
    }

    if (['error_occurred', 'achievement_unlock', 'streak_milestone', 'burnout_signal', 'abandonment'].includes(event)) {
      void this.flush();
    }
  }

  private makeEvent(event: TelemetryEvent, properties: Record<string, unknown>): TelemetryPayload {
    return {
      event,
      timestamp: Date.now(),
      properties,
      context: {
        page: window.location.pathname,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        userAgent: navigator.userAgent,
      },
    };
  }

  private enqueue(event: TelemetryPayload) {
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUED_EVENTS) this.queue.shift();
  }

  private isCurrentUser(session: TelemetrySession) {
    const { user, isAuthenticated } = useUserStore.getState();
    const clerk = window.Clerk?.session;
    return isAuthenticated && user?.id === session.userId &&
      (!session.clerkSessionId || clerk?.id === session.clerkSessionId);
  }

  private async flush() {
    const session = this.session;
    const clerk = window.Clerk?.session;
    if (!session || !clerk || session.flushing || !this.isCurrentUser(session)) return;

    session.clerkSessionId = clerk.id;
    session.flushing = true;
    try {
      const token: string | null = await clerk.getToken();
      if (this.session !== session || !this.isCurrentUser(session)) return;
      session.token = token ?? undefined;
      if (!token) return;

      if (!session.started) {
        await postObservation('session/start', JSON.stringify({
          sessionId: session.id,
          deviceInfo: {
            userAgent: navigator.userAgent,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            deviceType: 'desktop',
          },
        }), token);
        session.started = true;
      }

      if (this.session === session && this.isCurrentUser(session)) {
        await this.sendEvents(session, token);
      }
    } catch (error) {
      console.warn('[Telemetry] Observation sync failed:', error);
    } finally {
      session.flushing = false;
    }
  }

  private async sendEvents(session: TelemetrySession, token: string, keepalive = false) {
    let count = this.queue.length;
    while (count > 0) {
      const events = this.queue.slice(-count);
      const body = JSON.stringify({
        sessionId: session.id,
        events: events.map(event => ({ ...event, sessionId: session.id, userId: session.userId })),
      });
      if (keepalive && new TextEncoder().encode(body).byteLength > MAX_KEEPALIVE_BYTES) {
        count = Math.floor(count / 2);
        continue;
      }

      this.queue.splice(-count);
      try {
        await postObservation('events', body, token, keepalive);
      } catch (error) {
        if (this.session === session && this.isCurrentUser(session)) {
          this.queue = [...events, ...this.queue]
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(-MAX_QUEUED_EVENTS);
        }
        throw error;
      }
      return;
    }
  }

  private flushKeepalive(session: TelemetrySession) {
    // Use the token acquired while the page was active so fetch starts during the event.
    if (!session.started || !session.token || !this.isCurrentUser(session)) return;
    void this.sendEvents(session, session.token, true).catch(() => {});
  }

  private onVisibilityChange = () => {
    if (document.visibilityState === 'hidden' && this.session) {
      this.flushKeepalive(this.session);
    } else {
      void this.flush();
    }
  };

  private onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted && this.session) {
      this.flushKeepalive(this.session);
    } else {
      this.destroy();
    }
  };

  destroy() {
    const session = this.session;
    if (!session) return;

    window.clearInterval(this.flushInterval);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    if (session.started && session.token && this.isCurrentUser(session)) {
      this.enqueue(this.makeEvent('session_end', { duration: Date.now() - session.startedAt }));
      this.flushKeepalive(session);
      void postObservation('session/end', JSON.stringify({ sessionId: session.id }), session.token, true)
        .catch(() => {});
    }

    this.session = undefined;
    this.queue = [];
  }
}

export const telemetry = new TelemetryManager();

// Convenience functions for common events
export const trackPageView = (page: string) => {
  telemetry.track('page_view', { page });
};

export const trackDsaProblemSolve = (problemId: string, difficulty: string, timeTaken: number) => {
  telemetry.track('dsa_problem_solve', {
    problemId,
    difficulty,
    timeTaken,
  });
};

export const trackGoalComplete = (goalId: string, goalType: string) => {
  telemetry.track('goal_complete', {
    goalId,
    goalType,
  });
};

export const trackAchievementUnlock = (achievementId: string, category: string) => {
  telemetry.track('achievement_unlock', {
    achievementId,
    category,
  });
};

export const trackStreakMilestone = (streakDays: number) => {
  telemetry.track('streak_milestone', {
    streakDays,
  });
};

export const trackKeyboardShortcut = (shortcut: string, context: string) => {
  telemetry.track('keyboard_shortcut', {
    shortcut,
    context,
  });
};

export const trackError = (error: Error, context: string) => {
  telemetry.track('error_occurred', {
    errorMessage: error.message,
    errorStack: error.stack,
    context,
  });
};

// --- Observation & Friction Tracking ---
export const trackHesitation = (element: string, context: Record<string, unknown> = {}) => {
  telemetry.track('hesitation', {
    element,
    severity: 'low',
    ...context,
  });
};

export const trackAbandonment = (page: string, context: Record<string, unknown> = {}) => {
  telemetry.track('abandonment', {
    element: page,
    severity: 'medium',
    ...context,
  });
};

export const trackOnboardingConfusion = (step: string, context: Record<string, unknown> = {}) => {
  telemetry.track('onboarding_confusion', {
    element: `onboarding_step_${step}`,
    step,
    severity: 'medium',
    ...context,
  });
};

export const trackNotificationDismissal = (
  notificationId: string,
  context: Record<string, unknown> = {}
) => {
  telemetry.track('notification_dismissal', {
    element: `notification_${notificationId}`,
    notificationId,
    severity: 'low',
    ...context,
  });
};

export const trackWorkspaceInterruption = (element: string, context: Record<string, unknown> = {}) => {
  telemetry.track('workspace_interruption', {
    element,
    severity: 'medium',
    ...context,
  });
};

export const trackStreakPreservation = (streakDays: number, context: Record<string, unknown> = {}) => {
  telemetry.track('streak_preservation', {
    element: 'streak_shield',
    streakDays,
    ...context,
  });
};

export const trackRecoverySuccess = (context: Record<string, unknown> = {}) => {
  telemetry.track('recovery_success', {
    element: 'recovery_center',
    ...context,
  });
};

export const trackBurnoutSignal = (reason: string, context: Record<string, unknown> = {}) => {
  telemetry.track('burnout_signal', {
    element: 'burnout_monitor',
    reason,
    severity: 'high',
    ...context,
  });
};

export const trackInsightView = (insightId: string, type: string) => {
  telemetry.track('insight_view', { insightId, type });
};

export const trackInsightDismiss = (insightId: string, type: string) => {
  telemetry.track('insight_dismiss', { insightId, type });
};

export const trackSuggestionClick = (suggestionId: string, type: string) => {
  telemetry.track('suggestion_click', { suggestionId, type });
};

export const trackChallengeAttempt = (challengeId: string, platform: string) => {
  telemetry.track('challenge_attempt', { challengeId, platform });
};

export const trackRetentionBannerView = (type: string, message: string) => {
  telemetry.track('retention_banner_view', { type, message });
};

export const trackRetentionBannerDismiss = (type: string) => {
  telemetry.track('retention_banner_dismiss', { type });
};
