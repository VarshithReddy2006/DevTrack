// In-memory stand-in for the Redis sorted sets, so league tests never need a Redis server.
// Ordering matches ZREVRANGE: higher score first, equal scores in reverse lexicographic order.
import type { LeagueScoreStore, ScoreEntry } from '../../../modules/leagues/scoreStore.js';

export class FakeScoreStore implements LeagueScoreStore {
  readonly sets = new Map<string, Map<string, number>>();
  readonly applied = new Map<string, Set<string>>();
  readonly ttls = new Map<string, number>();

  async incrementOnce(key: string, member: string, delta: number, dedupe: { setKey: string; id: string }) {
    const seen = this.applied.get(dedupe.setKey) ?? new Set<string>();
    this.applied.set(dedupe.setKey, seen);
    if (seen.has(dedupe.id)) return null;
    seen.add(dedupe.id);
    const set = this.sets.get(key) ?? new Map<string, number>();
    this.sets.set(key, set);
    const score = (set.get(member) ?? 0) + delta;
    set.set(member, score);
    return score;
  }

  async seed(key: string, members: string[]) {
    if (members.length === 0) return;
    const set = this.sets.get(key) ?? new Map<string, number>();
    this.sets.set(key, set);
    for (const member of members) if (!set.has(member)) set.set(member, 0);
  }

  async replace(key: string, entries: ScoreEntry[]) {
    if (entries.length === 0) this.sets.delete(key);
    else this.sets.set(key, new Map(entries.map(e => [e.member, e.score])));
  }

  async remove(key: string, member: string) {
    this.sets.get(key)?.delete(member);
  }

  async ranked(key: string, start: number, stop: number) {
    const all = [...(this.sets.get(key) ?? new Map<string, number>())]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => b.score - a.score || (a.member < b.member ? 1 : a.member > b.member ? -1 : 0));
    return all.slice(start, stop === -1 ? undefined : stop + 1);
  }

  async exists(key: string) {
    return this.sets.has(key);
  }

  async expire(key: string, seconds: number) {
    if (this.sets.has(key)) this.ttls.set(key, seconds);
  }

  score(key: string, member: string): number | undefined {
    return this.sets.get(key)?.get(member);
  }

  /** Simulates FLUSHALL on the Redis the leagues use. */
  flush() {
    this.sets.clear();
    this.applied.clear();
    this.ttls.clear();
  }
}
