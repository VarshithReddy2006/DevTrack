// infra/k6/sse-1000.js
// Budget: 1,000 concurrent SSE streams, each opened through the ticket handshake, with fewer than
// 0.01% of streams dropped while they are meant to be open.
//
//   k6 run infra/k6/sse-1000.js        (needs a k6 binary built with the SSE extension, see README.md)
//
// Per VU: POST /api/v1/auth/sse-handshake for a single-use ticket (valid 10s), then
// GET /api/v1/events?ticket=<ticket> and hold the stream for HOLD_S seconds.
//
// What is measured:
//   sse_streams_opened  streams that answered 200
//   sse_drops           rate of streams that failed to open or died before their hold time ended
//   sse_messages        events received (data frames; the server's `: heartbeat` comments are not events)
//   sse_open_failures   handshake or open failures (also counted in sse_drops)
// With FANOUT_PATH set, a publisher drives real server-side events at FANOUT_RPS (default 10/s) so the
// delivery threshold (sse_messages > 0) means something. Without it the streams only carry heartbeats.
//
// Env: TARGET_URL, TEST_TOKEN / TEST_TOKENS (see helpers/auth.js) and, to scale the run:
//   CONNECTIONS (1000)  RAMP_S (60)  HOLD_S (120, must be > RAMP_S)
//   FANOUT_PATH (unset = no publisher)  FANOUT_METHOD (POST)  FANOUT_BODY (JSON string)  FANOUT_RPS (10)

import http from 'k6/http';
import sse from 'k6/x/sse';
import { check, fail } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { API, envNumber, fetchSseTicket, jsonAuthHeaders, requireToken } from './helpers/auth.js';

const CONNECTIONS = envNumber('CONNECTIONS', 1000);
const RAMP_S = envNumber('RAMP_S', 60);
const HOLD_S = envNumber('HOLD_S', 120);
const FANOUT_PATH = __ENV.FANOUT_PATH || '';
const FANOUT_METHOD = (__ENV.FANOUT_METHOD || 'POST').toUpperCase();
const FANOUT_BODY = __ENV.FANOUT_BODY || null;
const FANOUT_RPS = envNumber('FANOUT_RPS', 10);

const streamsOpened = new Counter('sse_streams_opened');
const openFailures = new Counter('sse_open_failures');
const messages = new Counter('sse_messages');
const drops = new Rate('sse_drops');

const scenarios = {
  subscribers: {
    // CONNECTIONS iterations spread evenly over RAMP_S. An iteration is one stream held for HOLD_S, so
    // after RAMP_S all CONNECTIONS streams are open together (needs HOLD_S > RAMP_S) until the first
    // ones reach their hold time.
    executor: 'constant-arrival-rate',
    exec: 'subscribe',
    rate: CONNECTIONS,
    timeUnit: `${RAMP_S}s`,
    duration: `${RAMP_S}s`,
    preAllocatedVUs: CONNECTIONS,
    maxVUs: CONNECTIONS + 50,
    gracefulStop: `${HOLD_S + 30}s`,
  },
};

if (FANOUT_PATH) {
  scenarios.fanout = {
    executor: 'constant-arrival-rate',
    exec: 'publish',
    rate: FANOUT_RPS,
    timeUnit: '1s',
    // Only while every stream is open: from the end of the ramp until the first streams hit HOLD_S
    startTime: `${RAMP_S}s`,
    duration: `${Math.max(1, HOLD_S - RAMP_S)}s`,
    preAllocatedVUs: 5,
    maxVUs: 20,
  };
}

const thresholds = {
  // 0.01% of streams
  sse_drops: ['rate<0.0001'],
  sse_open_failures: ['count<1'],
  'http_req_duration{endpoint:sse_handshake}': ['p(95)<500'],
  checks: ['rate>0.999'],
};
if (FANOUT_PATH) thresholds.sse_messages = ['count>0'];

export const options = { scenarios, thresholds };

export function setup() {
  requireToken();
  if (HOLD_S <= RAMP_S) {
    fail(`HOLD_S (${HOLD_S}) must be longer than RAMP_S (${RAMP_S}) so all ${CONNECTIONS} streams are open at the same time.`);
  }
}

// One iteration = one stream. The iteration ends when the stream is closed, so while an iteration runs
// its VU holds exactly one connection.
export function subscribe() {
  const ticket = fetchSseTicket();
  if (!ticket) {
    openFailures.add(1);
    drops.add(true);
    return;
  }

  let intentionalClose = false;
  let opened = false;
  let failed = false;

  const res = sse.open(
    `${API}/events?ticket=${ticket}`,
    { method: 'GET', headers: { Accept: 'text/event-stream' }, tags: { endpoint: 'sse_stream' } },
    function (client) {
      client.on('open', function () {
        opened = true;
        streamsOpened.add(1);
        // Hold the stream for HOLD_S, then close it ourselves so the close is not counted as a drop
        setTimeout(function () {
          intentionalClose = true;
          client.close();
        }, HOLD_S * 1000);
      });

      client.on('event', function () {
        messages.add(1);
      });

      client.on('error', function () {
        if (intentionalClose) return;
        failed = true;
        client.close();
      });
    },
  );

  check(res, { 'sse stream answers 200': (r) => r && r.status === 200 });
  if (!opened) openFailures.add(1);
  drops.add(failed || !opened);
}

// Optional publisher: triggers real server-side activity for the token's user, which the server
// fans out to every open stream of that user.
export function publish() {
  const res = http.request(FANOUT_METHOD, `${API}${FANOUT_PATH}`, FANOUT_BODY, {
    headers: jsonAuthHeaders(),
    tags: { endpoint: 'sse_fanout_trigger' },
  });
  check(res, { 'fan-out trigger is 2xx': (r) => r.status >= 200 && r.status < 300 });
}
