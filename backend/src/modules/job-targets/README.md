# Job target fetching

`jobtarget.submitted` is routed by the existing outbox relay to `jd-fetch` in
the `ai` / `all` worker role. Run the `xp` role as well: it owns that relay.
The worker loads the owned target from MongoDB; URLs in event payloads are ignored.
Pasted text bypasses network and browser work. URL targets use the existing
SSRF-safe static fetch and cleaned main/article/body text. Fewer than 150 words
triggers a sandboxed Chromium fallback. Successful text is bounded to 50,000
characters, persisted as `ready`, and submitted to the existing `jd-parse` queue,
which already queues `jd-score` after parsing.

The fetch worker implements retrieval, not the unfinished storage integration of
those downstream workers. Main's `JobTargetPort` still defaults to an unwired
adapter; a working registered parse/score storage adapter is required for end-to-end
ATS results. Fetching and queue handoff can run independently of that adapter.

## Browser isolation and limits

- Chromium's sandbox stays enabled. Startup fails if the host cannot support it;
  there is no `--no-sandbox` fallback. Supply a compatible Puppeteer Chromium binary
  and its OS dependencies in the ai worker deployment. The existing generic backend
  Docker image is not a verified scraper deployment.
- Chromium uses a pipe for DevTools, a dead fixed HTTP proxy with loopback bypass
  disabled, disabled QUIC and nonproxied WebRTC, and failed browser DNS resolution.
  It never uses `request.continue()`. Allowed GET document/script/style/XHR/fetch
  requests are fulfilled by Node's `safeFetch`, which checks every DNS answer and
  pins the socket to a vetted address. Browser redirects are returned manually so
  their next request is intercepted and screened again.
- An enforced response CSP blocks frames, workers, objects, forms, popups and
  downloads. Service workers and cache are bypassed. Non-HTTP protocols and
  nonstandard subresource ports are refused. Other methods/resources are aborted.
  No upstream cookies, authorization or browser request headers are forwarded;
  public cross-origin GET responses are readable through wildcard CORS. This is
  an unauthenticated public-page renderer, not a user browser session.
- Rendering has one 10-second deadline covering its initial fetch, launch,
  navigation and extraction. Cancellation reaches pending Node sockets; DNS waits
  are bounded too. Cleanup has separate bounded waits, closes the page and browser,
  and kills the owned browser process if graceful close fails. Each render starts
  a disposable browser; one fetch job runs at a time per ai worker process.
- The initial response and subsequent intercepted responses share a 5 MiB budget;
  initial HTTP redirect responses are individually bounded by safeFetch. At most
  100 subsequent requests are admitted. Encoded bodies are refused to avoid
  decompression bypasses. Rendered text also has a 5 MiB check. The JavaScript heap
  is constrained, but these byte limits are not a total Chromium RSS limit; deploy
  with normal process/container memory and egress limits as additional containment.
- A Redis Lua sliding window uses Redis server time and atomically admits at most
  three render attempts per user per 60 seconds, shared across processes. The
  reservation happens before browser launch and fails closed on Redis failure.

Blocked targets and payload violations are permanent fetch failures; transient
network, timeout, rate-budget and queue failures can be retried through the existing
worker/DLQ policy. Persisted failure reasons are codes rather than fetched content.
Text is saved before queue handoff, so a handoff retry reuses saved text. Parse jobs
use a stable target-based id and retain completion for one day (up to 1,000 jobs);
this is bounded queue deduplication, not a permanent exactly-once guarantee.
Deleting a target prevents subsequent owned writes from recreating it.

## Validation

Run `npm run test:job-fetch` and `npm run build` from `backend/`. The focused suite
uses fixture transports and mocked worker adapters, an owned temporary MongoDB
for persistence/ownership/deletion/queue-retry checks, and actual sandboxed Chromium
for JavaScript rendering, redirects and SSRF refusal. It does not contact live job
boards or require a shared MongoDB/Redis server. GET-only access, discarded cookies,
the CSP, payload budgets, unsupported encodings, bot protection and login walls can
prevent some real job boards from rendering; failures remain explicit.

The ordinary backend unit suite includes the mocked browser/worker checks. The
dedicated `test:job-fetch` command additionally runs the actual-browser and owned
MongoDB checks under `tests/`; it requires a working sandboxed Chromium installation.
