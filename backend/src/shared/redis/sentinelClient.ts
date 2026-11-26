// src/shared/redis/sentinelClient.ts — Redis Sentinel failover client
// Provides high-availability Redis with automatic master failover and read-replica distribution

import Redis from 'ioredis';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';

// Read Sentinel config from process.env directly for testability
const getSentinelHosts = (): string => process.env.REDIS_SENTINEL_HOSTS || '';
const getSentinelMasterName = (): string => process.env.REDIS_SENTINEL_MASTER_NAME || env.REDIS_SENTINEL_MASTER_NAME;
const getSentinelPassword = (): string => process.env.REDIS_SENTINEL_PASSWORD || '';
const getRedisPassword = (): string => process.env.REDIS_PASSWORD || env.REDIS_PASSWORD || '';

let _masterClient: Redis | null = null;
let _replicaClient: Redis | null = null;
let _connecting = false;
let _replicaConnecting = false;

/**
 * Check whether a Redis client is active or in a valid transitional state
 * that should not trigger duplicate socket creation.
 */
export function isClientAlive(client: Redis | null): boolean {
  return Boolean(
    client &&
      (client.status === 'ready' ||
        client.status === 'connecting' ||
        client.status === 'connect' ||
        client.status === 'wait' ||
        client.status === 'reconnecting')
  );
}

export interface SentinelHealth {
  status: 'disconnected' | 'connecting' | 'connected';
  masterHost: string | null;
  masterPort: number | null;
  replicaHost: string | null;
  replicaPort: number | null;
  sentinelCount: number;
  lastError: string | null;
}

/**
 * Parse REDIS_SENTINEL_HOSTS into an array of {host, port} objects.
 * Format: "host1:port1,host2:port2,host3:port3"
 */
export function parseSentinelHosts(hostsString: string): Array<{ host: string; port: number }> {
  if (!hostsString) return [];
  return hostsString.split(',').map((entry) => {
    const [host, port] = entry.trim().split(':');
    return {
      host: host || 'localhost',
      port: port ? parseInt(port, 10) : 26379,
    };
  });
}

/**
 * Check if Redis Sentinel is configured
 */
export function isSentinelConfigured(): boolean {
  return Boolean(getSentinelHosts());
}

/**
 * Create a Sentinel-configured Redis client
 */
function createSentinelClient(role: 'master' | 'slave' = 'master'): Redis {
  const sentinelHosts = parseSentinelHosts(getSentinelHosts());
  const sentinelPassword = getSentinelPassword() || undefined;
  const redisPassword = getRedisPassword() || undefined;

  if (sentinelHosts.length === 0) {
    throw new Error('REDIS_SENTINEL_HOSTS is not configured');
  }

  const config: {
    sentinels: Array<{ host: string; port: number }>;
    name: string;
    sentinelPassword?: string;
    password?: string;
    lazyConnect: boolean;
    maxRetriesPerRequest: number | null;
    retryStrategy?: (times: number) => number | void;
    reconnectOnError?: (err: Error) => boolean | 1 | 2;
    role?: 'master' | 'slave';
  } = {
    sentinels: sentinelHosts,
    name: getSentinelMasterName(),
    sentinelPassword,
    password: redisPassword,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy(times: number) {
      const delay = Math.min(times * 100, 3000);
      logger.warn(`[redis-sentinel] Reconnecting ${role}`, { attempt: times, delayMs: delay });
      return delay;
    },
    reconnectOnError(err: Error) {
      const target = 'READONLY';
      return err.message.includes(target) ? 1 : false;
    },
  };

  if (role === 'slave') {
    config.role = 'slave';
  }

  return new Redis(config);
}

/**
 * Get the Redis Master client (for write operations)
 */
export function getRedisMaster(): Redis {
  if (!isSentinelConfigured()) {
    throw new Error('Redis Sentinel is not configured. Use getRedisClient() for standalone Redis.');
  }

  if (isClientAlive(_masterClient)) {
    return _masterClient!;
  }

  if (_connecting) {
    if (_masterClient) return _masterClient;
  }

  _connecting = true;

  try {
    _masterClient = createSentinelClient('master');

    _masterClient.on('connect', () => {
      logger.info('[redis-sentinel] Master connected', {
        event: 'sentinel_master_connected',
        masterName: getSentinelMasterName(),
      });
      _connecting = false;
    });

    _masterClient.on('ready', () => {
      logger.info('[redis-sentinel] Master ready', {
        event: 'sentinel_master_ready',
        masterName: getSentinelMasterName(),
      });
    });

    _masterClient.on('error', (err: Error) => {
      logger.error('[redis-sentinel] Master error', err, {
        event: 'sentinel_master_error',
        masterName: getSentinelMasterName(),
      });
      _connecting = false;
    });

    _masterClient.on('close', () => {
      logger.warn('[redis-sentinel] Master connection closed', { event: 'sentinel_master_closed' });
    });

    _masterClient.on('reconnecting', () => {
      logger.info('[redis-sentinel] Master reconnecting', { event: 'sentinel_master_reconnecting' });
    });

    // Listen for Sentinel failover events
    _masterClient.on('+switch-master', (data: string) => {
      logger.info('[redis-sentinel] Master switch detected', {
        event: 'sentinel_master_switch',
        data,
      });
      // Following a master switch, recycle replica client so it reconnects to updated topology
      if (_replicaClient && typeof _replicaClient.disconnect === 'function') {
        try {
          _replicaClient.disconnect();
        } catch (_) {}
        _replicaClient = null;
        _replicaConnecting = false;
      }
    });

    void _masterClient.connect().catch((err) => {
      logger.warn('[redis-sentinel] Master initial connect failed (will retry)', {
        error: err instanceof Error ? err.message : String(err),
      });
      _connecting = false;
    });
  } catch (err) {
    logger.error('[redis-sentinel] Failed to create master client', err);
    _connecting = false;
    throw err;
  }

  return _masterClient;
}

/**
 * Get a Redis Replica client (for read operations)
 * Returns the master client if replicas are not available
 */
export function getRedisReplica(): Redis {
  if (!isSentinelConfigured()) {
    throw new Error('Redis Sentinel is not configured. Use getRedisClient() for standalone Redis.');
  }

  if (isClientAlive(_replicaClient)) {
    return _replicaClient!;
  }

  if (_replicaConnecting) {
    if (_replicaClient) return _replicaClient;
  }

  _replicaConnecting = true;

  try {
    _replicaClient = createSentinelClient('slave');

    _replicaClient.on('connect', () => {
      logger.info('[redis-sentinel] Replica connected', {
        event: 'sentinel_replica_connected',
        masterName: getSentinelMasterName(),
      });
      _replicaConnecting = false;
    });

    _replicaClient.on('ready', () => {
      logger.info('[redis-sentinel] Replica ready', {
        event: 'sentinel_replica_ready',
        masterName: getSentinelMasterName(),
      });
    });

    _replicaClient.on('error', (err: Error) => {
      logger.error('[redis-sentinel] Replica error', err, {
        event: 'sentinel_replica_error',
        masterName: getSentinelMasterName(),
      });
      _replicaConnecting = false;
    });

    _replicaClient.on('close', () => {
      logger.warn('[redis-sentinel] Replica connection closed', { event: 'sentinel_replica_closed' });
    });

    _replicaClient.on('reconnecting', () => {
      logger.info('[redis-sentinel] Replica reconnecting', { event: 'sentinel_replica_reconnecting' });
    });

    void _replicaClient.connect().catch((err) => {
      logger.warn('[redis-sentinel] Replica initial connect failed (will retry)', {
        error: err instanceof Error ? err.message : String(err),
      });
      _replicaConnecting = false;
    });
  } catch (err) {
    logger.error('[redis-sentinel] Failed to create replica client, falling back to master', err);
    _replicaConnecting = false;
    // Fall back to master if replica creation fails
    return getRedisMaster();
  }

  return _replicaClient;
}

/**
 * Get health status of Sentinel connections
 */
export function getSentinelHealth(): SentinelHealth {
  const sentinelHosts = parseSentinelHosts(getSentinelHosts());
  const masterStatus = _masterClient?.status ?? 'end';
  const replicaStatus = _replicaClient?.status ?? 'end';

  const statusMap: Record<string, 'connected' | 'connecting' | 'disconnected'> = {
    ready: 'connected',
    wait: 'connecting',
    connect: 'connecting',
    connecting: 'connecting',
    reconnecting: 'connecting',
    close: 'disconnected',
    end: 'disconnected',
  };

  const overallStatus = statusMap[masterStatus] ?? 'disconnected';

  return {
    status: overallStatus,
    masterHost: _masterClient?.options?.host ?? null,
    masterPort: _masterClient?.options?.port ?? null,
    replicaHost: _replicaClient?.options?.host ?? null,
    replicaPort: _replicaClient?.options?.port ?? null,
    sentinelCount: sentinelHosts.length,
    lastError: null,
  };
}

/**
 * Disconnect Sentinel clients
 */
export async function disconnectSentinel(): Promise<void> {
  const master = _masterClient;
  const replica = _replicaClient;

  const disconnectPromises: Promise<unknown>[] = [];

  if (master && master.status === 'ready') {
    disconnectPromises.push(master.quit().catch(() => master.disconnect()));
  } else if (master && typeof master.disconnect === 'function') {
    master.disconnect();
  }
  if (replica && replica.status === 'ready') {
    disconnectPromises.push(replica.quit().catch(() => replica.disconnect()));
  } else if (replica && typeof replica.disconnect === 'function') {
    replica.disconnect();
  }

  await Promise.allSettled(disconnectPromises);

  _masterClient = null;
  _replicaClient = null;
  _connecting = false;
  _replicaConnecting = false;

  logger.info('[redis-sentinel] Disconnected', { event: 'sentinel_disconnected' });
}

/**
 * Reset Sentinel clients (useful for testing)
 */
export function resetSentinelClients(): void {
  _masterClient = null;
  _replicaClient = null;
  _connecting = false;
  _replicaConnecting = false;
}
