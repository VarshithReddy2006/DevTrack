import { Types } from 'mongoose';

const COLLECTION = 'revisioncards';
const OBJECT_ID_STRING_PATTERN = /^[a-fA-F0-9]{24}$/;

export const name = '20261126000000-normalizeRevisionCardUserId';

export async function up({ db, session }) {
  const collection = db.collection(COLLECTION);
  const docs = await collection
    .find({ userId: { $type: 'string', $regex: OBJECT_ID_STRING_PATTERN } }, { session })
    .toArray();

  for (const doc of docs) {
    const userObjId = new Types.ObjectId(doc.userId);
    const existing = await collection.findOne(
      { userId: userObjId, problemKey: doc.problemKey },
      { session },
    );

    if (existing) {
      const tags = Array.isArray(doc.tags) ? doc.tags : [];
      const tagWeight =
        typeof doc.tagWeight === 'number' && Number.isFinite(doc.tagWeight) ? doc.tagWeight : 1;
      await collection.updateOne(
        { _id: existing._id },
        {
          ...(tags.length ? { $addToSet: { tags: { $each: tags } } } : {}),
          $max: { tagWeight },
        },
        { session },
      );
      await collection.deleteOne({ _id: doc._id }, { session });
    } else {
      await collection.updateOne(
        { _id: doc._id },
        { $set: { userId: userObjId } },
        { session },
      );
    }
  }
}

export async function down() {
  // Data-repair migration: keep normalized ObjectId userId values intact so
  // revision queue and analytics aggregation pipelines remain consistent.
}

export default {
  name,
  up,
  down,
};
