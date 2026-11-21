import { z } from 'zod';
import { RetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';
import { sha256, type VerificationDecision } from './evidenceProof.js';

export interface GitHubIdentity { accountId: string; verifiedEmails: string[] }
export class GitHubBackoffError extends RetryableError {
  constructor(public readonly retryAfterMs: number) { super('GitHub verification rate limited'); }
}
/** The response passed the 1 MiB limit; callers can ask for something smaller instead of retrying. */
export class GitHubResponseTooLargeError extends RetryableError {
  constructor() { super('GitHub verification API response too large'); }
}
export function parseCommitReference(raw: string): { owner: string; repo: string; sha: string } | undefined {
  try {
    if (raw.length > 2048) return;
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return;
    const match = url.pathname.match(/^\/([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d_.-]{1,100})\/commit\/([a-f\d]{40})\/?$/i);
    if (!match || ['.', '..'].includes(match[2])) return;
    return { owner: match[1], repo: match[2], sha: match[3].toLowerCase() };
  } catch { return; }
}

/** Fixed API origin, no redirects, bounded body and timeout; never fetch caller-supplied URLs. */
export async function githubJson(path: string): Promise<unknown | null> {
  const response = await fetch('https://api.github.com' + path, {
    redirect: 'error', signal: AbortSignal.timeout(10000), headers: {
      accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'user-agent': 'DevTrack-EvidenceVerifier',
      ...(process.env.GITHUB_TOKEN ? { authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}),
    },
  });
  if (response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) {
    await response.body?.cancel();
    const retry = response.headers.get('retry-after');
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : undefined;
    const until = retry ? Date.parse(retry) : Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const wait = seconds !== undefined ? seconds * 1000 : Number.isFinite(until) && until > Date.now() ? until - Date.now() : 60000;
    throw new GitHubBackoffError(Math.min(3600000, Math.max(1000, wait)));
  }
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new RetryableError('GitHub verification API unavailable'); }
  const reader = response.body?.getReader();
  if (!reader) throw new RetryableError('GitHub verification API returned no body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1024 * 1024) throw new GitHubResponseTooLargeError();
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => undefined); }
}

const account = z.object({ id: z.number().int().positive() }).nullable();
const commitSchema = z.object({
  sha: z.string(), author: account, committer: account,
  commit: z.object({ author: z.object({ email: z.string() }), committer: z.object({ email: z.string() }),
    verification: z.object({ verified: z.boolean(), reason: z.string(), signature: z.string().nullable(), payload: z.string().nullable() }) }),
});
const reject = (reason: string, receipt: Record<string, unknown> = {}): VerificationDecision => ({ verified: false, reason, receipt });

export async function verifyGitHubCommit(reference: string, identity: GitHubIdentity | null,
  getJson: (path: string) => Promise<unknown | null> = githubJson): Promise<VerificationDecision> {
  const ref = parseCommitReference(reference);
  if (!ref) return reject('invalid_github_commit_url');
  if (!identity?.accountId || !identity.verifiedEmails.length) return reject('verified_identity_missing');
  const prefix = '/repos/' + encodeURIComponent(ref.owner) + '/' + encodeURIComponent(ref.repo);
  const rawRepository = await getJson(prefix);
  if (rawRepository === null) return reject('public_repository_not_found');
  const repository = z.object({ id: z.number().int().positive(), private: z.boolean() }).safeParse(rawRepository);
  if (!repository.success) throw new RetryableError('GitHub repository verification response malformed');
  if (repository.data.private) return reject('repository_not_public');
  const raw = await getJson(prefix + '/commits/' + ref.sha);
  if (raw === null) return reject('commit_not_found');
  const parsed = commitSchema.safeParse(raw);
  if (!parsed.success) throw new RetryableError('GitHub commit verification response malformed');
  const commit = parsed.data;
  const signature = commit.commit.verification;
  const receipt = { scope: 'signed_commit_authorship', provider: 'github', repositoryId: repository.data.id,
    sha: ref.sha, accountId: identity.accountId, signatureVerified: signature.verified, signatureReason: signature.reason };
  if (commit.sha.toLowerCase() !== ref.sha) return reject('commit_sha_mismatch', receipt);
  if (['gpgverify_error', 'gpgverify_unavailable'].includes(signature.reason)) throw new RetryableError('GitHub signature verification temporarily unavailable');
  if (!signature.verified || signature.reason !== 'valid' || !signature.signature || !signature.payload) return reject('signature_not_verified', receipt);
  if (String(commit.author?.id) !== identity.accountId || String(commit.committer?.id) !== identity.accountId) return reject('github_account_mismatch', receipt);
  const emails = new Set(identity.verifiedEmails.map(email => email.trim().toLowerCase()));
  if (!emails.has(commit.commit.author.email.trim().toLowerCase()) || !emails.has(commit.commit.committer.email.trim().toLowerCase())) return reject('verified_email_mismatch', receipt);
  return { verified: true, reason: 'signed_commit_authorship_verified', receipt: { ...receipt,
    signatureHash: sha256(signature.signature), signedPayloadHash: sha256(signature.payload) } };
}
