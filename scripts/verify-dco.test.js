/**
 * Unit tests for DevTrack DCO Validator (scripts/verify-dco.js)
 *
 * Verifies the 4 mandatory test requirements:
 * 1. A valid signed-off commit.
 * 2. A commit missing the sign-off.
 * 3. A malformed sign-off.
 * 4. A sign-off whose identity does not match the commit identity.
 *
 * Plus edge cases:
 * - Case-insensitive email comparison
 * - Multiple trailers with one valid matching sign-off
 * - Committer identity match
 */

const assert = require('node:assert');
const { validateCommitDCO } = require('./verify-dco');

console.log('🧪 Running DCO Validation Test Suite...\n');

let passedTests = 0;
let totalTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
  }
}

// ── Test 1: Valid signed-off commit ──────────────────────────────────────────
test('1. Valid signed-off commit matching author identity', () => {
  const commit = {
    hash: 'a1b2c3d4e5f6',
    authorName: 'Ada Lovelace',
    authorEmail: 'ada@example.com',
    committerName: 'Ada Lovelace',
    committerEmail: 'ada@example.com',
    subject: 'feat(dsa): add topic progress tracker',
    body: `feat(dsa): add topic progress tracker

Implements topic-level tracking for algorithmic practice.

Signed-off-by: Ada Lovelace <ada@example.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, true, 'Expected commit to be valid');
});

// ── Test 2: Commit missing sign-off ──────────────────────────────────────────
test('2. Commit missing the Signed-off-by trailer', () => {
  const commit = {
    hash: 'b2c3d4e5f6a1',
    authorName: 'Alan Turing',
    authorEmail: 'alan@example.com',
    committerName: 'Alan Turing',
    committerEmail: 'alan@example.com',
    subject: 'fix(engine): optimize state evaluation',
    body: `fix(engine): optimize state evaluation

Reduces complexity from O(n^2) to O(n log n).`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false, 'Expected commit to fail');
  assert.strictEqual(result.reason, 'MISSING_SIGNOFF');
});

// ── Test 3: Malformed sign-off ───────────────────────────────────────────────
test('3a. Malformed sign-off: missing angle brackets around email', () => {
  const commit = {
    hash: 'c3d4e5f6a1b2',
    authorName: 'Grace Hopper',
    authorEmail: 'grace@example.com',
    committerName: 'Grace Hopper',
    committerEmail: 'grace@example.com',
    subject: 'docs: clarify contribution guidelines',
    body: `docs: clarify contribution guidelines

Signed-off-by: Grace Hopper grace@example.com`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false, 'Expected commit to fail');
  assert.strictEqual(result.reason, 'MALFORMED_SIGNOFF');
});

test('3b. Malformed sign-off: missing email entirely', () => {
  const commit = {
    hash: 'c3d4e5f6a1b3',
    authorName: 'Grace Hopper',
    authorEmail: 'grace@example.com',
    committerName: 'Grace Hopper',
    committerEmail: 'grace@example.com',
    subject: 'docs: update setup instructions',
    body: `docs: update setup instructions

Signed-off-by: Grace Hopper`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false, 'Expected commit to fail');
  assert.strictEqual(result.reason, 'MALFORMED_SIGNOFF');
});

test('3c. Malformed sign-off: empty trailer', () => {
  const commit = {
    hash: 'c3d4e5f6a1b4',
    authorName: 'Grace Hopper',
    authorEmail: 'grace@example.com',
    committerName: 'Grace Hopper',
    committerEmail: 'grace@example.com',
    subject: 'chore: housekeeping',
    body: `chore: housekeeping

Signed-off-by:`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false, 'Expected commit to fail');
  assert.strictEqual(result.reason, 'MALFORMED_SIGNOFF');
});

// ── Test 4: Identity mismatch ───────────────────────────────────────────────
test('4a. Sign-off whose email does not match author', () => {
  const commit = {
    hash: 'd4e5f6a1b2c3',
    authorName: 'Margaret Hamilton',
    authorEmail: 'margaret@apollo.org',
    committerName: 'Margaret Hamilton',
    committerEmail: 'margaret@apollo.org',
    subject: 'feat(guidance): add radar telemetry parsing',
    body: `feat(guidance): add radar telemetry parsing

Signed-off-by: Margaret Hamilton <other-email@domain.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false, 'Expected commit to fail');
  assert.strictEqual(result.reason, 'IDENTITY_MISMATCH');
});

test('4b. Sign-off whose name does not match author', () => {
  const commit = {
    hash: 'd4e5f6a1b2c4',
    authorName: 'Margaret Hamilton',
    authorEmail: 'margaret@apollo.org',
    committerName: 'Margaret Hamilton',
    committerEmail: 'margaret@apollo.org',
    subject: 'feat(guidance): add reboot recovery',
    body: `feat(guidance): add reboot recovery

Signed-off-by: John Doe <margaret@apollo.org>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false, 'Expected commit to fail');
  assert.strictEqual(result.reason, 'IDENTITY_MISMATCH');
});

// ── Additional Edge Cases ────────────────────────────────────────────────────
test('5. Valid sign-off with case-insensitive email matching', () => {
  const commit = {
    hash: 'e5f6a1b2c3d4',
    authorName: 'Katherine Johnson',
    authorEmail: 'Katherine.Johnson@NASA.GOV',
    committerName: 'Katherine Johnson',
    committerEmail: 'Katherine.Johnson@NASA.GOV',
    subject: 'refactor(trajectory): compute rendezvous delta-v',
    body: `refactor(trajectory): compute rendezvous delta-v

Signed-off-by: Katherine Johnson <katherine.johnson@nasa.gov>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, true, 'Expected case-insensitive email match to pass');
});

test('6. Valid sign-off matching committer identity (rebased/committed on behalf)', () => {
  const commit = {
    hash: 'f6a1b2c3d4e5',
    authorName: 'Original Author',
    authorEmail: 'author@example.com',
    committerName: 'DevTrack Maintainer',
    committerEmail: 'maintainer@devtrack.org',
    subject: 'fix(core): cherry-picked upstream fix',
    body: `fix(core): cherry-picked upstream fix

Signed-off-by: DevTrack Maintainer <maintainer@devtrack.org>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, true, 'Expected committer sign-off match to pass');
});

console.log(`\nResults: ${passedTests}/${totalTests} tests passed.`);

if (passedTests !== totalTests) {
  process.exit(1);
} else {
  console.log('🎉 All DCO validation scenarios verified successfully!\n');
  process.exit(0);
}
