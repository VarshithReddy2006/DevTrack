import { useEffect, useState } from 'react';
import { motion, useSpring } from 'framer-motion';

export interface ScoreRadialDialProps {
  score: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
  className?: string;
}

function getScoreColor(score: number): string {
  if (score >= 80) return '#10b981'; // emerald-500
  if (score >= 60) return '#f59e0b'; // amber-500
  return '#ef4444'; // red-500
}

export function ScoreRadialDial({
  score,
  size = 120,
  strokeWidth = 10,
  label = 'ATS score dial',
  className = '',
}: ScoreRadialDialProps) {
  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  const [displayScore, setDisplayScore] = useState(clampedScore);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (clampedScore / 100) * circumference;
  const strokeColor = getScoreColor(clampedScore);

  const spring = useSpring(clampedScore, { stiffness: 60, damping: 20 });

  useEffect(() => {
    spring.set(clampedScore);
    const unsubscribe = spring.on('change', (latest) => {
      setDisplayScore(Math.round(latest));
    });
    // Ensure synchronous update for static/test environments
    setDisplayScore(clampedScore);
    return () => unsubscribe();
  }, [clampedScore, spring]);

  const center = size / 2;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={clampedScore}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`relative inline-flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="block"
      >
        {/* Background track circle */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#e2e8f0" /* slate-200 */
          strokeWidth={strokeWidth}
        />
        {/* Animated progress circle */}
        <motion.circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      {/* Centered Score Readout */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center select-none pointer-events-none">
        <span className="text-3xl font-bold tracking-tight text-slate-900 leading-none">
          {displayScore}
        </span>
        <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider mt-0.5">
          / 100
        </span>
      </div>
    </div>
  );
}
