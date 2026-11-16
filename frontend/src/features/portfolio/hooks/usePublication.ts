import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchPublication,
  isPublicationUnavailable,
  publishProfile,
  unpublishProfile,
  type PublicationStatus,
  type PublishInput,
} from '../../../services/publicationService';

export const PUBLICATION_QUERY_KEY = ['profilePublication'] as const;

export function usePublication() {
  const queryClient = useQueryClient();
  const query = useQuery<PublicationStatus, Error>({
    queryKey: PUBLICATION_QUERY_KEY,
    queryFn: ({ signal }) => fetchPublication({ signal }),
    staleTime: 60 * 1000,
    // A server without the API will not grow it by retrying.
    retry: (count, error) => !isPublicationUnavailable(error) && count < 1,
  });

  const remember = (status: PublicationStatus) => queryClient.setQueryData(PUBLICATION_QUERY_KEY, status);
  const publish = useMutation<PublicationStatus, unknown, PublishInput>({ mutationFn: (input) => publishProfile(input), onSuccess: remember });
  const unpublish = useMutation<PublicationStatus, unknown>({ mutationFn: () => unpublishProfile(), onSuccess: remember });

  return {
    status: query.data,
    isLoading: query.isLoading,
    isUnavailable: query.isError && isPublicationUnavailable(query.error),
    isError: query.isError && !isPublicationUnavailable(query.error),
    refetch: () => query.refetch(),
    publish,
    unpublish,
  };
}
