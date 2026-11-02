import Redis from 'ioredis';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { createServer, Server } from 'net';
import { EnvironmentValidationResult } from '../types/orchestrator.js';
import { isSupportedNodeVersion, SUPPORTED_NODE_VERSIONS } from '../utils/nodeVersion.js';

dotenv.config({ path: '../.env' });

export class EnvironmentReadinessValidator {
  async validate(): Promise<EnvironmentValidationResult> {
    const checks: EnvironmentValidationResult['checks'] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check Node.js version
    const nodeVersionCheck = this.checkNodeVersion();
    checks.push(nodeVersionCheck);
    if (nodeVersionCheck.status === 'fail') {
      errors.push(nodeVersionCheck.message);
    }

    // Check environment variables
    const envCheck = this.checkEnvironmentVariables();
    checks.push(...envCheck.checks);
    errors.push(...envCheck.errors);
    warnings.push(...envCheck.warnings);

    // Check Redis connection
    const redisCheck = await this.checkRedisConnection();
    checks.push(redisCheck);
    if (redisCheck.status === 'fail') {
      errors.push(redisCheck.message);
    }

    // Check MongoDB connection
    const mongoCheck = await this.checkMongoConnection();
    checks.push(mongoCheck);
    if (mongoCheck.status === 'fail') {
      errors.push(mongoCheck.message);
    }

    // Check port availability
    const portCheck = await this.checkPortAvailability();
    checks.push(...portCheck.checks);
    errors.push(...portCheck.errors);

    // Unsupported Node and missing required variables fail; infrastructure remains a warning.
    const criticalErrors = errors.filter(e => e.includes('environment variable'));
    const nodeErrors = nodeVersionCheck.status === 'fail' ? [nodeVersionCheck.message] : [];
    
    return {
      valid: criticalErrors.length === 0 && nodeErrors.length === 0,
      errors: [...criticalErrors, ...nodeErrors],
      warnings: [...warnings, ...errors.filter(e => !e.includes('environment variable') && e !== nodeVersionCheck.message)],
      checks
    };
  }

  private checkNodeVersion(): EnvironmentValidationResult['checks'][0] {
    const nodeVersion = process.version;
    if (!isSupportedNodeVersion(nodeVersion)) {
      return {
        name: 'Node.js Version',
        status: 'fail',
        message: `Node.js ${nodeVersion} is unsupported. Requires ${SUPPORTED_NODE_VERSIONS}`
      };
    }

    return {
      name: 'Node.js Version',
      status: 'pass',
      message: `Node.js ${nodeVersion} is compatible`
    };
  }

  private checkEnvironmentVariables(): {
    checks: EnvironmentValidationResult['checks'][0][];
    errors: string[];
    warnings: string[];
  } {
    const checks: EnvironmentValidationResult['checks'][0][] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    const requiredVars: string[] = []; // No required vars for dev - use defaults

    const optionalVars = [
      'MONGODB_URI',
      'REDIS_HOST',
      'REDIS_PORT',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY'
    ];

    for (const varName of requiredVars) {
      const value = process.env[varName];
      if (!value) {
        checks.push({
          name: `Environment: ${varName}`,
          status: 'fail',
          message: `Missing required environment variable: ${varName}`
        });
        errors.push(`Missing required environment variable: ${varName}`);
      } else {
        checks.push({
          name: `Environment: ${varName}`,
          status: 'pass',
          message: `${varName} is set`
        });
      }
    }

    for (const varName of optionalVars) {
      const value = process.env[varName];
      if (!value) {
        checks.push({
          name: `Environment: ${varName}`,
          status: 'warn',
          message: `${varName} not set (will use default)`
        });
        warnings.push(`${varName} not set (will use default)`);
      } else {
        checks.push({
          name: `Environment: ${varName}`,
          status: 'pass',
          message: `${varName} is set`
        });
      }
    }

    return { checks, errors, warnings };
  }

  private async checkRedisConnection(): Promise<EnvironmentValidationResult['checks'][0]> {
    try {
      const redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        maxRetriesPerRequest: 1,
        retryStrategy: () => null
      });

      await redis.ping();
      await redis.quit();

      return {
        name: 'Redis Connection',
        status: 'pass',
        message: 'Successfully connected to Redis'
      };
    } catch (error) {
      return {
        name: 'Redis Connection',
        status: 'warn',
        message: `Redis not available: ${error instanceof Error ? error.message : 'Unknown error'} (Start with: npm run dev:infra)`
      };
    }
  }

  private async checkMongoConnection(): Promise<EnvironmentValidationResult['checks'][0]> {
    try {
      const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/devtrack';
      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 2000
      });
      await mongoose.connection.close();

      return {
        name: 'MongoDB Connection',
        status: 'pass',
        message: 'Successfully connected to MongoDB'
      };
    } catch (error) {
      return {
        name: 'MongoDB Connection',
        status: 'warn',
        message: `MongoDB not available: ${error instanceof Error ? error.message : 'Unknown error'} (Start with: npm run dev:infra)`
      };
    }
  }

  private async checkPortAvailability(): Promise<{
    checks: EnvironmentValidationResult['checks'][0][];
    errors: string[];
  }> {
    const checks: EnvironmentValidationResult['checks'][0][] = [];
    const errors: string[] = [];

    const ports = [
      { name: 'Frontend', port: 5173 },
      { name: 'Backend', port: 3001 },
      { name: 'Redis', port: 6379 },
      { name: 'MongoDB', port: 27017 }
    ];

    for (const { name, port } of ports) {
      const isAvailable = await this.isPortAvailable(port);
      if (!isAvailable) {
        checks.push({
          name: `Port: ${name} (${port})`,
          status: 'warn',
          message: `Port ${port} is already in use`
        });
      } else {
        checks.push({
          name: `Port: ${name} (${port})`,
          status: 'pass',
          message: `Port ${port} is available`
        });
      }
    }

    return { checks, errors };
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();

      server.once('error', () => {
        resolve(false);
      });

      server.once('listening', () => {
        server.close();
        resolve(true);
      });

      server.listen(port);
    });
  }
}
