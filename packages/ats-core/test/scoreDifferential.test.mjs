import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { checkKeywordCoverage, escapeRegExp, MAX_KEYWORD_COUNT, MAX_KEYWORD_LENGTH, sanitizeKeywords, scoreDifferential } from '@devtrack/ats-core';

const good = 'Built reliable Node.js services handling requests for customers across multiple regions';
const compare = (originalBullets, revisedBullets, targetKeywords = []) => scoreDifferential({ originalBullets, revisedBullets, targetKeywords });

test('context-free coverage preserves shared keyword frequencies and boundaries', () => {
  const text = 'Node.js services. Improved Node.js APIs and C++ code.';
  const full = checkKeywordCoverage(text, ['Node.js', 'C++', 'Java']);
  assert.deepEqual(checkKeywordCoverage(text, ['Node.js', 'C++', 'Java'], { includeContext: false }), full.map(item => ({ ...item, context: [] })));
  assert.ok(full[1].context.length > 0);
});

test('empty and whitespace-only bullet lists score zero', () => {
  assert.deepEqual(compare([], [' ', '\n'], ['Node.js']), {
    originalScore: 0, revisedScore: 0, delta: 0, keywordChanges: { added: [], removed: [] },
    brevityScore: 0, originalBrevityScore: 0,
  });
});

test('adding and deleting bullets produces signed, reversible deltas', () => {
  const addition = compare([], [good], ['Node.js']);
  const deletion = compare([good], [], ['Node.js']);
  assert.ok(addition.delta > 0);
  assert.equal(deletion.delta, -addition.delta);
  assert.deepEqual(addition.keywordChanges.added, ['Node.js']);
  assert.deepEqual(deletion.keywordChanges.removed, ['Node.js']);
});

test('keywords use case-insensitive literal word boundaries and stable deduplication', () => {
  const result = compare(['Built JavaScript applications'], ['Built Java applications with C++ and .NET services'], ['Java', ' C++ ', 'c++', '.NET']);
  assert.deepEqual(result.keywordChanges, { added: ['Java', 'C++', '.NET'], removed: [] });
  assert.deepEqual(compare(['C# services'], ['C++ services'], ['C#', 'C++']).keywordChanges, { added: ['C++'], removed: ['C#'] });
});

test('adding a target keyword improves otherwise equivalent bullets', () => {
  const result = compare(['Built reliable services handling requests for customers across multiple regions'], [good], ['Node.js']);
  assert.ok(result.delta > 0);
  assert.equal(result.brevityScore, 100);
});

test('repeated keyword stuffing is penalized without manufacturing new coverage', () => {
  const result = compare([good], [`${good} Node.js Node.js Node.js Node.js Node.js`], ['Node.js', 'node.js']);
  assert.ok(result.delta < 0);
  assert.deepEqual(result.keywordChanges, { added: [], removed: [] });
});

test('brevity penalizes short bullets, long bullets, and explicit fluff phrases', () => {
  assert.ok(compare([good], ['Built APIs']).brevityScore < 100);
  assert.ok(compare([good], [Array(60).fill('word').join(' ')]).brevityScore < 100);
  const result = compare([good], [`Really successfully ${good}`]);
  assert.ok(result.brevityScore < result.originalBrevityScore);
  assert.ok(result.delta < 0);
});

test('the utility is deterministic and does not mutate frozen input', () => {
  const input = Object.freeze({ originalBullets: Object.freeze([good]), revisedBullets: Object.freeze([good]), targetKeywords: Object.freeze(['Node.js', 'node.js', ' ']) });
  assert.deepEqual(scoreDifferential(input), scoreDifferential(input));
  assert.equal(scoreDifferential(input).delta, 0);
  assert.deepEqual(input.targetKeywords, ['Node.js', 'node.js', ' ']);
});

test('scores and brevity stay integer-bounded even for extreme stuffing', () => {
  for (const revised of [[], [good], ['Node.js '.repeat(1000)], ['very '.repeat(1000)]]) {
    const result = compare([good], revised, ['Node.js']);
    for (const field of ['originalScore', 'revisedScore', 'brevityScore', 'originalBrevityScore']) {
      assert.ok(Number.isInteger(result[field]) && result[field] >= 0 && result[field] <= 100);
    }
    assert.equal(result.delta, result.revisedScore - result.originalScore);
  }
});

test('a browser bundle computes identical differential results', async () => {
  const { outputFiles } = await build({ entryPoints: ['dist/index.js'], platform: 'browser', bundle: true, format: 'iife', globalName: 'atsCore', write: false });
  const browser = runInNewContext(outputFiles[0].text + '\natsCore');
  const input = { originalBullets: [good], revisedBullets: ['Built C++ services with .NET handling requests for customers'], targetKeywords: ['Node.js', '.NET', 'C++'] };
  assert.equal(JSON.stringify(browser.scoreDifferential(input)), JSON.stringify(scoreDifferential(input)));
});

test('keyword sanitization enforces 64-char and 100-keyword bounds and prevents ReDoS', () => {
  assert.equal(escapeRegExp('C++ .* (a+)+'), 'C\\+\\+ \\.\\* \\(a\\+\\)\\+');
  const longSkill = 'x'.repeat(MAX_KEYWORD_LENGTH + 1);
  const raw = ['Node.js', longSkill, '  ', ...Array.from({ length: 120 }, (_, i) => `kw-${i}`)];
  const sanitized = sanitizeKeywords(raw);
  assert.equal(sanitized.length, MAX_KEYWORD_COUNT);
  assert.ok(!sanitized.includes(longSkill));

  const evilBullet = `${'a'.repeat(950)}!`;
  const evilKeywords = ['(a+)+$', '([a-z]+)*$', '.*', longSkill, ...Array.from({ length: 120 }, (_, i) => `(a+)+${i}`)];
  scoreDifferential({ originalBullets: [evilBullet], revisedBullets: [`${evilBullet} Node.js`], targetKeywords: evilKeywords });
  const start = performance.now();
  const res = scoreDifferential({ originalBullets: [evilBullet], revisedBullets: [`${evilBullet} Node.js`], targetKeywords: evilKeywords });
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5, `Expected < 5ms, got ${elapsed}ms`);
  assert.deepEqual(res.keywordChanges, { added: [], removed: [] });
});
