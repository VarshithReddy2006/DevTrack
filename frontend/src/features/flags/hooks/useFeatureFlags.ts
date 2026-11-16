import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { getFlags } from '../../../services/flagsService';

export function useFeatureFlags() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const canFetch = isLoaded && isSignedIn && Boolean(userId);
  const query = useQuery({
    queryKey: ['feature-flags', userId],
    queryFn: ({ signal }) => getFlags(signal),
    enabled: canFetch,
    staleTime: 60_000,
    retry: false,
  });

  return {
    isEnabled: (key: string) => Boolean(canFetch && !query.isError && query.data?.[key] === true),
    isLoading: !isLoaded || query.isLoading,
    error: query.error,
    retry: query.refetch,
  };
}
