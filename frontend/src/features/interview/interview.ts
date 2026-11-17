import type { InterviewRole, InterviewSession } from '../../services/interviewService';

export const INTERVIEW_STUDIO_FLAG = 'interview-studio';
export const INTERVIEW_STUDIO_PATH = '/interview';
export const interviewReviewPath = (id: string) => `${INTERVIEW_STUDIO_PATH}/${encodeURIComponent(id)}/review`;
export const INTERVIEW_ANSWER_LIMIT = 8_000;

export const INTERVIEW_ROLE_LABELS: Record<InterviewRole, string> = {
  backend: 'Backend Engineer',
  distributed_systems: 'Distributed Systems Architect',
  frontend_architect: 'Frontend Architect',
  fullstack: 'Full-Stack Lead',
};

export const isProcessing = (session?: InterviewSession | null) =>
  session?.status === 'in_progress' && session.state !== 'QUESTION_PENDING';
