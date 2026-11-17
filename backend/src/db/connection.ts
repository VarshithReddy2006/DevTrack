// src/db/connection.ts - MongoDB connection
import mongoose from 'mongoose';
import { env } from '../config/index.js';
import { logger } from '../shared/index.js';
import { setMongoStatus, setApiStatus } from '../shared/runtime/infrastructureRegistry.js';

export function sanitizeMongoError(error: string): string {
  return error
    .replace(/mongodb(\+srv)?:\/\/[^@\s]+@/gi, 'mongodb$1://***:***@')
    .replace(/password=[^&\s]+/gi, 'password=***');
}

export const MONGO_OPTIONS: mongoose.ConnectOptions = {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  maxPoolSize: 50,
  minPoolSize: 1,
  retryWrites: true,
  retryReads: true,
};

let reconnectTimer: NodeJS.Timeout | null = null;
let disconnecting = false;

export function scheduleMongoReconnect(delayMs = 5000): void {
  if (reconnectTimer || disconnecting) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (mongoose.connection.readyState === 0) {
      logger.info('[mongo-retry] Attempting background MongoDB reconnection...');
      try {
        await connectDatabase();
        logger.info('[mongo-retry] Background MongoDB reconnection succeeded');
      } catch (err) {
        const safe = sanitizeMongoError(err instanceof Error ? err.message : String(err));
        logger.warn('[mongo-retry] Background reconnection attempt failed, will retry', { error: safe });
        scheduleMongoReconnect(delayMs);
      }
    }
  }, delayMs);
}

export async function connectDatabase(): Promise<void> {
  disconnecting = false;
  try {
    logger.info('Attempting MongoDB connection...', {
      readyState: mongoose.connection.readyState,
    });
    await mongoose.connect(env.MONGODB_URI, MONGO_OPTIONS);
    setMongoStatus('healthy');
    setApiStatus('healthy');
    logger.info('Connected to MongoDB successfully', {
      readyState: mongoose.connection.readyState,
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const safeMessage = sanitizeMongoError(rawMessage);
    setMongoStatus('failed', safeMessage);
    logger.error('Failed to connect to MongoDB', { error: safeMessage });
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  disconnecting = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    await mongoose.disconnect();
    setMongoStatus('stopped');
    logger.info('Disconnected from MongoDB');
  } catch (error) {
    logger.error('Error disconnecting from MongoDB', error);
    throw error;
  }
}

// Handle connection events to keep infrastructure state synchronized
mongoose.connection.on('connected', () => {
  setMongoStatus('healthy');
  setApiStatus('healthy');
  logger.info('MongoDB connected event received', { readyState: mongoose.connection.readyState });
});

mongoose.connection.on('reconnected', () => {
  setMongoStatus('healthy');
  setApiStatus('healthy');
  logger.info('MongoDB reconnected event received', { readyState: mongoose.connection.readyState });
});

mongoose.connection.on('error', (error) => {
  const safeMessage = sanitizeMongoError(error instanceof Error ? error.message : String(error));
  setMongoStatus('failed', safeMessage);
  logger.error('MongoDB connection error', { error: safeMessage });
});

mongoose.connection.on('disconnected', () => {
  setMongoStatus('failed', 'MongoDB disconnected');
  logger.warn('MongoDB disconnected event received', { readyState: mongoose.connection.readyState });
  scheduleMongoReconnect();
});
