// infra/k6/read-paths.js
// Budget: 500 RPS across the primary read paths with p95 < 80ms and < 1% failed requests.
//
//   k6 run infra/k6/read-paths.js
//
// Routes (the v2 names in the planning doc map onto the /api/v1 gateway that main serves today):
//   GET /api/v1/profile/public/:username   public portfolio (no auth)
//   GET /api/v1/dsa/problems               DSA question list (auth)
//   GET /api/v1/runtime-state              runtime state (auth)
//
// Traffic is an open model (ramping-arrival-rate) because the budget is a request rate, not a VU count:
// k6 keeps starting iterations at the target RPS and adds VUs when responses get slow, so a slow server
// shows up as latency and dropped iterations instead of silently lowering the load.
//
// Env: TARGET_URL, TEST_TOKEN / TEST_TOKENS, TEST_USERNAME (see helpers/auth.js) and, to scale the run:
//   PEAK_RPS (500)  WARMUP_RPS (50)  WARMUP_S (30)  RAMP_S (60)  SUSTAIN_S (120)  MAX_VUS (1000)

import http from 'k6/http';
import { check, fail } from 'k6';
import { API, TEST_USERNAME, authHeaders, envNumber, requireToken } from './helpers/auth.js';

const PEAK_RPS = envNumber('PEAK_RPS', 500);
const WARMUP_RPS = Math.min(envNumber('WARMUP_RPS', 50), PEAK_RPS);
const WARMUP_S = envNumber('WARMUP_S', 30);
const RAMP_S = envNumber('RAMP_S', 60);
const SUSTAIN_S = envNumber('SUSTAIN_S', 120);
const MAX_VUS = envNumber('MAX_VUS', 1000);

export const options = {
  scenarios: {
    read_paths: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: Math.min(200, MAX_VUS),
      maxVUs: MAX_VUS,
      stages: [
        { duration: `${WARMUP_S}s`, target: WARMUP_RPS }, // warm-up: caches, connection pools, JIT
        { duration: `${RAMP_S}s`, target: PEAK_RPS }, // ramp-up to the budget
        { duration: `${SUSTAIN_S}s`, target: PEAK_RPS }, // sustained load at the budget
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<80'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    // Same budget per route, so one slow endpoint cannot hide behind fast ones
    'http_req_duration{endpoint:portfolio}': ['p(95)<80'],
    'http_req_duration{endpoint:dsa_questions}': ['p(95)<80'],
    'http_req_duration{endpoint:runtime_state}': ['p(95)<80'],
  },
};

// Traffic shape: the public portfolio is the hottest path, then the DSA list, then runtime state.
const READS = [
  { weight: 50, endpoint: 'portfolio', url: () => `${API}/profile/public/${TEST_USERNAME}`, auth: false },
  { weight: 30, endpoint: 'dsa_questions', url: () => `${API}/dsa/problems`, auth: true },
  { weight: 20, endpoint: 'runtime_state', url: () => `${API}/runtime-state`, auth: true },
];
const TOTAL_WEIGHT = READS.reduce((sum, read) => sum + read.weight, 0);

function pickRead() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const read of READS) {
    roll -= read.weight;
    if (roll < 0) return read;
  }
  return READS[0];
}

export function setup() {
  requireToken();
  // Fail fast on a wrong URL / username instead of recording 100% errors
  const probe = http.get(`${API}/profile/public/${TEST_USERNAME}`);
  if (probe.status !== 200) {
    fail(`GET ${API}/profile/public/${TEST_USERNAME} returned ${probe.status}. Check TARGET_URL and set TEST_USERNAME to a public profile.`);
  }
}

export default function () {
  const read = pickRead();
  const res = http.get(read.url(), {
    headers: read.auth ? authHeaders() : {},
    tags: { endpoint: read.endpoint },
  });
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}
