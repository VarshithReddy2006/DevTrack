import { z } from 'zod';

export const wordCount = (value: string) => value.trim().split(/\s+/u).filter(Boolean).length;

export const postingUrlSchema = z.string().trim().max(2048, 'Use a URL of at most 2,048 characters.').refine(value => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const labels = host.split('.');
    // Job board links require a DNS hostname. Reject all IP literals, including
    // canonicalized decimal/hex IPv4, rather than maintaining a partial IP denylist.
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !host.includes(':') && !/^\d+(\.\d+){3}$/.test(host)
      && labels.length > 1 && host.length <= 253
      && labels.every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
      && !['localhost', 'local', 'internal', 'localdomain', 'lan', 'home', 'corp', 'home.arpa'].some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}, 'Enter a public HTTP or HTTPS job-board URL. Local hosts, IP addresses and credentials are not allowed.');

export const postingTextSchema = z.string().trim()
  .min(1, 'Paste the job description.')
  .max(50_000, 'Use at most 50,000 characters.')
  .refine(value => wordCount(value) >= 100, 'Include at least 100 words in the job description.');
