import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { SearchX } from 'lucide-react';
import { Button } from '../components/ui';
import { scaleIn, springCalm, staggerContainer, staggerItem } from '../lib/motion';

export const NotFoundPage: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className="relative min-h-screen flex items-center justify-center px-4 overflow-hidden bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 font-sans">
      <div className="absolute top-1/4 left-1/4 w-[420px] h-[420px] bg-dt-primary/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-[360px] h-[360px] bg-dt-secondary/15 rounded-full blur-[100px] pointer-events-none" />

      <motion.main
        variants={scaleIn}
        initial="initial"
        animate="animate"
        transition={springCalm}
        className="dt-card dt-dark-glass dt-card-pad-xl relative z-10 w-full max-w-[480px] text-center"
      >
        <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="flex flex-col items-center">
          <motion.div
            variants={staggerItem}
            className="inline-flex items-center justify-center w-14 h-14 rounded-[18px] bg-white/5 border border-white/10 text-slate-300 mb-6"
          >
            <SearchX className="w-6 h-6" aria-hidden="true" />
          </motion.div>

          <motion.p variants={staggerItem} className="text-xs font-bold tracking-[0.2em] text-slate-500 mb-3">
            ERROR 404
          </motion.p>

          <motion.h1 variants={staggerItem} className="text-[32px] font-bold text-white tracking-tight leading-tight">
            Page Not Found
          </motion.h1>

          <motion.p variants={staggerItem} className="text-[15px] text-slate-400 mt-3 mb-8 max-w-[360px]">
            This page doesn't exist or may have been moved. Check the address, or head back to your dashboard.
          </motion.p>

          <motion.div variants={staggerItem}>
            <Button size="lg" onClick={() => navigate('/dashboard')}>
              Return to Dashboard
            </Button>
          </motion.div>
        </motion.div>
      </motion.main>
    </div>
  );
};

export default NotFoundPage;
