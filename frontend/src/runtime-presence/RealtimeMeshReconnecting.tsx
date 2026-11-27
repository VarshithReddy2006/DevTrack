// frontend/src/runtime-presence/RealtimeMeshReconnecting.tsx
// Cinematic replacement for generic "reconnecting" alerts.
// Communicates resilience and intelligence through an animated mesh recovery state.

import React from 'react';
import { motion, colors, typography, depth, telemetry } from '../design-system/tokens/index.ts';

interface RealtimeMeshReconnectingProps {
  status: 'connecting' | 'reconnecting' | 'restoring' | 'connected';
}

export const RealtimeMeshReconnecting: React.FC<RealtimeMeshReconnectingProps> = ({ status }) => {
  const isActive = status !== 'connected';

  if (!isActive) return null;

  return (
    <div
      className="fixed bottom-20 md:bottom-6 right-4 md:right-6 overflow-hidden z-40 flex items-center gap-4 px-5 py-3 rounded-xl transition-all duration-[800ms]"
      style={{
        background: colors.surface.floating,
        backdropFilter: depth.glass.heavy,
        border: `1px solid ${colors.surface.borderGlow}`,
        boxShadow: depth.shadows.level3,
        transform: isActive ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.95)',
        opacity: isActive ? 1 : 0,
        pointerEvents: isActive ? 'auto' : 'none',
        transitionTimingFunction: motion.spring.fluid,
      }}
    >
      {/* Animated Mesh Icon */}
      <div className="relative w-6 h-6 flex items-center justify-center">
        {/* Core node */}
        <div 
          className="absolute w-2 h-2 rounded-full"
          style={{
            background: status === 'restoring' ? colors.accent.primary : colors.accent.warning,
            boxShadow: `0 0 10px ${status === 'restoring' ? colors.accent.primary : colors.accent.warning}`,
          }}
        />
        {/* Orbiting recovery ring */}
        <div 
          className="absolute inset-0 rounded-full border border-t-transparent animate-spin"
          style={{
            borderColor: status === 'restoring' ? colors.accent.primary : colors.accent.warning,
            borderTopColor: 'transparent',
            animationDuration: status === 'restoring' ? '1s' : '2s',
          }}
        />
        {/* Pulse effect */}
        <div
          className="absolute inset-0 rounded-full animate-ping opacity-30"
          style={{
            background: status === 'restoring' ? colors.accent.primary : colors.accent.warning,
            animationDuration: telemetry.pulseParams.frequency,
          }}
        />
      </div>

      <div className="flex flex-col">
        <span 
          style={{ 
            fontFamily: typography.family.display, 
            fontWeight: typography.weights.semibold,
            color: colors.text.primary,
            fontSize: '14px',
            letterSpacing: typography.tracking.tight,
          }}
        >
          Runtime Mesh Recovery
        </span>
        <span
          style={{
            fontFamily: typography.family.mono,
            color: colors.text.secondary,
            fontSize: '11px',
            letterSpacing: typography.tracking.wide,
            textTransform: 'uppercase'
          }}
        >
          {status === 'reconnecting' ? 'Establishing secure channel...' : 'Restoring signal integrity...'}
        </span>
      </div>
    </div>
  );
};
