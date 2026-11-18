import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluateBulletEdits } from '../dist/index.js';

// Captured from main274e0fb's original backend adapter before the shared move.
const fixtures = JSON.parse(readFileSync(new URL('./bullet-score-fixtures.json', import.meta.url), 'utf8'));
for (const fixture of fixtures) {
  test(`preserves the original persisted score: ${fixture.name}`, () => {
    assert.deepEqual(evaluateBulletEdits(fixture.bullets, fixture.context), fixture.expected);
  });
}
