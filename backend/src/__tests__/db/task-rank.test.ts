import { describe, it, expect } from 'vitest';
import { rankBetween } from '../../db/models/projectTask.model.js';

// Deterministic "random" so failures reproduce
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('rankBetween', () => {
  it('creates a first rank for an empty column', () => {
    const r = rankBetween(null, null);
    expect(r.length).toBeGreaterThan(0);
  });

  it('sorts after prev and before next', () => {
    const a = rankBetween(null, null);
    const c = rankBetween(a, null);
    const b = rankBetween(a, c);
    expect(a < b && b < c).toBe(true);
  });

  it('rejects an inverted or equal range', () => {
    expect(() => rankBetween('b', 'a')).toThrow();
    expect(() => rankBetween('a', 'a')).toThrow();
  });

  it('survives 100 moves into the same gap (always the top slot)', () => {
    const rand = seeded(1);
    const ranks = [rankBetween(null, null, rand), rankBetween(null, null, rand)].sort();
    for (let i = 0; i < 100; i++) {
      ranks.unshift(rankBetween(null, ranks[0], rand));
    }
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('survives 100 moves squeezed between the same two cards', () => {
    const rand = seeded(2);
    const lo = rankBetween(null, null, rand);
    const hi = rankBetween(lo, null, rand);
    let upper = hi;
    const placed: string[] = [];
    for (let i = 0; i < 100; i++) {
      const r = rankBetween(lo, upper, rand);
      expect(r > lo && r < upper).toBe(true);
      placed.push(r);
      upper = r;
    }
    expect(new Set(placed).size).toBe(100);
  });

  it('keeps order across random insertions', () => {
    const rand = seeded(3);
    const list: string[] = [];
    for (let i = 0; i < 300; i++) {
      const at = Math.floor(rand() * (list.length + 1));
      const r = rankBetween(list[at - 1] ?? null, list[at] ?? null, rand);
      list.splice(at, 0, r);
    }
    expect([...list].sort()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
  });

  it('two concurrent moves into the same gap get different ranks', () => {
    const lo = rankBetween(null, null);
    const hi = rankBetween(lo, null);
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) results.add(rankBetween(lo, hi));
    expect(results.size).toBeGreaterThan(1);
  });
});
