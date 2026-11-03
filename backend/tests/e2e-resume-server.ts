// Disposable API for the browser resume flow. Production auth is never bypassed:
// only these test-created routers receive the fixed test identity.
import express, { type Request, type Response, type NextFunction } from 'express';
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

const [{ User }, { getRedisClient, disconnectRedis }, { startResumeUploadWorker, stopResumeUploadWorker },
  { createResumeUploadRoutes }, { createResumeIntelligenceRoutes }] = await Promise.all([
  import('../src/db/models/index.js'),
  import('../src/shared/redis/index.js'),
  import('../src/workers/worker-resume-upload.js'),
  import('../src/modules/resume/upload/upload.routes.js'),
  import('../src/modules/resume/routes/resume-intelligence.routes.js'),
]);

const user = await User.create({
  clerkId: 'e2e_clerk_user',
  email: 'resume-e2e@example.test',
  username: 'resume_e2e',
  displayName: 'Resume E2E User',
});
await getRedisClient().ping();
await startResumeUploadWorker();

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
  await stopResumeUploadWorker();
  await disconnectRedis();
  await database.close();
  if (process.env.MONGODB_URI === database.uri) delete process.env.MONGODB_URI;
}
process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
