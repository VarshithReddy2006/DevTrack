// src/workers/WorkerHealthMonitor.ts - Worker Health Monitoring System
// Monitors worker health, provides health check endpoints, and manages auto-restart

import { logger } from '../shared/logger.js';

export interface WorkerHealthStatus {
  workerType: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastHeartbeat: number;
  uptime: number;
  jobsProcessed: number;
  jobsFailed: number;
  queueDepth: number;
  errorRate: number;
}

export class WorkerHealthMonitor {
  private healthStatus: Map<string, WorkerHealthStatus> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private workerType: string;

  constructor(workerType: string) {
    this.workerType = workerType;
  }

  start(): void {
    if (this.heartbeatInterval) return;
    logger.info(`[WorkerHealthMonitor] Starting health monitor for ${this.workerType}`, {
      workerType: this.workerType,
    });

    // Initialize health status
    this.healthStatus.set(this.workerType, {
      workerType: this.workerType,
      status: 'healthy',
      lastHeartbeat: Date.now(),
      uptime: 0,
      jobsProcessed: 0,
      jobsFailed: 0,
      queueDepth: 0,
      errorRate: 0,
    });

    // Start heartbeat interval (every 30 seconds)
    this.heartbeatInterval = setInterval(() => {
      this.updateHeartbeat();
    }, 30000);

    // Start health check interval (every 60 seconds)
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 60000);
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    logger.info(`[WorkerHealthMonitor] Stopped health monitor for ${this.workerType}`, {
      workerType: this.workerType,
    });
  }

  updateHeartbeat(): void {
    const status = this.healthStatus.get(this.workerType);
    if (status) {
      status.lastHeartbeat = Date.now();
      status.uptime = process.uptime();
      this.healthStatus.set(this.workerType, status);
    }
  }

  performHealthCheck(): void {
    const status = this.healthStatus.get(this.workerType);
    if (!status) return;

    // Calculate error rate
    const totalJobs = status.jobsProcessed + status.jobsFailed;
    const errorRate = totalJobs > 0 ? status.jobsFailed / totalJobs : 0;

    // Determine health status based on error rate and queue depth
    let newStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    if (errorRate > 0.5 || status.queueDepth > 1000) {
      newStatus = 'unhealthy';
    } else if (errorRate > 0.1 || status.queueDepth > 500) {
      newStatus = 'degraded';
    }

    // Log status change
    if (newStatus !== status.status) {
      logger.warn(`[WorkerHealthMonitor] Worker ${this.workerType} status changed`, {
        workerType: this.workerType,
        oldStatus: status.status,
        newStatus,
        errorRate,
        queueDepth: status.queueDepth,
      });
    }

    status.status = newStatus;
    status.errorRate = errorRate;
    this.healthStatus.set(this.workerType, status);

    // Auto-restart if unhealthy
    if (newStatus === 'unhealthy') {
      logger.error(`[WorkerHealthMonitor] Worker ${this.workerType} is unhealthy, triggering restart`, {
        workerType: this.workerType,
        errorRate,
        queueDepth: status.queueDepth,
      });
      this.triggerRestart();
    }
  }

  recordJobProcessed(): void {
    const status = this.healthStatus.get(this.workerType);
    if (status) {
      status.jobsProcessed++;
      status.queueDepth = Math.max(0, status.queueDepth - 1);
      this.healthStatus.set(this.workerType, status);
    }
  }

  recordJobFailed(): void {
    const status = this.healthStatus.get(this.workerType);
    if (status) {
      status.jobsFailed++;
      this.healthStatus.set(this.workerType, status);
    }
  }

  updateQueueDepth(depth: number): void {
    const status = this.healthStatus.get(this.workerType);
    if (status) {
      status.queueDepth = depth;
      this.healthStatus.set(this.workerType, status);
    }
  }

  getHealthStatus(): WorkerHealthStatus {
    const status = this.healthStatus.get(this.workerType);
    if (!status) {
      throw new Error(`No health status found for worker ${this.workerType}`);
    }
    return status;
  }

  private triggerRestart(): void {
    logger.error(`[WorkerHealthMonitor] Triggering graceful restart for ${this.workerType}`, {
      workerType: this.workerType,
    });

    // Send SIGTERM to self for graceful shutdown
    // Process manager (PM2, Docker, etc.) will handle restart
    process.kill(process.pid, 'SIGTERM');
  }

  // Express middleware for health check endpoint
  static healthCheckMiddleware(workerType: string) {
    const monitor = new WorkerHealthMonitor(workerType);
    monitor.start();

    return (req: any, res: any) => {
      try {
        const status = monitor.getHealthStatus();
        const statusCode = status.status === 'healthy' ? 200 : status.status === 'degraded' ? 200 : 503;
        
        res.status(statusCode).json({
          success: true,
          data: status,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        res.status(503).json({
          success: false,
          error: 'Health check failed',
          timestamp: new Date().toISOString(),
        });
      }
    };
  }
}
