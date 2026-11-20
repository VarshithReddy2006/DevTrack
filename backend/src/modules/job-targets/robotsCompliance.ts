// src/modules/job-targets/robotsCompliance.ts — robots.txt rules and per-domain crawl spacing for job URL fetches.
//
// Parsing and matching follow RFC 9309: the most specific user-agent group wins, the longest matching
// path rule wins, Allow beats Disallow on a tie, and `*` / `$` work in paths. Fetching robots.txt and
// the actual page request are injected, so this module has no network or Redis dependency of its own.
// Cache and spacing state live in memory per instance; a shared store can replace the two small maps later.

export const BOT_NAME = 'DevTrackBot';
export const BOT_USER_AGENT = 'DevTrackBot/2.0 (+https://devtrack.sh/bot)';
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_CRAWL_DELAY_MS = 1000;
/** Upper bound so a hostile `Crawl-delay: 99999` cannot park a worker for hours. */
export const MAX_CRAWL_DELAY_MS = 30_000;

export interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
  crawlDelaySec?: number;
}

export interface RobotsRules {
  groups: RobotsGroup[];
}

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow means "allow everything" and adds no rule.
      if (value) current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
    }
  }
  return { groups };
}

/** Picks the group for our bot: an exact product-token match beats `*`. Merges groups naming the same agent. */
function groupFor(rules: RobotsRules, botName: string): RobotsGroup | null {
  const name = botName.toLowerCase();
  const named = rules.groups.filter((g) => g.agents.some((a) => a !== '*' && name.startsWith(a)));
  const pick = named.length ? named : rules.groups.filter((g) => g.agents.includes('*'));
  if (!pick.length) return null;
  const merged: RobotsGroup = { agents: [], rules: [] };
  for (const g of pick) {
    merged.agents.push(...g.agents);
    merged.rules.push(...g.rules);
    if (g.crawlDelaySec !== undefined) merged.crawlDelaySec = g.crawlDelaySec;
  }
  return merged;
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export function isAllowed(rules: RobotsRules, pathAndQuery: string, botName = BOT_NAME): boolean {
  const group = groupFor(rules, botName);
  if (!group) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    if (!patternToRegExp(r.path).test(pathAndQuery)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}

/** Crawl delay in ms: the site's value when given, never below the 1 s floor or above the cap. */
export function crawlDelayMs(rules: RobotsRules | null, botName = BOT_NAME): number {
  const sec = rules ? groupFor(rules, botName)?.crawlDelaySec : undefined;
  const ms = sec === undefined ? MIN_CRAWL_DELAY_MS : sec * 1000;
  return Math.min(MAX_CRAWL_DELAY_MS, Math.max(MIN_CRAWL_DELAY_MS, ms));
}

export class RobotsDisallowedError extends Error {
  readonly code = 'robots_disallowed';
  readonly statusCode = 422;
  constructor(public readonly url: string) {
    super('This site does not allow automated fetching of that page. Paste the job text instead.');
    this.name = 'RobotsDisallowedError';
  }
}

export interface RobotsResponse {
  status: number;
  body: string;
}

export interface RobotsDeps {
  /** Fetch https://host/robots.txt. Should throw on network failure. */
  fetchRobots: (origin: string) => Promise<RobotsResponse>;
  now?: () => number;
}

interface CacheEntry {
  rules: RobotsRules | 'allow_all' | 'disallow_all';
  expiresAt: number;
}

export interface CheckResult {
  /** Milliseconds the caller must wait before requesting, so one host is never hit faster than its delay. */
  waitMs: number;
  userAgent: string;
}

export class RobotsCompliance {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly nextSlot = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: RobotsDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async load(origin: string): Promise<CacheEntry['rules']> {
    const hit = this.cache.get(origin);
    if (hit && hit.expiresAt > this.now()) return hit.rules;

    let rules: CacheEntry['rules'];
    try {
      const res = await this.deps.fetchRobots(origin);
      if (res.status >= 200 && res.status < 300) rules = parseRobots(res.body);
      else if (res.status >= 400 && res.status < 500) rules = 'allow_all'; // no robots.txt: nothing is restricted
      else rules = 'disallow_all'; // 5xx: the site is unreachable or unwell, so do not crawl
    } catch {
      rules = 'disallow_all';
    }
    this.cache.set(origin, { rules, expiresAt: this.now() + ROBOTS_CACHE_TTL_MS });
    return rules;
  }

  /**
   * Throws RobotsDisallowedError when the URL is off limits. Otherwise reserves the next slot for the host
   * and returns how long to wait before sending the request.
   */
  async check(rawUrl: string): Promise<CheckResult> {
    const url = new URL(rawUrl);
    const origin = url.origin;
    const rules = await this.load(origin);

    if (rules === 'disallow_all') throw new RobotsDisallowedError(rawUrl);
    if (rules !== 'allow_all' && !isAllowed(rules, url.pathname + url.search)) throw new RobotsDisallowedError(rawUrl);

    const delay = crawlDelayMs(rules === 'allow_all' ? null : rules);
    const now = this.now();
    const slot = Math.max(now, this.nextSlot.get(url.host) ?? 0);
    this.nextSlot.set(url.host, slot + delay);
    return { waitMs: slot - now, userAgent: BOT_USER_AGENT };
  }
}
