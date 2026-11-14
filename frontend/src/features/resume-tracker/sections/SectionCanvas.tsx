import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ATSReplayViewer } from '../replay/ATSReplayViewer';
import { OverviewSection } from './OverviewSection';
import { JobMatchSection } from './JobMatchSection';
import { ResumeAuditSection } from './ResumeAuditSection';
import { ImprovementCenterSection } from './ImprovementCenterSection';

interface SectionCanvasProps {
  activeSection: string;
}

const sectionVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

export const SectionCanvas: React.FC<SectionCanvasProps> = ({ activeSection }) => {
  return (
    <div className="w-full">
      <AnimatePresence mode="wait">
        <motion.div
          key={activeSection}
          variants={sectionVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        >
          {activeSection === 'overview' && <OverviewSection />}
          {activeSection === 'job-match' && <JobMatchSection />}
          {activeSection === 'replay' && <ATSReplayViewer />}
          {activeSection === 'resume-audit' && <ResumeAuditSection />}
          {activeSection === 'improvement-center' && <ImprovementCenterSection />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};
