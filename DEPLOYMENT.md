# Production Deployment Guide

Instructions for deploying DevTrack in staging and production environments.

---

## Deployment Targets

| Component | Recommended Host | Notes |
|-----------|-----------------|-------|
| Frontend | Vercel | Static SPA + env injection at build time |
| Backend API | Render | Express + SSE; set `ENABLE_WORKERS=false` |
| Workers | Render (separate services) | One service per `WORKER_TYPE` |
| MongoDB | MongoDB Atlas | Required |
| Redis | Upstash / Redis Cloud | Required for BullMQ and SSE pub/sub |

GitHub Actions workflows in `.github/workflows/` automate staging and production deploys on merge to `main`.


---

## Scaling Modes

### Mode 1: Unified (development / small staging)

Single process runs API and all workers.

```bash
cd backend
npm run build && npm start
# Workers in a second terminal:
npm run worker
```


Or use `docker compose up --build` from the repo root.


### Mode 2: Split production (recommended)


Separate the HTTP server from background workers so each scales independently.

| Service | Command | Environment |
|---------|---------|-------------|
| API | `node dist/index.js` | `ENABLE_WORKERS=false` |
| Sync worker | `node dist/worker-entrypoint.js` | `WORKER_TYPE=sync` |
| Readiness intelligence | `node dist/worker-entrypoint.js` | `WORKER_TYPE=readiness` |
| XP worker | `node dist/worker-entrypoint.js` | `WORKER_TYPE=xp` |
| Maintenance worker | `node dist/worker-entrypoint.js` | `WORKER_TYPE=maintenance` |
| Resume intelligence | `node dist/worker-entrypoint.js` | `WORKER_TYPE=resume-intelligence` |
| Dataset ingestion | `node dist/worker-entrypoint.js` | `WORKER_TYPE=dataset` |
| Render pool | `node dist/worker-entrypoint.js` | `WORKER_TYPE=render` |

Supported selectors are `sync`, `xp`, `maintenance`, `resume-intelligence`,
`dataset`, `render` and `all`. An unset or empty selector defaults to `all`, preserving the
local development fallback; typos fail before service imports/connections.
Use explicit roles in production.
`all` starts the union once and is intended for local development. There is no
separate orchestration-compensation consumer; `orch` and `orchestration` are
unsupported. The resume role runs the existing resume consumers and profile rebuild.
The `readiness` role runs all six Readiness consumers. The `xp` role also runs
streak recalculation and notifications. The Resume role includes both legacy
feature queues and session-based upload, ATS, embedding, semantic and recommendation
queues. Start all seven roles in production with API `ENABLE_WORKERS=false`.
Recurring work (mission generation, platform sync sweeps, cleanups) runs as BullMQ
repeatable jobs registered by the maintenance role, not as timers inside the API, so any number of
API replicas produce each scheduled job exactly once. Keep at least one `maintenance` worker (or an
`all` process) running, otherwise nothing triggers the schedules.
Shutdown allows nine seconds for startup/drain/disconnect, then exits nonzero on a
deadline failure; unfinished work is recovered through BullMQ stalled-job handling.

The render role (`domain-og-render` queue) draws the 1200x630 share cards served at
`GET /api/v1/profile/public/:username/og.png` with satori and resvg. The API only queues a job and
waits up to eight seconds for the stored card; if no render worker is running it answers `503` with
`Retry-After`, so deploy at least one `render` service wherever the API serves public profiles. Set
`PUBLIC_API_URL` on the API to its public origin so the `/u/:username` share page can emit an absolute
`og:image`; without it (production default) the static preview image stays in place. The Docker image
ships the bundled Inter font under `assets/fonts` (SIL OFL 1.1).

The dataset role runs dataset ingestion independently. Backend `npm run worker:*`
commands use the same dispatcher; their positional role overrides `WORKER_TYPE`.
On SIGINT/SIGTERM, registered workers drain before MongoDB/shared Redis disconnect.
Startup failures clean up already registered workers and exit nonzero.

Use `docker-compose.prod.yml` for a local production simulation:

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f
```

> **Port note:** `docker-compose.prod.yml` publishes the API on host port **4000** by default and routes it to container port **3001**. Override only the host port with `API_PORT`. Development publishes container port 3001 directly.

### Distributed traces

Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to the collector's full HTTP/JSON trace ingest URL, such as `http://otel-collector:4318/v1/traces`. You can also set `OTEL_EXPORTER_OTLP_ENDPOINT` to the base collector URL. Set `OTEL_SERVICE_NAME` per deployment role to distinguish API and worker spans. Without an endpoint, the API and workers propagate trace IDs locally and skip exporting spans. Set `OTEL_SDK_DISABLED=true` to disable the SDK.

For custom process entry points, preload the built SDK with `node --import ./dist/instrumentation.js ...` before loading instrumented libraries. Exported spans keep trace IDs, timings, operation names, and status codes. The exporter drops request URLs, database arguments, Redis payloads, and exception bodies.

When the transactional outbox from issue #296 is available, persist `captureTraceContext()` in the event's `traceContext` field. Enqueue within `withTraceContext(row.traceContext, () => queue.add(...))` so BullMQ derives its metadata from the originating request.


---

## Database Migrations

Build the backend and explicitly export the target database's `MONGODB_URI`
before running these commands from `backend/`:

```bash
npm run build
pnpm migrate:status
pnpm migrate:up
pnpm migrate:down --step=1
```

The npm equivalents are `npm run migrate:status`, `npm run migrate:up`, and
`npm run migrate:down -- --step=1`. Run `up` as a release step before starting
the new API or rolling out workers. The production API checks the ledger before
listening and exits if migrations are pending, changed, or locked. Rollback
reverses the latest applied batch by default. Roll back the application with the
schema, since the newer API requires its migrations to be applied.

Replica sets and sharded clusters commit each migration's writes and ledger entry
together. Rollback uses one transaction per batch. On standalone MongoDB,
take a backup first. A failed or interrupted operation can leave partial writes
and a `recovery` marker in `schema_migrations`. Resolve the partial writes using the
migration's `up` and `down` definitions and your backup, then reconcile the ledger
with the verified database state before retrying. If the runner crashed or a
transaction's commit outcome is unknown, confirm it has stopped and verify the
database and ledger before clearing the `runner` record in
`schema_migration_locks`. The lock has no automatic expiry.

---

## Environment Variables

### Backend (required in production)


| Variable | Required | Default (dev) | Description |
|----------|----------|---------------|-------------|
| `NODE_ENV` | Yes | `development` | `production` in prod |
| `PORT` | No | `3001` | HTTP listen port |
| `MONGODB_URI` | Yes | `mongodb://localhost:27017/devtrack` | MongoDB connection string |
| `CORS_ORIGIN` | Yes | `http://localhost:5173` | Frontend origin - **must be HTTPS in production** |
| `PUBLIC_API_URL` | No | `http://localhost:<PORT>` in dev, unset in prod | Public origin of the API, used for the absolute `og:image` link in `/u/:username` previews |
| `CLERK_SECRET_KEY` | Yes | - | Clerk backend secret |
| `REDIS_URL` | Recommended | - | Full Redis URL (overrides host/port) |
| `REDIS_HOST` | No | `localhost` | Redis hostname |
| `REDIS_PORT` | No | `6379` | Redis port |
| `REDIS_PASSWORD` | No | `''` | Redis password |
| `OPENAI_API_KEY` | One of two | - | OpenAI for embeddings and intelligence |
| `GEMINI_API_KEY` | One of two | - | Google Gemini fallback |
| `GITHUB_TOKEN` | No | - | Raises GitHub API rate limits |
| `ENABLE_WORKERS` | No | - | Set `false` on API-only containers |
| `WORKER_TYPE` | No | `all` | Worker process selector |
| `SYNC_ENABLED` | No | `true` | Platform sync sweep (BullMQ repeatable on the maintenance worker; `false` removes it) |
| `SYNC_INTERVAL_MINUTES` | No | `15` (prod) | Sync sweep interval in minutes, applied by the maintenance worker at startup |
| `CLOSED_BETA` | No | `false` | Restrict access to beta users |
| `TRUST_PROXY` | No | unset | Number of reverse proxies in front of the API (`1` on Render and behind the compose nginx). See [Behind a reverse proxy](#behind-a-reverse-proxy) |
| `RATE_LIMIT_WINDOW_MS` | No | `900000` | Global rate limit window |
| `RATE_LIMIT_MAX_REQUESTS` | No | `100` | Max requests per window |

Copy `.env.example` (root) as a starting template for production.

#### Behind a reverse proxy

The rate limiters key requests by `req.ip`. Behind a proxy that is the proxy's own address unless Express is told to trust the `X-Forwarded-For` header, which means every user shares one bucket (for example 100 requests per 15 minutes for the whole app). Set `TRUST_PROXY` to the number of proxies between the internet and the API:

- Render web service: `TRUST_PROXY=1`
- `docker-compose.prod.yml` (nginx in front of `api`): `TRUST_PROXY=1`
- API exposed directly, no proxy: leave it unset

Only set it when a proxy really is in front. If the API is also reachable directly, clients can send their own `X-Forwarded-For` and pick any rate-limit bucket they like. Values must be a plain integer; anything else (including `true`) fails at startup.

> **Auth note:** DevTrack uses **Clerk** for authentication. The root `.env.example` templates all required environment variables for both Render and Vercel deployments.


### Frontend (build-time)

| Variable | Required | Default (dev) | Description |
|----------|----------|---------------|-------------|
| `VITE_API_BASE_URL` | Yes | `http://localhost:3001/api` | Backend API base URL |
| `VITE_CLERK_PUBLISHABLE_KEY` | Yes | - | Clerk frontend key |

Copy `frontend/.env.example` as a starting template.

> **Docker build note:** The frontend image accepts `VITE_API_BASE_URL` and `VITE_CLERK_PUBLISHABLE_KEY` build arguments, matching the variables read by the application. Both values are public client configuration embedded by Vite. Never pass `CLERK_SECRET_KEY` or another server-only secret as a frontend build argument.

---

## Docker Deployment

### Development full-stack

```bash
export VITE_CLERK_PUBLISHABLE_KEY=pk_test_your_key
docker compose config
docker compose build
docker compose up --build
```


Services: `mongo` (7), `redis` (7-alpine), `backend`, `frontend` (Nginx).

- Frontend: port 80, proxies `/api` to backend
- Backend: port 3001
- Requires `VITE_CLERK_PUBLISHABLE_KEY` in the shell or root `.env` for the frontend build. `backend/.env` is optional for Compose parsing but runtime features require the documented backend credentials.

### Production split topology

`docker-compose.prod.yml` defines:

- `api` - Express only, `ENABLE_WORKERS=false`
- `frontend` - Nginx serving the built app on host port 80 (`FRONTEND_PORT`); `/api` is proxied to the `api` service
- `worker-sync` (2 replicas), `worker-xp`, `worker-readiness`, `worker-resume`, `worker-dataset`, `worker-maint`
- `mongo`, `redis` with health checks

Use `docker compose --env-file .env.production -f docker-compose.prod.yml ...`
when `.env.production` supplies values used in Compose interpolation (for example
`MONGODB_URI`, `MONGO_USER`, `MONGO_PASS`, or `API_PORT`). The file is also loaded
into backend containers when present; it is optional for configuration parsing.

`VITE_CLERK_PUBLISHABLE_KEY` is required to build the `frontend` image.

### Shell deploy script

```bash
./deploy.sh
```


Builds images from `docker-compose.prod.yml`, starts the containers, and checks the `api` health endpoint. It reads `.env.production` from the repo root.

---

## Frontend (Vercel)

1. Import the GitHub repo at https://vercel.com/new
2. Leave the root directory at the repository root so the build can access `packages/contracts`.
3. Framework preset: **Vite**
4. Install command: `npm ci --prefix frontend --include=dev`
5. Build command: `npm run build --prefix frontend`
6. Output directory: `frontend/dist`
7. Inject environment variables:
   - `VITE_API_BASE_URL=https://your-api.render.com/api`
   - `VITE_CLERK_PUBLISHABLE_KEY=pk_live_...`

Rollback: Vercel Dashboard - Deployments - select last working build - Promote to Production.

---

## Backend (Render)

### 1. Create project and services

1. Create a new Web Service at https://dashboard.render.com
2. Connect your GitHub repository
3. Create a separate service for each worker type

### 2. Backend API Service

1. Name: `devtrack-api`
2. Root directory: leave blank to use the repository root. The backend requires both `packages/ats-core` and `packages/contracts`.
3. Build command: `npm ci --prefix backend --include=dev && npm run build --prefix backend`
4. Start command: `cd backend && node dist/index.js`
5. Environment: `Node`
6. Set `ENABLE_WORKERS=false`

### 3. Worker Services

Create one Render service per worker type. Use the same repository root and build command as the API.


| Service Name | `WORKER_TYPE` | Start Command |
|---------------|---------------|---------------|
| `devtrack-sync` | `sync` | `cd backend && node dist/worker-entrypoint.js` |
| `devtrack-readiness` | `readiness` | `cd backend && node dist/worker-entrypoint.js` |
| `devtrack-xp` | `xp` | `cd backend && node dist/worker-entrypoint.js` |
| `devtrack-resume` | `resume-intelligence` | `cd backend && node dist/worker-entrypoint.js` |
| `devtrack-dataset` | `dataset` | `cd backend && node dist/worker-entrypoint.js` |
| `devtrack-render` | `render` | `cd backend && node dist/worker-entrypoint.js` |
| `devtrack-maint` | `maintenance` | `cd backend && node dist/worker-entrypoint.js` |

### 4. Required Environment Variables (Render Dashboard)

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `MONGODB_URI` | From MongoDB Atlas |
| `REDIS_URL` | From Upstash/Redis Cloud |
| `CORS_ORIGIN` | `https://your-app.vercel.app` |
| `CLERK_SECRET_KEY` | From Clerk dashboard |
| `OPENAI_API_KEY` or `GEMINI_API_KEY` | Optional (runs in degraded AI mode if unset; set `REQUIRE_AI_KEYS=true` to require) |
| `ENABLE_WORKERS` | `false` (API only) |

### 5. Deployment Hook (GitHub Actions)

The `.github/workflows/deploy-production.yml` workflow triggers a redeploy of `devtrack-backend` on Render on every push to `main`.

Only **one** GitHub secret is required:

| Secret | Source |
|--------|--------|
| `RENDER_BACKEND_DEPLOY_HOOK` | Render Dashboard → `devtrack-backend` → Settings → Deploy Hook → Copy URL |

Health check: `GET /health`

---

## CI/CD

Workflows in `.github/workflows/`:

| Workflow | Trigger | Actions |
|----------|---------|---------|
| `pr-checks.yml` | PR to `main`/`develop` | Typecheck, lint, unit + integration tests, Docker build |
| `deploy-production.yml` | Push to `main` | Pings Render deploy hook → redeploys `devtrack-backend` |
| `deploy-staging.yml` | Manual (`workflow_dispatch`) | Same as production, triggered on demand |
| `deploy-render.yml` | Disabled (legacy) | Superseded by `deploy-production.yml` |

> **Vercel (Frontend):** Vercel redeploys automatically via its native GitHub integration — no token or workflow step is needed. Verify at [vercel.com](https://vercel.com) → your project → **Settings → Git** → confirm your GitHub repo is connected and the production branch is set to `main`.

---

## Pre-deploy Checklist

- [ ] `CLERK_SECRET_KEY` and `VITE_CLERK_PUBLISHABLE_KEY` configured |
- [ ] `MONGODB_URI` points to production cluster |
- [ ] `REDIS_URL` configured (BullMQ will not start without Redis) |
- [ ] `CORS_ORIGIN` is HTTPS and matches the frontend URL |
- [ ] AI keys (`OPENAI_API_KEY` or `GEMINI_API_KEY`): Optional. Runs in degraded AI mode with deterministic fallbacks when omitted; set `REQUIRE_AI_KEYS=true` to enforce. |
- [ ] `ENABLE_WORKERS=false` on API containers |
- [ ] Worker services running with correct `WORKER_TYPE` |
- [ ] `VITE_API_BASE_URL` matches the deployed API URL (Render) |

---

## Monitoring

| Endpoint | Access | Purpose |
|----------|---------|---------|
| `GET /health` | Public | Liveness probe |
| `GET /health/detailed` | Admin | Dependency status |
| `GET /metrics` | Admin | Prometheus metrics |
| `GET /api/v1/ops/health` | Public | Ops module health |
| `GET /api/v1/ops/queues` | Ops auditor | Queue depths |
| `GET /api/v1/ops/metrics` | Ops auditor | Runtime metrics |

---

## Post-Deploy Verification

### Manual checklist

| Test | Expected |
|------|----------|
| Landing page loads | No console errors |
| Clerk sign-in | Redirect to dashboard |
| Dashboard | Stats, streak, missions render |
| DSA page | Platform stats and heatmap |
| Platform sync | Manual sync returns per-platform status |
| SSE events | Real-time updates after sync |
| Logout | Redirect to landing |

### Health endpoints

```bash
curl https://your-api.render.com/health
curl https://your-api.render.com/health/detailed  # requires admin auth
```


### Common issues


| Issue | Fix |
|-------|-----|
| CORS errors | Set `CORS_ORIGIN` to exact Vercel URL (HTTPS) |
| 401 on API calls | Verify `CLERK_SECRET_KEY` and frontend Clerk key match the same Clerk app |
| MongoDB connection failed | Check `MONGODB_URI` in Render variables |
| Blank frontend page | Verify `VITE_API_BASE_URL` in Vercel build env |
| Workers not processing | Confirm `REDIS_URL` is set and worker services are running |
| AI features unavailable | Set `OPENAI_API_KEY` or `GEMINI_API_KEY` |

---

## Related Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Worker topology and queue names
- [README.md](./README.md) - Local development setup
- [PROJECT_STATUS.md](./PROJECT_STATUS.md) - Known production gaps

## Daily challenge tiers

Before deploying issue #96 to an existing database:

1. Stop API and sync workers that read or write daily challenges. Keep old
   versions stopped until the new version is deployed.
2. From `backend/`, explicitly set `MONGODB_URI` to the intended database and run
   `npm run migrate:daily-challenge-tiers`.
3. Deploy the new code and restart writers.

The migration first creates the unique `{ date: 1, difficulty: 1 }` index,
then removes the old unique date-only index. It is safe to rerun. No challenge
documents, completion counts, IDs, or XP transactions are rewritten. Existing
challenges remain the challenge for their date and tier; missing tiers are
created lazily. Fresh databases get the compound index from the model.

Difficulty is selected per user on each request using the existing streak
rules and the user's local weekday. A change in streak may select a different
tier; completion and rewards are tracked independently per tier through the
existing user/challenge XP ledger key. New tier completion counts start at zero.

Do not roll back to date-only uniqueness after multiple tiers exist without a
separate data migration. This command does not perform that rollback.
