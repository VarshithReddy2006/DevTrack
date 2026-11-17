import { useEffect, useState } from 'react';
import { replaceEqualDeep, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useSse } from '../../../hooks/useSse';
import {
  getCurrentInterview, getInterview, startInterview, submitInterviewAnswer,
  type InterviewSession,
} from '../../../services/interviewService';
import { isProcessing } from '../interview';

const deltaSchema = z.object({
  sessionId: z.string(),
  turnIndex: z.number().int().min(0).max(4),
  stateVersion: z.number().int().nonnegative(),
  delta: z.string(),
  seq: z.number().int().nonnegative(),
});
const completedSchema = z.object({ sessionId: z.string() });

type Reply = {
  sessionId: string;
  turnIndex: number;
  stateVersion: number;
  chunks: Map<number, string>;
};

function matches(reply: Reply, session: InterviewSession) {
  return reply.sessionId === session.id && reply.turnIndex === session.currentTurnIndex
    && reply.stateVersion === session.stateVersion;
}

function replyText(reply: Reply) {
  const tokens: string[] = [];
  // Render the complete prefix as gaps fill. The server snapshot provides the final reply.
  for (let seq = 0; reply.chunks.has(seq); seq++) tokens.push(reply.chunks.get(seq)!);
  return tokens.join('');
}

function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 409;
}

export function useInterviewSession(userId: string) {
  const client = useQueryClient();
  const key = ['interview', 'current', userId] as const;
  const [reply, setReply] = useState<Reply | null>(null);
  const current = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => {
      const known = client.getQueryData<InterviewSession | null>(key);
      return known ? getInterview(known.id, signal) : getCurrentInterview(signal);
    },
    staleTime: 0,
    retry: false,
    refetchInterval: ({ state }) => isProcessing(state.data) ? 2_500 : false,
    structuralSharing: (oldData: unknown, newData: unknown) => {
      const previous = oldData as InterviewSession | null | undefined;
      const incoming = newData as InterviewSession | null;
      if (previous && incoming && previous.id === incoming.id && incoming.stateVersion < previous.stateVersion) {
        return previous;
      }
      return replaceEqualDeep(previous, incoming);
    },
  });

  const { isConnected } = useSse({
    onEvent: event => {
      const session = client.getQueryData<InterviewSession | null>(key);
      if (!session || session.status !== 'in_progress') return;
      if (event.type === 'interview.session.completed') {
        const parsed = completedSchema.safeParse(event.payload);
        if (parsed.success && parsed.data.sessionId === session.id) {
          void client.invalidateQueries({ queryKey: key, exact: true });
        }
        return;
      }
      if (event.type !== 'interview.turn.delta') return;
      const parsed = deltaSchema.safeParse(event.payload);
      if (!parsed.success) return;
      const { sessionId, turnIndex, stateVersion, delta, seq } = parsed.data;
      if (sessionId !== session.id || turnIndex !== session.currentTurnIndex) return;
      const scoring = session.state === 'SCORING' && stateVersion === session.stateVersion;
      const early = session.state === 'QUESTION_PENDING' && stateVersion === session.stateVersion + 1;
      if (!scoring && !early) return;

      setReply(previous => {
        if (previous?.sessionId === sessionId && previous.turnIndex === turnIndex && previous.stateVersion === stateVersion) {
          if (previous.chunks.has(seq)) return previous;
          return { ...previous, chunks: new Map(previous.chunks).set(seq, delta) };
        }
        return { sessionId, turnIndex, stateVersion, chunks: new Map([[seq, delta]]) };
      });
    },
  });

  useEffect(() => {
    if (isConnected) void client.invalidateQueries({ queryKey: ['interview', 'current', userId], exact: true });
  }, [client, isConnected, userId]);

  async function save(session: InterviewSession) {
    await client.cancelQueries({ queryKey: key, exact: true });
    client.setQueryData<InterviewSession>(key, session);
  }

  async function recover(error: unknown) {
    if (isConflict(error)) await client.invalidateQueries({ queryKey: key, exact: true });
  }

  const start = useMutation({ mutationFn: startInterview, onSuccess: save, onError: recover, retry: false });
  const answer = useMutation({
    mutationFn: ({ session, answer }: { session: InterviewSession; answer: string }) =>
      submitInterviewAnswer(session.id, session.currentTurnIndex, answer, session.stateVersion),
    onSuccess: save,
    onError: recover,
    retry: false,
  });

  const session = current.data;
  const streamedReply = session?.state === 'SCORING' && reply && matches(reply, session) ? replyText(reply) : '';
  return {
    current, start, answer, streamedReply,
    reset: () => {
      setReply(null);
      start.reset();
      answer.reset();
      void client.resetQueries({ queryKey: key, exact: true });
    },
  };
}
