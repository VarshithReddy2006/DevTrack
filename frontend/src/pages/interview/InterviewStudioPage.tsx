import { useAuth } from '@clerk/clerk-react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AnswerComposer } from '../../features/interview/components/AnswerComposer';
import { InterviewTranscript } from '../../features/interview/components/InterviewTranscript';
import { QuestionCard } from '../../features/interview/components/QuestionCard';
import { RolePicker } from '../../features/interview/components/RolePicker';
import { useInterviewSession } from '../../features/interview/hooks/useInterviewSession';
import { INTERVIEW_ROLE_LABELS, interviewReviewPath, isProcessing } from '../../features/interview/interview';

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === 'object' && error !== null && 'message' in error
      && typeof error.message === 'string' && error.message) return error.message;
  return fallback;
}

function Studio({ userId }: { userId: string }) {
  const { current, start, answer, streamedReply, reset } = useInterviewSession(userId);
  const reduceMotion = useReducedMotion();
  const session = current.data;
  const turn = session?.turns[session.currentTurnIndex];
  const processing = isProcessing(session);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-8 text-slate-900 sm:px-8">
      <header className="space-y-2">
        <Link to="/readiness" className="inline-flex items-center gap-1.5 text-sm font-medium text-violet-700 hover:underline">
          <ArrowLeft size={16} aria-hidden="true" /> Readiness
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Interview studio</h1>
        {session && <p className="text-sm text-slate-600">{INTERVIEW_ROLE_LABELS[session.role]}</p>}
      </header>
      {current.isPending && <p role="status" className="text-sm text-slate-600">Checking for an active interview…</p>}
      {current.isError && (
        <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p role="alert">Couldn’t load the latest interview state.</p>
          <button type="button" className="underline" onClick={() => void current.refetch()}>Try again</button>
        </div>
      )}
      {session === null && <RolePicker pending={start.isPending} onStart={role => start.mutate(role)} />}
      {start.isError && !session && (
        <p role="alert" className="text-sm text-red-700">{errorMessage(start.error, 'Couldn’t start the interview.')}</p>
      )}
      {session?.status === 'in_progress' && (
        <>
          {processing && session.state !== 'SCORING' && (
            <p role="status" className="rounded-xl bg-violet-50 p-4 text-sm text-violet-900">
              {session.state === 'FINAL_SCORECARD' ? 'Preparing your scorecard…' : 'Preparing your question…'}
            </p>
          )}
          {session.state === 'QUESTION_PENDING' && turn && (
            <motion.div key={`${session.id}:${session.currentTurnIndex}`} className="space-y-4"
              initial={reduceMotion ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}>
              <QuestionCard index={session.currentTurnIndex} prompt={turn.question.prompt} />
              <AnswerComposer pending={answer.isPending} onAnswer={text => answer.mutate({ session, answer: text })} />
              {answer.isError && answer.variables?.session.currentTurnIndex === session.currentTurnIndex && (
                <p role="alert" className="text-sm text-red-700">{errorMessage(answer.error, 'Couldn’t submit your answer.')}</p>
              )}
            </motion.div>
          )}
        </>
      )}
      {session && session.status !== 'in_progress' && (
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
          {session.status === 'completed' ? (
            <Link to={interviewReviewPath(session.id)} className="font-semibold text-violet-700 underline">Review scorecard</Link>
          ) : <p>{session.status === 'expired' ? 'This interview has expired.' : 'This interview has ended.'}</p>}
          <button type="button" className="font-medium text-violet-700 underline" onClick={reset}>Start another interview</button>
        </div>
      )}
      {session && (
        <InterviewTranscript turns={session.turns}
          live={session.state === 'SCORING' && session.status === 'in_progress'
            ? { turnIndex: session.currentTurnIndex, text: streamedReply } : undefined} />
      )}
    </div>
  );
}

export default function InterviewStudioPage() {
  const { userId } = useAuth();
  return userId ? <Studio key={userId} userId={userId} /> : null;
}
