// infra/k6/write-mix.js
// Budget: 100 RPS of mixed writes with an abort rate below 0.5%.
//
//   k6 run infra/k6/write-mix.js
//
// The v2 write paths named in the planning doc (interview turns, code submissions, XP events) are not
// routes on main yet, so the mix uses the closest real write routes under /api/v1:
//   35%  POST   /dsa/problems         create a tracked problem (stands in for a code submission)
//   25%  PATCH  /dsa/problems/:id     mark it solved (status change + XP/mission side effects, async)
//   20%  POST   /activity             activity log entry
//   10%  PATCH  /profile              portfolio profile edit
//   10%  DELETE /dsa/problems/:id     keeps the data set from growing without bound
// XP is awarded asynchronously from these writes, so XP events are exercised indirectly.
//
// "Abort" means the write did not commit: a network error, a 5xx, or a 409 write conflict. Validation
// errors and 429s are reported separately because they point at the script or the rate limiter, not the
// database. Run this against a throwaway user and database: it creates and edits real documents.
//
// Env: TARGET_URL, TEST_TOKEN / TEST_TOKENS (see helpers/auth.js) and, to scale the run:
//   RATE (100)  DURATION_S (180)  MAX_VUS (400)

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { API, envNumber, jsonAuthHeaders, requireToken } from './helpers/auth.js';

const RATE = envNumber('RATE', 100);
const DURATION_S = envNumber('DURATION_S', 180);
const MAX_VUS = envNumber('MAX_VUS', 400);

const writeAborts = new Rate('write_aborts');
const writeThrottled = new Counter('write_throttled');
const writeRejected = new Counter('write_rejected');

export const options = {
  scenarios: {
    write_mix: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${DURATION_S}s`,
      preAllocatedVUs: Math.min(100, MAX_VUS),
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    write_aborts: ['rate<0.005'],
    checks: ['rate>0.99'],
    // Not part of the issue's budget; a generous guard so a hung write path cannot pass silently
    'http_req_duration{kind:write}': ['p(95)<1000'],
  },
};

// Each VU is its own JS runtime, so this is per-VU state: ids of problems this VU created.
const created = [];
const MAX_TRACKED = 50;

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const CATEGORIES = ['Arrays', 'Graphs', 'Dynamic Programming', 'Trees', 'Strings'];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function send(method, path, body, action) {
  const params = { headers: jsonAuthHeaders(), tags: { kind: 'write', action } };
  const payload = body === null ? null : JSON.stringify(body);
  const res = method === 'DELETE' ? http.del(`${API}${path}`, null, params) : http.request(method, `${API}${path}`, payload, params);

  const aborted = res.status === 0 || res.status >= 500 || res.status === 409;
  writeAborts.add(aborted);
  if (res.status === 429) writeThrottled.add(1);
  else if (res.status >= 400 && !aborted) writeRejected.add(1);
  return res;
}

function createProblem() {
  const stamp = `${__VU}-${__ITER}-${Date.now()}`;
  const res = send(
    'POST',
    '/dsa/problems',
    {
      title: `k6 problem ${stamp}`,
      platform: 'other',
      difficulty: pick(DIFFICULTIES),
      url: `https://example.com/k6/${stamp}`,
      tags: ['k6'],
      category: pick(CATEGORIES),
    },
    'create_problem',
  );
  check(res, { 'create problem is 201': (r) => r.status === 201 });
  if (res.status === 201) {
    created.push(res.json('data.id'));
    if (created.length > MAX_TRACKED) created.shift();
  }
}

function solveProblem() {
  if (created.length === 0) return createProblem();
  const id = pick(created);
  const res = send('PATCH', `/dsa/problems/${id}`, { status: 'solved', timeTaken: 5 + Math.floor(Math.random() * 40) }, 'solve_problem');
  check(res, { 'solve problem is 200': (r) => r.status === 200 });
}

function logActivity() {
  const res = send(
    'POST',
    '/activity',
    { type: 'note_added', title: 'k6 note', description: 'Load test activity entry', platform: 'devtrack', tags: ['k6'] },
    'log_activity',
  );
  check(res, { 'log activity is 201': (r) => r.status === 201 });
}

function editProfile() {
  const res = send('PATCH', '/profile', { bio: `k6 bio ${Date.now()}` }, 'edit_profile');
  check(res, { 'edit profile is 200': (r) => r.status === 200 });
}

function deleteProblem() {
  if (created.length === 0) return logActivity();
  const id = created.pop();
  const res = send('DELETE', `/dsa/problems/${id}`, null, 'delete_problem');
  check(res, { 'delete problem is 200': (r) => r.status === 200 });
}

const MIX = [
  { weight: 35, run: createProblem },
  { weight: 25, run: solveProblem },
  { weight: 20, run: logActivity },
  { weight: 10, run: editProfile },
  { weight: 10, run: deleteProblem },
];
const TOTAL_WEIGHT = MIX.reduce((sum, entry) => sum + entry.weight, 0);

export function setup() {
  requireToken();
}

export default function () {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const entry of MIX) {
    roll -= entry.weight;
    if (roll < 0) return entry.run();
  }
  return createProblem();
}
