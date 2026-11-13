// AppShell — Premium Engineering OS layout matching Design.pdf exactly
// Dark navy sidebar (88px collapsed / 260px expanded) + 72px sticky topbar

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { UserButton } from '@clerk/clerk-react';
import {
  LayoutDashboard,
  Code2,
  FolderKanban,
  UserRound,
  Settings,
  Shield,
  ChevronLeft,
  ChevronRight,
  Menu,
  Search,
  X,
  Flame,
  Zap,
  Activity,
  Clock,
  Wifi,
  RefreshCw,
  Target,
  TrendingUp,
  FileText,
} from 'lucide-react';
import { cn } from '../../lib/design-system/tokens.css';
import { useSse } from '../../hooks/useSse';
import { useUIStore } from '../../store/uiStore';
import { NotificationBell } from '../../features/notifications/NotificationBell';
import { NotificationDrawer } from '../../features/notifications/NotificationDrawer';
import { ThemeToggle } from '../shared/ThemeToggle';
import { isFeatureEnabled } from '../../lib/feature-flags';
import { useRuntimeState } from '../../hooks/useRuntimeState';
import { useUserStore } from '../../store/userStore';
import { OnboardingModal } from '../../features/onboarding';
import { useSyncIntelligence } from '../../runtime-intelligence/useSyncIntelligence';

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  path: string;
}

const coreNav: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={20} />, path: '/dashboard' },
  { id: 'focus', label: 'Focus', icon: <Target size={20} />, path: '/focus' },
  { id: 'dsa', label: 'DSA', icon: <Code2 size={20} />, path: '/dsa' },
  { id: 'projects', label: 'Projects', icon: <FolderKanban size={20} />, path: '/projects' },
  { id: 'resume', label: 'Resume', icon: <FileText size={20} />, path: '/resume' },
  { id: 'readiness', label: 'Readiness', icon: <TrendingUp size={20} />, path: '/readiness' },
  { id: 'profile', label: 'Profile', icon: <UserRound size={20} />, path: '/profile' },
  { id: 'settings', label: 'Settings', icon: <Settings size={20} />, path: '/settings' },
];

export const AppShell = () => {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { connectionStatus: connectionState, diagnostics } = useSse();
  const [pingMs, setPingMs] = useState<number | null>(null);

  // Mount the Runtime Intelligence Engine synchronizer
  useSyncIntelligence();

  useEffect(() => {
    if (connectionState !== 'connected') {
      setPingMs(null);
      return;
    }

    const runPing = async () => {
      const start = performance.now();
      try {
        const baseUrl = import.meta.env.VITE_API_BASE_URL || '';
        // Health endpoint is at root level, not under API base path
        const healthUrl = baseUrl.replace(/\/api$/, '') + '/health';
        await fetch(healthUrl, {
          method: 'GET',
          cache: 'no-store',
        });
        const duration = Math.round(performance.now() - start);
        setPingMs(duration);
      } catch {
        setPingMs(null);
      }
    };

    runPing();
    const interval = setInterval(runPing, 15_000);
    return () => clearInterval(interval);
  }, [connectionState]);

  const toggleSearch = useUIStore((s) => s.toggleSearch);
  const { data: runtimeState } = useRuntimeState();
  const streak = runtimeState?.streak ?? 0;
  const user = useUserStore((s) => s.user);
  const displayName = user?.displayName || user?.username || 'Developer';

  const navItems = [
    ...coreNav,
    ...(isFeatureEnabled('admin_panel')
      ? [{ id: 'admin', label: 'Admin', icon: <Shield size={20} />, path: '/admin' } as NavItem]
      : []),
  ];

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandOpen(true);
      }
      if (e.key === 'Escape') {
        setCommandOpen(false);
        setNotificationsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sidebarWidth = collapsed ? 'w-[5.25rem]' : 'w-[14.5rem]';
  const mainMargin = collapsed ? 'md:ml-[5.25rem]' : 'md:ml-[14.5rem]';

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#09090B] text-[#111827] dark:text-[#F8FAFC] flex transition-colors duration-300">
      {/* ─── DESKTOP SIDEBAR ─── */}
      <aside
        className={cn(
          'hidden md:flex flex-col fixed left-0 top-0 h-screen z-40',
          'bg-[#F8FAFC]/75 dark:bg-[#0D0D11]/90 backdrop-blur-2xl border-r border-slate-200/50 dark:border-zinc-800/80 transition-all duration-300 ease-out shadow-sm',
          sidebarWidth
        )}
      >
        {/* Logo */}
        <div className={cn('h-[72px] flex items-center border-b border-slate-200/50 dark:border-zinc-800/80', collapsed ? 'px-0 justify-center' : 'px-5')}>
          <Link to="/dashboard" className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#8B5CF6] to-[#A78BFA] flex items-center justify-center shrink-0 shadow-[0_4px_16px_rgba(139,92,246,0.3)]">
              <Zap className="w-[18px] h-[18px] text-white" />
            </div>
            {!collapsed && (
              <div className="flex flex-col min-w-0">
                <span className="font-bold text-[14px] tracking-tight text-slate-800 dark:text-zinc-100 leading-none">DevTrack</span>
                <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400 dark:text-zinc-500 mt-0.5">Engineering OS</span>
              </div>
            )}
          </Link>
        </div>

        {/* Section label */}
        {!collapsed && (
          <div className="px-5 pt-6 pb-2">
            <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">Core Systems</span>
          </div>
        )}

        {/* Nav items */}
        <nav className={cn('flex-1 px-2.5 space-y-1 mt-4', collapsed && 'pt-4')} aria-label="Main">
          {navItems.map((item) => (
            <SidebarNavLink
              key={item.id}
              item={item}
              collapsed={collapsed}
              active={location.pathname.startsWith(item.path)}
            />
          ))}
        </nav>

        {/* Streak card at bottom (refined to be extremely compact and horizontal) */}
        <div className={cn('px-2.5 pb-2.5', collapsed && 'px-2')}>
          {!collapsed ? (
            <div className="rounded-xl bg-white/60 border border-slate-200/50 shadow-sm p-3 hover:border-[#8B5CF6]/30 transition-all duration-300">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center shrink-0">
                  <Flame className="w-4 h-4 text-orange-500" />
                </div>
                <div className="min-w-0">
                  <p className="text-slate-800 font-extrabold text-[12px] leading-none">{streak} Day Streak</p>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-orange-500 mt-1">
                    {streak > 7 ? 'High Momentum' : 'Active'}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1 py-1.5 rounded-lg hover:bg-slate-50">
              <Flame className="w-4.5 h-4.5 text-orange-500" />
              <span className="text-[9px] font-black text-orange-500">{streak}</span>
            </div>
          )}
        </div>

        {/* Profile dock (reduced height, tighter) */}
        {!collapsed && (
          <div className="px-2.5 pb-4">
            <button
              type="button"
              onClick={() => navigate('/profile')}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-slate-50 border border-transparent hover:border-slate-200/60 transition-all duration-300"
            >
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#8B5CF6]/20 to-[#A78BFA]/20 border border-[#8B5CF6]/30 flex items-center justify-center shrink-0">
                <span className="text-[10px] font-bold text-[#8B5CF6]">{displayName.charAt(0).toUpperCase()}</span>
              </div>
              <div className="text-left min-w-0">
                <p className="text-xs font-bold text-slate-800 truncate">{displayName}</p>
                <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Elite Node</p>
              </div>
            </button>
          </div>
        )}

        {/* Collapse toggle */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="absolute -right-3 top-20 w-6 h-6 rounded-full bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-400 hover:text-[#111827] dark:hover:text-zinc-100 hover:border-[#8B5CF6]/40 transition-all duration-200"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </button>
      </aside>

      {/* ─── MOBILE SIDEBAR OVERLAY ─── */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="fixed left-0 top-0 h-full w-[260px] bg-white dark:bg-[#0D0D11] border-r border-slate-200/50 dark:border-zinc-800/80 z-50 md:hidden shadow-2xl"
            >
              <div className="h-[72px] flex items-center justify-between px-5 border-b border-[rgba(17,24,39,0.06)] dark:border-zinc-800/80">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#8B5CF6] to-[#A78BFA] flex items-center justify-center shadow-[0_4px_16px_rgba(139,92,246,0.35)]">
                    <Zap className="w-[18px] h-[18px] text-white" />
                  </div>
                  <span className="font-bold text-[15px] text-[#111827] dark:text-zinc-100">DevTrack</span>
                </div>
                <button type="button" onClick={() => setMobileOpen(false)} className="p-1.5 text-zinc-400 hover:text-[#111827] dark:hover:text-zinc-200">
                  <X size={20} />
                </button>
              </div>
              <nav className="p-2.5 space-y-1 mt-2">
                {navItems.map((item) => (
                  <SidebarNavLink
                    key={item.id}
                    item={item}
                    collapsed={false}
                    active={location.pathname.startsWith(item.path)}
                  />
                ))}
              </nav>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ─── MAIN CONTENT AREA ─── */}
      <main className={cn('flex-1 min-w-0 min-h-screen flex flex-col transition-all duration-300', mainMargin)}>
        {/* ─── TOPBAR (72px sticky with refined center layer) ─── */}
        <header className="sticky top-0 z-30 h-[72px] bg-gradient-to-b from-[#F8FAFC] to-[#F8FAFC]/90 dark:from-[#09090B] dark:to-[#09090B]/90 backdrop-blur-2xl border-b border-slate-200/50 dark:border-zinc-800/80 shadow-sm flex items-center transition-colors duration-300">
          <div className="w-full max-w-[1440px] mx-auto px-4 md:px-8 flex items-center justify-between gap-4">
            {/* Mobile menu button */}
            <div className="flex items-center gap-2 md:hidden">
              <button
                type="button"
                className="p-2 text-zinc-500 hover:text-slate-800 transition-colors"
                onClick={() => setMobileOpen(true)}
                aria-label="Open menu"
              >
                <Menu size={20} />
              </button>
            </div>

            {/* Central Unified Grouped Action Command Layer */}
            <div className="flex-1 min-w-0 flex items-center justify-center max-w-4xl mx-auto w-full gap-2 sm:gap-4">
              {/* Search Command Bar */}
              <button
                type="button"
                onClick={() => setCommandOpen(true)}
                className="flex items-center gap-2.5 flex-1 min-w-0 max-w-lg px-3 sm:px-4 py-2 rounded-full border border-slate-200 bg-white/80 text-slate-500 text-sm hover:border-[#8B5CF6]/40 focus:outline focus:outline-2 focus:outline-[#8B5CF6]/40 hover:bg-[#8B5CF6]/5 transition-all duration-300 shadow-sm group"
              >
                <Search size={14} className="shrink-0 text-slate-400 group-hover:text-[#8B5CF6] transition-colors" />
                <span className="truncate text-[12px] font-semibold text-slate-600 tracking-tight">Show my hardest problems…</span>
                <kbd className="hidden sm:flex ml-auto shrink-0 text-[9px] px-1.5 py-0.5 rounded-[5px] bg-slate-100 border border-slate-200 text-slate-500 font-mono tracking-widest items-center justify-center">⌘K</kbd>
              </button>

              {/* Realtime Status Dot */}
              <div className="shrink-0 flex items-center border border-slate-200/80 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 rounded-full px-3 py-1.5 shadow-sm">
                <ConnectionDot status={connectionState} pingMs={pingMs} diagnostics={diagnostics} />
              </div>

              {/* Theme Toggle */}
              <div className="shrink-0">
                <ThemeToggle />
              </div>

              {/* Notifications */}
              <div className="shrink-0 border border-slate-200/80 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 rounded-full p-1.5 shadow-sm flex items-center justify-center">
                <NotificationBell onClick={() => setNotificationsOpen(true)} />
              </div>

              {/* Profile Mini Cluster (Clerk UserButton) */}
              <div className="hidden md:flex items-center ml-2">
                <UserButton 
                  afterSignOutUrl="/login"
                  appearance={{
                    elements: {
                      userButtonAvatarBox: "w-8 h-8 rounded-full border border-slate-200 dark:border-zinc-700 shadow-sm",
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </header>

        {/* ─── PAGE CONTENT ─── */}
        <div className="flex-1 overflow-y-auto pb-20 md:pb-0">
          <div className="max-w-[1440px] mx-auto px-4 md:px-10 lg:px-14 py-8 md:py-10">
            <Outlet />
          </div>
        </div>
      </main>

      {/* ─── MOBILE BOTTOM NAVIGATION (Premium Glassmorphic) ─── */}
      <nav 
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/75 backdrop-blur-2xl border-t border-slate-200/50 px-2 py-2 flex justify-around items-center shadow-[0_-4px_24px_rgba(124,92,252,0.04)]"
        aria-label="Mobile Navigation"
      >
        {coreNav.map((item) => {
          const active = location.pathname.startsWith(item.path);
          return (
            <Link
              key={item.id}
              to={item.path}
              className={cn(
                "flex flex-col items-center gap-1.5 py-1 px-3.5 rounded-xl transition-all duration-300 relative",
                active ? "text-[#7C3AED]" : "text-slate-400 hover:text-slate-600"
              )}
            >
              {active && (
                <motion.div
                  layoutId="mobile-nav-active"
                  className="absolute inset-0 bg-[#8B5CF6]/8 rounded-xl"
                  transition={{ type: 'spring', damping: 25, stiffness: 350 }}
                />
              )}
              <span className={cn("transition-transform duration-300 relative z-10 shrink-0", active && "scale-110 text-[#7C3AED]")}>
                {item.icon}
              </span>
              <span className="text-[9px] font-bold tracking-tight relative z-10 leading-none">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* ─── COMMAND PALETTE ─── */}
      <AnimatePresence>
        {commandOpen && (
          <CommandPalette
            items={navItems}
            onClose={() => setCommandOpen(false)}
            onNavigate={(path) => {
              navigate(path);
              setCommandOpen(false);
            }}
            onSearch={toggleSearch}
          />
        )}
      </AnimatePresence>

      <NotificationDrawer open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
      <OnboardingModal />
    </div>
  );
};

/* ─── Sidebar Nav Link ─── */
function SidebarNavLink({
  item,
  collapsed,
  active,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
}) {
  return (
      <Link
        to={item.path}
        className={cn(
          'relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-300 group',
          active
            ? 'bg-[#8B5CF6]/10 dark:bg-[#8B5CF6]/20 text-[#5B21B6] dark:text-[#A78BFA]'
            : 'text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-100 hover:bg-slate-50 dark:hover:bg-zinc-800/60',
          collapsed && 'justify-center px-0 mx-1'
        )}
      >
        {/* Active indicator bar */}
        {active && (
          <motion.div
            layoutId="sidebar-active"
            className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-[#8B5CF6]"
            transition={{ type: 'spring', damping: 30, stiffness: 500 }}
          />
        )}
        <span className={cn(active ? 'text-[#7C3AED]' : 'text-slate-400 group-hover:scale-110', 'transition-all duration-300')}>{item.icon}</span>
        {!collapsed && <span className="truncate">{item.label}</span>}
      </Link>
  );
}

/* ─── Connection status dot for topbar ─── */
function ConnectionDot({ 
  status, 
  pingMs,
  diagnostics 
}: { 
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  pingMs: number | null;
  diagnostics: any;
}) {
  const [open, setOpen] = useState(false);
  const isConnected = status === 'connected';
  
  const statusColorMap = {
    connected: { dot: 'bg-emerald-500', text: 'text-emerald-600', bg: 'bg-emerald-50' },
    connecting: { dot: 'bg-amber-500', text: 'text-amber-600', bg: 'bg-amber-50' },
    reconnecting: { dot: 'bg-amber-500', text: 'text-amber-600', bg: 'bg-amber-50' },
    disconnected: { dot: 'bg-rose-500', text: 'text-rose-600', bg: 'bg-rose-50' },
  };

  const current = statusColorMap[status] || statusColorMap.disconnected;
  const latencyText = pingMs !== null ? `${pingMs}ms` : 'offline';
  const latencyColor = pingMs !== null && pingMs < 100 ? 'text-emerald-500' : pingMs !== null && pingMs < 300 ? 'text-amber-500' : 'text-rose-500';

  // Format date nicely
  const connectedTime = diagnostics?.connectedAt 
    ? new Date(diagnostics.connectedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'Never';

  return (
    <div className="relative">
      <button 
        type="button" 
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 tracking-tight hover:text-slate-800 transition-colors focus:outline-none"
      >
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', current.dot, !isConnected && 'animate-pulse')} />
        <span>{status === 'connected' ? 'Live' : status === 'reconnecting' ? 'Reconnecting…' : status === 'connecting' ? 'Connecting…' : 'Offline'}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute right-0 mt-2.5 w-60 bg-white border border-slate-200 rounded-xl shadow-xl z-50 p-4 text-left pointer-events-auto"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-2 mb-2">
              <span className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400">Connection Telemetry</span>
              <span className={cn('px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-tight', current.bg, current.text)}>
                {status}
              </span>
            </div>

            <div className="space-y-2">
              {/* Latency */}
              <div className="flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-2 text-slate-500">
                  <Wifi size={12} className="text-slate-400" />
                  <span>Ping Latency</span>
                </div>
                <span className={cn('font-bold', latencyColor)}>{latencyText}</span>
              </div>

              {/* Total Events */}
              <div className="flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-2 text-slate-500">
                  <Activity size={12} className="text-slate-400" />
                  <span>Events Streamed</span>
                </div>
                <span className="font-bold text-slate-700">{diagnostics?.totalEventsReceived ?? 0}</span>
              </div>

              {/* Reconnect attempts */}
              <div className="flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-2 text-slate-500">
                  <RefreshCw size={12} className="text-slate-400" />
                  <span>Reconnects</span>
                </div>
                <span className="font-bold text-slate-700">{diagnostics?.totalReconnects ?? 0}</span>
              </div>

              {/* Connected since */}
              <div className="flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-2 text-slate-500">
                  <Clock size={12} className="text-slate-400" />
                  <span>Session Start</span>
                </div>
                <span className="font-bold text-slate-700">{connectedTime}</span>
              </div>
            </div>

            {/* Infrastructure Note */}
            <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between">
              <span className="text-[9px] text-slate-400 font-bold">Node: sse-edge-us</span>
              <span className="text-[9px] text-emerald-500 font-bold flex items-center gap-1">
                <span className="w-1 h-1 rounded-full bg-emerald-500 animate-ping" />
                Active
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── Command Palette ─── */
function CommandPalette({
  items,
  onClose,
  onNavigate,
  onSearch,
}: {
  items: NavItem[];
  onClose: () => void;
  onNavigate: (path: string) => void;
  onSearch: () => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = query
    ? items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase()))
    : items;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/15 backdrop-blur-md flex items-start justify-center pt-[16vh] px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <motion.div
        initial={{ opacity: 0, y: -16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -16, scale: 0.97 }}
        transition={{ type: 'spring', damping: 30, stiffness: 400 }}
        className="w-full max-w-lg bg-white border border-zinc-200/80 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 p-4 border-b border-zinc-100">
          <Search size={18} className="text-[#8B5CF6] shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Where do you want to go?"
            className="flex-1 bg-transparent outline-none text-sm text-[#111827] placeholder:text-zinc-400 font-medium"
          />
          <button type="button" onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="p-2 max-h-72 overflow-y-auto">
          {filtered.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.path)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-zinc-600 hover:text-[#111827] hover:bg-zinc-50 transition-colors"
            >
              {item.icon}
              <span className="font-medium">{item.label}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="py-6 text-center text-sm text-zinc-500">No matches</p>
          )}
        </div>
        <div className="px-4 py-3 border-t border-zinc-100 text-xs text-zinc-500 bg-zinc-50/50">
          <button type="button" onClick={onSearch} className="hover:text-[#8B5CF6] font-semibold transition-colors">
            Advanced search
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default AppShell;
