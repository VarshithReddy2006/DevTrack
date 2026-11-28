const COLLECTION = 'dailychallengeassignments';
const INDEX_NAME = 'userId_1_dayKey_1';

export const name = '20261128105000-dailyChallengeAssignments';
export const transactional = false;

// Production runs with Mongoose autoIndex off. The unique index is what keeps concurrent
// first reads from creating two assignments for the same user and day.
export async function up({ db }) {
  await db.collection(COLLECTION).createIndex({ userId: 1, dayKey: 1 }, { name: INDEX_NAME, unique: true });
}

export async function down({ db }) {
  try {
    await db.collection(COLLECTION).dropIndex(INDEX_NAME);
  } catch (error) {
    // 26 = namespace not found, 27 = index not found: already rolled back.
    if (error?.code !== 26 && error?.code !== 27) throw error;
  }
}

export default { name, transactional, up, down };
