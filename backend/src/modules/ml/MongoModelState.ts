import mongoose from 'mongoose';

interface StateDocument<T> {
  _id: string;
  revision: number;
  value: T;
}

/** Atomic per-key updates shared by API and worker processes. */
export class MongoModelState<T> {
  constructor(private readonly name: string) {}

  private collection() {
    const db = mongoose.connection.db;
    if (!db || mongoose.connection.readyState !== 1) {
      throw new Error('MongoDB is unavailable for ML governance');
    }
    return db.collection<StateDocument<T>>(this.name);
  }

  async get(id: string): Promise<T | undefined> {
    return (await this.collection().findOne({ _id: id }))?.value;
  }

  async list(): Promise<T[]> {
    return this.collection().find().map(document => document.value).toArray();
  }

  async update(id: string, change: (current: T | undefined) => T | undefined): Promise<T | undefined> {
    const collection = this.collection();
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await collection.findOne({ _id: id });
      const value = change(current?.value);
      if (value === undefined) return undefined;

      if (current) {
        const result = await collection.updateOne(
          { _id: id, revision: current.revision },
          { $set: { value }, $inc: { revision: 1 } },
        );
        if (result.modifiedCount === 1) return value;
      } else {
        try {
          await collection.insertOne({ _id: id, revision: 1, value });
          return value;
        } catch (error) {
          if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
        }
      }
    }

    throw new Error('Concurrent ML governance updates exceeded retry limit');
  }
}
