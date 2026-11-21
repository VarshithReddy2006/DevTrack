import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listAdminFlags,
  listFlagAudit,
  updateAdminFlag,
  type AdminFeatureFlag,
  type FlagSettingsChange,
} from '../../../services/opsFlagsService';

export const adminFlagKeys = {
  all: ['ops', 'flags'] as const,
  list: ['ops', 'flags', 'list'] as const,
  audit: ['ops', 'flags', 'audit'] as const,
};

export const AUDIT_LIMIT = 50;

export function useAdminFlags() {
  return useQuery({
    queryKey: adminFlagKeys.list,
    queryFn: ({ signal }) => listAdminFlags(signal),
    retry: false,
  });
}

export function useFlagAudit() {
  return useQuery({
    queryKey: adminFlagKeys.audit,
    queryFn: ({ signal }) => listFlagAudit(AUDIT_LIMIT, signal),
    retry: false,
  });
}

/**
 * Updates one flag optimistically. A failed update rolls the row back, then the list is
 * refetched either way, because a 503 can mean "saved, but the cache wasn't invalidated".
 */
export function useUpdateFlag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, changes }: { key: string; changes: FlagSettingsChange }) => updateAdminFlag(key, changes),
    retry: false,
    onMutate: async ({ key, changes }) => {
      await queryClient.cancelQueries({ queryKey: adminFlagKeys.list });
      const previous = queryClient.getQueryData<AdminFeatureFlag[]>(adminFlagKeys.list);
      queryClient.setQueryData<AdminFeatureFlag[]>(adminFlagKeys.list, (flags) =>
        flags?.map((flag) => (flag.key === key ? { ...flag, ...changes } : flag)));
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(adminFlagKeys.list, context.previous);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<AdminFeatureFlag[]>(adminFlagKeys.list, (flags) =>
        flags?.map((flag) => (flag.key === updated.key ? updated : flag)));
    },
    onSettled: (_data, error) => {
      void queryClient.invalidateQueries({ queryKey: adminFlagKeys.audit });
      if (error) void queryClient.invalidateQueries({ queryKey: adminFlagKeys.list });
    },
  });
}
