import { describe, expect, it } from 'vitest';
import { postingTextSchema, postingUrlSchema, wordCount } from '../jobTargetValidation';

describe('posting URL validation', () => {
  it.each([
    'https://jobs.lever.co/company/role', 'http://boards.greenhouse.io/company/jobs/123',
    'https://www.linkedin.com/jobs/view/123', 'https://company.wd5.myworkdayjobs.com/jobs',
    'https://careers.example.com./role', 'https://careers.xn--bcher-kva.de/jobs',
  ])('accepts a public job-board hostname: %s', value => expect(postingUrlSchema.safeParse(value).success).toBe(true));

  it.each([
    '', 'not a URL', '//jobs.lever.co/role', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://jobs.lever.co/role',
    'https://user:password@jobs.lever.co/role', 'http://localhost/', 'http://LOCALHOST./',
    'https://jobs.localhost/', 'http://printer.local/', 'https://db.internal/', 'http://db.localdomain/',
    'https://db.lan/', 'https://router.home.arpa/', 'http://metadata/', 'https://intranet/',
    'http://127.0.0.1/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/',
    'http://169.254.169.254/', 'http://0/', 'http://2130706433/', 'http://0x7f000001/',
    'http://0177.0.0.1/', 'http://127.1/', 'http://[::1]/', 'http://[fc00::1]/',
    'http://[::ffff:127.0.0.1]/', 'https://8.8.8.8/', 'https://bad..example/',
  ])('rejects invalid, local or literal-address URLs: %s', value => expect(postingUrlSchema.safeParse(value).success).toBe(false));

  it('trims without stripping query parameters and rejects oversized input', () => {
    expect(postingUrlSchema.parse(' https://jobs.lever.co/role?team=api ')).toBe('https://jobs.lever.co/role?team=api');
    expect(postingUrlSchema.safeParse(`https://jobs.lever.co/${'a'.repeat(2048)}`).success).toBe(false);
  });
});

it('counts whitespace-separated words and enforces 100 words and 50,000 characters', () => {
  expect(wordCount(' \t one\n two   three\u00a0')).toBe(3);
  expect(wordCount(' \n ')).toBe(0);
  expect(postingTextSchema.safeParse('word '.repeat(99)).success).toBe(false);
  expect(postingTextSchema.parse(` \n${'word '.repeat(100)} `)).toBe('word '.repeat(100).trim());
  expect(postingTextSchema.safeParse('word '.repeat(10_001)).success).toBe(false);
});
