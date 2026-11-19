import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';
import { GitHubBackoffError, githubJson, parseCommitReference, verifyGitHubCommit } from './githubVerifier.service.js';
import { evidenceInputHash, evidenceProof } from './evidenceProof.js';

const sha = 'a'.repeat(40);
const url = `https://github.com/example/repo/commit/${sha}`;
const identity = { accountId: '123', verifiedEmails: ['user@example.com'] };
function commit() {
  return { sha, author: { id: 123 }, committer: { id: 123 }, commit: {
    author: { email: 'user@example.com' }, committer: { email: 'user@example.com' },
    verification: { verified: true, reason: 'valid', signature: 'signed', payload: 'payload' },
  } };
}
function api(value: unknown = commit(), repo: unknown = { id: 45, private: false }) {
  return vi.fn(async (path: string) => path.endsWith('/commits/' + sha) ? value : repo);
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('GitHub signed commit authorship', () => {
  it('verifies a public signed commit against both linked account ids and verified emails', async () => {
    const get = api();
    const result = await verifyGitHubCommit(url, identity, get);
    expect(result.verified).toBe(true);
    expect(result.receipt).toMatchObject({ sha, accountId: '123', repositoryId: 45, signatureVerified: true,
      signatureHash: expect.stringMatching(/^[a-f\d]{64}$/), signedPayloadHash: expect.stringMatching(/^[a-f\d]{64}$/) });
    expect(JSON.stringify(result)).not.toContain('user@example.com');
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/repos/example/repo', `/repos/example/repo/commits/${sha}`]);
  });
  it.each(['http://github.com/example/repo/commit/' + sha, url + '?x=1', url + '#diff',
    url.replace('github.com', 'github.com.evil.test'), url.replace('github.com', 'user:pass@github.com'),
    url.replace(sha, 'main'), url.replace('repo/commit', '../commit'), url.replace('github.com', '127.0.0.1'),
    url.replace('repo/commit', 'x'.repeat(101) + '/commit')])('rejects unsafe commit reference %s without API access', async value => {
    const get = api();
    expect(parseCommitReference(value)).toBeUndefined();
    expect((await verifyGitHubCommit(value, identity, get)).reason).toBe('invalid_github_commit_url');
    expect(get).not.toHaveBeenCalled();
  });
  it('does not verify missing identity, inaccessible repos or private repos', async () => {
    expect((await verifyGitHubCommit(url, null, api())).reason).toBe('verified_identity_missing');
    expect((await verifyGitHubCommit(url, identity, api(commit(), null))).reason).toBe('public_repository_not_found');
    const get = api(commit(), { id: 45, private: true });
    expect((await verifyGitHubCommit(url, identity, get)).reason).toBe('repository_not_public');
    expect(get).toHaveBeenCalledOnce();
    expect((await verifyGitHubCommit(url, identity, api(null))).reason).toBe('commit_not_found');
  });
  it.each(['author', 'committer'] as const)('rejects a mismatching %s account despite a valid signature', async field => {
    const value = commit(); value[field].id = 999;
    expect((await verifyGitHubCommit(url, identity, api(value))).reason).toBe('github_account_mismatch');
  });
  it.each(['author', 'committer'] as const)('rejects unverified %s email despite linked account ids', async field => {
    const value = commit(); value.commit[field].email = 'spoof@example.com';
    expect((await verifyGitHubCommit(url, identity, api(value))).reason).toBe('verified_email_mismatch');
  });
  it.each(['unsigned', 'invalid', 'unknown_key', 'unverified_email'])('rejects signature reason %s', async reason => {
    const value = commit(); value.commit.verification.reason = reason; value.commit.verification.verified = false;
    expect((await verifyGitHubCommit(url, identity, api(value))).reason).toBe('signature_not_verified');
  });
  it('rejects a mismatching sha and missing signature material', async () => {
    const value = commit(); value.sha = 'b'.repeat(40);
    expect((await verifyGitHubCommit(url, identity, api(value))).reason).toBe('commit_sha_mismatch');
    value.sha = sha; value.commit.verification.signature = '';
    expect((await verifyGitHubCommit(url, identity, api(value))).reason).toBe('signature_not_verified');
  });
  it('keeps malformed and temporarily unavailable provider results retryable', async () => {
    await expect(verifyGitHubCommit(url, identity, api({}))).rejects.toBeInstanceOf(RetryableError);
    await expect(verifyGitHubCommit(url, identity, api(commit(), {}))).rejects.toBeInstanceOf(RetryableError);
    const value = commit(); value.commit.verification.reason = 'gpgverify_unavailable';
    await expect(verifyGitHubCommit(url, identity, api(value))).rejects.toBeInstanceOf(RetryableError);
  });
});

describe('bounded fixed-origin GitHub transport', () => {
  it('never follows redirects or sends a token to a caller-supplied origin', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
    const request = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', request);
    expect(await githubJson('/repos/example/repo')).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith('https://api.github.com/repos/example/repo', expect.objectContaining({
      redirect: 'error', signal: expect.any(AbortSignal), headers: expect.objectContaining({ authorization: 'Bearer fixture-token' }),
    }));
  });
  it.each([429, 403])('backs off rate-limited status %s using Retry-After', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status, headers: { 'retry-after': '120', 'x-ratelimit-remaining': '0' } })));
    await expect(githubJson('/repos/example/repo')).rejects.toMatchObject({ retryAfterMs: 120000 });
  });
  it('uses rate reset, bounds excessive backoff, and treats auth/server failures as retryable', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    request.mockResolvedValueOnce(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60) } }));
    const error = await githubJson('/repos/example/repo').catch(error => error);
    expect(error).toBeInstanceOf(GitHubBackoffError);
    if (!(error instanceof GitHubBackoffError)) throw new Error('Expected rate-limit backoff');
    expect(error.retryAfterMs).toBeGreaterThan(59000);
    request.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '999999' } }));
    await expect(githubJson('/repos/example/repo')).rejects.toMatchObject({ retryAfterMs: 3600000 });
    for (const status of [401, 403, 500]) {
      request.mockResolvedValueOnce(new Response('', { status }));
      await expect(githubJson('/repos/example/repo')).rejects.toBeInstanceOf(RetryableError);
    }
    request.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await githubJson('/repos/example/repo')).toBeNull();
  });
  it('refuses an oversized response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))));
    await expect(githubJson('/repos/example/repo')).rejects.toThrow('too large');
  });
});

describe('explicit proof selection and input fingerprints', () => {
  const claim = { _id: 'claim', userId: 'user', claimText: 'Authored this commit', source: 'github', sourceUrl: url };
  it('ignores unsupported summaries and rejects ambiguous or invalid explicit proof references', () => {
    expect(evidenceProof({ ...claim, sourceUrl: 'https://github.com/example/repo' })).toBeUndefined();
    expect(evidenceProof({ ...claim, evidenceSources: [{ type: 'dsa', referenceType: 'dsa_problem', referenceId: 'bad', metadata: { platform: 'leetcode' } }] })).toMatchObject({ kind: 'invalid' });
    expect(evidenceProof({ ...claim, evidenceSources: [{ type: 'dsa', referenceType: 'dsa_problem', referenceId: '1'.repeat(24), metadata: { platform: 'leetcode' } }] })).toMatchObject({ kind: 'invalid', reason: 'multiple_proof_references' });
    expect(evidenceProof({ ...claim, evidenceSources: [{ type: 'github', referenceType: 'github_commit', referenceId: url }] })).toMatchObject({ kind: 'github_commit' });
  });
  it('binds content, owner and references, independently of metadata key order and Mongoose serialization', () => {
    const source = { type: 'github', referenceType: 'github_commit', referenceId: url, metadata: { a: 1, b: 2 } };
    const first = evidenceInputHash({ ...claim, evidenceSources: [source] });
    expect(evidenceInputHash({ ...claim, evidenceSources: [{ ...source, metadata: { b: 2, a: 1 } }] })).toBe(first);
    expect(evidenceInputHash({ ...claim, evidenceSources: [{ ...source, toJSON: () => source } as never] })).toBe(first);
    expect(evidenceInputHash({ ...claim, claimText: 'Changed prose', evidenceSources: [source] })).not.toBe(first);
    expect(evidenceInputHash({ ...claim, userId: 'other', evidenceSources: [source] })).not.toBe(first);
    expect(evidenceInputHash({ ...claim, source: undefined })).toBe(evidenceInputHash({ ...claim, source: 'user', subjectType: 'resume_claim' }));
  });
});
