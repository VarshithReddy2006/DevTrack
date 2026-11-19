import { z } from 'zod';
import type { BulletEdit } from '@devtrack/ats-core';
import { editorBulletSchema } from '../../services/resumeEditorService';

const bullets = z.array(editorBulletSchema).max(200);
const path = z.string().max(128);
const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), path, value: z.unknown() }),
  z.object({ op: z.literal('replace'), path, value: z.unknown() }),
  z.object({ op: z.literal('remove'), path }),
]);
const revision = z.object({
  resumeId: z.string().min(1), sectionId: z.string().min(1).max(50),
  versionNumber: z.number().int().min(1), patch: z.array(operation).max(2000),
  baseSnapshot: bullets.optional(), atsScore: z.number().min(0).max(100),
  createdAt: z.string().datetime({ offset: true }), restoredFrom: z.number().int().nonnegative().optional(),
});
const response = z.object({ currentVersion: z.number().int().nonnegative(), revisions: z.array(revision).max(50) });
type Patch = z.infer<typeof operation>;
export type RevisionCheckpoint = Omit<z.infer<typeof revision>, 'patch' | 'baseSnapshot'> & { before: BulletEdit[]; after: BulletEdit[] };
export interface BulletHistory { currentVersion: number; currentBullets: BulletEdit[]; checkpoints: RevisionCheckpoint[] }
const copy = (items: readonly BulletEdit[]): BulletEdit[] => items.map(item => ({ ...item }));

/** The server compare() ledger emits only add/remove/replace over bullet arrays. */
function apply(state: BulletEdit[], change: Patch): BulletEdit[] {
  if (change.path === '' && change.op !== 'remove') return bullets.parse(change.value);
  const match = /^\/(0|[1-9]\d*|-)(?:\/(section|bulletIndex|originalText|editedText))?$/.exec(change.path);
  if (!match) throw new Error('Unsupported revision path.');
  const index = match[1] === '-' ? state.length : Number(match[1]);
  const field = match[2] as keyof BulletEdit | undefined;
  if (!Number.isSafeInteger(index) || index < 0 || index > state.length || (index === state.length && (field || change.op !== 'add'))) throw new Error('Invalid revision index.');
  if (!field) {
    if (change.op === 'add') {
      if (state.length >= 200) throw new Error('Revision exceeds the bullet limit.');
      state.splice(index, 0, editorBulletSchema.parse(change.value));
    } else if (change.op === 'remove') state.splice(index, 1);
    else state[index] = editorBulletSchema.parse(change.value);
  } else {
    if (change.op !== 'add' && !Object.hasOwn(state[index], field)) throw new Error('Missing revision field.');
    if (change.op === 'remove') delete (state[index] as Partial<BulletEdit>)[field];
    else Object.defineProperty(state[index], field, { value: change.value, enumerable: true, configurable: true, writable: true });
  }
  return state;
}

export function parseBulletHistory(value: unknown, resumeId: string): BulletHistory {
  const ledger = response.parse(value);
  if (!ledger.revisions.length) {
    if (ledger.currentVersion !== 0) throw new Error('History is missing its retained checkpoints.');
    return { currentVersion: 0, currentBullets: [], checkpoints: [] };
  }
  const records = [...ledger.revisions].sort((a, b) => a.versionNumber - b.versionNumber);
  if (records[0].baseSnapshot === undefined) throw new Error('History is missing its retained baseline.');
  let state = copy(records[0].baseSnapshot);
  const checkpoints: RevisionCheckpoint[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.resumeId !== resumeId || record.versionNumber !== records[0].versionNumber + index) throw new Error('History contains mismatched or missing versions.');
    const before = copy(state);
    for (const change of record.patch) state = apply(state, change);
    state = bullets.parse(state);
    checkpoints.push({ resumeId, sectionId: record.sectionId, versionNumber: record.versionNumber, atsScore: record.atsScore, createdAt: record.createdAt, restoredFrom: record.restoredFrom, before, after: copy(state) });
  }
  if (records[records.length - 1].versionNumber !== ledger.currentVersion) throw new Error('History does not match the current resume version.');
  return { currentVersion: ledger.currentVersion, currentBullets: copy(state), checkpoints };
}

/** Match the server's section-only restore semantics, using the latest snapshot. */
export function previewRevisionRestore(current: readonly BulletEdit[], checkpoint: RevisionCheckpoint): BulletEdit[] {
  if (checkpoint.sectionId === '*') return copy(checkpoint.after);
  const section = checkpoint.sectionId.toLowerCase();
  const kept = copy(current.filter(item => item.section.toLowerCase() !== section));
  const position = current.findIndex(item => item.section.toLowerCase() === section);
  kept.splice(position < 0 ? kept.length : position, 0, ...copy(checkpoint.after.filter(item => item.section.toLowerCase() === section)));
  return kept;
}

export function relativeRevisionTime(value: string, now = Date.now()): string {
  const minutes = Math.round((Date.parse(value) - now) / 60000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  return Math.abs(hours) < 24 ? formatter.format(hours, 'hour') : formatter.format(Math.round(hours / 24), 'day');
}
