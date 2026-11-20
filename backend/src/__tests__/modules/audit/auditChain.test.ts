import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  canonicalize,
  chainNext,
  hashPayload,
  merkleRoot,
  verifyAuditChain,
  type AuditChainFields,
} from '../../../modules/audit/auditChain.service.js';

function buildChain(n: number): AuditChainFields[] {
  const chain: AuditChainFields[] = [];
  for (let i = 0; i < n; i++) {
    chain.push(
      chainNext(chain[chain.length - 1] ?? null, {
        timestamp: new Date(Date.UTC(2026, 10, 1, 0, i)),
        userId: `user-${i % 3}`,
        eventType: i % 2 ? 'flag_raised' : 'profile_computed',
        payload: { score: i, note: `entry ${i}` },
      }),
    );
  }
  return chain;
}

describe('chainNext', () => {
  it('starts at sequence 1 from the genesis hash', () => {
    const first = buildChain(1)[0];
    expect(first.sequenceNumber).toBe(1);
    expect(first.previousHash).toBe(GENESIS_HASH);
    expect(first.recordHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('links each record to the previous one', () => {
    const c = buildChain(4);
    for (let i = 1; i < c.length; i++) {
      expect(c[i].sequenceNumber).toBe(i + 1);
      expect(c[i].previousHash).toBe(c[i - 1].recordHash);
    }
  });

  it('hashes payloads independent of key order', () => {
    expect(hashPayload({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashPayload({ b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
    expect(canonicalize({ x: undefined, y: 1 })).toBe('{"y":1}');
  });
});

describe('verifyAuditChain', () => {
  it('accepts an intact chain, whatever order it arrives in', () => {
    const c = buildChain(20);
    expect(verifyAuditChain(c)).toEqual({ ok: true, checked: 20 });
    expect(verifyAuditChain([...c].reverse())).toEqual({ ok: true, checked: 20 });
  });

  it('accepts an empty chain', () => {
    expect(verifyAuditChain([])).toEqual({ ok: true, checked: 0 });
  });

  it('pinpoints a modified record', () => {
    const c = buildChain(10);
    c[4] = { ...c[4], eventType: 'flag_cleared' };
    expect(verifyAuditChain(c)).toMatchObject({ ok: false, brokenAt: 5, reason: 'hash_mismatch' });
  });

  it('catches a modified record whose hash was recomputed, because the next link breaks', () => {
    const c = buildChain(10);
    const forged = chainNext(c[3], { timestamp: c[4].timestamp, userId: c[4].userId, eventType: 'flag_cleared', payload: { forged: true } });
    c[4] = forged;
    expect(verifyAuditChain(c)).toMatchObject({ ok: false, brokenAt: 6, reason: 'previous_hash_mismatch' });
  });

  it('detects a deleted record as a sequence gap', () => {
    const c = buildChain(10);
    c.splice(6, 1);
    expect(verifyAuditChain(c)).toMatchObject({ ok: false, brokenAt: 8, reason: 'sequence_gap' });
  });

  it('detects a deleted record at the head against genesis', () => {
    const c = buildChain(5).slice(1);
    // The slice now starts at 2 with no anchor, so only inner links are checked...
    expect(verifyAuditChain(c).ok).toBe(true);
    // ...but anchoring at the genesis position exposes it.
    expect(verifyAuditChain(c, { sequenceNumber: 0, recordHash: GENESIS_HASH })).toMatchObject({ ok: false, brokenAt: 2, reason: 'sequence_gap' });
  });

  it('detects an inserted record', () => {
    const c = buildChain(6);
    const extra = chainNext(c[2], { timestamp: new Date(0), userId: 'x', eventType: 'flag_raised', payload: {} });
    const withInsert = [...c.slice(0, 3), extra, ...c.slice(3)];
    expect(verifyAuditChain(withInsert)).toMatchObject({ ok: false, reason: 'duplicate_or_out_of_order' });
  });

  it('verifies a range using the record before it as anchor, and still catches tampering inside', () => {
    const c = buildChain(12);
    const slice = c.slice(5, 9);
    expect(verifyAuditChain(slice, c[4])).toEqual({ ok: true, checked: 4 });
    const bad = slice.map((r, i) => (i === 2 ? { ...r, userId: 'someone-else' } : r));
    expect(verifyAuditChain(bad, c[4])).toMatchObject({ ok: false, brokenAt: 8, reason: 'hash_mismatch' });
  });

  it('rejects a range whose anchor does not match', () => {
    const c = buildChain(8);
    expect(verifyAuditChain(c.slice(3), c[1])).toMatchObject({ ok: false, brokenAt: 4 });
  });
});

describe('merkleRoot', () => {
  it('is deterministic and changes when any hash changes', () => {
    const hashes = buildChain(7).map((r) => r.recordHash);
    const root = merkleRoot(hashes);
    expect(merkleRoot(hashes)).toBe(root);
    const tampered = [...hashes];
    tampered[3] = hashes[4];
    expect(merkleRoot(tampered)).not.toBe(root);
  });
  it('handles empty and single inputs', () => {
    expect(merkleRoot([])).toBe(GENESIS_HASH);
    const one = buildChain(1)[0].recordHash;
    expect(merkleRoot([one])).toBe(one);
  });
});
