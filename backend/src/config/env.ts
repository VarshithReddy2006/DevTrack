// src/config/env.ts - Environment configuration
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseTrustProxy } from './trustProxy.js';

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

const IS_PROD = NODE_ENV === 'production';

function getCorsOrigin(): string {
  const defaultOrigin = IS_PROD ? 'https://dev-track.app' : 'http://localhost:5173';
  const origin = getEnvVar('CORS_ORIGIN', defaultOrigin);

  // In production, validate it's an HTTPS origin or a localhost / 127.0.0.1 simulation
  if (IS_PROD) {
    const isLocalhost = origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
    if (!origin.startsWith('https://') && !isLocalhost) {
      throw new Error(`CORS_ORIGIN must use HTTPS in production. Got: ${origin}`);
    }
  }
  return origin;
}

const DEFAULT_PRODUCTION_ORIGINS = [
  'https://dev-track.app',
  'https://*.dev-track.app',
  'https://devtrack.sh',
  'https://*.devtrack.sh',
  'https://app.devtrack.sh',
];

function getAllowedOrigins(): string[] {
  const corsOrigin = getCorsOrigin();
  const raw = process.env.ALLOWED_ORIGINS;
  if (raw !== undefined && raw.trim() !== '') {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (IS_PROD) {
      for (const origin of list) {
        const star = origin.match(/^(https?):\/\/\*\.([^:/]+)(?::(\d+))?$/i);
        if (star) {
          if (star[1].toLowerCase() !== 'https') {
            throw new Error(`ALLOWED_ORIGINS wildcard must use HTTPS in production. Got: ${origin}`);
          }
        } else {
          const isLocalhost = origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
          if (!origin.startsWith('https://') && !isLocalhost) {
            throw new Error(`ALLOWED_ORIGINS must use HTTPS in production. Got: ${origin}`);
          }
        }
      }
    }
    return Array.from(new Set([...list, corsOrigin]));
  }
  return IS_PROD ? Array.from(new Set([corsOrigin, ...DEFAULT_PRODUCTION_ORIGINS])) : [corsOrigin];
}

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
  GITHUB_TOKENS: (process.env.GITHUB_TOKENS || process.env.GITHUB_TOKEN || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
  LEETCODE_TOKENS: (process.env.LEETCODE_TOKENS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),

  // CORS
  CORS_ORIGIN: getCorsOrigin(),
  ALLOWED_ORIGINS: getAllowedOrigins(),

  // Public origin of this API, used for absolute og:image links in shared portfolio previews.
  // Unset in production means previews keep the static image.
  PUBLIC_API_URL: getEnvVar('PUBLIC_API_URL', IS_PROD ? '' : `http://localhost:${getEnvVarNumber('PORT', 3001)}`),

  // Custom portfolio domains must be a CNAME for this edge hostname.
  CUSTOM_DOMAIN_CNAME_TARGET: getEnvVar('CUSTOM_DOMAIN_CNAME_TARGET', 'cname.devtrack.sh'),

  // Reverse proxy hops (Render / nginx = 1). Unset = not behind a proxy.
  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),

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

  // Redis Sentinel for high availability
  REDIS_SENTINEL_HOSTS: getEnvVar('REDIS_SENTINEL_HOSTS', ''), // Comma-separated host:port pairs
  REDIS_SENTINEL_MASTER_NAME: getEnvVar('REDIS_SENTINEL_MASTER_NAME', 'mymaster'),
  REDIS_SENTINEL_PASSWORD: getEnvVar('REDIS_SENTINEL_PASSWORD', ''),

  // Beta Controls
  CLOSED_BETA: getEnvVar('CLOSED_BETA', 'false') === 'true',

  // AI/ML API Keys - REQUIRED for production intelligence
  // In development, warn but allow startup with degraded mode
  GEMINI_API_KEY: getEnvVar('GEMINI_API_KEY', ''),

  // Semantic Cache Configuration
  SEMANTIC_CACHE_ENABLED: getEnvVar('SEMANTIC_CACHE_ENABLED', 'true') === 'true',
  SEMANTIC_CACHE_SIMILARITY_THRESHOLD: Number(process.env.SEMANTIC_CACHE_SIMILARITY_THRESHOLD ?? 0.95),
  SEMANTIC_CACHE_TTL_SECONDS: getEnvVarNumber('SEMANTIC_CACHE_TTL_SECONDS', 7 * 24 * 60 * 60), // 7 days default
};

export default env;
