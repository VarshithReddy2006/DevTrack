// ============================================================================
// NotificationDrawer.tsx — Side Drawer for Notifications
// ============================================================================
// Slides in from right, 400px wide. Shows notifications grouped by today/earlier.
// Connected to notificationStore for real-time SSE-driven notifications.
// ============================================================================

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Bell, Check, Trash2, Zap, Flame, Trophy, AlertTriangle, RefreshCw, Star, Info } from 'lucide-react';
import { useNotificationStore, type Notification, type NotificationType } from '../../store/notificationStore';
import { useDialogFocus } from '../../components/ui/useDialogFocus';
import { overlayEnter, drawerSlideRight, overlaySpring, durations, prefersReducedMotion } from '../../design-system/motion';

// ---------------------------------------------------------------------------
// Icon mapping
// ---------------------------------------------------------------------------

const NOTIFICATION_ICONS: Record<NotificationType, { icon: React.ReactNode; color: string; bg: string }> = {
  xp_updated:           { icon: <Zap size={16} />,            color: '#F59E0B', bg: '#FEF3C7' },
  level_up:             { icon: <Star size={16} />,           color: '#8B5CF6', bg: '#F5F3FF' },
  streak_milestone:     { icon: <Flame size={16} />,          color: '#F97316', bg: '#FFF7ED' },
  streak_at_risk:       { icon: <AlertTriangle size={16} />,  color: '#EF4444', bg: '#FEF2F2' },
  sync_completed:       { icon: <RefreshCw size={16} />,      color: '#22C55E', bg: '#F0FDF4' },
  sync_failed:          { icon: <AlertTriangle size={16} />,  color: '#EF4444', bg: '#FEF2F2' },
  achievement_unlocked: { icon: <Trophy size={16} />,         color: '#10B981', bg: '#ECFDF5' },
  mission_completed:    { icon: <Star size={16} />,           color: '#F59E0B', bg: '#FEF3C7' },
  challenge_completed:  { icon: <Trophy size={16} />,         color: '#F59E0B', bg: '#FEF3C7' },
  notification_created: { icon: <Info size={16} />,           color: '#3B82F6', bg: '#EFF6FF' },
  general:              { icon: <Bell size={16} />,           color: '#64748B', bg: '#F1F5F9' },
};

function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Notification Item
// ---------------------------------------------------------------------------

const NotificationItem: React.FC<{ notification: Notification; onRead: (id: string) => void }> = ({
  notification,
  onRead,
}) => {
  const config = NOTIFICATION_ICONS[notification.type] ?? NOTIFICATION_ICONS.general;

  return (
    <motion.div
      initial={prefersReducedMotion ? {} : { opacity: 0, x: 16 }}
      animate={prefersReducedMotion ? {} : { opacity: 1, x: 0 }}
      transition={{ duration: durations.fast }}
      className={[
        'flex items-start gap-3 p-3 rounded-xl transition-all duration-200 cursor-pointer group',
        notification.read
          ? 'opacity-60 hover:opacity-80'
          : 'hover:bg-slate-50',
      ].join(' ')}
      onClick={() => !notification.read && onRead(notification.id)}
    >
      {/* Icon */}
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-sm border"
        style={{
          backgroundColor: config.bg,
          color: config.color,
          borderColor: `${config.color}20`,
        }}
      >
        {config.icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className={[
          'text-sm leading-snug truncate',
          notification.read ? 'font-medium text-slate-500' : 'font-bold text-[#0F172A]',
        ].join(' ')}>
          {notification.title}
        </p>
        {notification.body && (
          <p className="text-xs text-slate-400 font-medium mt-0.5 line-clamp-2">
            {notification.body}
          </p>
        )}
        <p className="text-[10px] text-slate-400 font-semibold mt-1 tabular-nums">
          {getRelativeTime(notification.createdAt)}
        </p>
      </div>

      {/* Unread indicator */}
      {!notification.read && (
        <div className="w-2 h-2 rounded-full bg-dt-primary shrink-0 mt-2 shadow-[0_0_6px_rgba(124,92,252,0.4)]" />
      )}
    </motion.div>
  );
};

// ---------------------------------------------------------------------------
// Notification Drawer
// ---------------------------------------------------------------------------

interface NotificationDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const NotificationDrawer: React.FC<NotificationDrawerProps> = ({ open, onClose }) => {
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const markRead = useNotificationStore((s) => s.markRead);
  const clearAll = useNotificationStore((s) => s.clearAll);
  // Focus trap, Escape, scroll lock and focus restore are shared with Modal/Drawer.
  const drawerRef = useDialogFocus<HTMLDivElement>(onClose);

  // Group notifications
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTs = today.getTime();

  const todayNotifs = notifications.filter((n) => n.createdAt >= todayTs);
  const earlierNotifs = notifications.filter((n) => n.createdAt < todayTs);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            variants={overlayEnter}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: durations.overlay }}
            className="fixed inset-0 z-[80] bg-black/15 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Drawer */}
          <motion.div
            ref={drawerRef}
            variants={drawerSlideRight}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={overlaySpring}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0.05, right: 0.8 }}
            onDragEnd={(_, info) => {
              if (info.offset.x > 150) {
                onClose();
              }
            }}
            className="fixed right-0 top-0 h-full w-[400px] max-w-[90vw] z-[81] bg-white border-l border-slate-100 shadow-2xl flex flex-col"
            role="dialog"
            aria-label="Notifications"
            aria-modal="true"
            tabIndex={-1}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-black text-[#0F172A] tracking-tight">Notifications</h2>
                {unreadCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-dt-primary text-white text-[10px] font-black tabular-nums">
                    {unreadCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="p-2 text-slate-400 hover:text-dt-primary rounded-lg hover:bg-dt-primary/5 transition-colors"
                    aria-label="Mark all as read"
                    title="Mark all as read"
                  >
                    <Check size={16} />
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    onClick={clearAll}
                    className="p-2 text-slate-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors"
                    aria-label="Clear all"
                    title="Clear all"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="p-2 text-slate-400 hover:text-[#0F172A] rounded-lg hover:bg-slate-50 transition-colors"
                  aria-label="Close notifications"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-3 py-2">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center py-20">
                  <div className="w-14 h-14 rounded-2xl bg-slate-50 flex items-center justify-center mb-4">
                    <Bell size={24} className="text-slate-300" />
                  </div>
                  <p className="text-sm font-bold text-slate-400">No notifications yet</p>
                  <p className="text-xs text-slate-300 mt-1">Activity updates will appear here</p>
                </div>
              ) : (
                <>
                  {todayNotifs.length > 0 && (
                    <div className="mb-4">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 px-3 py-2">
                        Today
                      </p>
                      <div className="space-y-0.5">
                        {todayNotifs.map((n) => (
                          <NotificationItem key={n.id} notification={n} onRead={markRead} />
                        ))}
                      </div>
                    </div>
                  )}

                  {earlierNotifs.length > 0 && (
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 px-3 py-2">
                        Earlier
                      </p>
                      <div className="space-y-0.5">
                        {earlierNotifs.map((n) => (
                          <NotificationItem key={n.id} notification={n} onRead={markRead} />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default NotificationDrawer;
