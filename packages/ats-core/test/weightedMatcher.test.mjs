import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { weightedMatcher, skillTier, DEFAULT_SKILL_WEIGHTS, extractRequirements } from '@devtrack/ats-core';

const requirement = (skill, tier) => ({ skill, tier });
const mixed = [requirement('Python', 'mandatory'), requirement('SQL', 'mandatory'),
  requirement('Docker', 'preferred'), requirement('Leadership', 'soft')];

test('uses 60/25/15 coverage with canonical matched and missing lists per tier', () => {
  assert.deepEqual(weightedMatcher(mixed, ['python3', 'docker']), {
    score: 55,
    tiers: {
      mandatory: { score: 50, matched: ['Python'], missing: ['SQL'] },
      preferred: { score: 100, matched: ['Docker'], missing: [] },
      soft: { score: 0, matched: [], missing: ['leadership'] },
    },
    matchedSkills: ['Python', 'Docker'], missingCriticalRequirements: ['SQL'],
  });
});

for (const [skills, score] of [[[], 0], [['Python', 'SQL', 'Docker', 'leadership'], 100],
  [['Python', 'SQL'], 60], [['Docker'], 25], [['leadership'], 15]]) {
  test('scores mixed-tier coverage at ' + score, () => assert.equal(weightedMatcher(mixed, skills).score, score));
}

test('caps high coverage at 75 when any mandatory requirement is missing', () => {
  const core = Array.from({ length: 10 }, (_, index) => requirement('core ' + index, 'mandatory'));
  const targets = [...core, requirement('Docker', 'preferred'), requirement('leadership', 'soft')];
  const result = weightedMatcher(targets, [...core.slice(1).map(item => item.skill), 'docker', 'leadership']);
  assert.equal(result.tiers.mandatory.score, 90);
  assert.equal(result.score, 75);
  assert.deepEqual(result.missingCriticalRequirements, ['core 0']);
});

test('supports partial custom weights, normalization and the mandatory cap with zero core weight', () => {
  assert.equal(weightedMatcher(mixed, ['Python', 'SQL'], { weights: { mandatory: 20 } }).score, 33.33);
  assert.equal(weightedMatcher(mixed, ['Docker', 'leadership'], { weights: { mandatory: 0 } }).score, 75);
  assert.equal(weightedMatcher(mixed, ['Python', 'SQL', 'Docker', 'leadership'], { weights: { soft: 0 } }).score, 100);
  assert.equal(weightedMatcher(mixed, ['Python', 'SQL'], {
    weights: { mandatory: 6, preferred: 2.5, soft: 1.5 },
  }).score, 60);
});

test('handles empty criteria and redistributes absent tiers without free points', () => {
  assert.deepEqual(weightedMatcher([], ['Python']), {
    score: 0, tiers: {
      mandatory: { score: null, matched: [], missing: [] },
      preferred: { score: null, matched: [], missing: [] },
      soft: { score: null, matched: [], missing: [] },
    }, matchedSkills: [], missingCriticalRequirements: [],
  });
  assert.equal(weightedMatcher([requirement('Docker', 'preferred')], ['Docker']).score, 100);
  assert.equal(weightedMatcher([requirement('Python', 'mandatory')], ['Python']).score, 100);
  assert.equal(weightedMatcher([requirement('leadership', 'soft')], ['leadership']).score, 100);
  assert.equal(weightedMatcher([requirement('Python', 'mandatory')], ['Python'], { weights: { mandatory: 0 } }).score, 0);
});

test('normalizes aliases, Unicode and whitespace; deduplicates in the strictest tier', () => {
  const targets = [requirement('psql', 'preferred'), requirement('Postgres', 'mandatory'),
    requirement('PostgreSQL', 'soft'), requirement('Code   Review', 'soft'), requirement(' ', 'mandatory')];
  const available = ['ＰＳＱＬ', 'psql', ' code review ', 'irrelevant', ''];
  const report = weightedMatcher(targets, available);
  assert.equal(report.score, 100);
  assert.deepEqual(report.matchedSkills, ['PostgreSQL', 'code review']);
  assert.equal(report.tiers.preferred.score, null);
  assert.deepEqual(weightedMatcher([...targets].reverse(), [...available].reverse()), report);
});

test('matches entire terms rather than substrings', () => {
  const result = weightedMatcher(['Java', 'C++', 'C#', '.NET'].map(skill => requirement(skill, 'mandatory')),
    ['JavaScript', 'C', 'dotnet']);
  assert.deepEqual(result.tiers.mandatory.matched, ['.NET']);
  assert.deepEqual(result.missingCriticalRequirements, ['C#', 'C++', 'Java']);
  assert.equal(result.score, 25);
});

test('infers default taxonomy tiers and allows explicit job priority to override them', () => {
  for (const skill of ['Python', 'Postgres', 'distributed system']) assert.equal(skillTier(skill), 'mandatory');
  for (const skill of ['Docker', 'React', 'K8s', 'unknown tool']) assert.equal(skillTier(skill), 'preferred');
  for (const skill of ['Agile', 'Code Review', 'mentorship', 'Leadership']) assert.equal(skillTier(skill), 'soft');
  assert.equal(weightedMatcher([{ skill: 'python3' }], ['Python']).score, 100);
  assert.equal(weightedMatcher([requirement('Python', 'preferred')], []).tiers.mandatory.score, null);
});

test('scores a parsed backend job with caller-supplied mandatory and preferred priorities', () => {
  const jd = extractRequirements('Requirements: Python and PostgreSQL.\nPreferred: Docker and React.');
  const targets = jd.skills.map(item => ({ skill: item.skill,
    tier: item.contexts.some(context => context.priority === 'required') ? 'mandatory' : 'preferred' }));
  targets.push(requirement('mentorship', 'soft'));
  assert.equal(weightedMatcher(targets, ['python', 'psql', 'Docker', 'mentorship']).score, 87.5);
});

for (const bad of [-1, NaN, Infinity, -Infinity, undefined]) {
  test('rejects invalid weight ' + String(bad), () => {
    assert.throws(() => weightedMatcher(mixed, [], { weights: { soft: bad } }), RangeError);
  });
}
test('rejects all-zero weights and invalid runtime tiers', () => {
  assert.throws(() => weightedMatcher([], [], { weights: { mandatory: 0, preferred: 0, soft: 0 } }), RangeError);
  assert.throws(() => weightedMatcher([requirement('Python', 'invalid')], []), RangeError);
});

test('avoids overflow with very large weights', () => {
  assert.equal(weightedMatcher(mixed, ['Docker', 'leadership'], {
    weights: { mandatory: Number.MAX_VALUE, preferred: Number.MAX_VALUE, soft: Number.MAX_VALUE },
  }).score, 66.67);
  assert.equal(weightedMatcher([requirement('Python', 'mandatory')], ['Python'], {
    weights: { mandatory: Number.MIN_VALUE, preferred: Number.MAX_VALUE },
  }).score, 100);
});

test('all candidate subsets obey the formula and never lose score by adding a match', () => {
  for (let mask = 0; mask < 16; mask++) {
    const skills = mixed.filter((_, index) => mask & (1 << index)).map(item => item.skill);
    const core = Number(Boolean(mask & 1)) + Number(Boolean(mask & 2));
    const expected = Math.min(core < 2 ? 75 : 100,
      30 * core + (mask & 4 ? 25 : 0) + (mask & 8 ? 15 : 0));
    const result = weightedMatcher(mixed, skills);
    assert.equal(result.score, expected);
    for (const target of mixed) {
      assert.ok(weightedMatcher(mixed, [...skills, target.skill]).score >= result.score);
    }
  }
});

test('rounds the final score from unrounded coverage', () => {
  const targets = [...['a', 'b', 'c'].map(skill => requirement(skill, 'mandatory')),
    ...['d', 'e', 'f'].map(skill => requirement(skill, 'preferred')), requirement('g', 'soft')];
  const result = weightedMatcher(targets, ['a', 'd', 'g']);
  assert.equal(result.score, 43.33);
  assert.equal(result.tiers.mandatory.score, 33.33);
});

test('does not mutate inputs or exported defaults and returns independent result lists', () => {
  const targets = Object.freeze(mixed.map(item => Object.freeze({ ...item })));
  const skills = Object.freeze(['Python']);
  const options = Object.freeze({ weights: Object.freeze({ soft: 10 }) });
  const before = JSON.stringify({ targets, skills, options });
  const result = weightedMatcher(targets, skills, options);
  result.missingCriticalRequirements.push('fake');
  result.matchedSkills.push('fake');
  assert.deepEqual(result.tiers.mandatory.matched, ['Python']);
  assert.deepEqual(result.tiers.mandatory.missing, ['SQL']);
  assert.equal(JSON.stringify({ targets, skills, options }), before);
  assert.throws(() => { DEFAULT_SKILL_WEIGHTS.mandatory = 0; }, TypeError);
});

test('matches Node results in a browser bundle without Node runtime dependencies', async () => {
  const { outputFiles } = await build({ entryPoints: ['dist/index.js'], platform: 'browser',
    bundle: true, format: 'iife', globalName: 'atsCore', write: false });
  const browser = runInNewContext(outputFiles[0].text + '\natsCore');
  for (const skills of [[], ['python3'], ['Python', 'SQL', 'Docker', 'Leadership']]) {
    assert.equal(JSON.stringify(browser.weightedMatcher(mixed, skills)), JSON.stringify(weightedMatcher(mixed, skills)));
  }
});
