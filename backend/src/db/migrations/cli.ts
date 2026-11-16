import mongoose from 'mongoose';
import { discoverMigrations } from './discover.js';
import { createMigrationRunner } from './runner.js';

function parseCommand([command, flag, ...rest]: string[]): { command: 'up' | 'down' | 'status' | 'check'; steps: number } {
  if (rest.length === 0 && !flag && (command === 'up' || command === 'check' || command === 'status')) {
    return { command, steps: 1 };
  }
  if (rest.length === 0 && command === 'down' && (!flag || /^--step=[1-9]\d*$/.test(flag))) {
    const steps = flag ? Number(flag.slice('--step='.length)) : 1;
    if (Number.isSafeInteger(steps)) return { command, steps };
  }
  throw new Error('Usage: cli.js up | down [--step=N] | status | check');
}

try {
  const { command, steps } = parseCommand(process.argv.slice(2));
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Set MONGODB_URI explicitly before running this command');
  const migrations = await discoverMigrations();
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  const runner = createMigrationRunner(mongoose.connection, migrations);
  if (command === 'status') console.table(await runner.status());
  else if (command === 'down') await runner.down(steps);
  else await runner[command]();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/mongodb(\+srv)?:\/\/[^@\s]+@/gi, 'mongodb$1://***:***@'));
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}