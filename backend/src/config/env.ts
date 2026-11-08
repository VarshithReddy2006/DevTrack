// src/config/env.ts - Environment configuration
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvVarNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const num = Number(value);
  if (isNaN(num)) {
    throw new Error(`Environment variable ${key} must be a number`);
  }
  return num;
}

const isRender = process.env.RENDER === 'true';
const defaultEnv = isRender ? 'production' : 'development';
const NODE_ENV = getEnvVar('NODE_ENV', defaultEnv);

function getCorsOrigin(): string {
  const origin = getEnvVar('CORS_ORIGIN', 'http://localhost:5173');
  const isProd = NODE_ENV === 'production';

  // In production, validate it's an HTTPS origin or a localhost / 127.0.0.1 simulation
  if (isProd) {
    const isLocalhost = origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
    if (!origin.startsWith('https://') && !isLocalhost) {
      throw new Error(`CORS_ORIGIN must use HTTPS in production. Got: ${origin}`);
    }
  }
  return origin;
}

const IS_PROD = NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// In production, critical secrets MUST be explicitly provided.
// Dev defaults are only used in development/test environments.
// ---------------------------------------------------------------------------
function requireInProd(key: string, devDefault: string): string {
  if (IS_PROD) {
    return getEnvVar(key); // no default → throws if missing
  }
  return getEnvVar(key, devDefault);
}

export const env = {
  // Server
  PORT: getEnvVarNumber('PORT', 3001),
  NODE_ENV,
  IS_PROD,
  IS_DEV: NODE_ENV === 'development',

  // Database — required in production
  MONGODB_URI: requireInProd('MONGODB_URI', 'mongodb://localhost:27017/devtrack'),



  // Platform Tokens
  GITHUB_TOKEN: getEnvVar('GITHUB_TOKEN', ''),

  // CORS
  CORS_ORIGIN: getCorsOrigin(),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: getEnvVarNumber('RATE_LIMIT_WINDOW_MS', 900000), // 15 minutes
  RATE_LIMIT_MAX_REQUESTS: getEnvVarNumber('RATE_LIMIT_MAX_REQUESTS', 100),

  // Auth-specific rate limiting (stricter for auth endpoints)
  AUTH_RATE_LIMIT_WINDOW_MS: getEnvVarNumber('AUTH_RATE_LIMIT_WINDOW_MS', 900000), // 15 min
  AUTH_RATE_LIMIT_MAX_REQUESTS: getEnvVarNumber('AUTH_RATE_LIMIT_MAX_REQUESTS', 5), // 5 attempts
  AUTH_RATE_LIMIT_MAX_REQUESTS_WINDOW_1H: getEnvVarNumber('AUTH_RATE_LIMIT_MAX_REQUESTS_WINDOW_1H', 20),

  // Platform Sync Scheduler
  SYNC_ENABLED: getEnvVar('SYNC_ENABLED', 'true') === 'true',
  SYNC_INTERVAL_MINUTES: getEnvVarNumber('SYNC_INTERVAL_MINUTES', NODE_ENV === 'development' ? 5 : 15),
  SYNC_MAX_RETRIES: getEnvVarNumber('SYNC_MAX_RETRIES', 3),
  SYNC_COOLDOWN_MS: getEnvVarNumber('SYNC_COOLDOWN_MS', NODE_ENV === 'development' ? 15_000 : 5 * 60 * 1000),

  // Redis — required in production (BullMQ backend)
  REDIS_HOST: getEnvVar('REDIS_HOST', 'localhost'),
  REDIS_PORT: getEnvVarNumber('REDIS_PORT', 6379),
  REDIS_PASSWORD: getEnvVar('REDIS_PASSWORD', ''),
  REDIS_URL: getEnvVar('REDIS_URL', ''),

  // Beta Controls
  CLOSED_BETA: getEnvVar('CLOSED_BETA', 'false') === 'true',

  // AI/ML API Keys - REQUIRED for production intelligence
  // In development, warn but allow startup with degraded mode
  GEMINI_API_KEY: getEnvVar('GEMINI_API_KEY', ''),
};

export default env;
