import mongoose from 'mongoose';
import { repairSubmissionProjections } from '../modules/platform-sync/submission-projections.js';

const args = process.argv.slice(2);
function value(flag: string) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
const userId = value('--user-id');
const uri = process.env.MONGODB_URI;
if (!userId || !uri) throw new Error('Explicit MONGODB_URI and --user-id are required; no .env is loaded.');
if (!mongoose.Types.ObjectId.isValid(userId)) throw new Error('Invalid --user-id');
const platform = value('--platform');
if (platform && platform !== 'leetcode' && platform !== 'codeforces') throw new Error('Invalid --platform');
try {
  await mongoose.connect(uri);
  const result = await repairSubmissionProjections(userId, {
    limit: Number(value('--limit') ?? 25), afterId: value('--after-id'),
    platform: platform === 'leetcode' || platform === 'codeforces' ? platform : undefined,
    dryRun: !args.includes('--apply'),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.failed.length) process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
