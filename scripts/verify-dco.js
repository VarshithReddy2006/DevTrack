#!/usr/bin/env node

/**
 * DevTrack Developer Certificate of Origin (DCO) Sign-off Validator
 *
 * Validates that all commits in a specified range contain a valid `Signed-off-by` trailer
 * matching the commit author's identity (and any listed co-authors), according to the
 * Developer Certificate of Origin 1.1:
 * https://developercertificate.org/
 */

const { execSync } = require('node:child_process');
const process = require('node:process');

// Regex for standard DCO trailer: Signed-off-by: Full Name <email@example.com>
// Disallows '<' or '>' in the name, requires non-whitespace email with '@' enclosed in '<>'
const DCO_TRAILER_REGEX = /^Signed-off-by:\s*([^<>\r\n]+?)\s*<([^\s<>\r\n@]+@[^\s<>\r\n@]+)>\s*$/i;

// Regex for GitHub Co-authored-by trailer: Co-authored-by: Full Name <email@example.com>
const CO_AUTHOR_REGEX = /^Co-authored-by:\s*([^<>\r\n]+?)\s*<([^\s<>\r\n@]+@[^\s<>\r\n@]+)>\s*$/i;

/**
 * Validates a single commit object against DCO 1.1 specifications.
 *
 * Rules:
 * 1. Author name and author email must be present and non-empty.
 * 2. At least one valid Signed-off-by trailer must match the Author's identity.
 *    (Committer match alone is NOT accepted; the author certifies the contribution).
 * 3. If multiple Signed-off-by trailers exist, none may be malformed.
 * 4. Co-authored-by trailers are NOT sign-offs. If co-authors are listed, each co-author
 *    must also provide a corresponding Signed-off-by trailer certifying their work.
 *
 * @param {Object} commit
 * @param {string} commit.hash - Commit hash (short or full)
 * @param {string} commit.authorName - Author name
 * @param {string} commit.authorEmail - Author email
 * @param {string} [commit.committerName] - Committer name
 * @param {string} [commit.committerEmail] - Committer email
 * @param {string} commit.subject - Commit subject
 * @param {string} commit.body - Full commit message body (including subject and trailers)
 * @returns {{ valid: boolean, reason?: string, details?: string }}
 */
function validateCommitDCO(commit) {
  if (!commit || typeof commit !== 'object' || !commit.body) {
    return {
      valid: false,
      reason: 'MISSING_DATA',
      details: 'Commit message or metadata is empty or undefined',
    };
  }

  // 1. Author metadata validation
  const authorName = (commit.authorName || '').trim();
  const authorEmail = (commit.authorEmail || '').trim();

  if (!authorName || !authorEmail) {
    return {
      valid: false,
      reason: 'MISSING_AUTHOR_METADATA',
      details: `Commit author metadata is incomplete (name: "${commit.authorName || ''}", email: "${commit.authorEmail || ''}")`,
    };
  }

  if (!authorEmail.includes('@') || authorEmail.includes(' ')) {
    return {
      valid: false,
      reason: 'INVALID_AUTHOR_EMAIL',
      details: `Commit author email is invalid: "${authorEmail}"`,
    };
  }

  const lines = commit.body.split(/\r?\n/);

  // 2. Scan and validate Signed-off-by trailers
  const signOffLines = lines.filter((line) => /^Signed-off-by:/i.test(line.trim()));

  if (signOffLines.length === 0) {
    return {
      valid: false,
      reason: 'MISSING_SIGNOFF',
      details: 'Commit does not contain a "Signed-off-by:" trailer',
    };
  }

  const parsedSignOffs = [];

  for (const line of signOffLines) {
    const trimmed = line.trim();
    const match = trimmed.match(DCO_TRAILER_REGEX);
    if (!match) {
      return {
        valid: false,
        reason: 'MALFORMED_SIGNOFF',
        details: `Sign-off trailer is malformed. Expected format: "Signed-off-by: Full Name <email@example.com>". Found: "${trimmed}"`,
      };
    }

    const name = match[1].trim();
    const email = match[2].trim().toLowerCase();

    if (!name || !email) {
      return {
        valid: false,
        reason: 'MALFORMED_SIGNOFF',
        details: `Sign-off trailer has empty name or email: "${trimmed}"`,
      };
    }

    parsedSignOffs.push({ name, email, raw: trimmed });
  }

  // 3. Match against Author identity
  const normalizedAuthorName = authorName.toLowerCase();
  const normalizedAuthorEmail = authorEmail.toLowerCase();

  const authorSignOffMatch = parsedSignOffs.find(
    (s) => s.name.toLowerCase() === normalizedAuthorName && s.email === normalizedAuthorEmail
  );

  if (!authorSignOffMatch) {
    // Check if sign-off was provided only for committer
    const committerName = (commit.committerName || '').trim().toLowerCase();
    const committerEmail = (commit.committerEmail || '').trim().toLowerCase();
    const committerMatched = parsedSignOffs.some(
      (s) => s.name.toLowerCase() === committerName && s.email === committerEmail
    );

    if (committerMatched && (normalizedAuthorName !== committerName || normalizedAuthorEmail !== committerEmail)) {
      return {
        valid: false,
        reason: 'COMMITTER_ONLY_SIGNOFF',
        details: `Sign-off matches committer (${commit.committerName} <${commit.committerEmail}>) but NOT the commit author (${authorName} <${authorEmail}>). DCO 1.1 requires author certification.`,
      };
    }

    const expected = `${authorName} <${authorEmail}>`;
    const found = parsedSignOffs.map((s) => `${s.name} <${s.email}>`).join(', ');
    return {
      valid: false,
      reason: 'IDENTITY_MISMATCH',
      details: `Sign-off identity does not match commit author.\n    Expected: "${expected}"\n    Found:    "${found}"`,
    };
  }

  // 4. Validate Co-authors (if any)
  const coAuthorLines = lines.filter((line) => /^Co-authored-by:/i.test(line.trim()));

  for (const line of coAuthorLines) {
    const trimmed = line.trim();
    const match = trimmed.match(CO_AUTHOR_REGEX);
    if (!match) {
      return {
        valid: false,
        reason: 'MALFORMED_COAUTHOR',
        details: `Co-authored-by trailer is malformed: "${trimmed}"`,
      };
    }

    const coName = match[1].trim().toLowerCase();
    const coEmail = match[2].trim().toLowerCase();

    // Verify co-author has a corresponding Signed-off-by trailer
    const hasCoAuthorSignOff = parsedSignOffs.some(
      (s) => s.name.toLowerCase() === coName && s.email === coEmail
    );

    if (!hasCoAuthorSignOff) {
      return {
        valid: false,
        reason: 'MISSING_COAUTHOR_SIGNOFF',
        details: `Co-author "${match[1].trim()} <${match[2].trim()}>" is listed in commit trailers but lacks a corresponding Signed-off-by trailer certifying their contribution under DCO 1.1.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Checks that a git commit object exists locally.
 *
 * @param {string} sha
 * @returns {boolean}
 */
function gitObjectExists(sha) {
  if (!sha || typeof sha !== 'string' || !/^[0-9a-fA-F]{4,64}$/.test(sha.trim())) {
    return false;
  }
  try {
    execSync(`git cat-file -e "${sha.trim()}^{commit}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Counts commits in a given revision range.
 *
 * @param {string} range
 * @returns {number}
 */
function getCommitCount(range) {
  try {
    const countStr = execSync(`git rev-list --count ${range}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return parseInt(countStr, 10) || 0;
  } catch {
    return -1;
  }
}

/**
 * Parses commit objects from git log output for a given revision range.
 *
 * @param {string} range
 * @returns {Array<Object>}
 */
function getCommitsFromGit(range) {
  if (!range || typeof range !== 'string' || !range.trim()) {
    throw new Error('Revision range parameter is missing or empty.');
  }

  const delimiter = '===DEVTRACK_COMMIT_DELIMITER===';
  // Format: hash%nauthorName%nauthorEmail%ncommitterName%ncommitterEmail%nsubject%nbody%ndelimiter
  const cmd = `git log --no-merges --format="%H%n%an%n%ae%n%cn%n%ce%n%s%n%B%n${delimiter}" ${range.trim()}`;
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

Environment variables:
  PR_BASE_SHA                Base commit SHA (used when --base is omitted)
  PR_HEAD_SHA                Head commit SHA (used when --head is omitted)
`);
    process.exit(0);
  }

  let range = '';
  let isPRMode = false;
  let baseSha = '';
  let headSha = '';

  const baseIdx = args.indexOf('--base');
  const headIdx = args.indexOf('--head');
  const rangeIdx = args.indexOf('--range');

  if (baseIdx !== -1 || headIdx !== -1) {
    if (baseIdx === -1 || headIdx === -1 || !args[baseIdx + 1] || !args[headIdx + 1]) {
      console.error('❌ Error: Both --base <sha> and --head <sha> must be supplied together with non-empty values.');
      process.exit(1);
    }
    baseSha = args[baseIdx + 1].trim();
    headSha = args[headIdx + 1].trim();
    range = `${baseSha}..${headSha}`;
    isPRMode = true;
  } else if (rangeIdx !== -1) {
    if (!args[rangeIdx + 1] || !args[rangeIdx + 1].trim()) {
      console.error('❌ Error: --range requires a non-empty revision range argument.');
      process.exit(1);
    }
    range = args[rangeIdx + 1].trim();
  } else if (process.env.PR_BASE_SHA && process.env.PR_HEAD_SHA) {
    baseSha = process.env.PR_BASE_SHA.trim();
    headSha = process.env.PR_HEAD_SHA.trim();
    range = `${baseSha}..${headSha}`;
    isPRMode = true;
  } else {
    // Local fallback: verify against origin/main or HEAD~1
    try {
      execSync('git rev-parse --verify origin/main', { stdio: 'ignore' });
      range = 'origin/main..HEAD';
    } catch {
      range = 'HEAD~1..HEAD';
    }
  }

  // PR Mode Range Verifications
  if (isPRMode) {
    if (!gitObjectExists(baseSha)) {
      console.error(`❌ Error: Base commit "${baseSha}" is not present in local Git object database.`);
      console.error('   Ensure the checkout action fetched sufficient history (e.g., fetch-depth: 0 or git fetch).');
      process.exit(1);
    }

    if (!gitObjectExists(headSha)) {
      console.error(`❌ Error: Head commit "${headSha}" is not present in local Git object database.`);
      console.error('   Ensure the checkout action fetched sufficient history.');
      process.exit(1);
    }

    const commitCount = getCommitCount(range);
    if (commitCount === 0) {
      console.error(`❌ Error: PR commit range "${range}" contains 0 commits.`);
      console.error('   Cannot validate empty pull request commit range.');
      process.exit(1);
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
    if (isPRMode) {
      console.error(`❌ Error: Found 0 non-merge commits in PR range "${range}".`);
      process.exit(1);
    } else {
      console.log('ℹ️  No non-merge commits found in the given range.');
      process.exit(0);
    }
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
    console.error('DevTrack requires all contributions to be signed off under DCO 1.1:');
    console.error('  https://developercertificate.org/\n');
    console.error('1. If your git name or email is not yet configured:');
    console.error('     git config user.name "Your Full Name"');
    console.error('     git config user.email "your.email@example.com"\n');
    console.error('2. If you need to sign off your latest commit:');
    console.error('     git commit --amend -s --no-edit\n');
    console.error('3. If you have multiple commits needing sign-off on a feature branch:');
    console.error('     git rebase -i --signoff <base-commit-sha>\n');
    console.error('4. If co-authors are listed (Co-authored-by:), each co-author must also have');
    console.error('   a matching Signed-off-by trailer in the commit message.\n');
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
  gitObjectExists,
  getCommitCount,
  DCO_TRAILER_REGEX,
  CO_AUTHOR_REGEX,
};
