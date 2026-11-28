// ============================================================================
// BottomNav.tsx — Mobile Bottom Navigation
// ============================================================================
// iOS/Android-style bottom navigation for mobile devices.
// ============================================================================

import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Home, FolderKanban, User } from 'lucide-react';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { safeAreas } from '../../design-system/layout';
import { prefersReducedMotion } from '../../design-system/motion';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

// ---------------------------------------------------------------------------
// Navigation Items
// ---------------------------------------------------------------------------

const navItems: NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', icon: Home },
  { path: '/projects', label: 'Projects', icon: FolderKanban },
  { path: '/profile', label: 'Profile', icon: User },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const BottomNav: React.FC = () => {
  const location = useLocation();
  const isMobile = useIsMobile();
  
  // Only show on mobile
  if (!isMobile) return null;

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200 shadow-[0_-4px_16px_rgba(0,0,0,0.08)]"
      style={{
        paddingBottom: safeAreas.bottom,
      }}
      role="navigation"
      aria-label="Mobile navigation"
    >
      <div className="flex items-center justify-around h-16">
        {navItems.map((item) => {
          const isActive = location.pathname.startsWith(item.path);
          const Icon = item.icon;
          
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className="relative flex flex-col items-center justify-center flex-1 h-full group"
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              {/* Active indicator */}
              {isActive && !prefersReducedMotion && (
                <motion.div
                  layoutId="bottomNavIndicator"
                  className="absolute top-0 left-1/2 -translate-x-1/2 w-12 h-1 bg-dt-primary rounded-b-full"
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                />
              )}
              
              {/* Icon */}
              <motion.div
                animate={isActive && !prefersReducedMotion ? { scale: [1, 1.1, 1] } : {}}
                transition={{ duration: 0.3 }}
                className="mb-1"
              >
                <Icon
                  size={22}
                  className={[
                    'transition-colors duration-200',
                    isActive
                      ? 'text-dt-primary'
                      : 'text-gray-400 group-hover:text-gray-600',
                  ].join(' ')}
                />
              </motion.div>
              
              {/* Label */}
              <span
                className={[
                  'text-[10px] font-bold uppercase tracking-wider transition-colors duration-200',
                  isActive
                    ? 'text-dt-primary'
                    : 'text-gray-400 group-hover:text-gray-600',
                ].join(' ')}
              >
                {item.label}
              </span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
};

export default BottomNav;
