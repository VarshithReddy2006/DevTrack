// tests/chaos/helpers/fakeRedis.ts — In-memory stand-in for the Redis commands the
// SSE event bus and ticket store use, with crash/restart controls.
// Time comes from Date.now(), so under vi.useFakeTimers() stream ids are deterministic.

export class RedisConnectionError extends Error {
  constructor() {
    super('connect ECONNREFUSED 127.0.0.1:6379');
    this.name = 'RedisConnectionError';
  }
}

type StreamEntry = [id: string, fields: string[]];

export class FakeRedis {
  status: 'ready' | 'reconnecting' = 'ready';
  private strings = new Map<string, string>();
  private streams = new Map<string, StreamEntry[]>();
  private lastId = new Map<string, [number, number]>();
  readonly commandLog: string[] = [];
  private refusal: Error | null = null;

  /** Redis process dies: every command fails until restart(). Persisted data stays on disk. */
  crash(): void {
    this.status = 'reconnecting';
  }

  /** Redis comes back. Without persistence (no RDB/AOF) the keyspace is empty. */
  restart(opts: { persist: boolean }): void {
    if (!opts.persist) {
      this.strings.clear();
      this.streams.clear();
      this.lastId.clear();
    }
    this.status = 'ready';
  }

  get health(): 'connected' | 'disconnected' {
    return this.status === 'ready' ? 'connected' : 'disconnected';
  }

  streamLength(key: string): number {
    return this.streams.get(key)?.length ?? 0;
  }

  /** Connection stays up but commands are refused (MISCONF, OOM, READONLY replica). */
  refuseCommands(error: Error): void {
    this.refusal = error;
  }

  acceptCommands(): void {
    this.refusal = null;
  }

  private guard(command: string): void {
    this.commandLog.push(command);
    if (this.status !== 'ready') throw new RedisConnectionError();
    if (this.refusal) throw this.refusal;
  }

  async setex(key: string, _ttl: number, value: string): Promise<'OK'> {
    this.guard('setex');
    this.strings.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.guard('get');
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, ..._options: Array<string | number>): Promise<'OK'> {
    this.guard('set');
    this.strings.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    this.guard('del');
    return keys.filter((key) => this.strings.delete(key)).length;
  }

  async keys(pattern: string): Promise<string[]> {
    this.guard('keys');
    const matcher = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return [...this.strings.keys()].filter((key) => matcher.test(key));
  }

  async getdel(key: string): Promise<string | null> {
    this.guard('getdel');
    const value = this.strings.get(key) ?? null;
    this.strings.delete(key);
    return value;
  }

  async incr(key: string): Promise<number> {
    this.guard('incr');
    const next = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async expire(): Promise<number> {
    this.guard('expire');
    return 1;
  }

  async xadd(key: string, id: string, ...fields: string[]): Promise<string> {
    this.guard('xadd');
    if (id !== '*') throw new Error('FakeRedis only supports auto-generated stream ids');
    const [lastMs, lastSeq] = this.lastId.get(key) ?? [0, -1];
    const now = Date.now();
    const next: [number, number] = now > lastMs ? [now, 0] : [lastMs, lastSeq + 1];
    this.lastId.set(key, next);
    const entryId = `${next[0]}-${next[1]}`;
    const list = this.streams.get(key) ?? [];
    list.push([entryId, fields]);
    this.streams.set(key, list);
    return entryId;
  }

  async xtrim(key: string, _strategy: string, _approx: string, maxLen: number): Promise<number> {
    this.guard('xtrim');
    const list = this.streams.get(key) ?? [];
    const excess = Math.max(0, list.length - maxLen);
    list.splice(0, excess);
    return excess;
  }

  async xrange(key: string, start: string, end: string, ...opts: Array<string | number>): Promise<StreamEntry[]> {
    this.guard('xrange');
    const exclusive = start.startsWith('(');
    const from = start === '-' ? [0, 0] : parseId(exclusive ? start.slice(1) : start);
    const to = end === '+' ? [Infinity, Infinity] : parseId(end);
    const countAt = opts.findIndex((o) => o === 'COUNT');
    const count = countAt >= 0 ? Number(opts[countAt + 1]) : Infinity;
    return (this.streams.get(key) ?? [])
      .filter(([id]) => {
        const cmpFrom = compare(parseId(id), from);
        return (exclusive ? cmpFrom > 0 : cmpFrom >= 0) && compare(parseId(id), to) <= 0;
      })
      .slice(0, count);
  }
}

function parseId(id: string): [number, number] {
  const [ms, seq] = id.split('-');
  return [Number(ms), Number(seq ?? 0)];
}

function compare(a: number[], b: number[]): number {
  return a[0] - b[0] || a[1] - b[1];
}
