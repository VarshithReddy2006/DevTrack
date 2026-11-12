import { vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';

process.env.MONGOMS_MD5_CHECK = '0';

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongoServer: MongoMemoryReplSet;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: {
      version: '7.0.14',
    },
  });
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    const collection = collections[key];
    await collection.deleteMany({});
  }
});

// ----------------------------------------------------
// Mock 'ioredis' globally
// ----------------------------------------------------
vi.mock('ioredis', () => {
  class MockRedis {
    status = 'ready';
    ping = vi.fn().mockResolvedValue('PONG');
    hget = vi.fn().mockResolvedValue(null);
    hset = vi.fn().mockResolvedValue(1);
    hexists = vi.fn().mockResolvedValue(false);
    hgetall = vi.fn().mockResolvedValue({});
    dbsize = vi.fn().mockResolvedValue(0);
    keys = vi.fn().mockResolvedValue([]);
    del = vi.fn().mockResolvedValue(1);
    connect = vi.fn().mockResolvedValue(undefined);
    quit = vi.fn().mockResolvedValue(undefined);
    on = vi.fn().mockImplementation((event, callback) => {
      if (event === 'connect' || event === 'ready') {
        setTimeout(() => callback && callback(), 10);
      }
      return this;
    });
    pipeline = vi.fn().mockReturnValue({
      del: vi.fn(),
      exec: vi.fn().mockResolvedValue([])
    });
  }
  return {
    default: MockRedis,
    Redis: MockRedis
  };
});

// ----------------------------------------------------
// Mock BullMQ queues and workers globally
// ----------------------------------------------------
const mockQueueJobs = new Map<string, any[]>();
const mockWorkers = new Map<string, any[]>();

const mockProcessNextJob = async (queueName: string) => {
  const jobs = mockQueueJobs.get(queueName) || [];
  const workers = mockWorkers.get(queueName) || [];
  if (jobs.length === 0 || workers.length === 0) return;

  const job = jobs.shift();
  const worker = workers[0];

  if (!worker || !worker.processor) return;

  let attempts = 0;
  const execute = async () => {
    attempts++;
    job.attemptsMade = attempts - 1;
    
    try {
      await worker.processor(job);
      job._state = 'completed';
    } catch (err: any) {
      const isDiscarded = job._isDiscarded || false;
      const maxAttempts = job.opts?.attempts || 3;
      
      if (!isDiscarded && attempts < maxAttempts) {
        setTimeout(execute, 20);
      } else {
        job._state = 'failed';
      }
    }
  };

  setTimeout(execute, 10);
};

vi.mock('bullmq', () => {
  class MockQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    add = vi.fn().mockImplementation(async (jobName, data, opts) => {
      const jobId = `mock-job-${Math.random().toString(36).substr(2, 9)}`;
      const job = {
        id: jobId,
        name: jobName,
        data,
        opts: opts || { attempts: 3 },
        attemptsMade: 0,
        getState: vi.fn().mockImplementation(async () => job._state || 'waiting'),
        discard: vi.fn().mockImplementation(() => {
          job._isDiscarded = true;
        }),
        _state: 'waiting',
        _isDiscarded: false,
        log: vi.fn(),
        updateProgress: vi.fn(),
      };
      
      if (!mockQueueJobs.has(this.name)) {
        mockQueueJobs.set(this.name, []);
      }
      mockQueueJobs.get(this.name)!.push(job);
      
      mockProcessNextJob(this.name);
      return job;
    });
    addBulk = vi.fn().mockResolvedValue([]);
    drain = vi.fn().mockImplementation(async () => {
      mockQueueJobs.set(this.name, []);
      return undefined;
    });
    getJobCounts = vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0 });
    getWorkers = vi.fn().mockResolvedValue([]);
    getJob = vi.fn().mockResolvedValue(null);
    getWaiting = vi.fn().mockResolvedValue([]);
    getCompleted = vi.fn().mockResolvedValue([]);
    getFailed = vi.fn().mockResolvedValue([]);
    getWaitingCount = vi.fn().mockResolvedValue(0);
    getActiveCount = vi.fn().mockResolvedValue(0);
    getCompletedCount = vi.fn().mockResolvedValue(0);
    getFailedCount = vi.fn().mockResolvedValue(0);
    getDelayedCount = vi.fn().mockResolvedValue(0);
    close = vi.fn().mockResolvedValue(undefined);
  }
  
  class MockWorker {
    name: string;
    processor: any;
    options: any;
    constructor(name: string, processor: any, options: any) {
      this.name = name;
      this.processor = processor;
      this.options = options || {};
      
      if (!mockWorkers.has(this.name)) {
        mockWorkers.set(this.name, []);
      }
      mockWorkers.get(this.name)!.push(this);
      
      mockProcessNextJob(this.name);
    }
    on = vi.fn();
    close = vi.fn().mockImplementation(async () => {
      const list = mockWorkers.get(this.name) || [];
      const idx = list.indexOf(this);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
      return undefined;
    });
  }
  
  return {
    Queue: MockQueue,
    Worker: MockWorker
  };
});

// ----------------------------------------------------
// Mock AI and Embedding Provider Adapters Globally
// ----------------------------------------------------
vi.mock('../modules/ai/provider/AIProviderAdapter.js', () => {
  return {
    AIProviderAdapter: {
      generateResponse: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          consistencyScore: 90,
          verifiedClaims: ['Advanced System Architecture design'],
          suspiciousClaims: [],
          summary: 'Candidate claims match platform evidence.'
        })
      }),
      getAllProviderHealth: vi.fn().mockReturnValue([]),
      getTokenUsageStats: vi.fn().mockReturnValue({ totalTokens: 0 }),
      getCurrentProvider: vi.fn().mockReturnValue('gemini')
    }
  };
});

vi.mock('../modules/ai/embedding/EmbeddingProviderAdapter.js', () => {
  class MockEmbeddingAdapter {
    generateEmbedding = vi.fn().mockResolvedValue({ vector: new Array(1536).fill(0.1), dimensions: 1536, provider: 'openai', model: 'text-embedding-3-small' });
    generateEmbeddingBatch = vi.fn().mockResolvedValue([
      { vector: new Array(1536).fill(0.1), dimensions: 1536, provider: 'openai', model: 'text-embedding-3-small' }
    ]);
  }
  return {
    EmbeddingProviderAdapter: MockEmbeddingAdapter
  };
});

// ----------------------------------------------------
// Clear mock stores before each test run
// ----------------------------------------------------
beforeEach(() => {
  mockQueueJobs.clear();
  mockWorkers.clear();
});
