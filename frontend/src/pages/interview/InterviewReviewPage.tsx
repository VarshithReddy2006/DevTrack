import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { InterviewTranscript } from '../../features/interview/components/InterviewTranscript';
import { Scorecard } from '../../features/interview/components/Scorecard';
import { INTERVIEW_ROLE_LABELS, INTERVIEW_STUDIO_PATH } from '../../features/interview/interview';
import { getInterview } from '../../services/interviewService';

function Review({ userId, sessionId }: { userId: string; sessionId: string }) {
  const reduceMotion = useReducedMotion();
  const query = useQuery({
    queryKey: ['interview', 'review', userId, sessionId],
    queryFn: ({ signal }) => getInterview(sessionId, signal),
    retry: false,
  });
  const session = query.data;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-8 text-slate-900 sm:px-8">
      <header className="space-y-2">
        <Link to={INTERVIEW_STUDIO_PATH} className="inline-flex items-center gap-1.5 text-sm font-medium text-violet-700 hover:underline">
          <ArrowLeft size={16} aria-hidden="true" /> Interview studio
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Interview review</h1>
        {session && <p className="text-sm text-slate-600">{INTERVIEW_ROLE_LABELS[session.role]}</p>}
      </header>
      {query.isPending && <p role="status" className="text-sm text-slate-600">Loading your scorecard…</p>}
      {query.isError && (
        <div className="space-y-2 text-sm text-red-800">
          <p role="alert">Couldn’t load this interview.</p>
          <button type="button" className="underline" onClick={() => void query.refetch()}>Try again</button>
        </div>
      )}
      {session?.status === 'completed' && session.scorecard && (
        <motion.div className="space-y-5" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }}>
          <Scorecard scorecard={session.scorecard} basicMode={session.mode === 'basic_mode'} />
          <InterviewTranscript turns={session.turns} />
        </motion.div>
      )}
      {session && (session.status !== 'completed' || !session.scorecard) && (
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
          A scorecard isn’t available for this interview.
        </p>
      )}
    </div>
  );
}

export default function InterviewReviewPage() {
  const { userId } = useAuth();
  const { sessionId } = useParams();
  return userId && sessionId ? <Review userId={userId} sessionId={sessionId} /> : null;
}
