import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  MessageSquare,
  Sparkles,
  Send,
  Loader2,
  Bot,
  User,
  AlertTriangle,
  RefreshCcw,
} from 'lucide-react';

import { useReadinessDomain, useReadinessData } from '../../features/readiness/hooks/useReadinessData';
import { WorkspaceHeader } from '../../features/readiness/components/WorkspaceHeader';
import { EmptyState } from '../../components/shared/EmptyState';
import { readinessService } from '../../services/readinessService';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isError?: boolean;
};

const AIGuidancePage: React.FC = () => {
  const { data: copilotData, loading: copilotLoading, error: copilotError } = useReadinessDomain('copilot');
  const { data: dsaData } = useReadinessDomain('dsa');
  const { data: roadmapData } = useReadinessDomain('roadmap');
  const { data: evolutionData } = useReadinessDomain('evolution');
  const { data: snapshotData } = useReadinessData();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  // Restore persisted conversation turns on mount
  useEffect(() => {
    let active = true;
    const fetchHistory = async () => {
      try {
        const history = await readinessService.getCopilotHistory('career-copilot');
        if (active && history && history.length > 0) {
          setMessages(history);
        }
      } catch (err) {
        console.warn('Could not restore AI guidance history', err);
      }
    };
    void fetchHistory();
    return () => {
      active = false;
    };
  }, []);

  if (copilotLoading) {
    return (
      <div className="flex flex-col gap-6 max-w-[1400px] mx-auto w-full pb-16 px-4 animate-pulse">
        <div className="h-16 w-64 bg-slate-200/50 rounded-2xl" />
        <div className="h-[600px] bg-slate-200/50 rounded-[32px]" />
      </div>
    );
  }

  if (copilotError || !copilotData) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh]">
        <EmptyState size="lg" icon="alert" title="AI Guidance Unavailable" description="Could not load guidance terminal." />
      </div>
    );
  }



  // Generate Suggested Questions dynamically
  const getSuggestedQuestions = () => {
    const suggestions: string[] = [];
    
    // Resume (Using overallScore as proxy if ATS not immediately flat)
    if (snapshotData && snapshotData.dynamicState.overallScore < 60) {
      suggestions.push("How can I improve my resume and profile?");
    }

    // DSA
    const dsa = dsaData as any;
    if (dsa && dsa.intelligence) {
      if (dsa.intelligence.consistencyScore < 50) {
        suggestions.push("Create a DSA improvement plan.");
      }
    }

    // Roadmap
    const roadmap = roadmapData as any;
    if (roadmap && roadmap.roadmapProgress !== undefined) {
      if (roadmap.roadmapProgress < 40) {
        suggestions.push("What should I learn next?");
      }
    }

    // Evolution/Career
    const evolution = evolutionData as any;
    if (evolution && evolution.biggestBlocker && evolution.biggestBlocker.skill) {
      suggestions.push("What is blocking my career growth?");
    }

    // Fallbacks if not enough suggestions
    if (suggestions.length < 4) {
      const fallbacks = [
        "Am I placement ready?", 
        "What role fits me best?", 
        "Generate my roadmap.",
        "Why is my ATS score low?",
        "What topics should I practice?",
        "What project should I build next?"
      ];
      for (const fallback of fallbacks) {
        if (!suggestions.includes(fallback)) {
          suggestions.push(fallback);
          if (suggestions.length >= 4) break;
        }
      }
    }

    return suggestions.slice(0, 4);
  };

  const handleSend = async (text: string) => {
    if (!text.trim()) return;
    
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    const context = {
      resumeIntelligence: snapshotData?.rawMetrics?.skills,
      dsaIntelligence: dsaData && 'intelligence' in dsaData ? dsaData.intelligence : null,
      roadmapIntelligence: roadmapData,
      evolutionIntelligence: evolutionData,
      careerProfile: snapshotData?.dynamicState?.roleAlignment,
    };

    try {
      const history = messages.map(m => ({ role: m.role, content: m.content }));
      // Call persistent copilot endpoint
      const aiResponseText = await readinessService.sendCopilotChatRequest(text, context, history, 'career-copilot');
      
      setMessages(prev => [...prev, { id: (Date.now() + 1).toString(), role: 'assistant', content: aiResponseText }]);
    } catch (error) {
      setMessages(prev => [...prev, { 
        id: (Date.now() + 1).toString(),
        role: 'assistant', 
        content: 'Unable to generate guidance. Please try again.', 
        isError: true 
      }]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleClearHistory = async () => {
    await readinessService.clearCopilotHistory('career-copilot');
    setMessages([]);
  };

  const handleRetry = (text: string) => {
    setMessages(prev => {
      const newMsgs = [...prev];
      if (newMsgs[newMsgs.length - 1].isError) {
        newMsgs.pop(); // remove error
      }
      return newMsgs;
    });
    handleSend(text);
  };

  const suggestions = getSuggestedQuestions();

  return (
    <div className="min-h-[calc(100vh-64px)] bg-slate-50/50 relative flex flex-col">
      {/* Soft background glow */}
      <div className="absolute top-0 inset-x-0 h-[600px] bg-gradient-to-b from-indigo-50/80 via-white to-transparent pointer-events-none" />
      
      <div className="max-w-[1200px] mx-auto w-full pb-12 px-4 md:px-8 flex flex-col flex-1 relative z-10">
        <div className="pt-6 pb-6 flex justify-between items-center">
          <WorkspaceHeader
            domain="AI Guidance"
            title="AI Career Copilot"
            coreQuestion="What should I do next based on my DevTrack data?"
            icon={<MessageSquare size={24} />}
            accentColor="#EC4899"
          />
          {messages.length > 0 && (
            <button
              onClick={handleClearHistory}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-500 hover:text-rose-600 bg-white/80 hover:bg-rose-50 border border-slate-200 hover:border-rose-200 rounded-xl transition shadow-sm cursor-pointer"
              title="Reset conversation thread"
            >
              <RefreshCcw size={13} />
              Reset Thread
            </button>
          )}
        </div>

        {/* ─── Main Chat Container ─── */}
        <div className="flex flex-col flex-1 bg-white/70 backdrop-blur-xl border border-white/60 rounded-[32px] shadow-[0_8px_40px_rgb(0,0,0,0.06)] overflow-hidden min-h-[650px] mb-8">
          
          {/* Messages List Area */}
          <div className="flex-1 overflow-y-auto p-6 md:p-10 space-y-8 scroll-smooth">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-2xl mx-auto py-12">
                <div className="relative mb-8">
                  <div className="absolute inset-0 bg-gradient-to-br from-indigo-500 to-pink-500 rounded-3xl blur-[40px] opacity-20 animate-pulse" />
                  <div className="w-24 h-24 bg-gradient-to-br from-indigo-50 to-pink-50 border border-white rounded-3xl flex items-center justify-center shadow-lg relative z-10">
                    <Sparkles size={40} className="text-pink-500" />
                  </div>
                </div>
                <h3 className="text-3xl font-bold text-slate-800 mb-4 tracking-tight">Welcome to your Copilot</h3>
                <p className="text-base text-slate-500 mb-12 font-medium leading-relaxed max-w-md">
                  Your personal career coach powered by your DevTrack data. Ask anything about your skills, roadmap, or placement readiness.
                </p>
                
                <div className="w-full">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {suggestions.map((q, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSend(q)}
                        className="p-4 text-left bg-white/80 backdrop-blur-sm border border-slate-200/60 rounded-2xl text-sm font-semibold text-slate-700 hover:border-pink-300 hover:shadow-md hover:-translate-y-0.5 transition-all group"
                      >
                        <span className="group-hover:text-pink-600 transition-colors">{q}</span>
                        <div className="mt-2 text-[11px] font-medium text-slate-400">Click to ask &rarr;</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="max-w-4xl mx-auto w-full space-y-8 pb-10">
                {messages.map((msg) => {
                  const isUser = msg.role === 'user';
                  return (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`flex gap-5 w-full ${isUser ? 'flex-row-reverse' : ''}`}
                    >
                      {/* Avatar */}
                      <div className="shrink-0 pt-1">
                        {isUser ? (
                          <div className="w-10 h-10 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center shadow-sm">
                            <User size={18} className="text-slate-600" />
                          </div>
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-50 to-pink-50 border border-pink-100 flex items-center justify-center shadow-sm relative">
                            <Bot size={18} className="text-pink-500 relative z-10" />
                            <div className="absolute inset-0 bg-pink-400 rounded-full blur-[10px] opacity-20" />
                          </div>
                        )}
                      </div>
                      
                      {/* Bubble */}
                      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[85%] md:max-w-[75%]`}>
                        <div className={`px-6 py-4 text-[15px] leading-relaxed shadow-sm ${
                          isUser 
                            ? 'bg-slate-100 text-slate-800 rounded-3xl rounded-tr-sm font-medium' 
                            : msg.isError
                              ? 'bg-rose-50/80 backdrop-blur-sm border border-rose-100 text-rose-800 rounded-3xl rounded-tl-sm'
                              : 'bg-white/80 backdrop-blur-md border border-slate-100 text-slate-800 rounded-3xl rounded-tl-sm'
                        }`}>
                          {msg.isError ? (
                            <div className="flex flex-col gap-3">
                              <div className="flex items-center gap-2">
                                <AlertTriangle size={18} className="text-rose-500" />
                                <span className="font-semibold text-[15px]">{msg.content}</span>
                              </div>
                              <button
                                onClick={() => {
                                  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
                                  if (lastUserMsg) handleRetry(lastUserMsg.content as string);
                                }}
                                className="flex items-center gap-1.5 px-4 py-2 bg-rose-100 hover:bg-rose-200 text-rose-700 text-sm font-bold rounded-xl transition-colors w-fit shadow-sm hover:shadow"
                              >
                                <RefreshCcw size={14} /> Retry
                              </button>
                            </div>
                          ) : (
                            <div className="whitespace-pre-wrap">{msg.content}</div>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  );
                })}

                {isTyping && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex gap-5 max-w-4xl mx-auto w-full"
                  >
                    <div className="shrink-0 pt-1">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-50 to-pink-50 border border-pink-100 flex items-center justify-center shadow-sm relative">
                        <Bot size={18} className="text-pink-500 relative z-10" />
                        <div className="absolute inset-0 bg-pink-400 rounded-full blur-[10px] opacity-20 animate-pulse" />
                      </div>
                    </div>
                    <div className="px-6 py-4 rounded-3xl rounded-tl-sm bg-white/80 backdrop-blur-md border border-slate-100 shadow-sm flex items-center gap-3">
                      <Loader2 size={18} className="text-pink-500 animate-spin" />
                      <span className="text-[15px] text-slate-500 font-medium animate-pulse">DevTrack AI is analyzing your profile...</span>
                    </div>
                  </motion.div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* ─── Input Area ─── */}
          <div className="p-6 md:px-10 md:pb-8 md:pt-4 bg-white/50 backdrop-blur-lg border-t border-slate-100/50">
            <div className="max-w-4xl mx-auto">
              <div className="relative flex items-end gap-3 bg-white rounded-3xl p-2 shadow-[0_2px_12px_rgb(0,0,0,0.04)] border border-slate-200/80 focus-within:border-indigo-300 focus-within:ring-4 focus-within:ring-indigo-100/50 transition-all">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend(input);
                    }
                  }}
                  placeholder="Ask your career copilot..."
                  className="w-full max-h-40 min-h-[56px] bg-transparent border-none px-4 py-4 text-[15px] text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-0 resize-none font-medium leading-relaxed"
                  rows={1}
                />
                <button
                  onClick={() => handleSend(input)}
                  disabled={!input.trim() || isTyping}
                  className="shrink-0 w-14 h-14 bg-gradient-to-br from-indigo-600 to-pink-500 hover:from-indigo-700 hover:to-pink-600 disabled:from-slate-200 disabled:to-slate-200 disabled:text-slate-400 text-white rounded-2xl flex items-center justify-center transition-all shadow-md disabled:shadow-none mb-0.5 mr-0.5"
                >
                  <Send size={22} className={input.trim() && !isTyping ? "translate-x-0.5 -translate-y-0.5 transition-transform" : ""} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AIGuidancePage;
