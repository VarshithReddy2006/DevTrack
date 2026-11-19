import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { loadBulletHistory, restoreBulletRevision } from '../../../services/bulletRevisionService';

export const bulletHistoryKey = (userId: string, resumeId: string) => ['resume-bullet-history', userId, resumeId] as const;
export function useBulletRevisionHistory(userId: string, resumeId: string) {
  return useQuery({ queryKey: bulletHistoryKey(userId, resumeId), queryFn: ({ signal }) => loadBulletHistory(resumeId, signal), retry: false, staleTime: 0, refetchOnWindowFocus: false });
}
export function useRestoreRevision(userId: string, resumeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ version, expectedVersion }: { version: number; expectedVersion: number }) => restoreBulletRevision(resumeId, version, expectedVersion),
    retry: false,
    onSuccess: () => { void client.invalidateQueries({ queryKey: bulletHistoryKey(userId, resumeId) }); },
  });
}
