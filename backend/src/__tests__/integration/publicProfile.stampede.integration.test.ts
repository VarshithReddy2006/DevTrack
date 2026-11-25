import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import mongoose from 'mongoose';
import { User } from '../../db/models/user.model.js';
import { PublicProfile } from '../../db/models/publicProfile.model.js';

// Separate processes have separate single-flight maps and unmocked Redis clients.
const worker = `
import mongoose from 'mongoose';
import { PublicProfile } from './src/db/models/publicProfile.model.ts';
import { PublicProfileService } from './src/modules/profile/publicProfile.service.ts';
import { getRedisClient, disconnectRedis } from './src/shared/redis/client.ts';
await mongoose.connect(process.env.MONGODB_URI);
await getRedisClient().ping();
PublicProfileService.computeProfile = async userId => {
  await mongoose.connection.db.collection('stampede_computes').insertOne({ userId, worker: process.pid });
  await new Promise(resolve => setTimeout(resolve, 300));
  await PublicProfile.updateOne({ userId }, { $set: { 'snapshot.version': 2 } });
  return { trustScore: 0, suspicionScore: 0, flags: [] };
};
process.on('message', async message => {
  if (message !== 'go') return;
  try {
    const profiles = await Promise.all(Array.from({ length: 100 }, () =>
      PublicProfileService.getPublicProfileByUsername('stampede-integration', '127.0.0.1', 'public')));
    if (!profiles.every(profile => profile.snapshot.version === 2)) throw new Error('Stale result');
    await disconnectRedis();
    await mongoose.disconnect();
    process.send({ type: 'done', reads: profiles.length }, () => process.exit(0));
  } catch (error) {
    process.send({ type: 'error', message: String(error) }, () => process.exit(1));
  }
});
process.send({ type: 'ready' });
`;

it('coalesces 200 stale reads across two processes using the real Redis lease and Mongo snapshot', async () => {
  const user = await User.create({ clerkId: 'stampede_integration', username: 'stampede-integration',
    displayName: 'Synthetic concurrency fixture', email: 'stampede@example.test' });
  await PublicProfile.create({ userId: user._id, username: user.username, slug: user.username,
    published: true, visibility: 'public', snapshot: { version: 1 } });
  const children: ChildProcess[] = [];
  const completed: Array<Promise<void>> = [];
  const ready: Array<Promise<void>> = [];
  try {
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { ...process.env, SILENT_LOGGING: 'true' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      let diagnostics = '', finished = false;
      child.stdout?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
      child.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
      ready.push(new Promise<void>((resolve, reject) => {
        let started = false;
        child.on('message', message => {
          if ((message as { type: string }).type === 'ready') { started = true; resolve(); }
        });
        child.once('error', reject);
        child.once('exit', code => { if (!started || code !== 0) reject(new Error(diagnostics)); });
      }));
      completed.push(new Promise<void>((resolve, reject) => {
        child.on('message', message => {
          const result = message as { type: string; reads?: number; message?: string };
          if (result.type === 'done') finished = result.reads === 100;
          if (result.type === 'error') diagnostics += result.message;
        });
        child.once('error', reject);
        child.once('exit', code => code === 0 && finished ? resolve() : reject(new Error(diagnostics)));
      }));
    }
    // Attach rejection handlers before startup completes so a failed child cannot leak an unhandled rejection.
    const allDone = Promise.all(completed);
    void allDone.catch(() => {});
    await Promise.all(ready);
    children.forEach(child => child.send('go'));
    await allDone;
    expect(await mongoose.connection.db!.collection('stampede_computes').countDocuments()).toBe(1);
    expect((await PublicProfile.findOne({ userId: user._id }))?.stats.profileViews).toBe(200);
  } finally {
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    })));
  }
}, 20000);
