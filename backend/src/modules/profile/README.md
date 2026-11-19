# Public portfolio cache

`GET /api/v2/portfolio/:username` serves the existing public profile DTO through
Redis. The same handler is available under `/api/v1/portfolio/:username` and the
deprecated `/api/portfolio/:username` alias, through the existing shared ingress
middleware. GET and HEAD are public; the response is identical for every viewer.
The older `/profile/public/:username` endpoint and its view-counting behavior are
unchanged. The new cache endpoint does not record per-request profile views.

## Representation and privacy

- `portfolio:view:<lowercase handle>` stores only serialized, privacy-filtered
  public JSON, its SHA-256 ETag, a source fingerprint and a generation number.
  Private settings, source documents, user IDs, email and viewer information are
  not included in the response body. The response timestamp identifies the
  snapshot's computation time, so the same representation has a stable ETag.
- Every read, **including cache hits and conditional 304s**, checks indexed
  publication metadata and current UserSettings privacy in one MongoDB aggregation
  with an indexed lookup. Handles use the existing publication slug rules. Unpublished,
  private, recruiter-only and unknown profiles return the same 404. A database
  error fails the request rather than authorizing an old cached representation.
- The fingerprint includes publication version, selected sections, current
  privacy, snapshot version/time, anti-gaming review status and public SEO fields.
  Changed permissions or snapshot versions force a new filtered representation,
  even when an administrative/raw database write bypasses cache hooks.
- A cold fill rechecks publication/privacy after loading the snapshot. Concurrent
  changes cause a retry, or HTTP 503 if the source keeps changing. No unpublished
  profile is rebuilt or negative-cached. Old published snapshot formats use the
  existing snapshot rebuilder before being cached.

## TTL, SWR and invalidation

The Redis TTL is one hour. After five minutes, a hit with the **same authorized
source fingerprint** returns immediately and refreshes its representation in the
background. Changed fingerprints never receive this stale treatment. Cold fills
and refreshes are coalesced within one API process, not across API processes.

Each entry is tagged `user:<userId>`. Atomic Lua scripts maintain tag membership
and persistent generation counters. Invalidation advances the generation and
purges all tagged handles; a fill started before invalidation cannot repopulate
the old generation. An ownership marker prevents a former handle owner's tag
from deleting the new owner's cache entry after reassignment. Membership sets
expire shortly after the payload TTL; generation counters remain to prevent
generation-zero reuse by delayed writes. This uses the existing single Redis
client, not Redis Cluster multi-slot scripting.

Profile edits, tech-stack edits, project create/update/delete/sync, publication
changes and snapshot recomputation invalidate the user's tag. UserSettings save
and targeted update/replace/delete queries also purge representations. Raw/bulk
writes and transaction timing cannot be treated as reliable post-commit hooks;
the live source fingerprint remains the privacy boundary. Existing snapshot
rebuild scheduling still determines when changed source data appears in a
published snapshot; cache eviction does not itself verify or rebuild projects.

Redis commands have a 100 ms budget. Read/write/invalidation failures fall back
to authorized MongoDB reads and are logged. They do not reject already committed
profile or project mutations. Invalidation may need a later read to discard an
unusable entry after Redis recovers. The key's source fingerprint must match
before that entry can ever be served.

## HTTP cache policy decision

Successful responses send `Cache-Control: public, max-age=0, must-revalidate` and
a strong ETag. `If-None-Match` supports weak validators, lists and `*` for reads.
Errors use `no-store`.

Issue #444 proposes `public, max-age=300, stale-while-revalidate=86400`. That would
allow a browser/CDN to serve a revoked profile without contacting this API for
five minutes, or potentially longer while stale. Redis invalidation cannot purge
those downstream caches. This implementation preserves the existing publication
flow's next-request privacy revocation using mandatory origin revalidation, with
SWR inside Redis only. A future CDN-specific purge/revocation design would be
needed before safely enabling those HTTP freshness windows.

## Validation and performance boundaries

From `backend/`:

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
npm exec vitest run src/__tests__/modules/profile/portfolioCache.test.ts
$env:PORTFOLIO_PERF = '1'
npm exec vitest run src/__tests__/modules/profile/portfolioCache.test.ts
Remove-Item Env:PORTFOLIO_PERF
```

The opt-in benchmark writes `portfolio-cache-performance.tmp`: 200 serialized
cache-hit reads and 500 HTTP reads at concurrency 20. It uses a real owned
temporary MongoDB replica set and fixture Redis command semantics, with an
isolated HTTP router. It measures neither a live Redis deployment nor the full
API ingress limit. The existing shared IP request budget is retained; this
change does not grant a single IP 500 requests per second.

The sub-5 ms cache-hit and 500 RPS goals depend on MongoDB authorization reads,
network latency and deployment configuration. Local measurements are evidence
about that test environment, not a production guarantee. Live Redis Lua,
cross-process invalidation and deployed/CDN behavior require separate validation.

In the final local regression run, cached service reads measured approximately
4.6 ms median / 7.7 ms p95, and the isolated HTTP benchmark reached about 127 RPS.
These fixture-Redis results do **not** establish consistent sub-5 ms
reads or the 500 RPS goal; both remain performance limitations for review.
