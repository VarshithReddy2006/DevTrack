import { useQueryClient } from '@tanstack/react-query';
import { useSse } from '../../hooks/useSse';
import type { JobTargetStatus } from '../../services/jobTargetsService';

export const JOB_TARGET_FLAG = 'jd-matcher';
export const JOB_TARGET_POLL_MS = 3_000;

export const jobTargetsKey = (userId: string) => ['job-targets', userId] as const;
export const jobTargetKey = (userId: string, targetId: string) => [...jobTargetsKey(userId), targetId] as const;

export const targetIsPending = (status?: JobTargetStatus) =>
  status === 'submitted' || status === 'parsing' || status === 'scoring';

export const statusLabels: Record<JobTargetStatus, string> = {
  submitted: 'Queued', parsing: 'Parsing', scoring: 'Scoring', ready: 'Ready', failed: 'Failed',
};

export function useJobTargetUpdates(userId: string) {
  const client = useQueryClient();
  useSse({
    onEvent: event => {
      if (event.type !== 'jobtarget.parsed') return;
      const targetId = event.payload?.jobTargetId;
      if (typeof targetId !== 'string' || !targetId) return;

      void client.invalidateQueries({ queryKey: jobTargetsKey(userId), exact: true });
      void client.invalidateQueries({ queryKey: jobTargetKey(userId, targetId), exact: true });
    },
  });
}
