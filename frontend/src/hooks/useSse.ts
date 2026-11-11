// ============================================================================
// useSse.ts — Server-Sent Events hook with Zod validation
// ============================================================================
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { queryKeys } from '../lib/queryClient';
import { useUIStore } from '../store/uiStore';
import { useUserStore } from '../store/userStore';

const SSE_PATH = '/events';
const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_SEEN_ENVELOPE_IDS = 1000;

// ---------------------------------------------------------------------------
// Event types taxonomy
// ---------------------------------------------------------------------------
export type SseEventType =
  | 'runtime_state_patch'
  | 'runtime_state_full'
  | 'behavioral_message'
  | 'notification_created'
  | 'level_up'
  | 'streak_milestone'
  | 'streak_at_risk'
  | 'achievement_unlocked'
  | 'goal_completed'
  | 'challenge_completed'
  | 'near_milestone'
  | 'mission_progress'
  | 'sync_started'
  | 'sync_completed'
  | 'sync_failed'
  | 'new_submission'
  | 'xp_updated'
  | 'badge_earned'
  | 'resume_progression'
  | 'heartbeat';

// ---------------------------------------------------------------------------
// Zod schemas for runtime validation
// ---------------------------------------------------------------------------
const SseEventEnvelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  sequence: z.number().int(),
  timestamp: z.string(),
  userId: z.string(),
  payload: z.record(z.string(), z.any()),
});

export interface SseEvent {
  type: SseEventType;
  timestamp: string;
  userId?: string;
  platform?: string;
  stats?: {
    totalSolved?: number;
    easySolved?: number;
    mediumSolved?: number;
    hardSolved?: number;
    rating?: number;
    totalContests?: number;
    ingested?: number;
    successCount?: number;
    failedCount?: number;
    error?: string;
  };
  payload?: any;
}

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

interface UseSseOptions {
  onEvent?: (event: SseEvent) => void;
  extraInvalidateKeys?: string[][];
  enabled?: boolean;
}

interface UseSseResult {
  isConnected: boolean;
  connectionStatus: ConnectionStatus;
  lastEvent: SseEvent | null;
  reconnectAttempt: number;
  diagnostics: SseDiagnostics;
  eventHistory: SseEvent[];
}

export interface SseDiagnostics {
  connectedAt: number | null;
  lastEventAt: number | null;
  totalEventsReceived: number;
  totalReconnects: number;
  consecutiveFailures: number;
  avgReconnectDelay: number;
}

function invalidateOnSyncEvent(
  queryClient: ReturnType<typeof useQueryClient>,
  event: SseEvent
): void {
  switch (event.type) {
    case 'sync_started':
      queryClient.invalidateQueries({ queryKey: queryKeys.dsa.syncStatus });
      break;
    case 'sync_completed':
      queryClient.invalidateQueries({ queryKey: queryKeys.dsa.dashboard });
      queryClient.invalidateQueries({ queryKey: queryKeys.dsa.submissions() });
      queryClient.invalidateQueries({ queryKey: queryKeys.dsa.contests() });
      queryClient.invalidateQueries({ queryKey: queryKeys.dsa.topics });
      queryClient.invalidateQueries({ queryKey: queryKeys.dsa.platformStats });
      queryClient.invalidateQueries({ queryKey: queryKeys.dsa.syncStatus });
      break;
    case 'new_submission':
      queryClient.invalidateQueries({ queryKey: queryKeys.dsa.submissions() });
      break;
    case 'sync_failed':
      queryClient.invalidateQueries({ queryKey: queryKeys.dsa.syncStatus });
      break;
  }
}

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------
interface StoreState {
  connectionStatus: ConnectionStatus;
  lastEvent: SseEvent | null;
  reconnectAttempt: number;
  connectedAt: number | null;
  lastEventAt: number | null;
  totalEventsReceived: number;
  totalReconnects: number;
  consecutiveFailures: number;
  reconnectDelays: number[];
  eventHistory: SseEvent[];
  lastEventId: string | null;
}

const store: StoreState = {
  connectionStatus: 'disconnected',
  lastEvent: null,
  reconnectAttempt: 0,
  connectedAt: null,
  lastEventAt: null,
  totalEventsReceived: 0,
  totalReconnects: 0,
  consecutiveFailures: 0,
  reconnectDelays: [],
  eventHistory: [],
  lastEventId: null,
};

const MAX_HISTORY = 50;
const seenEventIds = new Set<string>();
const seenEnvelopeIds = new Set<string>();

function eventKey(event: SseEvent): string {
  return `${event.type}:${event.timestamp}:${JSON.stringify(event.stats || event.payload || '')}`;
}

function rememberEnvelopeId(id: string): void {
  seenEnvelopeIds.add(id);
  if (seenEnvelopeIds.size > MAX_SEEN_ENVELOPE_IDS) {
    const first = seenEnvelopeIds.values().next().value;
    if (first !== undefined) seenEnvelopeIds.delete(first);
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();

function emitChange() {
  for (const l of listeners) l();
}

function getSnapshot(): StoreState {
  return store;
}

interface HookCallbackRegistry {
  onEvent?: (event: SseEvent) => void;
  queryClient: ReturnType<typeof useQueryClient>;
  extraInvalidateKeys: string[][];
}

const activeCallbacks = new Set<HookCallbackRegistry>();

let globalEventSource: EventSource | null = null;
let globalReconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let globalHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let globalLastMessage = 0;
let globalConsecutiveFailures = 0;
let globalDisconnectedAt: number | null = null;
let userStoreSubscribed = false;
let previousAuth = false;

const STALE_STATE_THRESHOLD_MS = 30_000;

async function resolveAuthToken(): Promise<string | null> {
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

function attachUserStoreAuthListener(
  setSseStatus: (status: 'connected' | 'reconnecting' | 'disconnected') => void,
  setInfrastructureDegraded: (degraded: boolean) => void
) {
  if (userStoreSubscribed || typeof window === 'undefined') return;
  userStoreSubscribed = true;
  previousAuth = useUserStore.getState().isAuthenticated;

  useUserStore.subscribe((state) => {
    const wasAuthed = previousAuth;
    const isNowAuthed = state.isAuthenticated;
    previousAuth = isNowAuthed;

    if (isNowAuthed && !wasAuthed) {
      if (activeCallbacks.size > 0 && globalEventSource === null) {
        void connectGlobalSse(setSseStatus, setInfrastructureDegraded);
      }
    } else if (!isNowAuthed && wasAuthed) {
      disconnectGlobalSse(setSseStatus);
    }
  });
}

export async function connectGlobalSse(
  setSseStatus?: (status: 'connected' | 'reconnecting' | 'disconnected') => void,
  setInfrastructureDegraded?: (degraded: boolean) => void
) {
  const updateStatus = setSseStatus || ((status) => useUIStore.getState().setSseStatus(status));
  const updateDegraded = setInfrastructureDegraded || ((deg) => useUIStore.getState().setInfrastructureDegraded(deg));

  attachUserStoreAuthListener(updateStatus, updateDegraded);

  if (globalEventSource !== null) return;

  const token = await resolveAuthToken();
  const isAuthed = useUserStore.getState().isAuthenticated;

  if (!token && !isAuthed) {
    store.connectionStatus = 'disconnected';
    emitChange();
    updateStatus('disconnected');
    return;
  }

  store.connectionStatus = 'connecting';
  emitChange();
  updateStatus('reconnecting');

  let ticket: string | null = null;
  try {
    const { default: axiosClient } = await import('../utils/axiosClient');
    const { data } = await axiosClient.post<{ data: { ticket: string } }>('/auth/sse-handshake');
    ticket = data.data.ticket;
  } catch {
    console.warn('[SSE] Failed to obtain secure SSE handshake ticket, fallback to JWT.');
  }

  const urlParams = new URLSearchParams();
  if (ticket) {
    urlParams.set('ticket', ticket);
  } else if (token) {
    urlParams.set('token', token);
  }
  
  if (store.lastEventId) {
    urlParams.set('lastEventId', store.lastEventId);
  }

  const envUrl = import.meta.env.VITE_API_BASE_URL || '';
  const url = `${envUrl}${SSE_PATH}?${urlParams.toString()}`;
  const es = new EventSource(url);
  globalEventSource = es;

  es.onopen = () => {
    globalConsecutiveFailures = 0;
    const now = Date.now();
    store.connectedAt = now;
    store.totalReconnects = store.reconnectAttempt > 0 ? store.totalReconnects + 1 : store.totalReconnects;
    store.consecutiveFailures = 0;
    store.connectionStatus = 'connected';
    emitChange();
    updateStatus('connected');

    if (globalDisconnectedAt !== null) {
      const disconnectDuration = now - globalDisconnectedAt;
      if (disconnectDuration > STALE_STATE_THRESHOLD_MS) {
        console.info('[SSE] Hardened re-establishment, triggering reactive query refresh.');
        updateStatus('reconnecting');
        for (const cb of activeCallbacks) {
          cb.queryClient.refetchQueries();
        }
        setTimeout(() => {
          updateStatus('connected');
        }, 1000);
      }
      globalDisconnectedAt = null;
    }

    if (globalHeartbeatTimer) clearInterval(globalHeartbeatTimer);
    globalHeartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - globalLastMessage;
      if (globalLastMessage > 0 && elapsed > HEARTBEAT_INTERVAL_MS * 2) {
        console.warn('[SSE] Heartbeat dead, initiating reconnect.', { elapsed });
        es.close();
        globalEventSource = null;
        scheduleReconnect(true, updateStatus, updateDegraded);
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  es.onmessage = (ev) => {
    globalLastMessage = Date.now();
    if (ev.data?.startsWith(':')) return;

    let event: SseEvent;
    let envelopeId: string | null = null;

    try {
      const parsedRaw = JSON.parse(ev.data);
      envelopeId = ev.lastEventId || parsedRaw?.id || null;

      // Deduplicate by envelope ID before parsing or dispatching mutations
      if (envelopeId && seenEnvelopeIds.has(envelopeId)) {
        return;
      }
      
      // Perform Zod validation on event envelope structure
      const parsedEnvelope = SseEventEnvelopeSchema.safeParse(parsedRaw);
      if (parsedEnvelope.success) {
        const data = parsedEnvelope.data;
        envelopeId = data.id;
        if (seenEnvelopeIds.has(envelopeId)) {
          return;
        }
        event = {
          type: data.type as SseEventType,
          timestamp: data.timestamp,
          userId: data.userId,
          stats: data.payload as SseEvent['stats'],
          payload: data.payload,
        };
        store.lastEventId = data.id;
      } else {
        event = parsedRaw as SseEvent;
      }
    } catch (err) {
      console.error('[SSE] Structured payload corrupted, discarding parsing event', err);
      return;
    }

    if (envelopeId) {
      rememberEnvelopeId(envelopeId);
    }

    const key = eventKey(event);
    if (seenEventIds.has(key)) return;
    seenEventIds.add(key);
    if (seenEventIds.size > 200) {
      const first = seenEventIds.values().next().value;
      if (first) seenEventIds.delete(first);
    }

    store.eventHistory = [event, ...store.eventHistory].slice(0, MAX_HISTORY);
    store.lastEvent = event;
    store.lastEventAt = Date.now();
    store.totalEventsReceived++;
    store.consecutiveFailures = 0;
    emitChange();

    for (const cb of activeCallbacks) {
      try {
        cb.onEvent?.(event);
        invalidateOnSyncEvent(cb.queryClient, event);
        for (const k of cb.extraInvalidateKeys) {
          cb.queryClient.invalidateQueries({ queryKey: k });
        }
      } catch (e) {
        console.error('[SSE] Broadcast dispatch failure: ', e);
      }
    }
  };

  es.onerror = () => {
    globalConsecutiveFailures += 1;
    store.consecutiveFailures = globalConsecutiveFailures;

    if (globalDisconnectedAt === null) {
      globalDisconnectedAt = Date.now();
    }

    if (globalConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error('[SSE] Max consecutive failures hit, degradation protocol activated');
      store.connectionStatus = 'disconnected';
      emitChange();
      updateStatus('disconnected');
      updateDegraded(true);
      es.close();
      globalEventSource = null;
      return;
    }

    es.close();
    globalEventSource = null;
    scheduleReconnect(false, updateStatus, updateDegraded);
  };
}

export function disconnectGlobalSse(
  setSseStatus?: (status: 'connected' | 'reconnecting' | 'disconnected') => void
) {
  const updateStatus = setSseStatus || ((status) => useUIStore.getState().setSseStatus(status));

  if (globalHeartbeatTimer !== null) {
    clearInterval(globalHeartbeatTimer);
    globalHeartbeatTimer = null;
  }
  if (globalReconnectTimeout !== null) {
    clearTimeout(globalReconnectTimeout);
    globalReconnectTimeout = null;
  }
  if (globalEventSource !== null) {
    globalEventSource.close();
    globalEventSource = null;
  }
  store.connectionStatus = 'disconnected';
  store.reconnectAttempt = 0;
  store.lastEvent = null;
  store.eventHistory = [];
  store.lastEventId = null;
  globalDisconnectedAt = null;
  emitChange();
  updateStatus('disconnected');
}

function scheduleReconnect(
  isHeartbeat: boolean,
  setSseStatus: (status: 'connected' | 'reconnecting' | 'disconnected') => void,
  setInfrastructureDegraded: (degraded: boolean) => void
) {
  if (globalReconnectTimeout !== null) return;

  const attempt = isHeartbeat ? store.reconnectAttempt + 1 : store.reconnectAttempt;
  const delay = Math.min(
    RECONNECT_DELAY_MS * Math.pow(1.5, attempt),
    MAX_RECONNECT_DELAY_MS
  );

  store.reconnectAttempt = attempt + 1;
  store.connectionStatus = 'reconnecting';
  emitChange();
  setSseStatus('reconnecting');

  globalReconnectTimeout = setTimeout(() => {
    globalReconnectTimeout = null;
    connectGlobalSse(setSseStatus, setInfrastructureDegraded);
  }, delay);
}

export function useSse(options: UseSseOptions = {}): UseSseResult {
  const { onEvent, extraInvalidateKeys = [], enabled = true } = options;

  const queryClient = useQueryClient();
  const isAuthenticated = useUserStore((s) => s.isAuthenticated);
  const setSseStatus = (status: any) => useUIStore.getState().setSseStatus(status);
  const setInfrastructureDegraded = (degraded: boolean) => useUIStore.getState().setInfrastructureDegraded(degraded);

  const { connectionStatus, lastEvent, reconnectAttempt } = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot
  );

  const callbackRef = useRef<HookCallbackRegistry>({
    onEvent,
    queryClient,
    extraInvalidateKeys,
  });

  useEffect(() => {
    callbackRef.current = { onEvent, queryClient, extraInvalidateKeys };
  });

  useEffect(() => {
    if (!enabled) return;

    const cb = callbackRef.current;
    activeCallbacks.add(cb);

    if (activeCallbacks.size === 1 || (isAuthenticated && globalEventSource === null)) {
      connectGlobalSse(setSseStatus, setInfrastructureDegraded);
    }

    return () => {
      activeCallbacks.delete(cb);
      if (activeCallbacks.size === 0) {
        disconnectGlobalSse(setSseStatus);
      }
    };
  }, [enabled, isAuthenticated]);

  const avgDelay = store.reconnectDelays.length > 0
    ? store.reconnectDelays.reduce((a, b) => a + b, 0) / store.reconnectDelays.length
    : 0;

  return {
    isConnected: connectionStatus === 'connected',
    connectionStatus,
    lastEvent,
    reconnectAttempt,
    diagnostics: {
      connectedAt: store.connectedAt,
      lastEventAt: store.lastEventAt,
      totalEventsReceived: store.totalEventsReceived,
      totalReconnects: store.totalReconnects,
      consecutiveFailures: store.consecutiveFailures,
      avgReconnectDelay: Math.round(avgDelay),
    },
    eventHistory: store.eventHistory,
  };
}

export function __resetSseForTests(): void {
  disconnectGlobalSse();
  seenEnvelopeIds.clear();
  seenEventIds.clear();
  userStoreSubscribed = false;
  previousAuth = false;
  store.connectionStatus = 'disconnected';
  store.lastEvent = null;
  store.reconnectAttempt = 0;
  store.connectedAt = null;
  store.lastEventAt = null;
  store.totalEventsReceived = 0;
  store.totalReconnects = 0;
  store.consecutiveFailures = 0;
  store.eventHistory = [];
  store.lastEventId = null;
  activeCallbacks.clear();
}

export const useXpUpdates = () => {
  const latestEvent = store.eventHistory.find((e) => e.type === 'xp_updated' || e.type === 'runtime_state_patch');
  return {
    latestXp: latestEvent?.stats?.totalSolved as number | undefined,
    delta: latestEvent?.stats?.easySolved as number | undefined,
  };
};

export const useStreakUpdates = () => {
  const latestEvent = store.eventHistory.find(
    (e) => e.type === 'streak_milestone' || e.type === 'streak_at_risk'
  );
  return {
    streak: latestEvent?.stats?.totalSolved as number | undefined,
    atRisk: latestEvent?.type === 'streak_at_risk',
  };
};

export const useAchievementUnlocks = () => {
  const latestEvent = store.eventHistory.find((e) => e.type === 'badge_earned' || e.type === 'achievement_unlocked');
  return {
    achievement: latestEvent?.stats as { name?: string; rarity?: string } | undefined,
  };
};

export const useConnectionState = () => ({
  connected: store.connectionStatus === 'connected',
  reconnecting: store.connectionStatus === 'reconnecting',
  lastEvent: store.lastEvent?.type ?? null,
  error: store.connectionStatus === 'disconnected' ? 'Connection unavailable' : null,
});
