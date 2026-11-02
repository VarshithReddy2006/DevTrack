import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// ---------------------------------------------------------------------------
// Types from Toast & UI
// ---------------------------------------------------------------------------
export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
  progress?: {
    current: number;
    total: number;
  };
  icon?: string;
}

// ---------------------------------------------------------------------------
// Types from Overlays
// ---------------------------------------------------------------------------
export type OverlayType = 'level_up' | 'streak_milestone' | 'challenge_completed' | 'achievement_unlocked' | 'streak_at_risk';

export interface OverlayItem {
  id: string;
  type: OverlayType;
  data: Record<string, unknown>;
  priority: number;
  timestamp: number;
  duration?: number;
}

const OVERLAY_PRIORITIES: Record<OverlayType, number> = {
  level_up: 4,
  streak_milestone: 3,
  challenge_completed: 2,
  achievement_unlocked: 1,
  streak_at_risk: 5,
};

const DEFAULT_DURATION = 4000;

// ---------------------------------------------------------------------------
// Types from Notifications
// ---------------------------------------------------------------------------
export type NotificationType =
  | 'xp_updated'
  | 'level_up'
  | 'streak_milestone'
  | 'streak_at_risk'
  | 'sync_completed'
  | 'sync_failed'
  | 'achievement_unlocked'
  | 'mission_completed'
  | 'challenge_completed'
  | 'notification_created'
  | 'general';

export type NotificationPriority = 'low' | 'medium' | 'high';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body?: string;
  priority: NotificationPriority;
  tone?: string;
  platform?: string;
  read: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Combined State Interface
// ---------------------------------------------------------------------------
interface AppState {
  // --- UI Section ---
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  activeModal: string | null;
  modalProps: Record<string, unknown>;
  openModal: (modalId: string, props?: Record<string, unknown>) => void;
  closeModal: () => void;
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
  clearToasts: () => void;
  addActionToast: (toast: Omit<Toast, 'id' | 'action'> & { action: Toast['action'] }) => void;
  isOnline: boolean;
  setOnline: (online: boolean) => void;
  sseStatus: 'connected' | 'reconnecting' | 'disconnected';
  setSseStatus: (status: 'connected' | 'reconnecting' | 'disconnected') => void;
  isInfrastructureDegraded: boolean;
  setInfrastructureDegraded: (degraded: boolean) => void;
  lastSseEvent: unknown | null;
  setLastSseEvent: (event: unknown) => void;

  isSearchOpen: boolean;
  toggleSearch: () => void;
  setSearchOpen: (open: boolean) => void;
  isPageLoading: boolean;
  setPageLoading: (loading: boolean) => void;

  // --- Overlay Section (Original names queue, enqueue, dismiss, clearQueue) ---
  queue: OverlayItem[];
  activeOverlay: OverlayItem | null;
  enqueue: (type: OverlayType, data: Record<string, unknown>, duration?: number) => void;
  dismiss: () => void;
  processQueue: () => void;
  clearQueue: () => void;

  // --- Notification Section (Original name clearAll) ---
  notifications: Notification[];
  unreadCount: number;
  isDrawerOpen: boolean;
  addNotification: (n: Omit<Notification, 'id' | 'createdAt' | 'read'>) => void;
  markAllRead: () => void;
  markRead: (id: string) => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  clearAll: () => void;
}

// ---------------------------------------------------------------------------
// LocalStorage helpers
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'devtrack_notifications';
let notificationStorageKey: string | null = null;
const MAX_ITEMS = 50;
const PERSIST_COUNT = 20;
let toastCounter = 0;
let notifCounter = 0;

function loadFromStorage(): Notification[] {
  try {
    const raw = notificationStorageKey ? localStorage.getItem(notificationStorageKey) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

function saveToStorage(notifications: Notification[]) {
  try {
    const toSave = notifications.slice(0, PERSIST_COUNT);
    if (notificationStorageKey) localStorage.setItem(notificationStorageKey, JSON.stringify(toSave));
  } catch {
    // Ignore storage errors
  }
}

const initialNotifications = loadFromStorage();

export function setNotificationAccount(userId: string | null) {
  notificationStorageKey = userId ? `${STORAGE_KEY}:${encodeURIComponent(userId)}` : null;
  const notifications = loadFromStorage();
  useAppStateStore.setState({ notifications, unreadCount: notifications.filter(n => !n.read).length });
}

export const THEME_STORAGE_KEY = 'devtrack_theme';

export function getInitialTheme(): 'light' | 'dark' | 'system' {
  if (typeof window === 'undefined') return 'system';
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
  } catch {
    // Ignore storage errors
  }
  return 'system';
}

export function applyTheme(theme: 'light' | 'dark' | 'system') {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;
  const isDark =
    theme === 'system'
      ? Boolean(window.matchMedia?.('(prefers-color-scheme: dark)')?.matches)
      : theme === 'dark';

  root.classList.toggle('dark', isDark);
  root.setAttribute('data-theme', isDark ? 'dark' : 'light');
  root.style.colorScheme = isDark ? 'dark' : 'light';
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// Main Consolidated Store
// ---------------------------------------------------------------------------
export const useAppStateStore = create<AppState>()(
  devtools(
    (set, get) => ({
      // --- UI ---
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      theme: getInitialTheme(),
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      activeModal: null,
      modalProps: {},
      openModal: (modalId, props = {}) => set({ activeModal: modalId, modalProps: props }),
      closeModal: () => set({ activeModal: null, modalProps: {} }),
      toasts: [],
      addToast: (toast) => {
        const id = `toast-${++toastCounter}`;
        const newToast: Toast = { ...toast, id };
        const duration = toast.duration ?? 5000;
        if (duration > 0) {
          setTimeout(() => {
            set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
          }, duration);
        }
        set((state) => {
          const trimmed = state.toasts.slice(-3);
          return { toasts: [...trimmed, newToast] };
        });
      },
      removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
      clearToasts: () => set({ toasts: [] }),
      addActionToast: (toast) => {
        const id = `toast-${++toastCounter}`;
        const newToast: Toast = { ...toast, id, duration: toast.duration ?? 8000 };
        if (newToast.duration && newToast.duration > 0) {
          setTimeout(() => {
            set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
          }, newToast.duration);
        }
        set((state) => {
          const trimmed = state.toasts.slice(-3);
          return { toasts: [...trimmed, newToast] };
        });
      },
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
      setOnline: (online) => set({ isOnline: online }),
      sseStatus: 'disconnected',
      setSseStatus: (status) => set({ sseStatus: status }),
      isInfrastructureDegraded: false,
      setInfrastructureDegraded: (degraded) => set({ isInfrastructureDegraded: degraded }),
      lastSseEvent: null,
      setLastSseEvent: (event) => set({ lastSseEvent: event }),

      isSearchOpen: false,
      toggleSearch: () => set((state) => ({ isSearchOpen: !state.isSearchOpen })),
      setSearchOpen: (open) => set({ isSearchOpen: open }),
      isPageLoading: false,
      setPageLoading: (loading) => set({ isPageLoading: loading }),

      // --- Overlays ---
      queue: [],
      activeOverlay: null,
      enqueue: (type, data, duration) => {
        const newItem: OverlayItem = {
          id: `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          type,
          data,
          priority: OVERLAY_PRIORITIES[type],
          timestamp: Date.now(),
          duration: duration ?? DEFAULT_DURATION,
        };
        set((state) => {
          const newQueue = [...state.queue, newItem].sort((a, b) => b.priority - a.priority);
          return { queue: newQueue };
        });
        if (!get().activeOverlay) {
          get().processQueue();
        }
      },
      dismiss: () => {
        set({ activeOverlay: null });
        setTimeout(() => {
          get().processQueue();
        }, 300);
      },
      processQueue: () => {
        const { activeOverlay, queue } = get();
        if (activeOverlay || queue.length === 0) return;
        const [nextItem, ...remainingQueue] = queue;
        set({ activeOverlay: nextItem, queue: remainingQueue });
        if (nextItem.duration) {
          setTimeout(() => {
            if (get().activeOverlay?.id === nextItem.id) {
              get().dismiss();
            }
          }, nextItem.duration);
        }
      },
      clearQueue: () => set({ queue: [], activeOverlay: null }),

      // --- Notifications ---
      notifications: initialNotifications,
      unreadCount: initialNotifications.filter((n) => !n.read).length,
      isDrawerOpen: false,
      addNotification: (n) => {
        const id = `notif-${Date.now()}-${++notifCounter}`;
        const newNotif: Notification = { ...n, id, read: false, createdAt: Date.now() };
        set((state) => {
          const updated = [newNotif, ...state.notifications].slice(0, MAX_ITEMS);
          const unread = updated.filter((x) => !x.read).length;
          saveToStorage(updated);
          return { notifications: updated, unreadCount: unread };
        });
      },
      markAllRead: () => {
        set((state) => {
          const updated = state.notifications.map((n) => ({ ...n, read: true }));
          saveToStorage(updated);
          return { notifications: updated, unreadCount: 0 };
        });
      },
      markRead: (id) => {
        set((state) => {
          const updated = state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
          const unread = updated.filter((x) => !x.read).length;
          saveToStorage(updated);
          return { notifications: updated, unreadCount: unread };
        });
      },
      openDrawer: () => set({ isDrawerOpen: true }),
      closeDrawer: () => set({ isDrawerOpen: false }),
      clearAll: () => {
        saveToStorage([]);
        set({ notifications: [], unreadCount: 0 });
      },
    }),
    { name: 'AppStateStore' }
  )
);
