import React from 'react';
import { motion } from 'framer-motion';
import { Eye, Crosshair, FileSearch, Wrench, PlayCircle } from 'lucide-react';

const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: Eye },
  { id: 'job-match', label: 'Job Match', icon: Crosshair },
  { id: 'replay', label: 'ATS Replay', icon: PlayCircle },
  { id: 'resume-audit', label: 'Resume Audit', icon: FileSearch },
  { id: 'improvement-center', label: 'Improvement Center', icon: Wrench },
] as const;

interface SectionNavigationProps {
  activeSection: string;
  onSectionSelect: (id: string) => void;
}

export const SectionNavigation: React.FC<SectionNavigationProps> = ({ activeSection, onSectionSelect }) => {
  return (
    <nav className="w-full sticky top-0 z-20 bg-[#FAFAFC]/80 backdrop-blur-lg border-b border-[rgba(124,92,252,0.06)] -mx-6 lg:-mx-10 px-6 lg:px-10">
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-none py-1">
        {SECTIONS.map((section) => {
          const isActive = activeSection === section.id;
          const Icon = section.icon;

          return (
            <button
              key={section.id}
              onClick={() => onSectionSelect(section.id)}
              className={`
                relative flex items-center gap-2 px-4 py-3 rounded-lg
                text-[13px] font-semibold whitespace-nowrap
                transition-colors duration-200
                ${isActive
                  ? 'text-dt-primary'
                  : 'text-dt-textMuted hover:text-dt-textSecondary hover:bg-[rgba(124,92,252,0.03)]'
                }
              `}
            >
              <Icon className="w-4 h-4" />
              <span>{section.label}</span>

              {/* Active indicator */}
              {isActive && (
                <motion.div
                  layoutId="section-tab-indicator"
                  className="absolute bottom-0 left-3 right-3 h-[2px] rounded-full bg-dt-primary"
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
