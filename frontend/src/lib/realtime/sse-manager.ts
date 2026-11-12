// Reconnect-safe SSE store — complements useSse hook for progression events
//
// Resilience features:
// - Exponential backoff with full jitter; the attempt counter is only reset
//   once a connection has stayed open for STABLE_CONNECTION_MS.
// - Browser online/offline awareness: retries pause while offline and an
//   immediate reconnect (with a fresh handshake ticket) fires on `online`.
// - Monotonic sequence tracking to drop replayed/duplicate events, with an
//   ID-based fallback for events that carry no sequence number.
// - Snapshot reset: a `runtime_state_full` envelope replaces local state and
//   invalidates TanStack Query caches so the UI resynchronises.

import { create } from 'zustand';
import { queryClient } from '../queryClient';
import { useUserStore } from '../../store/userStore';

export type SseEventType =
  | 'xp_updated'
  | 'level_up'
  | 'streak_milestone'
  | 'streak_at_risk'
  | 'badge_earned'
  | 'goal_completed'
  | 'goal_progress'
  | 'challenge_updated'
  | 'challenge_completed'
  | 'notification'
  | 'session_event'
  | 'comeback_trigger'
  | 'fatigue_warning'
  | 'sync_started'
  | 'sync_completed'
  | 'sync_failed'
  | 'new_submission'
  | 'runtime_state_full';

export interface SseEvent {
  type: SseEventType;
  timestamp: string;
  userId?: string;
  /** Server event ID (SSE `id:` field or envelope `id`). */
  id?: string;
  /** Per-user monotonic sequence number, when the server provides one. */
  sequence?: number;
  data: Record<string, unknown>;
}

export interface SseConnectionState {
  connected: boolean;
  reconnecting: boolean;
  /** True while the browser reports no network; retries are paused. */
  offline: boolean;
  lastEvent: string | null;
  error: string | null;
}

interface SseStore {
  connectionState: SseConnectionState;
  eventHistory: SseEvent[];
  lastEventId: string | null;
  /** Highest sequence number accepted so far (null until one is seen). */
  lastSequence: number | null;
  /** Latest full runtime state received via `runtime_state_full`. */
  snapshot: Record<string, unknown> | null;
  listeners: Map<SseEventType, Set<(event: SseEvent) => void>>;
  connect: () => Promise<void>;
  disconnect: () => void;
  handleEvent: (event: SseEvent, id?: string) => void;
  subscribe: (type: SseEventType, callback: (event: SseEvent) => void) => () => void;
  clearHistory: () => void;
}

const MAX_HISTORY = 50;
const MAX_SEEN_IDS = 1000;

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
/** A connection must stay open this long before the attempt counter resets. */
export const STABLE_CONNECTION_MS = 5_000;
export const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * Full-jitter exponential backoff (AWS "Exponential Backoff and Jitter").
 * `attempt` is the number of consecutive failures before this retry (0-based).
 */
export function computeBackoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * Extract the sequence from a live event ID of the form
 * `${userId}-${sequence}-${epochMs}`. Fallback (`-fallback-`) and snapshot
 * (`-full-`) IDs, and Redis stream IDs (`ms-seq`), carry no usable sequence.
 */
export function sequenceFromEventId(id: string | undefined): number | undefined {
  if (!id || id.includes('-fallback-') || id.includes('-full-')) return undefined;
  const match = /^.+-(\d+)-(\d+)$/.exec(id);
  if (!match) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}

let eventSource: EventSource | null = null;
let reconnectAttempts = 0;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let stabilityTimeout: ReturnType<typeof setTimeout> | null = null;
/** Incremented on every connect/disconnect so stale async work is ignored. */
let connectGeneration = 0;
/** True between connect() and disconnect(); gates automatic reconnects. */
let shouldConnect = false;
let networkListenersAttached = false;
let userStoreSubscribed = false;
let previousAuthState: boolean | null = null;
/** Timestamp (ms) of the event that set `lastSequence`. */
let lastSequenceTime = Number.NEGATIVE_INFINITY;
const seenEventIds = new Set<string>();

export async function resolveAuthToken(): Promise<string | null> {
  if (typeof window !== 'undefined' && window.Clerk && window.Clerk.session) {
    try {
      const token = await window.Clerk.session.getToken();
      if (token) return token;
    } catch {
      // ignore
    }
  }
  if (typeof localStorage !== 'undefined') {
    const localToken = localStorage.getItem('devtrack_access_token');
    if (localToken) return localToken;
  }
  return null;
}

export function attachUserStoreListener(): void {
  if (userStoreSubscribed) return;
  userStoreSubscribed = true;
  previousAuthState = useUserStore.getState().isAuthenticated;

  useUserStore.subscribe((state) => {
    const wasAuthed = previousAuthState ?? false;
    const isNowAuthed = state.isAuthenticated;
    previousAuthState = isNowAuthed;

    if (isNowAuthed && !wasAuthed) {
      if (shouldConnect) {
        void useSseStore.getState().connect();
      }
    } else if (!isNowAuthed && wasAuthed) {
      useSseStore.getState().disconnect();
      useSseStore.getState().clearHistory();
    }
  });
}

function eventKey(event: SseEvent, id?: string): string {
  if (id) return id;
  return `${event.type}:${event.timestamp}:${JSON.stringify(event.data)}`;
}

function rememberKey(key: string): void {
  seenEventIds.add(key);
  if (seenEventIds.size > MAX_SEEN_IDS) {
    const first = seenEventIds.values().next().value;
    if (first !== undefined) seenEventIds.delete(first);
  }
}

function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function clearReconnectTimer(): void {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
}

function clearStabilityTimer(): void {
  if (stabilityTimeout) {
    clearTimeout(stabilityTimeout);
    stabilityTimeout = null;
  }
}

function closeEventSource(): void {
  clearStabilityTimer();
  if (eventSource) {
    eventSource.onopen = null;
    eventSource.onmessage = null;
    eventSource.onerror = null;
    eventSource.close();
    eventSource = null;
  }
}

function setConnectionState(patch: Partial<SseConnectionState>): void {
  useSseStore.setState((state) => ({
    connectionState: { ...state.connectionState, ...patch },
  }));
}

function enterOfflineState(): void {
  clearReconnectTimer();
  closeEventSource();
  setConnectionState({ connected: false, reconnecting: false, offline: true, error: null });
}

function scheduleReconnect(): void {
  if (!shouldConnect) return;
  clearReconnectTimer();

  if (isBrowserOffline()) {
    enterOfflineState();
    return;
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    setConnectionState({ connected: false, reconnecting: false, error: 'Connection unavailable' });
    return;
  }

  const delay = computeBackoffDelay(reconnectAttempts);
  reconnectAttempts++;
  setConnectionState({
    connected: false,
    reconnecting: true,
    error: `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`,
  });

  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    // connect() acquires a fresh handshake ticket
    void useSseStore.getState().connect();
  }, delay);
}

function handleOffline(): void {
  if (!shouldConnect) return;
  enterOfflineState();
}

function handleOnline(): void {
  setConnectionState({ offline: false });
  if (!shouldConnect) return;
  // The network changed, so earlier failures say nothing about the new one.
  reconnectAttempts = 0;
  clearReconnectTimer();
  void useSseStore.getState().connect();
}

function attachNetworkListeners(): void {
  if (networkListenersAttached || typeof window === 'undefined') return;
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  networkListenersAttached = true;
}

function detachNetworkListeners(): void {
  if (!networkListenersAttached || typeof window === 'undefined') return;
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('offline', handleOffline);
  networkListenersAttached = false;
}

/** Normalise a raw SSE `data:` payload (envelope or legacy shape). */
export function parseSseMessage(raw: string, transportId?: string): SseEvent | null {
  const parsed = JSON.parse(raw) as Partial<SseEvent> & {
    payload?: Record<string, unknown>;
    stats?: Record<string, unknown>;
  };
  if (!parsed || typeof parsed.type !== 'string') return null;

  const id = transportId || (typeof parsed.id === 'string' ? parsed.id : undefined);
  const sequence =
    typeof parsed.sequence === 'number' && Number.isFinite(parsed.sequence)
      ? parsed.sequence
      : sequenceFromEventId(id);

  return {
    type: parsed.type,
    timestamp: parsed.timestamp ?? new Date().toISOString(),
    userId: parsed.userId,
    id,
    sequence,
    data: parsed.data ?? parsed.payload ?? (parsed.stats ? { ...parsed.stats } : {}),
  };
}

/**
 * Decide whether an event was already delivered. Sequenced events are
 * compared against the highest accepted sequence; everything else falls back
 * to a bounded set of seen IDs / composite keys.
 */
function isDuplicate(event: SseEvent): boolean {
  const key = eventKey(event, event.id);

  if (event.id && seenEventIds.has(event.id)) {
    return true;
  }

  if (event.type === 'runtime_state_full') {
    if (seenEventIds.has(key)) return true;
    rememberKey(key);
    if (event.id) rememberKey(event.id);
    return false;
  }

  if (typeof event.sequence === 'number' && event.sequence > 0) {
    const lastSequence = useSseStore.getState().lastSequence;
    const eventTime = Date.parse(event.timestamp);

    if (lastSequence !== null && event.sequence <= lastSequence) {
      // A lower sequence with a strictly newer timestamp means the server's
      // per-user counter was reset (its Redis key expired); accept it.
      const counterReset = Number.isFinite(eventTime) && eventTime > lastSequenceTime;
      if (!counterReset) return true;
    }

    lastSequenceTime = Number.isFinite(eventTime) ? eventTime : lastSequenceTime;
    useSseStore.setState({ lastSequence: event.sequence });
    if (event.id) rememberKey(event.id);
    return false;
  }

  if (seenEventIds.has(key)) return true;
  rememberKey(key);
  if (event.id) rememberKey(event.id);
  return false;
}

function applySnapshot(event: SseEvent): void {
  const state = event.data.state;
  // Sequences after a snapshot start from a fresh baseline.
  lastSequenceTime = Number.NEGATIVE_INFINITY;
  useSseStore.setState({
    snapshot: state && typeof state === 'object' ? (state as Record<string, unknown>) : null,
    lastSequence: null,
  });
  void queryClient.invalidateQueries();
}

export const useSseStore = create<SseStore>((set, get) => ({
  connectionState: {
    connected: false,
    reconnecting: false,
    offline: false,
    lastEvent: null,
    error: null,
  },
  eventHistory: [],
  lastEventId: null,
  lastSequence: null,
  snapshot: null,
  listeners: new Map(),

  connect: async () => {
    shouldConnect = true;
    attachNetworkListeners();
    attachUserStoreListener();
    clearReconnectTimer();
    closeEventSource();

    const generation = ++connectGeneration;

    if (isBrowserOffline()) {
      enterOfflineState();
      return;
    }

    const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';
    const token = await resolveAuthToken();
    const isAuthed = useUserStore.getState().isAuthenticated;

    if (!token && !isAuthed) {
      setConnectionState({ reconnecting: false, error: 'No auth token' });
      return;
    }

    setConnectionState({ reconnecting: true, offline: false });

    // Acquire secure handshake ticket before connecting
    let ticket: string;
    try {
      const { getSSEHandshakeTicket } = await import('../../services/authService');
      ticket = await getSSEHandshakeTicket();
    } catch (err) {
      if (generation !== connectGeneration) return;
      console.error('[SSE] Failed to acquire handshake ticket:', err);
      setConnectionState({ error: 'Failed to authenticate SSE' });
      scheduleReconnect();
      return;
    }

    // disconnect() or a newer connect() happened while we were waiting
    if (generation !== connectGeneration || !shouldConnect) return;

    const lastId = get().lastEventId;
    let url = `${baseUrl}/api/events?ticket=${encodeURIComponent(ticket)}`;
    if (lastId) {
      url += `&lastEventId=${encodeURIComponent(lastId)}`;
    }

    const source = new EventSource(url);
    eventSource = source;

    source.onopen = () => {
      if (source !== eventSource) return;
      setConnectionState({ connected: true, reconnecting: false, offline: false, error: null });
      // Only forgive earlier failures once the connection proves stable;
      // a server that accepts and immediately drops keeps backing off.
      clearStabilityTimer();
      stabilityTimeout = setTimeout(() => {
        stabilityTimeout = null;
        if (source === eventSource) reconnectAttempts = 0;
      }, STABLE_CONNECTION_MS);
    };

    source.onmessage = (event) => {
      if (source !== eventSource) return;
      if (typeof event.data !== 'string' || event.data.startsWith(':')) return;
      try {
        const normalized = parseSseMessage(event.data, event.lastEventId || undefined);
        if (!normalized || isDuplicate(normalized)) return;

        if (normalized.type === 'runtime_state_full') {
          applySnapshot(normalized);
        }

        get().handleEvent(normalized, normalized.id);
      } catch (err) {
        console.error('[SSE] Failed to parse event:', err);
      }
    };

    source.onerror = () => {
      if (source !== eventSource) return;
      closeEventSource();
      scheduleReconnect();
    };
  },

  disconnect: () => {
    shouldConnect = false;
    connectGeneration++;
    clearReconnectTimer();
    closeEventSource();
    detachNetworkListeners();
    reconnectAttempts = 0;
    set({
      connectionState: {
        connected: false,
        reconnecting: false,
        offline: false,
        lastEvent: null,
        error: null,
      },
    });
  },

  handleEvent: (event, id) => {
    const { listeners, eventHistory } = get();
    const newHistory = [event, ...eventHistory].slice(0, MAX_HISTORY);
    set({
      eventHistory: newHistory,
      lastEventId: id || get().lastEventId,
      connectionState: {
        ...get().connectionState,
        lastEvent: event.type,
      },
    });

    listeners.get(event.type)?.forEach((cb) => {
      try {
        cb(event);
      } catch (err) {
        console.error('[SSE] Listener error:', err);
      }
    });
  },

  subscribe: (type, callback) => {
    const { listeners } = get();
    if (!listeners.has(type)) {
      listeners.set(type, new Set());
    }
    listeners.get(type)!.add(callback);
    return () => {
      const setForType = listeners.get(type);
      setForType?.delete(callback);
      if (setForType?.size === 0) listeners.delete(type);
    };
  },

  clearHistory: () => set({ eventHistory: [] }),
}));

/** Test-only: reset module-level connection state between test cases. */
export function __resetSseManagerForTests(): void {
  useSseStore.getState().disconnect();
  lastSequenceTime = Number.NEGATIVE_INFINITY;
  seenEventIds.clear();
  userStoreSubscribed = false;
  previousAuthState = null;
  useSseStore.setState({
    eventHistory: [],
    lastEventId: null,
    lastSequence: null,
    snapshot: null,
    listeners: new Map(),
  });
}

export const useXpUpdates = () => {
  const latestEvent = useSseStore((s) => s.eventHistory.find((e) => e.type === 'xp_updated'));
  return {
    latestXp: latestEvent?.data?.xp as number | undefined,
    delta: latestEvent?.data?.delta as number | undefined,
  };
};

export const useStreakUpdates = () => {
  const latestEvent = useSseStore((s) =>
    s.eventHistory.find((e) => e.type === 'streak_milestone' || e.type === 'streak_at_risk')
  );
  return {
    streak: latestEvent?.data?.streak as number | undefined,
    atRisk: latestEvent?.type === 'streak_at_risk',
  };
};

export const useAchievementUnlocks = () => {
  const latestEvent = useSseStore((s) => s.eventHistory.find((e) => e.type === 'badge_earned'));
  return {
    achievement: latestEvent?.data as { name?: string; rarity?: string } | undefined,
  };
};

export const useConnectionState = () => useSseStore((s) => s.connectionState);

export default useSseStore;
