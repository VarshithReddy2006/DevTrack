import type { DsaProblemPlatform } from '../../shared/dsa-platforms.js';

type ProblemIdentityInput = {
  platform: DsaProblemPlatform;
  url?: string;
  externalId?: string;
};

export function isManualProblem(externalId?: string): boolean {
  return !externalId || externalId.startsWith('manual:');
}

export function dsaProblemIdentity({ platform, url, externalId }: ProblemIdentityInput) {
  const external = externalId?.trim().toLowerCase() ?? '';
  if (
    (platform === 'leetcode' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(external)) ||
    (platform === 'codeforces' && /^\d+-[a-z]\d*$/.test(external)) ||
    (platform === 'codechef' && /^[a-z0-9_]+$/.test(external))
  ) return { platform, key: `${platform}:${external}` };

  let address: URL;
  try {
    address = new URL(url ?? '');
  } catch {
    return { platform, key: undefined };
  }
  if (address.protocol !== 'https:' && address.protocol !== 'http:') return { platform, key: undefined };

  const host = address.hostname.replace(/^www\./, '');
  const pathname = address.pathname.toLowerCase();
  const allow = (provider: DsaProblemPlatform) => platform === provider || platform === 'other';
  if (host === 'leetcode.com' && allow('leetcode')) {
    const match = /^\/problems\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/.exec(pathname);
    if (match) return { platform: 'leetcode' as const, key: `leetcode:${match[1]}` };
  }
  if (host === 'codeforces.com' && allow('codeforces')) {
    const match = /^\/(?:problemset\/problem\/(\d+)|(?:contest|gym)\/(\d+)\/problem)\/([a-z]\d*)(?:\/|$)/.exec(pathname);
    if (match) return { platform: 'codeforces' as const, key: `codeforces:${match[1] ?? match[2]}-${match[3]}` };
  }
  if (host === 'codechef.com' && allow('codechef')) {
    const match = /^\/(?:[a-z0-9_]+\/)?problems\/([a-z0-9_]+)(?:\/|$)/.exec(pathname);
    if (match) return { platform: 'codechef' as const, key: `codechef:${match[1]}` };
  }
  return { platform, key: undefined };
}
