// src/db/connection.ts - MongoDB connection
import mongoose from 'mongoose';
import { env } from '../config/index.js';
import { logger } from '../shared/index.js';
import { setMongoStatus } from '../shared/runtime/infrastructureRegistry.js';

export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(env.MONGODB_URI);
    setMongoStatus('healthy');
    logger.info('Connected to MongoDB');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setMongoStatus('failed', message);
    logger.error('Failed to connect to MongoDB', error);
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
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
  logger.info('MongoDB connected event received');
});

mongoose.connection.on('reconnected', () => {
  setMongoStatus('healthy');
  logger.info('MongoDB reconnected');
});

mongoose.connection.on('error', (error) => {
  const message = error instanceof Error ? error.message : String(error);
  setMongoStatus('failed', message);
  logger.error('MongoDB connection error', error);
});

mongoose.connection.on('disconnected', () => {
  setMongoStatus('failed', 'MongoDB disconnected');
  logger.warn('MongoDB disconnected');
});

process.on('SIGINT', async () => {
  await disconnectDatabase();
  process.exit(0);
});
