import React from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';

interface Props {
  domain: string;
  title: string;
  coreQuestion: string;
  icon: React.ReactNode;
  accentColor: string;
  actions?: React.ReactNode;
}

export const WorkspaceHeader: React.FC<Props> = ({ domain, title, coreQuestion, icon, accentColor, actions }) => {
  const navigate = useNavigate();

  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="mb-8"
    >
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => navigate('/readiness')}
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-600 transition-colors group"
        >
          <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
          Mission Control
        </button>
        <ChevronRight size={12} className="text-slate-300" />
        <span className="text-xs font-bold uppercase tracking-wider" style={{ color: accentColor }}>{domain}</span>
      </div>

      {/* Title Block */}
      <div className={actions ? "flex flex-wrap items-center gap-4" : "flex items-center gap-4"}>
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-lg"
          style={{ background: `linear-gradient(135deg, ${accentColor}20, ${accentColor}40)`, border: `1px solid ${accentColor}30` }}
        >
          <span style={{ color: accentColor }}>{icon}</span>
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-black tracking-tight text-slate-800">{title}</h1>
          <p className="text-sm font-medium text-slate-500 mt-0.5 italic">"{coreQuestion}"</p>
        </div>
        {actions && <div className="ml-auto shrink-0">{actions}</div>}
      </div>
    </motion.div>
  );
};
