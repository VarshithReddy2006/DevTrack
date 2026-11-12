import { useQuery } from '@tanstack/react-query';
import { fetchDsaIntelligence, type DsaIntelligenceResponse } from '../services/dsaIntelligenceService';
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
