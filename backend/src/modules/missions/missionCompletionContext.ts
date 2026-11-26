import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClientSession } from 'mongoose';

export interface MissionCompletionContext {
  session: ClientSession;
  postCommit: Array<() => Promise<void>>;
}

const missionCompletionStorage = new AsyncLocalStorage<MissionCompletionContext>();

export function getMissionCompletionContext(): MissionCompletionContext | undefined {
  return missionCompletionStorage.getStore();
}

export async function runInMissionCompletionContext<T>(
  session: ClientSession,
  fn: () => Promise<T>,
): Promise<{ value: T; postCommit: Array<() => Promise<void>> }> {
  const ctx: MissionCompletionContext = { session, postCommit: [] };
  const value = await missionCompletionStorage.run(ctx, fn);
  return { value, postCommit: ctx.postCommit };
}
