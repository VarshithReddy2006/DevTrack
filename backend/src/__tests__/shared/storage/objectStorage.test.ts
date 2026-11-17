import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isValidStorageKey, LocalDiskObjectStorage, SIGNED_URL_TTL_MS } from '../../../shared/storage/objectStorage.js';

const SECRET = 'unit-test-signing-secret-0123456789';
let root: string;
let storage: LocalDiskObjectStorage;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devtrack-storage-'));
  storage = new LocalDiskObjectStorage({ root, secret: SECRET, downloadPath: '/dl' });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const parse = (url: string) => {
  const query = new URL(url, 'http://x').searchParams;
  return { key: query.get('key')!, expires: query.get('expires')!, signature: query.get('sig')! };
};

describe('local disk driver', () => {
  it('stores, reads, checks and deletes objects', async () => {
    expect(await storage.get('dossiers/u1/a.pdf')).toBeNull();
    expect(await storage.exists('dossiers/u1/a.pdf')).toBe(false);
    await storage.put('dossiers/u1/a.pdf', Buffer.from('%PDF-one'));
    expect((await storage.get('dossiers/u1/a.pdf'))!.toString()).toBe('%PDF-one');
    expect(await storage.exists('dossiers/u1/a.pdf')).toBe(true);
    await storage.put('dossiers/u1/a.pdf', Buffer.from('%PDF-two')); // overwrite
    expect((await storage.get('dossiers/u1/a.pdf'))!.toString()).toBe('%PDF-two');
    await storage.delete('dossiers/u1/a.pdf');
    await storage.delete('dossiers/u1/a.pdf'); // already gone
    expect(await storage.exists('dossiers/u1/a.pdf')).toBe(false);
    expect(await readdir(path.join(root, 'dossiers/u1'))).toEqual([]); // no temp files left behind
  });

  it('deleteExcept keeps one object and tolerates a missing prefix', async () => {
    for (const name of ['a', 'b', 'c']) await storage.put(`dossiers/u1/${name}.pdf`, Buffer.from(name));
    await storage.put('dossiers/u2/z.pdf', Buffer.from('z'));
    expect(await storage.deleteExcept('dossiers/u1', 'dossiers/u1/b.pdf')).toBe(2);
    expect(await readdir(path.join(root, 'dossiers/u1'))).toEqual(['b.pdf']);
    expect(await storage.exists('dossiers/u2/z.pdf')).toBe(true);
    expect(await storage.deleteExcept('dossiers/nobody', 'dossiers/nobody/x.pdf')).toBe(0);
  });

  it.each(['../escape.pdf', 'dossiers/../../escape.pdf', '/etc/passwd', 'a//b', 'a/./b', '.hidden', 'dossiers/.x', 'a\\b', 'a b', '', 'x'.repeat(201)])(
    'rejects the unsafe key %j', async key => {
      expect(isValidStorageKey(key)).toBe(false);
      await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow('Invalid object storage key');
      await expect(storage.get(key)).rejects.toThrow('Invalid object storage key');
      expect(() => storage.signUrl(key)).toThrow('Invalid object storage key');
    });

  it('refuses a weak signing secret', () => {
    expect(() => new LocalDiskObjectStorage({ root, secret: 'short', downloadPath: '/dl' })).toThrow(/at least 16/);
  });
});

describe('signed URLs', () => {
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);

  it('expire exactly 15 minutes after they are issued', () => {
    expect(SIGNED_URL_TTL_MS).toBe(15 * 60 * 1000);
    const { url, expiresAt } = storage.signUrl('dossiers/u1/a.pdf', now);
    expect(url.startsWith('/dl?')).toBe(true);
    expect(expiresAt.getTime()).toBe(now + SIGNED_URL_TTL_MS);
    const params = parse(url);
    expect(storage.verifySignedUrl(params, now)).toBe(true);
    expect(storage.verifySignedUrl(params, now + SIGNED_URL_TTL_MS - 1)).toBe(true);
    expect(storage.verifySignedUrl(params, now + SIGNED_URL_TTL_MS)).toBe(false);
    expect(storage.verifySignedUrl(params, now + SIGNED_URL_TTL_MS + 60_000)).toBe(false);
  });

  it('reject any tampering', () => {
    const params = parse(storage.signUrl('dossiers/u1/a.pdf', now).url);
    expect(storage.verifySignedUrl({ ...params, key: 'dossiers/u2/a.pdf' }, now)).toBe(false);
    expect(storage.verifySignedUrl({ ...params, expires: String(Number(params.expires) + 60_000) }, now)).toBe(false);
    expect(storage.verifySignedUrl({ ...params, signature: params.signature.slice(0, -1) + (params.signature.endsWith('A') ? 'B' : 'A') }, now)).toBe(false);
    expect(storage.verifySignedUrl({ ...params, signature: params.signature.slice(1) }, now)).toBe(false);
    expect(storage.verifySignedUrl({ ...params, signature: '' }, now)).toBe(false);
    expect(storage.verifySignedUrl({ ...params, expires: 'abc' }, now)).toBe(false);
    expect(storage.verifySignedUrl({ ...params, key: '../a.pdf' }, now)).toBe(false);
  });

  it('are bound to the secret and to the key they were issued for', () => {
    const other = new LocalDiskObjectStorage({ root, secret: 'a-completely-different-secret-value', downloadPath: '/dl' });
    const params = parse(storage.signUrl('dossiers/u1/a.pdf', now).url);
    expect(other.verifySignedUrl(params, now)).toBe(false);
    const second = parse(storage.signUrl('dossiers/u1/b.pdf', now).url);
    expect(storage.verifySignedUrl({ ...params, signature: second.signature }, now)).toBe(false);
  });
});
