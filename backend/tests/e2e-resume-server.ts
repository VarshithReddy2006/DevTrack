// Disposable API for the browser resume flow. Production auth is never bypassed:
// only these test-created routers receive the fixed test identity.
import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connect } from 'node:net';
import { createIntegrationDatabase } from '../src/__tests__/integration/database.js';

if (process.env.DEVTRACK_E2E_FIXTURE !== '1' || process.env.NODE_ENV === 'production') {
  throw new Error('The resume E2E server requires DEVTRACK_E2E_FIXTURE=1 outside production.');
}
if (!process.env.REDIS_URL || !/^redis:\/\/(127\.0\.0\.1|localhost):6379(?:\/\d+)?$/.test(process.env.REDIS_URL)) {
  throw new Error('The resume E2E server requires an isolated localhost Redis service on port 6379.');
}

process.env.NODE_ENV = 'test';
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
await new Promise<void>((resolve, reject) => {
  const socket = connect(6379, '127.0.0.1');
  socket.setTimeout(2000);
  socket.once('connect', () => { socket.destroy(); resolve(); });
  socket.once('timeout', () => { socket.destroy(); reject(new Error('Redis is not reachable on 127.0.0.1:6379')); });
  socket.once('error', error => reject(new Error(`Redis is not reachable on 127.0.0.1:6379: ${error.message}`)));
});
const database = await createIntegrationDatabase(
  mongoose,
  () => MongoMemoryServer.create({ binary: { version: '7.0.14' } }),
  process.env.MONGODB_URI,
);
process.env.MONGODB_URI = database.uri;

const [{ User }, { getRedisClient, disconnectRedis }, { closeAllQueues }, { QueueNames }, { workerDefinitions },
  { AIProviderAdapter }, { EmbeddingProviderAdapter },
  { createResumeUploadRoutes }, { createResumeIntelligenceRoutes }] = await Promise.all([
  import('../src/db/models/index.js'),
  import('../src/shared/redis/index.js'),
  import('../src/shared/jobs/queueFactory.js'),
  import('../src/shared/jobs/types.js'),
  import('../src/workers/worker-runtime.js'),
  import('../src/modules/ai/provider/AIProviderAdapter.js'),
  import('../src/modules/ai/embedding/EmbeddingProviderAdapter.js'),
  import('../src/modules/resume/upload/upload.routes.js'),
  import('../src/modules/resume/routes/resume-intelligence.routes.js'),
]);

// Deterministic in-process AI/embedding stubs for the offline E2E fixture server
// so pipeline stages complete cleanly without external API keys.
AIProviderAdapter.generateResponse = async (request) => {
  const payload = request.responseSchemaVersion === 'resume-skills-v1'
    ? { skills: ['TypeScript', 'Node.js', 'React', 'MongoDB'] }
    : {
        extractedSkills: {
          languages: ['TypeScript'],
          frameworks: ['React', 'Express'],
          databases: ['MongoDB'],
          cloudTools: [],
          devOpsTools: ['Docker'],
          aiMlTools: [],
        },
        experienceSignals: {
          yearsOfExperience: 3,
          engineeringDepth: 7,
          projectComplexity: 7,
          leadershipIndicators: 5,
          productionExposure: 6,
        },
        roleAlignment: { backend: 80, frontend: 70, fullstack: 85, ml: 20, devops: 55 },
        weaknesses: ['Add quantitative latency and throughput metrics'],
        strengths: ['End-to-end TypeScript service delivery'],
        semanticSummary: 'Full-stack TypeScript engineer with backend API and React experience.',
        confidenceScore: 86,
      };
  return {
    content: JSON.stringify(payload),
    model: 'e2e-fixture-llm',
    provider: 'openai',
    tokensUsed: 0,
    latency: 1,
    cached: false,
    fallbackTriggered: false,
  };
};

EmbeddingProviderAdapter.prototype.generateEmbeddingBatch = async (texts) => texts.map((text) => {
  const hash = createHash('sha256').update(text).digest();
  const vector = Array.from({ length: 1536 }, (_, i) => Math.sin(i + hash[i % hash.length]) * 0.1);
  return { vector, provider: 'openai', model: 'e2e-fixture-embedding', dimensions: vector.length };
});

const user = await User.create({
  clerkId: 'e2e_clerk_user',
  email: 'resume-e2e@example.test',
  username: 'resume_e2e',
  displayName: 'Resume E2E User',
});
await getRedisClient().ping();

const resumeStageQueues = new Set<string>([
  QueueNames.RESUME_UPLOAD,
  QueueNames.RESUME_ATS,
  QueueNames.RESUME_EMBEDDING,
  QueueNames.RESUME_SEMANTIC,
  QueueNames.RESUME_RECOMMENDATION,
]);
const stageWorkers = await Promise.all(
  workerDefinitions
    .filter((definition) => definition.queueName && resumeStageQueues.has(definition.queueName))
    .map(async (definition) => {
      const lifecycle = await definition.load();
      await lifecycle.start();
      return lifecycle;
    }),
);

const auth = [async (req: Request, res: Response, next: NextFunction) => {
  if (req.headers.authorization !== 'Bearer devtrack-e2e-token') {
    res.status(401).json({ success: false, message: 'Missing E2E session token' });
    return;
  }
  (req as Request & { user: unknown }).user = {
    id: user._id.toString(),
    clerkId: user.clerkId,
    email: user.email,
    username: user.username,
    role: user.role,
  };
  next();
}];

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ status: 'ok', testDatabase: true }));
app.get('/api/auth/me', auth, (_req: Request, res: Response) => res.json({
  success: true,
  data: { id: user._id.toString(), clerkId: user.clerkId, email: user.email,
    username: user.username, displayName: user.displayName, role: user.role },
}));
app.use('/api/resume', createResumeUploadRoutes(auth));
app.use('/api/resume-intelligence', createResumeIntelligenceRoutes(auth));
app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ success: false, message: error.message });
});

const server = app.listen(3001, '127.0.0.1', () => {
  console.log('Resume E2E API ready on 127.0.0.1:3001');
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.allSettled(stageWorkers.map((worker) => worker.stop()));
  await closeAllQueues();
  await disconnectRedis();
  await database.close();
  if (process.env.MONGODB_URI === database.uri) delete process.env.MONGODB_URI;
}
process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
