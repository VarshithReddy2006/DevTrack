import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { beforeAll, afterAll, beforeEach } from 'vitest';
import { createIntegrationDatabase } from './database.js';

// Reject inherited application URIs before provisioning or connecting. The
// fixture owns both a fresh MongoDB process and a unique database per test file.
const database = await createIntegrationDatabase(
  mongoose,
  () => MongoMemoryReplSet.create({ binary: { version: '7.0.14' }, replSet: { count: 1 } }),
  process.env.MONGODB_URI,
);

// Application config loads dotenv at import time. Set the owned URI before
// dynamically importing any application modules, including models and Redis.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = database.uri;
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.PORT = '0';
process.env.ENABLE_WORKERS = 'false';
process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || 'sk_test_mock_clerk_secret_key_12345';

afterAll(async () => {
  try {
    await database.close();
  } finally {
    if (process.env.MONGODB_URI === database.uri) delete process.env.MONGODB_URI;
  }
});

const [{ getRedisClient, disconnectRedis }, { logger }, { User, UserXp }] = await Promise.all([
  import('../../shared/redis/index.js'),
  import('../../shared/logger.js'),
  import('../../db/models/index.js'),
]);

beforeAll(async () => {
  // Silence logger during tests unless debugging
  if (process.env.DEBUG !== 'true') {
    process.env.SILENT_LOGGING = 'true';
  }

  // Test Redis connection with a timeout to avoid hangs if Redis is offline
  const redis = getRedisClient();
  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 2000))
    ]);
  } catch (err) {
    logger.warn('[test-setup] Redis is offline. Running integration tests in degraded mode.', { error: String(err) });
  }
});

afterAll(async () => {
  await disconnectRedis();
});

beforeEach(async () => {
  await database.clear();

  // Seed baseline data
  const testUser = await User.create({
    clerkId: 'clerk_test_integration_user',
    email: 'test_integration@devtrack.app',
    username: 'test_integration',
    displayName: 'Test Integration User',
  });

  await UserXp.create({
    userId: testUser._id,
    totalXp: 500,
    currentLevel: 2,
    xpToNextLevel: 500,
    history: [],
  });
});
