// src/db/slowQueryProfiler.ts: Logs slow MongoDB queries with the plan the server picked.
//
// Uses the driver's command monitoring instead of a schema plugin: models are compiled at import
// time, before boot code runs, so a plugin registered at startup would miss most of them. When a
// read or write takes longer than the threshold, the same command is explained (queryPlanner only,
// nothing is executed again) and the log says whether it used an index (IXSCAN) or scanned the
// whole collection (COLLSCAN). Filter values are never logged, only the field names.

import type mongoose from 'mongoose';
import type { mongo } from 'mongoose';
import { logger as sharedLogger } from '../shared/logger.js';

type ProfilerLogger = Pick<typeof sharedLogger, 'warn'>;
type Command = Record<string, unknown>;

export interface SlowQueryProfilerOptions {
  thresholdMs?: number;
  logger?: ProfilerLogger;
}

export interface SlowQueryProfiler {
  detach(): void;
  /** Resolves once every explain started so far has been logged. */
  idle(): Promise<void>;
}

export interface PlanSummary {
  /** COLLSCAN when any part of the winning plan scans the collection, IXSCAN when it reads an index. */
  plan: string;
  stages: string[];
  indexes: string[];
}

export const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 100;

const PROFILED_COMMANDS = new Set(['find', 'aggregate', 'count', 'distinct', 'findAndModify', 'update', 'delete']);
const INDEX_STAGES = new Set(['IXSCAN', 'COUNT_SCAN', 'DISTINCT_SCAN', 'IDHACK', 'EXPRESS_IXSCAN', 'EXPRESS_CLUSTERED_IXSCAN']);
// Session, transaction and routing fields the driver adds; explain takes the bare command.
const ENVELOPE_FIELDS = new Set([
  'lsid', 'txnNumber', 'autocommit', 'startTransaction', '$clusterTime', '$db', '$readPreference',
  'readConcern', 'writeConcern', 'apiVersion', 'apiStrict', 'apiDeprecationErrors',
]);
const MAX_TRACKED_COMMANDS = 1000;

interface TrackedCommand {
  commandName: string;
  databaseName: string;
  collection: string;
  command: Command;
}

/** The command to explain: envelope stripped, and one statement for update/delete batches. */
function explainable(commandName: string, command: Command): Command {
  const bare: Command = {};
  for (const [field, value] of Object.entries(command)) {
    if (!ENVELOPE_FIELDS.has(field)) bare[field] = value;
  }
  if (commandName === 'update' && Array.isArray(bare.updates)) bare.updates = bare.updates.slice(0, 1);
  if (commandName === 'delete' && Array.isArray(bare.deletes)) bare.deletes = bare.deletes.slice(0, 1);
  return bare;
}

function filterOf(commandName: string, command: Command): unknown {
  switch (commandName) {
    case 'find': return command.filter;
    case 'count':
    case 'distinct':
    case 'findAndModify': return command.query;
    case 'update': return (command.updates as Command[] | undefined)?.[0]?.q;
    case 'delete': return (command.deletes as Command[] | undefined)?.[0]?.q;
    case 'aggregate': return (command.pipeline as Command[] | undefined)?.[0]?.$match;
    default: return undefined;
  }
}

function filterKeys(filter: unknown): string[] {
  return filter && typeof filter === 'object' ? Object.keys(filter) : [];
}

/** Collects stage names and index names from every winningPlan in an explain result. */
export function summarizePlan(explain: unknown): PlanSummary {
  const stages: string[] = [];
  const indexes: string[] = [];
  const walkPlan = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walkPlan);
    if (!node || typeof node !== 'object') return;
    for (const [field, value] of Object.entries(node)) {
      if (field === 'slotBasedPlan' || field === 'rejectedPlans') continue;
      if (field === 'stage' && typeof value === 'string') stages.push(value);
      else if (field === 'indexName' && typeof value === 'string') indexes.push(value);
      else walkPlan(value);
    }
  };
  const findWinningPlans = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(findWinningPlans);
    if (!node || typeof node !== 'object') return;
    for (const [field, value] of Object.entries(node)) {
      if (field === 'winningPlan') walkPlan(value);
      else if (field !== 'rejectedPlans') findWinningPlans(value);
    }
  };
  findWinningPlans(explain);

  const plan = stages.includes('COLLSCAN')
    ? 'COLLSCAN'
    : stages.some(stage => INDEX_STAGES.has(stage)) ? 'IXSCAN' : stages[stages.length - 1] ?? 'UNKNOWN';
  return { plan, stages, indexes: [...new Set(indexes)] };
}

/** Starts logging commands slower than the threshold on this connection's client. */
export function attachSlowQueryProfiler(connection: mongoose.Connection, options: SlowQueryProfilerOptions = {}): SlowQueryProfiler {
  const thresholdMs = options.thresholdMs ?? DEFAULT_SLOW_QUERY_THRESHOLD_MS;
  const log = options.logger ?? sharedLogger;
  const client = connection.getClient();
  const tracked = new Map<number, TrackedCommand>();
  const pending = new Set<Promise<void>>();

  async function explainAndLog(entry: TrackedCommand, durationMs: number): Promise<void> {
    const details = {
      event: 'slow_query',
      collection: entry.collection,
      operation: entry.commandName,
      durationMs,
      thresholdMs,
      filterKeys: filterKeys(filterOf(entry.commandName, entry.command)),
    };
    try {
      const explain = await client.db(entry.databaseName).command({
        explain: explainable(entry.commandName, entry.command),
        verbosity: 'queryPlanner',
      });
      log.warn('[db] Slow query', { ...details, ...summarizePlan(explain) });
    } catch (error) {
      log.warn('[db] Slow query', { ...details, plan: 'UNKNOWN', explainError: error instanceof Error ? error.message : String(error) });
    }
  }

  const onStarted = (event: mongo.CommandStartedEvent) => {
    if (!PROFILED_COMMANDS.has(event.commandName)) return;
    const collection = event.command[event.commandName];
    if (typeof collection !== 'string') return; // aggregate: 1 runs against the database, not a collection.
    if (tracked.size >= MAX_TRACKED_COMMANDS) tracked.delete(tracked.keys().next().value!);
    tracked.set(event.requestId, { commandName: event.commandName, databaseName: event.databaseName, collection, command: event.command });
  };
  const onSucceeded = (event: mongo.CommandSucceededEvent) => {
    const entry = tracked.get(event.requestId);
    if (!entry) return;
    tracked.delete(event.requestId);
    if (event.duration < thresholdMs) return;
    const task = explainAndLog(entry, Math.round(event.duration)).finally(() => pending.delete(task));
    pending.add(task);
  };
  const onFailed = (event: mongo.CommandFailedEvent) => {
    tracked.delete(event.requestId);
  };

  client.on('commandStarted', onStarted);
  client.on('commandSucceeded', onSucceeded);
  client.on('commandFailed', onFailed);

  return {
    detach() {
      client.off('commandStarted', onStarted);
      client.off('commandSucceeded', onSucceeded);
      client.off('commandFailed', onFailed);
      tracked.clear();
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
