import { Types, type Query, type Schema } from 'mongoose';
import { Embedding } from './embedding.model.js';

type DeleteQuery<T> = Query<unknown, T, object, T, 'deleteOne' | 'deleteMany'>;

export interface EmbeddingOwner {
  userId?: Types.ObjectId | string | null;
  /** The key the parent's embeddings were saved under (EmbeddingPersistenceLayer's sessionId). */
  sessionId?: string | null;
}

/**
 * Removes the embeddings of deleted parent documents. Rows are matched on owner AND key, and a parent
 * without an owner is skipped, so one user's delete can never reach another user's vectors.
 * Covers doc.deleteOne(), Model.deleteOne/deleteMany and findOneAndDelete/findByIdAndDelete. Raw
 * collection deletes and bulkWrite bypass Mongoose middleware and are not covered.
 */
export function cascadeEmbeddingDeletes<T>(schema: Schema<T>, owner: (doc: Record<string, unknown>) => EmbeddingOwner): void {
  const removeFor = async (docs: Record<string, unknown>[]) => {
    const filters = docs.flatMap(doc => {
      const { userId, sessionId } = owner(doc);
      if (!userId || !sessionId || !Types.ObjectId.isValid(String(userId))) return [];
      return [{ scope: 'user' as const, userId: new Types.ObjectId(String(userId)), sessionId }];
    });
    if (filters.length) await Embedding.deleteMany({ $or: filters });
  };

  schema.post('deleteOne', { document: true, query: false }, async function () {
    await removeFor([this as unknown as Record<string, unknown>]);
  });

  schema.post('findOneAndDelete', async function (doc: unknown) {
    if (doc) await removeFor([doc as Record<string, unknown>]);
  });

  // Query deletes do not hand over the documents, so read the targets first and clean up once the delete succeeded.
  const pending = new WeakMap<object, Record<string, unknown>[]>();
  for (const op of ['deleteOne', 'deleteMany'] as const) {
    schema.pre(op, { document: false, query: true }, async function (this: DeleteQuery<T>) {
      const find = this.model.find(this.getFilter());
      if (op === 'deleteOne') find.limit(1);
      pending.set(this, await find.lean<Record<string, unknown>[]>());
    });
    schema.post(op, { document: false, query: true }, async function (this: DeleteQuery<T>) {
      const docs = pending.get(this);
      pending.delete(this);
      if (docs?.length) await removeFor(docs);
    });
  }
}
