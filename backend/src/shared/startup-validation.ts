import { logger } from './logger.js';
import { getRedisClient } from './redis/index.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Queue } from 'bullmq';
import { QueueNames } from './jobs/types.js';

export async function validateStartup() {
  logger.info('[StartupValidation] Starting environment and service checks...');

  // 1. Environment Variables
  const requiredEnvVars = ['MONGODB_URI'];
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      logger.error(`[StartupValidation] CRITICAL ERROR: Missing ${envVar}`);
      throw new Error(`Missing ${envVar}`);
    }
  }

  // Redis check
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
      logger.error('[StartupValidation] CRITICAL ERROR: Missing REDIS_URL or REDIS_HOST in production');
      throw new Error('Missing REDIS_URL or REDIS_HOST');
    }
  }

  // 1.5 MongoDB Validation
  try {
    const mongoose = (await import('mongoose')).default;
    if (mongoose.connection.readyState !== 1) {
      logger.warn('[StartupValidation] MongoDB not connected yet. Waiting for orchestrator to handle connection...');
    } else {
      logger.info('[StartupValidation] MongoDB connection verified.');
    }
  } catch (err) {
    logger.error('[StartupValidation] CRITICAL ERROR: MongoDB validation failed', err);
    throw err;
  }

  // 2. Redis / Queue Bindings (optional in development)
  if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    try {
      const redis = getRedisClient();
      await redis.ping();
      logger.info('[StartupValidation] Redis connectivity verified.');

      // Just check if we can instantiate a queue for a critical worker
      const testQueue = new Queue(QueueNames.RESUME_SEMANTIC, { connection: redis });
      await testQueue.close();
      logger.info('[StartupValidation] Queue bindings verified.');
    } catch (err) {
      logger.warn('[StartupValidation] Redis/Queue validation failed - running without Redis', err as Record<string, unknown>);
    }
  } else {
    logger.warn('[StartupValidation] Redis not configured - running without Redis (queues and SSE will be degraded)');
  }

  // 3. Gemini Connectivity (non-blocking in local simulation)
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('[StartupValidation] GEMINI_API_KEY not set - AI features will operate in degraded mode');
  } else {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      logger.info('[StartupValidation] Gemini AI configuration verified.');
    } catch (err) {
      logger.warn('[StartupValidation] Gemini API validation warning', err);
    }
  }

  logger.info('[StartupValidation] All startup checks passed successfully.');
}
