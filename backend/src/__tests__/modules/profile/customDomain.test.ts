// customDomain.test.ts: custom portfolio domains with a fake DNS resolver (no real lookups).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CustomDomain } from '../../../db/models/customDomain.model.js';
import { errorHandler } from '../../../middleware/error.js';
import { mountApiRoutes } from '../../../routes/mount.js';
import { getSystemMaintenanceQueue } from '../../../shared/jobs/queueFactory.js';
import customDomainRoutes, { customDomainDeps } from '../../../modules/profile/customDomain.routes.js';
import {
  checkDomainRecords,
  parseDomain,
  type DnsResolver,
} from '../../../modules/profile/customDomain.service.js';
import {
  auditCustomDomains,
  enqueueCustomDomainVerification,
  verifyCustomDomain,
} from '../../../modules/profile/customDomainVerifier.worker.js';

vi.mock('../../../middleware/index.js', async () => {
  const { validateBody } = await import('../../../middleware/validation.js');
  const { asyncHandler } = await import('../../../middleware/error.js');
  return {
    validateBody, asyncHandler,
    authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = req.get('x-test-user');
      if (!user) { res.status(401).json({ success: false }); return; }
      Object.assign(req, { user: { id: user } });
      next();
    },
  };
});

const TARGET = 'cname.devtrack.sh';
const DOMAIN = 'portfolio.alexchen.dev';
const TOKEN = 'devtrack-verification=fixture-token';

function dnsError(code: string): Error {
  return Object.assign(new Error(`query ${code}`), { code });
}

type Answer<T> = T | Error | 'hang';

/** In-memory zone. Anything not listed answers ENOTFOUND, like a name that does not exist. */
function fakeDns(zone: { txt?: Record<string, Answer<string[][]>>; cname?: Record<string, Answer<string[]>> }) {
  const lookups: string[] = [];
  const answer = <T>(type: string, records: Record<string, Answer<T>> | undefined, host: string): Promise<T> => {
    lookups.push(`${type} ${host}`);
    const value = records?.[host];
    if (value === 'hang') return new Promise<T>(() => {});
    if (value instanceof Error) return Promise.reject(value);
    return value === undefined ? Promise.reject(dnsError('ENOTFOUND')) : Promise.resolve(value);
  };
  const resolver: DnsResolver = {
    resolveTxt: host => answer('TXT', zone.txt, host),
    resolveCname: host => answer('CNAME', zone.cname, host),
  };
  return { resolver, lookups };
}

function validZone(domain = DOMAIN, token = TOKEN) {
  return fakeDns({ txt: { [`_devtrack-challenge.${domain}`]: [[token]] }, cname: { [domain]: [TARGET] } });
}

async function createDomain(fields: Partial<{ userId: Types.ObjectId; domain: string; verificationToken: string; status: string; lastCheckedAt: Date | null }> = {}) {
  return CustomDomain.create({
    userId: new Types.ObjectId(), domain: DOMAIN, verificationToken: TOKEN, status: 'pending', ...fields,
  });
}

beforeAll(async () => {
  await CustomDomain.init();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseDomain', () => {
  it('normalizes case and a trailing dot', () => {
    expect(parseDomain('  Portfolio.AlexChen.DEV. ')).toBe(DOMAIN);
    expect(parseDomain('www.xn--80ak6aa92e.xn--p1ai')).toBe('www.xn--80ak6aa92e.xn--p1ai');
  });

  it.each([
    ['https://portfolio.alexchen.dev', 'without https://'],
    ['portfolio.alexchen.dev/about', 'without https://'],
    ['localhost', 'not a valid domain'],
    ['192.168.1.10', 'not a valid domain'],
    ['bad_name.example.com', 'not a valid domain'],
    ['-dash.example.com', 'not a valid domain'],
    ['devtrack.sh', 'belongs to DevTrack'],
    ['alex.devtrack.sh', 'belongs to DevTrack'],
    [TARGET, 'belongs to DevTrack'],
  ])('rejects %s', (input, message) => {
    expect(() => parseDomain(input)).toThrow(message);
  });
});

describe('checkDomainRecords', () => {
  it('verifies a matching TXT challenge and CNAME', async () => {
    const dns = fakeDns({
      // Long TXT values arrive split into chunks; trailing dots and case vary between resolvers.
      txt: { [`_devtrack-challenge.${DOMAIN}`]: [['v=spf1 -all'], ['devtrack-verification=', 'fixture-token']] },
      cname: { [DOMAIN]: ['CNAME.DevTrack.sh.'] },
    });

    const result = await checkDomainRecords(DOMAIN, TOKEN, { resolver: dns.resolver });

    expect(result).toMatchObject({ verified: true, transient: false, error: null, txt: { ok: true }, cname: { ok: true } });
    expect(dns.lookups.sort()).toEqual([`CNAME ${DOMAIN}`, `TXT _devtrack-challenge.${DOMAIN}`]);
  });

  it('rejects a TXT record with another token', async () => {
    const dns = fakeDns({ txt: { [`_devtrack-challenge.${DOMAIN}`]: [['devtrack-verification=someone-else']] }, cname: { [DOMAIN]: [TARGET] } });

    const result = await checkDomainRecords(DOMAIN, TOKEN, { resolver: dns.resolver });

    expect(result.verified).toBe(false);
    expect(result.transient).toBe(false);
    expect(result.error).toEqual({ code: 'TXT_MISMATCH', message: `The TXT record at _devtrack-challenge.${DOMAIN} does not match your verification token` });
  });

  it('reports a missing TXT record', async () => {
    const dns = fakeDns({ txt: { [`_devtrack-challenge.${DOMAIN}`]: dnsError('ENODATA') }, cname: { [DOMAIN]: [TARGET] } });

    const result = await checkDomainRecords(DOMAIN, TOKEN, { resolver: dns.resolver });

    expect(result.error).toEqual({ code: 'TXT_MISSING', message: `No TXT record found at _devtrack-challenge.${DOMAIN}` });
  });

  it('rejects a CNAME that points somewhere else', async () => {
    const dns = fakeDns({ txt: { [`_devtrack-challenge.${DOMAIN}`]: [[TOKEN]] }, cname: { [DOMAIN]: ['alexchen.github.io.'] } });

    const result = await checkDomainRecords(DOMAIN, TOKEN, { resolver: dns.resolver });

    expect(result).toMatchObject({ verified: false, txt: { ok: true }, cname: { ok: false, found: ['alexchen.github.io'] } });
    expect(result.error).toEqual({ code: 'CNAME_MISMATCH', message: `${DOMAIN} is a CNAME for alexchen.github.io, expected ${TARGET}` });
  });

  it('explains a missing CNAME, including the apex domain case', async () => {
    const dns = fakeDns({ txt: { '_devtrack-challenge.alexchen.dev': [[TOKEN]] } });

    const result = await checkDomainRecords('alexchen.dev', TOKEN, { resolver: dns.resolver });

    expect(result.error?.code).toBe('CNAME_MISSING');
    expect(result.error?.message).toContain(`Point it at ${TARGET}`);
    expect(result.error?.message).toContain('apex domains cannot use a CNAME');
  });

  it('reports a resolver timeout as a transient DNS_TIMEOUT', async () => {
    const dns = fakeDns({ txt: { [`_devtrack-challenge.${DOMAIN}`]: dnsError('ETIMEOUT') }, cname: { [DOMAIN]: [TARGET] } });

    const result = await checkDomainRecords(DOMAIN, TOKEN, { resolver: dns.resolver, timeoutMs: 1500 });

    expect(result).toMatchObject({ verified: false, transient: true });
    expect(result.error).toEqual({ code: 'DNS_TIMEOUT', message: `TXT lookup for _devtrack-challenge.${DOMAIN} timed out after 1500ms` });
  });

  it('gives up on a lookup that never answers', async () => {
    const dns = fakeDns({ txt: { [`_devtrack-challenge.${DOMAIN}`]: [[TOKEN]] }, cname: { [DOMAIN]: 'hang' } });

    const result = await checkDomainRecords(DOMAIN, TOKEN, { resolver: dns.resolver, timeoutMs: 20 });

    expect(result).toMatchObject({ verified: false, transient: true, error: { code: 'DNS_TIMEOUT' } });
  });

  it('treats a server failure as transient but a missing record as final', async () => {
    const servfail = fakeDns({ txt: { [`_devtrack-challenge.${DOMAIN}`]: dnsError('ESERVFAIL') }, cname: { [DOMAIN]: [TARGET] } });
    expect(await checkDomainRecords(DOMAIN, TOKEN, { resolver: servfail.resolver })).toMatchObject({
      transient: true, error: { code: 'DNS_ERROR', message: `TXT lookup for _devtrack-challenge.${DOMAIN} failed (ESERVFAIL)` },
    });

    const mixed = fakeDns({ txt: {}, cname: { [DOMAIN]: dnsError('ETIMEOUT') } });
    expect(await checkDomainRecords(DOMAIN, TOKEN, { resolver: mixed.resolver })).toMatchObject({
      transient: false, error: { code: 'TXT_MISSING' },
    });
  });
});

describe('verifyCustomDomain', () => {
  it('activates a pending domain whose records match', async () => {
    const doc = await createDomain();

    const outcome = await verifyCustomDomain(doc.id, { resolver: validZone().resolver });

    expect(outcome).toMatchObject({ status: 'active', applied: true });
    const saved = await CustomDomain.findById(doc.id).lean();
    expect(saved).toMatchObject({ status: 'active', lastError: null });
    expect(saved?.verifiedAt).toBeInstanceOf(Date);
  });

  it('marks the domain failed with a descriptive error when the token does not match', async () => {
    const doc = await createDomain();

    await verifyCustomDomain(doc.id, { resolver: validZone(DOMAIN, 'devtrack-verification=stale').resolver });

    const saved = await CustomDomain.findById(doc.id).lean();
    expect(saved).toMatchObject({ status: 'failed', verifiedAt: null, lastError: { code: 'TXT_MISMATCH' } });
    expect(saved?.lastError?.message).toContain(`_devtrack-challenge.${DOMAIN}`);
  });

  it('marks a pending domain failed on a DNS timeout', async () => {
    const doc = await createDomain();
    const dns = fakeDns({ txt: { [`_devtrack-challenge.${DOMAIN}`]: 'hang' }, cname: { [DOMAIN]: [TARGET] } });

    await verifyCustomDomain(doc.id, { resolver: dns.resolver, timeoutMs: 20 });

    expect(await CustomDomain.findById(doc.id).lean()).toMatchObject({ status: 'failed', lastError: { code: 'DNS_TIMEOUT' } });
  });

  it('refuses a domain another profile already has active', async () => {
    await createDomain({ status: 'active' });
    const second = await createDomain();

    const outcome = await verifyCustomDomain(second.id, { resolver: validZone().resolver });

    expect(outcome?.status).toBe('failed');
    expect(await CustomDomain.findById(second.id).lean()).toMatchObject({ status: 'failed', lastError: { code: 'DOMAIN_TAKEN' } });
  });

  it('does not touch a domain the owner replaced while the check was running', async () => {
    const doc = await createDomain();
    const dns = validZone();
    const resolveTxt = dns.resolver.resolveTxt;
    dns.resolver.resolveTxt = async host => {
      await CustomDomain.updateOne({ _id: doc._id }, { $set: { domain: 'other.alexchen.dev', verificationToken: 'devtrack-verification=new' } });
      return resolveTxt(host);
    };

    const outcome = await verifyCustomDomain(doc.id, { resolver: dns.resolver });

    expect(outcome?.applied).toBe(false);
    expect(await CustomDomain.findById(doc.id).lean()).toMatchObject({ domain: 'other.alexchen.dev', status: 'pending' });
  });

  it('returns null for a domain that was deleted', async () => {
    expect(await verifyCustomDomain(new Types.ObjectId().toString(), { resolver: validZone().resolver })).toBeNull();
  });
});

describe('auditCustomDomains', () => {
  it('suspends active domains whose records disappeared and keeps the rest', async () => {
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const healthy = await createDomain({ domain: 'healthy.example.com', status: 'active', lastCheckedAt: lastWeek });
    const removed = await createDomain({ domain: 'removed.example.com', status: 'active', lastCheckedAt: lastWeek });
    const flaky = await createDomain({ domain: 'flaky.example.com', status: 'active', lastCheckedAt: lastWeek });
    const pending = await createDomain({ domain: 'pending.example.com' });
    const dns = fakeDns({
      txt: {
        '_devtrack-challenge.healthy.example.com': [[TOKEN]],
        '_devtrack-challenge.flaky.example.com': dnsError('ETIMEOUT'),
        '_devtrack-challenge.pending.example.com': [[TOKEN]],
      },
      cname: {
        'healthy.example.com': [TARGET],
        'removed.example.com': [TARGET],
        'flaky.example.com': [TARGET],
        'pending.example.com': [TARGET],
      },
    });

    const summary = await auditCustomDomains({ resolver: dns.resolver, concurrency: 1 });

    expect(summary).toEqual({ checked: 3, active: 2, suspended: 1, inconclusive: 1, errors: 0 });
    expect(await CustomDomain.findById(healthy.id).lean()).toMatchObject({ status: 'active', lastError: null });
    const suspended = await CustomDomain.findById(removed.id).lean();
    expect(suspended).toMatchObject({ status: 'suspended', lastError: { code: 'TXT_MISSING' } });
    expect(suspended?.suspendedAt).toBeInstanceOf(Date);
    expect(await CustomDomain.findById(flaky.id).lean()).toMatchObject({ status: 'active', lastError: { code: 'DNS_TIMEOUT' } });
    expect(await CustomDomain.findById(pending.id).lean()).toMatchObject({ status: 'pending', lastCheckedAt: null });
    expect(dns.lookups.filter(lookup => lookup.startsWith('TXT'))).toHaveLength(3);
  });
});

describe('enqueueCustomDomainVerification', () => {
  it('queues a deduplicated verify_custom_domain job on the maintenance queue', async () => {
    await enqueueCustomDomainVerification('abc123');

    expect(getSystemMaintenanceQueue().add).toHaveBeenLastCalledWith(
      'verify-custom-domain',
      { task: 'verify_custom_domain', domainId: 'abc123' },
      expect.objectContaining({ deduplication: { id: 'custom-domain-verify:abc123', ttl: 30_000 } }),
    );
  });
});

describe('custom domain routes', () => {
  let server: Server;
  let base: string;
  const owner = new Types.ObjectId().toString();

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const routes = express.Router();
    // Same order as src/routes/index.ts.
    routes.use('/portfolio/custom-domain', customDomainRoutes);
    routes.get('/portfolio/:username', (req, res) => { res.json({ portfolio: req.params.username }); });
    mountApiRoutes(app, routes);
    app.use(errorHandler);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/portfolio`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function call(path: string, init: { method?: string; user?: string; body?: unknown } = {}) {
    return fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(init.user ? { 'x-test-user': init.user } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  it('registers a domain with a random TXT token and returns both DNS records', async () => {
    const response = await call('/custom-domain', { method: 'POST', user: owner, body: { domain: 'Portfolio.AlexChen.dev' } });

    expect(response.status).toBe(201);
    const { data } = await response.json();
    expect(data).toMatchObject({ domain: DOMAIN, status: 'pending', lastError: null });
    expect(data.records).toEqual([
      { type: 'TXT', name: `_devtrack-challenge.${DOMAIN}`, value: expect.stringMatching(/^devtrack-verification=[A-Za-z0-9_-]{32}$/) },
      { type: 'CNAME', name: DOMAIN, value: TARGET },
    ]);

    const again = await (await call('/custom-domain', { method: 'POST', user: owner, body: { domain: DOMAIN } })).json();
    expect(again.data.records[0].value).toBe(data.records[0].value);

    const otherUser = await (await call('/custom-domain', { method: 'POST', user: new Types.ObjectId().toString(), body: { domain: 'other.example.com' } })).json();
    expect(otherUser.data.records[0].value).not.toBe(data.records[0].value);
  });

  it('issues a new token and resets the status when the domain changes', async () => {
    await createDomain({ userId: new Types.ObjectId(owner), status: 'active' });

    const { data } = await (await call('/custom-domain', { method: 'POST', user: owner, body: { domain: 'www.alexchen.dev' } })).json();

    expect(data).toMatchObject({ domain: 'www.alexchen.dev', status: 'pending', verifiedAt: null });
    expect(data.records[0].value).not.toBe(TOKEN);
    expect(await CustomDomain.countDocuments({ userId: owner })).toBe(1);
  });

  it('rejects invalid domains and domains active on another profile', async () => {
    const invalid = await call('/custom-domain', { method: 'POST', user: owner, body: { domain: 'https://alexchen.dev' } });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe('INVALID_DOMAIN');

    await createDomain({ status: 'active' });
    const taken = await call('/custom-domain', { method: 'POST', user: owner, body: { domain: DOMAIN } });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: 'DOMAIN_TAKEN', message: `${DOMAIN} is already connected to another DevTrack profile` });
  });

  it('queues a verification job for the owner domain', async () => {
    const enqueue = vi.spyOn(customDomainDeps, 'enqueueVerification').mockResolvedValue(undefined);
    const doc = await createDomain({ userId: new Types.ObjectId(owner) });

    const response = await call('/custom-domain/verify', { method: 'POST', user: owner });

    expect(response.status).toBe(202);
    expect((await response.json()).data).toMatchObject({ id: doc.id, status: 'pending', verificationQueued: true });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(doc.id);
  });

  it('answers 404 when there is nothing to verify and 503 when the queue is down', async () => {
    const enqueue = vi.spyOn(customDomainDeps, 'enqueueVerification').mockRejectedValue(new Error('Redis unavailable'));

    expect((await call('/custom-domain/verify', { method: 'POST', user: owner })).status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();

    await createDomain({ userId: new Types.ObjectId(owner) });
    const down = await call('/custom-domain/verify', { method: 'POST', user: owner });
    expect(down.status).toBe(503);
    expect((await down.json()).code).toBe('VERIFICATION_UNAVAILABLE');
  });

  it('returns the status with the last error to the owner only', async () => {
    await createDomain({ userId: new Types.ObjectId(owner), status: 'failed' });
    await CustomDomain.updateOne({ userId: owner }, { $set: { lastError: { code: 'CNAME_MISMATCH', message: 'points elsewhere' } } });

    const response = await call('/custom-domain/status', { user: owner });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ domain: DOMAIN, status: 'failed', lastError: { code: 'CNAME_MISMATCH', message: 'points elsewhere' } });

    expect((await call('/custom-domain/status')).status).toBe(401);
    expect((await call('/custom-domain/status', { user: new Types.ObjectId().toString() })).status).toBe(404);
  });

  it('leaves GET /portfolio/custom-domain to the public portfolio of that handle', async () => {
    const response = await call('/custom-domain');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ portfolio: 'custom-domain' });
  });
});
