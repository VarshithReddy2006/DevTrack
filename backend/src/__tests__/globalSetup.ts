import { MongoMemoryReplSet } from 'mongodb-memory-server';

let mongoServer: MongoMemoryReplSet | null = null;

export async function setup() {
  process.env.MONGOMS_MD5_CHECK = '0';
  mongoServer = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: {
      version: '7.0.14',
    },
  });
  const uri = mongoServer.getUri();
  process.env.MONGO_TEST_URI = uri;
  console.log('[globalSetup] Started shared MongoMemoryReplSet:', uri);
}

export async function teardown() {
  if (mongoServer) {
    console.log('[globalSetup] Stopping shared MongoMemoryReplSet');
    await mongoServer.stop();
    mongoServer = null;
  }
}
