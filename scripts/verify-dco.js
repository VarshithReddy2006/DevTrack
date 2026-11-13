#!/usr/bin/env node

/**
 * DevTrack Developer Certificate of Origin (DCO) Sign-off Validator
 *
 * Validates that all commits in a specified range contain a valid `Signed-off-by` trailer
 * matching the commit author's identity, according to the Developer Certificate of Origin 1.1:
 * https://developercertificate.org/
 */

const { execSync } = require('node:child_process');
const process = require('node:process');

// Regex for standard DCO trailer: Signed-off-by: Full Name <email@example.com>
const DCO_TRAILER_REGEX = /^Signed-off-by:\s*([^<>\r\n]+?)\s*<([^<>\s\r\n]+@[^<>\s\r\n]+)>\s*$/im;
const DCO_LINE_SEARCH_REGEX = /^Signed-off-by:\s*(.*)$/im;

/**
 * Validates a single commit object.
 *
 * @param {Object} commit
 * @param {string} commit.hash - Commit hash (short or full)
 * @param {string} commit.authorName - Author name
 * @param {string} commit.authorEmail - Author email
 * @param {string} commit.committerName - Committer name
 * @param {string} commit.committerEmail - Committer email
 * @param {string} commit.subject - Commit subject
 * @param {string} commit.body - Full commit message body (including subject and trailers)
 * @returns {{ valid: boolean, reason?: string, details?: string }}
 */
function validateCommitDCO(commit) {
  if (!commit || !commit.body) {
    return {
      valid: false,
      reason: 'MISSING_DATA',
      details: 'Commit message or metadata is empty',
    };
  }

  // Find all lines starting with Signed-off-by:
  const lines = commit.body.split(/\r?\n/);
  const signOffLines = lines.filter((line) => /^Signed-off-by:/i.test(line.trim()));

  if (signOffLines.length === 0) {
    return {
      valid: false,
      reason: 'MISSING_SIGNOFF',
      details: 'Commit does not contain a "Signed-off-by:" trailer',
    };
  }

  // Check each sign-off line
  let hasValidTrailerFormat = false;
  let identityMatched = false;
  const foundSignOffs = [];

  for (const line of signOffLines) {
    const match = line.trim().match(DCO_TRAILER_REGEX);
    if (!match) {
      continue;
    }

    hasValidTrailerFormat = true;
    const signOffName = match[1].trim();
    const signOffEmail = match[2].trim().toLowerCase();
    foundSignOffs.push({ name: signOffName, email: signOffEmail });

    // Compare with author identity (case-insensitive for email, trimmed case-insensitive for name)
    const authorName = (commit.authorName || '').trim().toLowerCase();
    const authorEmail = (commit.authorEmail || '').trim().toLowerCase();
    const committerName = (commit.committerName || '').trim().toLowerCase();
    const committerEmail = (commit.committerEmail || '').trim().toLowerCase();

    const matchesAuthor =
      signOffName.toLowerCase() === authorName && signOffEmail === authorEmail;
    const matchesCommitter =
      signOffName.toLowerCase() === committerName && signOffEmail === committerEmail;

    if (matchesAuthor || matchesCommitter) {
      identityMatched = true;
      break;
    }
  }

  if (!hasValidTrailerFormat) {
    return {
      valid: false,
      reason: 'MALFORMED_SIGNOFF',
      details: `Sign-off trailer is malformed. Expected format: "Signed-off-by: Name <email@example.com>". Found: "${signOffLines[0]}"`,
    };
  }

  if (!identityMatched) {
    const expected = `${commit.authorName} <${commit.authorEmail}>`;
    const found = foundSignOffs.map((s) => `${s.name} <${s.email}>`).join(', ');
    return {
      valid: false,
      reason: 'IDENTITY_MISMATCH',
      details: `Sign-off identity does not match commit author.\n    Expected: "${expected}"\n    Found:    "${found}"`,
    };
  }

  return { valid: true };
}

/**
 * Parses commit objects from git log output for a given revision range.
 *
 * @param {string} range
 * @returns {Array<Object>}
 */
function getCommitsFromGit(range) {
  const delimiter = '===DEVTRACK_COMMIT_DELIMITER===';
  // Format: hash%nauthorName%nauthorEmail%ncommitterName%ncommitterEmail%nsubject%nbody%ndelimiter
  const cmd = `git log --no-merges --format="%H%n%an%n%ae%n%cn%n%ce%n%s%n%B%n${delimiter}" ${range}`;
  let output = '';
  try {
    output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    throw new Error(`Failed to execute git log for range "${range}": ${err.message}`);
  }

  if (!output) {
    return [];
  }

  const rawCommits = output.split(delimiter).filter((block) => block.trim().length > 0);
  const commits = [];

  for (const block of rawCommits) {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 6) continue;

    const hash = lines[0];
    const authorName = lines[1];
    const authorEmail = lines[2];
    const committerName = lines[3];
    const committerEmail = lines[4];
    const subject = lines[5];
    const body = lines.slice(5).join('\n');

    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      authorName,
      authorEmail,
      committerName,
      committerEmail,
      subject,
      body,
    });
  }

  return commits;
}

/**
 * Main execution function.
 */
function runCLI() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
DevTrack DCO Sign-off Verification

Usage:
  node scripts/verify-dco.js [options]

Options:
  --base <sha> --head <sha>  Validate commits in range base..head (typical for PRs)
  --range <range>            Validate specific git revision range (e.g. origin/main..HEAD)
  --help, -h                 Show this help message

If no options are provided:
  Checks PR base..head if GITHUB_BASE_REF/BASE_SHA is available, or defaults to origin/main..HEAD (or HEAD~1..HEAD).
`);
    process.exit(0);
  }

  let range = '';

  const baseIdx = args.indexOf('--base');
  const headIdx = args.indexOf('--head');
  const rangeIdx = args.indexOf('--range');

  if (baseIdx !== -1 && headIdx !== -1 && args[baseIdx + 1] && args[headIdx + 1]) {
    range = `${args[baseIdx + 1]}..${args[headIdx + 1]}`;
  } else if (rangeIdx !== -1 && args[rangeIdx + 1]) {
    range = args[rangeIdx + 1];
  } else if (process.env.PR_BASE_SHA && process.env.PR_HEAD_SHA) {
    range = `${process.env.PR_BASE_SHA}..${process.env.PR_HEAD_SHA}`;
  } else {
    // Determine reasonable local default
    try {
      execSync('git rev-parse --verify origin/main', { stdio: 'ignore' });
      range = 'origin/main..HEAD';
    } catch {
      range = 'HEAD~1..HEAD';
    }
  }

  console.log(`\n🔍 Verifying DCO sign-offs for commit range: ${range}`);

  let commits = [];
  try {
    commits = getCommitsFromGit(range);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (commits.length === 0) {
    console.log('ℹ️  No commits found to verify in the given range.');
    process.exit(0);
  }

  console.log(`📋 Found ${commits.length} commit(s) to inspect.\n`);

  const failures = [];

  for (const commit of commits) {
    const result = validateCommitDCO(commit);
    if (!result.valid) {
      failures.push({ commit, result });
    }
  }

  if (failures.length > 0) {
    console.error('================================================================================');
    console.error('❌ DCO VALIDATION FAILED');
    console.error('================================================================================');
    console.error(
      `Found ${failures.length} commit(s) without a valid Developer Certificate of Origin (DCO) sign-off:\n`
    );

    for (const { commit, result } of failures) {
      console.error(` commit ${commit.shortHash}: ${commit.subject}`);
      console.error(`   Author:  ${commit.authorName} <${commit.authorEmail}>`);
      console.error(`   Problem: [${result.reason}] ${result.details}`);
      console.error('');
    }

    console.error('--------------------------------------------------------------------------------');
    console.error('💡 HOW TO FIX DCO SIGN-OFF:');
    console.error('--------------------------------------------------------------------------------');
    console.error('DevTrack requires all contributions to be signed off under the DCO 1.1:');
    console.error('  https://developercertificate.org/\n');
    console.error('1. If your git name or email is not yet configured, set it:');
    console.error('     git config user.name "Your Full Name"');
    console.error('     git config user.email "your.email@example.com"\n');
    console.error('2. If you need to sign off your latest commit:');
    console.error('     git commit --amend -s --no-edit');
    console.error('     git push --force-with-lease\n');
    console.error('3. If you have multiple commits that need sign-off:');
    console.error('     git rebase -i --signoff <base-commit-sha>');
    console.error('     git push --force-with-lease\n');
    console.error('Note: Never force-push or rebase branches shared with other collaborators.');
    console.error('================================================================================\n');

    process.exit(1);
  }

  console.log(`✅ All ${commits.length} commit(s) have valid DCO sign-offs.`);
  process.exit(0);
}

if (require.main === module) {
  runCLI();
}

module.exports = {
  validateCommitDCO,
  getCommitsFromGit,
  DCO_TRAILER_REGEX,
};
