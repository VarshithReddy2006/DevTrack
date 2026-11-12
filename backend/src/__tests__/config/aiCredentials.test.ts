import { describe, expect, it } from 'vitest';
import { aiCredentialAction, isLocalOrigin } from '../../config/aiCredentials.js';

const base = { isProd: true, corsOrigin: 'https://app.example.com', hasOpenAi: false, hasGemini: false };

describe('aiCredentialAction', () => {
  it('is ok whenever a key exists', () => {
    expect(aiCredentialAction({ ...base, hasOpenAi: true })).toBe('ok');
    expect(aiCredentialAction({ ...base, hasGemini: true })).toBe('ok');
  });

  it('stops a real cloud production deploy with no key', () => {
    expect(aiCredentialAction(base)).toBe('exit');
  });

  it.each(['http://localhost', 'http://localhost:80', 'http://localhost:4000', 'http://127.0.0.1:8080'])(
    'only warns for a local production simulation at %s',
    (corsOrigin) => {
      expect(aiCredentialAction({ ...base, corsOrigin })).toBe('warn');
    },
  );

  it('only warns outside production', () => {
    expect(aiCredentialAction({ ...base, isProd: false })).toBe('warn');
  });
});

describe('isLocalOrigin', () => {
  it('does not treat a lookalike host as local', () => {
    expect(isLocalOrigin('http://localhost.evil.com')).toBe(false);
    expect(isLocalOrigin('https://localhost')).toBe(false);
  });
});
