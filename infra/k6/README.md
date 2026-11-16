# k6 load scenarios

Reproducible load tests for the three performance budgets DevTrack is held to.

| Script | Budget | Pass criteria (k6 thresholds) |
|--------|--------|-------------------------------|
| `read-paths.js` | 500 RPS on the primary read paths | `http_req_duration` p95 < 80ms, `http_req_failed` < 1%, same p95 per route |
| `sse-1000.js` | 1,000 concurrent SSE streams opened through the ticket handshake | `sse_drops` < 0.01%, no open failures, handshake p95 < 500ms |
| `write-mix.js` | 100 RPS of mixed writes | `write_aborts` < 0.5% |

`helpers/auth.js` holds the shared config (`TARGET_URL`, tokens) and the SSE ticket helper.

## Routes

The scripts hit the `/api/v1` gateway that `main` serves. The v2 route names from the planning doc do not
exist yet, so each one is mapped to the closest real route:

| Planning doc | Used here |
|--------------|-----------|
| `/api/v2/portfolio/:username` | `GET /api/v1/profile/public/:username` (public, no auth) |
| `/api/v2/dsa/questions` | `GET /api/v1/dsa/problems` |
| `/api/v2/runtime/state` | `GET /api/v1/runtime-state` |
| SSE ticket handshake | `POST /api/v1/auth/sse-handshake`, then `GET /api/v1/events?ticket=...` |
| Interview turns, code submissions, XP events (writes) | No such write routes yet. `write-mix.js` uses `POST/PATCH/DELETE /api/v1/dsa/problems`, `POST /api/v1/activity` and `PATCH /api/v1/profile`. XP is awarded asynchronously from these writes. |

When the v2 routes land, only the paths in the three scripts need to change.

## Setup

1. Install k6: <https://grafana.com/docs/k6/latest/set-up/install-k6/>.
2. For `sse-1000.js` you need a k6 binary built with the SSE extension, because core k6 has no streaming SSE
   client:
   ```bash
   go install go.k6.io/xk6/cmd/xk6@latest
   xk6 build --with github.com/phymbert/xk6-sse
   ```
   Then run the script with that binary (`./k6 run infra/k6/sse-1000.js`) instead of the stock `k6`.
3. Start the backend, MongoDB and Redis (`npm run dev:infra`, then `npm run backend`).
4. **Disable the API rate limiter for the run.** The global limiter allows 100 requests per 15 minutes per
   IP, so a load test from one machine only measures 429s. Start the backend with `NODE_ENV=development`
   (the limiter is skipped in development) or raise `RATE_LIMIT_MAX_REQUESTS`. Never do this on a shared
   or production environment.
5. Create a throwaway user (the write test creates and edits real documents, so do not use real data) and
   make its profile public, so the portfolio route returns 200.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `TARGET_URL` | `http://localhost:3001` | Backend base URL (the backend's default `PORT` is 3001) |
| `TEST_TOKEN` | required | Bearer token of the load-test user |
| `TEST_TOKENS` | unset | Comma separated tokens; VUs are spread across them. Overrides `TEST_TOKEN` |
| `TEST_USERNAME` | `loadtest` | Public profile that `read-paths.js` reads |

DevTrack verifies Clerk session JWTs on every protected route, so a local mock token cannot be minted.
Clerk session tokens last about a minute by default; for anything longer than a smoke run create a Clerk
JWT template with a long lifetime for the load-test user and use a token from it.

## Running

```bash
export TARGET_URL=http://localhost:3001
export TEST_TOKEN=<token>
export TEST_USERNAME=<public username>

npm run test:load:reads     # k6 run infra/k6/read-paths.js
npm run test:load:sse       # k6 run infra/k6/sse-1000.js   (use the xk6-sse build)
npm run test:load:writes    # k6 run infra/k6/write-mix.js
```

Scale a run down first to check the scripts and your setup (the issue suggests about 50 VUs):

```bash
k6 run -e PEAK_RPS=50 -e WARMUP_S=5 -e RAMP_S=10 -e SUSTAIN_S=20 infra/k6/read-paths.js
k6 run -e CONNECTIONS=50 -e RAMP_S=10 -e HOLD_S=30 infra/k6/sse-1000.js
k6 run -e RATE=10 -e DURATION_S=30 infra/k6/write-mix.js
```

| Script | Scaling variables (defaults) |
|--------|------------------------------|
| `read-paths.js` | `PEAK_RPS` (500), `WARMUP_RPS` (50), `WARMUP_S` (30), `RAMP_S` (60), `SUSTAIN_S` (120), `MAX_VUS` (1000) |
| `sse-1000.js` | `CONNECTIONS` (1000), `RAMP_S` (60), `HOLD_S` (120, must be greater than `RAMP_S`), `FANOUT_PATH`, `FANOUT_METHOD` (POST), `FANOUT_BODY`, `FANOUT_RPS` (10) |
| `write-mix.js` | `RATE` (100), `DURATION_S` (180), `MAX_VUS` (400) |

## What each script does

**`read-paths.js`**: an open-model `ramping-arrival-rate` scenario (the budget is a request rate, so k6
keeps starting requests at the target rate and adds VUs as responses slow down). Stages: warm-up
(30s at 50 RPS), ramp-up (60s to 500 RPS), sustained (120s at 500 RPS). Traffic mix: 50% portfolio,
30% DSA list, 20% runtime state. The thresholds cover the whole run including warm-up, which is the
stricter reading of the budget.

**`sse-1000.js`**: starts 1,000 iterations evenly over the ramp. Each one fetches a single-use ticket
(valid 10 seconds) and opens `GET /api/v1/events?ticket=...`, then closes the stream itself after
`HOLD_S`. A stream that fails to open or dies before its hold time counts as a drop, so the 0.01%
threshold on 1,000 streams allows no drops at all. 1,000 concurrent VUs need roughly 1-2 GB of RAM on the
load generator.

The server only emits events when something happens for that user, and every ticket here belongs to the
same user (or the users behind `TEST_TOKENS`). To measure delivery, set `FANOUT_PATH` to an endpoint that
triggers server-side activity for that user; a publisher then calls it at `FANOUT_RPS` while all streams
are open, and the run asserts that events arrive (`sse_messages > 0`). Without `FANOUT_PATH` the streams
carry only the server's `: heartbeat` comments, which are not SSE events, so the script then verifies
connection stability rather than message delivery. It does not count per-stream message loss.

**`write-mix.js`**: `constant-arrival-rate` at 100 RPS. Mix: 35% create problem, 25% mark solved, 20% log
activity, 10% edit profile, 10% delete problem. An "abort" is a write that did not commit: a network
error, a 5xx or a 409 write conflict (`write_aborts`). 429s (`write_throttled`) and validation errors
(`write_rejected`) are counted separately because they point at the rate limiter or the script, not the
database.

## Reading the result

k6 prints each threshold with a check mark or a cross and exits non-zero if any fails, so the scripts
can gate a CI job or a pre-deploy check. The numbers to look at first:

- `http_req_duration{endpoint:...}` p(95): which route is slow
- `dropped_iterations` (read and write tests): k6 could not start requests at the target rate, which means
  the server or the load generator is saturated even if latency looks fine
- `sse_drops`, `sse_open_failures`: streams that failed or died early
- `write_aborts`: failed commits
