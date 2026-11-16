// frontend/src/features/contests/alerts/contestAlertScheduler.ts

export interface ContestAlertItem {
  id: string;
  name: string;
  platform: string;
  startTime: string | Date;
  url: string;
}

const activeTimers = new Map<string, number>();

/**
 * Requests browser notification permission if not yet decided.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied';
  }
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch (err) {
    console.warn('[contestAlertScheduler] Permission request error:', err);
    return 'default';
  }
}

/**
 * Registers the Service Worker for background and offline contest alerts.
 */
export async function registerContestServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return registration;
  } catch (err) {
    console.warn('[contestAlertScheduler] Service Worker registration failed:', err);
    return null;
  }
}

/**
 * Schedules a local alert 30 minutes before a contest start time.
 */
export function scheduleContestAlert(contest: ContestAlertItem): number | null {
  if (typeof window === 'undefined') return null;

  const startMs = new Date(contest.startTime).getTime();
  const alertMs = startMs - 30 * 60 * 1000;
  const nowMs = Date.now();
  const delayMs = alertMs - nowMs;

  // Clear existing timer for this contest if any
  if (activeTimers.has(contest.id)) {
    window.clearTimeout(activeTimers.get(contest.id));
    activeTimers.delete(contest.id);
  }

  // If the 30-minute alert window has already passed, don't schedule
  if (delayMs < 0) {
    return null;
  }

  // Schedule notification
  const timerId = window.setTimeout(async () => {
    activeTimers.delete(contest.id);

    if (Notification.permission !== 'granted') return;

    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SHOW_CONTEST_NOTIFICATION',
        contestId: contest.id,
        contestName: contest.name,
        platform: contest.platform,
        url: contest.url,
        message: `${contest.name} on ${contest.platform.toUpperCase()} starts in 30 minutes!`,
      });
    } else {
      new Notification(`Upcoming Contest: ${contest.name}`, {
        body: `${contest.name} on ${contest.platform.toUpperCase()} starts in 30 minutes!`,
        icon: '/favicon.svg',
      });
    }
  }, delayMs);

  activeTimers.set(contest.id, timerId);
  return timerId;
}

/**
 * Schedules alerts for multiple upcoming contests if the user has opted in.
 */
export function scheduleAllContestAlerts(
  contests: ContestAlertItem[],
  isOptedIn = true
): void {
  if (!isOptedIn || typeof window === 'undefined' || Notification.permission !== 'granted') {
    return;
  }

  for (const contest of contests) {
    scheduleContestAlert(contest);
  }
}

/**
 * Cancels all pending alert timers.
 */
export function clearScheduledAlerts(): void {
  if (typeof window === 'undefined') return;
  for (const timerId of activeTimers.values()) {
    window.clearTimeout(timerId);
  }
  activeTimers.clear();
}
