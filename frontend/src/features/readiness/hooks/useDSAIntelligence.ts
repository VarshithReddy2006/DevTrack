import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchDsaIntelligence,
  syncDsaIntelligence,
  type DsaIntelligenceResponse,
} from '../services/dsaIntelligenceService';
import { useUserStore } from '../../../store/userStore';

export const useDSAIntelligence = () => {
  const { user } = useUserStore();

  return useQuery<DsaIntelligenceResponse, Error>({
    queryKey: ['dsaIntelligence', user?.id],
    queryFn: fetchDsaIntelligence,
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1,
  });
};

export const useSyncDSAIntelligence = () => {
  const { user } = useUserStore();
  const queryClient = useQueryClient();

  return useMutation<DsaIntelligenceResponse, Error, void>({
    mutationFn: syncDsaIntelligence,
    onSuccess: (updated) => {
      queryClient.setQueryData(['dsaIntelligence', user?.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['readinessData'] });
      void queryClient.invalidateQueries({ queryKey: ['placementRadar'] });
    },
  });
};
