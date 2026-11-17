import { describe, expect, it, vi } from 'vitest';
import {
  isBlockedAddress,
  isBlockedHostname,
  safeFetch,
  SafeFetchError,
  type RawResponse,
  type SafeFetchDeps,
} from './safeFetch.js';

const ok = (body = 'job text'): RawResponse => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(body) });
const redirect = (to: string): RawResponse => ({ status: 302, headers: { location: to }, body: Buffer.alloc(0) });

function deps(table: Record<string, string[]>, responses: Record<string, RawResponse>): SafeFetchDeps & { request: ReturnType<typeof vi.fn> } {
  return {
    resolve: async (h: string) => table[h] ?? [],
    request: vi.fn(async ({ url }: { url: URL }) => responses[url.toString()] ?? ok()),
  } as unknown as SafeFetchDeps & { request: ReturnType<typeof vi.fn> };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof SafeFetchError ? e.code : `other:${(e as Error).message}`;
  }
  return 'none';
}

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::10.0.0.1',
    '64:ff9b::7f00:1', '2002:7f00:1::1', 'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

describe('isBlockedHostname', () => {
  it('blocks local names and metadata hosts', () => {
    for (const h of ['localhost', 'LOCALHOST.', 'app.localhost', 'db.internal', 'printer.local', 'metadata.google.internal']) {
      expect(isBlockedHostname(h)).toBe(true);
    }
    expect(isBlockedHostname('boards.greenhouse.io')).toBe(false);
  });
});

describe('safeFetch', () => {
  it('fetches a public page', async () => {
    const d = deps({ 'jobs.example.com': ['93.184.216.34'] }, {});
    const res = await safeFetch('https://jobs.example.com/p/1', {}, d);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('job text');
    expect(d.request.mock.calls[0][0].ip).toBe('93.184.216.34');
  });

  it('blocks cloud metadata, loopback and private literals without any request', async () => {
    const d = deps({}, {});
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:27017/', 'http://[::1]/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://[::ffff:127.0.0.1]/']) {
      expect(await codeOf(safeFetch(url, {}, d))).toBe('BLOCKED_ADDRESS');
    }
    expect(d.request).not.toHaveBeenCalled();
  });

  it('blocks localhost and internal hostnames before resolving', async () => {
    const d = deps({ localhost: ['93.184.216.34'] }, {});
    expect(await codeOf(safeFetch('http://localhost/admin', {}, d))).toBe('BLOCKED_HOST');
    expect(await codeOf(safeFetch('http://redis.internal:6379/', {}, d))).toBe('BLOCKED_HOST');
  });

  it('blocks a public name that resolves to a private address (rebinding, mixed answers)', async () => {
    const d = deps({ 'evil.example': ['93.184.216.34', '10.0.0.8'], 'meta.example': ['169.254.169.254'] }, {});
    expect(await codeOf(safeFetch('https://evil.example/', {}, d))).toBe('BLOCKED_ADDRESS');
    expect(await codeOf(safeFetch('https://meta.example/', {}, d))).toBe('BLOCKED_ADDRESS');
    expect(d.request).not.toHaveBeenCalled();
  });

  it('rejects other protocols, credentials and junk', async () => {
    const d = deps({}, {});
    expect(await codeOf(safeFetch('file:///etc/passwd', {}, d))).toBe('BLOCKED_PROTOCOL');
    expect(await codeOf(safeFetch('gopher://example.com/', {}, d))).toBe('BLOCKED_PROTOCOL');
    expect(await codeOf(safeFetch('https://user:pw@example.com/', {}, d))).toBe('INVALID_URL');
    expect(await codeOf(safeFetch('not a url', {}, d))).toBe('INVALID_URL');
  });

  it('follows a public redirect and re-validates it', async () => {
    const d = deps(
      { 'a.example': ['93.184.216.34'], 'b.example': ['93.184.216.35'] },
      { 'https://a.example/old': redirect('https://b.example/new'), 'https://b.example/new': ok('moved') },
    );
    const res = await safeFetch('https://a.example/old', {}, d);
    expect(res.body.toString()).toBe('moved');
    expect(res.url).toBe('https://b.example/new');
  });

  it('rejects a redirect to an internal address', async () => {
    const d = deps(
      { 'a.example': ['93.184.216.34'] },
      { 'https://a.example/go': redirect('http://169.254.169.254/latest/meta-data/') },
    );
    expect(await codeOf(safeFetch('https://a.example/go', {}, d))).toBe('BLOCKED_ADDRESS');
    expect(d.request).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect to a non-http protocol and a relative redirect to localhost', async () => {
    const d = deps(
      { 'a.example': ['93.184.216.34'] },
      { 'https://a.example/f': redirect('file:///etc/passwd'), 'https://a.example/l': redirect('http://localhost/x') },
    );
    expect(await codeOf(safeFetch('https://a.example/f', {}, d))).toBe('BLOCKED_PROTOCOL');
    expect(await codeOf(safeFetch('https://a.example/l', {}, d))).toBe('BLOCKED_HOST');
  });

  it('stops after three redirects', async () => {
    const responses: Record<string, RawResponse> = {};
    for (let i = 0; i < 6; i++) responses[`https://a.example/${i}`] = redirect(`https://a.example/${i + 1}`);
    const d = deps({ 'a.example': ['93.184.216.34'] }, responses);
    expect(await codeOf(safeFetch('https://a.example/0', {}, d))).toBe('TOO_MANY_REDIRECTS');
    expect(d.request).toHaveBeenCalledTimes(4);
  });

  it('allows exactly three redirects', async () => {
    const responses: Record<string, RawResponse> = {
      'https://a.example/0': redirect('/1'),
      'https://a.example/1': redirect('/2'),
      'https://a.example/2': redirect('/3'),
      'https://a.example/3': ok('end'),
    };
    const d = deps({ 'a.example': ['93.184.216.34'] }, responses);
    expect((await safeFetch('https://a.example/0', {}, d)).body.toString()).toBe('end');
  });

  it('passes the size and time caps to the transport', async () => {
    const d = deps({ 'a.example': ['93.184.216.34'] }, {});
    await safeFetch('https://a.example/', {}, d);
    const call = d.request.mock.calls[0][0];
    expect(call.maxBytes).toBe(2 * 1024 * 1024);
    expect(call.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('surfaces an oversized response from the transport', async () => {
    const d: SafeFetchDeps = {
      resolve: async () => ['93.184.216.34'],
      request: async () => {
        throw new SafeFetchError('RESPONSE_TOO_LARGE', 'too big');
      },
    };
    expect(await codeOf(safeFetch('https://a.example/', {}, d))).toBe('RESPONSE_TOO_LARGE');
  });
});
