import { Types } from 'mongoose';

export const EMBEDDING_VERSION = '2.0.0';

export type EmbeddingScope =
  | { scope: 'user'; userId: string }
  | { scope: 'global'; userId?: never };

export function embeddingScopeFilter(scope: EmbeddingScope) {
  if (scope?.scope === 'global' && scope.userId === undefined) {
    return { scope: 'global' as const, userId: null };
  }
  if (scope?.scope === 'user' && typeof scope.userId === 'string' && Types.ObjectId.isValid(scope.userId)) {
    return { scope: 'user' as const, userId: new Types.ObjectId(scope.userId) };
  }
  throw new Error('A valid embedding owner or explicit global scope is required');
}
