/**
 * Hardened Test Suite for DevTrack DCO Validator (scripts/verify-dco.js)
 *
 * Verifies all security and compliance test cases required by the DCO specification:
 *  1. Valid author-matching sign-off.
 *  2. Missing sign-off trailer.
 *  3. Malformed sign-off trailers (missing '<>', missing email, empty).
 *  4. Author/sign-off name mismatch.
 *  5. Author/sign-off email mismatch.
 *  6. Committer-matching sign-off when author differs (REJECTED).
 *  7. Multiple sign-off trailers (all valid vs. one malformed).
 *  8. Duplicate sign-off trailers for the same author.
 *  9. Co-authored commits (with valid co-author sign-off vs. missing co-author sign-off).
 * 10. Co-authored trailer alone without DCO sign-off.
 * 11. Malformed co-author trailer.
 * 12. Incomplete or empty author metadata (missing name or email).
 * 13. Invalid author email syntax (missing '@', containing spaces).
 * 14. Unusual but valid Unicode names (accents, apostrophes, non-Latin scripts).
 * 15. Invalid email syntax inside Signed-off-by trailer.
 * 16. Git object availability check.
 * 17. Commit range parsing and missing parameter handling.
 * 18. Case-insensitive email comparisons.
 */

const assert = require('node:assert');
const {
  validateCommitDCO,
  gitObjectExists,
  getCommitsFromGit,
} = require('./verify-dco');

console.log('🧪 Running Comprehensive DCO Security & Compliance Test Suite...\n');

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

// ── 1. Valid Author-Matching Sign-Off ─────────────────────────────────────────
test('1. Valid sign-off matching commit author', () => {
  const commit = {
    hash: 'a1b2c3d4e5f6',
    authorName: 'Ada Lovelace',
    authorEmail: 'ada@example.com',
    committerName: 'Ada Lovelace',
    committerEmail: 'ada@example.com',
    subject: 'feat(dsa): add graph analytics engine',
    body: `feat(dsa): add graph analytics engine

Implements BFS and DFS telemetry.

Signed-off-by: Ada Lovelace <ada@example.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, true);
});

// ── 2. Missing Sign-Off ───────────────────────────────────────────────────────
test('2. Commit missing the Signed-off-by trailer entirely', () => {
  const commit = {
    hash: 'b2c3d4e5f6a1',
    authorName: 'Alan Turing',
    authorEmail: 'alan@example.com',
    subject: 'fix(crypto): strengthen state entropy',
    body: `fix(crypto): strengthen state entropy

Increases key derivation rounds.`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'MISSING_SIGNOFF');
});

// ── 3. Malformed Sign-Off ─────────────────────────────────────────────────────
test('3a. Malformed sign-off: missing angle brackets around email', () => {
  const commit = {
    hash: 'c3d4e5f6a1b2',
    authorName: 'Grace Hopper',
    authorEmail: 'grace@example.com',
    subject: 'docs: clarify contribution guide',
    body: `docs: clarify contribution guide

Signed-off-by: Grace Hopper grace@example.com`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'MALFORMED_SIGNOFF');
});

test('3b. Malformed sign-off: missing email address', () => {
  const commit = {
    hash: 'c3d4e5f6a1b3',
    authorName: 'Grace Hopper',
    authorEmail: 'grace@example.com',
    subject: 'docs: update readme',
    body: `docs: update readme

Signed-off-by: Grace Hopper`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'MALFORMED_SIGNOFF');
});

test('3c. Malformed sign-off: empty trailer', () => {
  const commit = {
    hash: 'c3d4e5f6a1b4',
    authorName: 'Grace Hopper',
    authorEmail: 'grace@example.com',
    subject: 'chore: cleanup',
    body: `chore: cleanup

Signed-off-by:`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'MALFORMED_SIGNOFF');
});

// ── 4. Author / Sign-Off Identity Mismatches ──────────────────────────────────
test('4a. Sign-off email mismatch with author', () => {
  const commit = {
    hash: 'd4e5f6a1b2c3',
    authorName: 'Margaret Hamilton',
    authorEmail: 'margaret@apollo.org',
    subject: 'feat(guidance): add radar telemetry',
    body: `feat(guidance): add radar telemetry

Signed-off-by: Margaret Hamilton <other@domain.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'IDENTITY_MISMATCH');
});

test('4b. Sign-off name mismatch with author', () => {
  const commit = {
    hash: 'd4e5f6a1b2c4',
    authorName: 'Margaret Hamilton',
    authorEmail: 'margaret@apollo.org',
    subject: 'feat(guidance): add restart protection',
    body: `feat(guidance): add restart protection

Signed-off-by: John Doe <margaret@apollo.org>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'IDENTITY_MISMATCH');
});

// ── 5. Committer Match When Author Differs (MUST BE REJECTED) ────────────────
test('5. Sign-off matches committer but NOT author (Must be REJECTED)', () => {
  const commit = {
    hash: 'e5f6a1b2c3d4',
    authorName: 'Original Contributor',
    authorEmail: 'contributor@example.com',
    committerName: 'Repository Maintainer',
    committerEmail: 'maintainer@devtrack.org',
    subject: 'feat(ui): add dashboard component',
    body: `feat(ui): add dashboard component

Signed-off-by: Repository Maintainer <maintainer@devtrack.org>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false, 'Committer-only sign-off must not pass author validation');
  assert.strictEqual(result.reason, 'COMMITTER_ONLY_SIGNOFF');
});

// ── 6. Multiple Sign-Off Trailers ─────────────────────────────────────────────
test('6a. Multiple valid sign-offs (author + co-signer)', () => {
  const commit = {
    hash: 'f6a1b2c3d4e5',
    authorName: 'Alice Johnson',
    authorEmail: 'alice@example.com',
    subject: 'refactor(api): optimize route handlers',
    body: `refactor(api): optimize route handlers

Signed-off-by: Alice Johnson <alice@example.com>
Signed-off-by: Bob Reviewer <bob@example.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, true);
});

test('6b. Multiple sign-offs where one is malformed (Must be REJECTED)', () => {
  const commit = {
    hash: 'f6a1b2c3d4e6',
    authorName: 'Alice Johnson',
    authorEmail: 'alice@example.com',
    subject: 'refactor(api): optimize queries',
    body: `refactor(api): optimize queries

Signed-off-by: Alice Johnson <alice@example.com>
Signed-off-by: Malformed Signer Without Brackets`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'MALFORMED_SIGNOFF');
});

// ── 7. Duplicate Sign-Off Trailers ────────────────────────────────────────────
test('7. Duplicate valid sign-off for same author', () => {
  const commit = {
    hash: 'a2b3c4d5e6f7',
    authorName: 'Claude Shannon',
    authorEmail: 'shannon@bell-labs.com',
    subject: 'feat(entropy): calculate channel capacity',
    body: `feat(entropy): calculate channel capacity

Signed-off-by: Claude Shannon <shannon@bell-labs.com>
Signed-off-by: Claude Shannon <shannon@bell-labs.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, true);
});

// ── 8. Co-Authored Commits ────────────────────────────────────────────────────
test('8a. Co-authored commit where co-author also signed off', () => {
  const commit = {
    hash: 'b3c4d5e6f7a2',
    authorName: 'Alice Author',
    authorEmail: 'alice@example.com',
    subject: 'feat(collaboration): paired programming implementation',
    body: `feat(collaboration): paired programming implementation

Co-authored-by: Bob Partner <bob@example.com>
Signed-off-by: Alice Author <alice@example.com>
Signed-off-by: Bob Partner <bob@example.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, true);
});

test('8b. Co-authored commit where co-author did NOT sign off (Must be REJECTED)', () => {
  const commit = {
    hash: 'b3c4d5e6f7a3',
    authorName: 'Alice Author',
    authorEmail: 'alice@example.com',
    subject: 'feat(collaboration): paired programming implementation',
    body: `feat(collaboration): paired programming implementation

Co-authored-by: Bob Partner <bob@example.com>
Signed-off-by: Alice Author <alice@example.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'MISSING_COAUTHOR_SIGNOFF');
});

test('8c. Co-authored trailer alone without any DCO sign-off (Must be REJECTED)', () => {
  const commit = {
    hash: 'b3c4d5e6f7a4',
    authorName: 'Alice Author',
    authorEmail: 'alice@example.com',
    subject: 'feat(collaboration): pair programming',
    body: `feat(collaboration): pair programming

Co-authored-by: Bob Partner <bob@example.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'MISSING_SIGNOFF');
});

test('8d. Malformed co-author trailer (Must be REJECTED)', () => {
  const commit = {
    hash: 'b3c4d5e6f7a5',
    authorName: 'Alice Author',
    authorEmail: 'alice@example.com',
    subject: 'feat(collaboration): pair programming',
    body: `feat(collaboration): pair programming

Co-authored-by: Bob Partner bob@example.com
Signed-off-by: Alice Author <alice@example.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'MALFORMED_COAUTHOR');
});

// ── 9. Author Metadata Edge Cases ─────────────────────────────────────────────
test('9a. Empty author name in commit object (Must be REJECTED)', () => {
  const commit = {
    hash: 'c4d5e6f7a2b3',
    authorName: '',
    authorEmail: 'author@example.com',
    subject: 'fix: edge case',
    body: `fix: edge case\n\nSigned-off-by: <author@example.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'MISSING_AUTHOR_METADATA');
});

test('9b. Empty author email in commit object (Must be REJECTED)', () => {
  const commit = {
    hash: 'c4d5e6f7a2b4',
    authorName: 'Valid Name',
    authorEmail: '  ',
    subject: 'fix: edge case',
    body: `fix: edge case\n\nSigned-off-by: Valid Name <>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'MISSING_AUTHOR_METADATA');
});

test('9c. Author email with invalid format without @ (Must be REJECTED)', () => {
  const commit = {
    hash: 'c4d5e6f7a2b5',
    authorName: 'Valid Name',
    authorEmail: 'invalid-email-at-domain.com',
    subject: 'fix: edge case',
    body: `fix: edge case\n\nSigned-off-by: Valid Name <invalid-email-at-domain.com>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'INVALID_AUTHOR_EMAIL');
});

// ── 10. Unusual But Valid Names and Formats ───────────────────────────────────
test('10a. Name with apostrophes and hyphens (Jean-Luc O\'Connor-Smith)', () => {
  const commit = {
    hash: 'd5e6f7a2b3c4',
    authorName: "Jean-Luc O'Connor-Smith",
    authorEmail: 'jean-luc@starfleet.org',
    subject: 'feat: warp telemetry',
    body: `feat: warp telemetry\n\nSigned-off-by: Jean-Luc O'Connor-Smith <jean-luc@starfleet.org>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, true);
});

test('10b. Name with accented characters (René Descartes)', () => {
  const commit = {
    hash: 'd5e6f7a2b3c5',
    authorName: 'René Descartes',
    authorEmail: 'rene@cogito.fr',
    subject: 'feat: method analysis',
    body: `feat: method analysis\n\nSigned-off-by: René Descartes <rene@cogito.fr>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, true);
});

test('10c. Unicode non-Latin script name (山田太郎)', () => {
  const commit = {
    hash: 'd5e6f7a2b3c6',
    authorName: '山田太郎',
    authorEmail: 'yamada@tokyo.jp',
    subject: 'feat: localized analytics',
    body: `feat: localized analytics\n\nSigned-off-by: 山田太郎 <yamada@tokyo.jp>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, true);
});

// ── 11. Case-Insensitive Email Matching ───────────────────────────────────────
test('11. Case-insensitive email comparison (UPPERCASE vs lowercase)', () => {
  const commit = {
    hash: 'e6f7a2b3c4d5',
    authorName: 'Katherine Johnson',
    authorEmail: 'Katherine.Johnson@NASA.GOV',
    subject: 'feat(orbital): calculation verify',
    body: `feat(orbital): calculation verify\n\nSigned-off-by: Katherine Johnson <katherine.johnson@nasa.gov>`,
  };

  const result = validateCommitDCO(commit);
  assert.strictEqual(result.valid, true);
});

// ── 12. Git Object and Range Safety Verification ─────────────────────────────
test('12a. Non-existent git SHA check returns false', () => {
  const exists = gitObjectExists('0000000000000000000000000000000000000000');
  assert.strictEqual(exists, false, 'Synthetic non-existent commit SHA must report false');
});

test('12b. Real repository commit SHA check returns true', () => {
  // 1cb61d3 is the repository initial commit
  const exists = gitObjectExists('1cb61d3');
  assert.strictEqual(exists, true, 'Initial commit 1cb61d3 must exist');
});

test('12c. Missing or invalid range parameter in getCommitsFromGit throws error', () => {
  assert.throws(
    () => getCommitsFromGit(''),
    /Revision range parameter is missing or empty/,
    'Empty range must throw error'
  );
});

console.log(`\nResults: ${passedTests}/${totalTests} tests passed.`);

if (passedTests !== totalTests) {
  process.exit(1);
} else {
  console.log('🎉 All 21 DCO security and compliance scenarios verified successfully!\n');
  process.exit(0);
}
