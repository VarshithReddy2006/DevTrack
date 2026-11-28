import type { ConceptDefinition } from './concepts.types.js';

export const SYSTEM_DESIGN_CATALOG: ConceptDefinition[] = [
  // ─── Beginner ───
  {
    id: 'sd-api-protocols',
    domain: 'system-design',
    title: 'Client–Server & API Protocols (REST vs GraphQL vs gRPC)',
    subtitle: 'Choosing request semantics, serialization, and transport framing across service boundaries',
    level: 'beginner',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 15,
    summary:
      'REST optimizes public cacheability with resource URIs, GraphQL eliminates client over-fetching across nested graphs, and gRPC drives low-latency strongly typed internal RPC over HTTP/2.',
    architectureFlow: [
      'Client prepares request payload and selects protocol based on caller (browser vs service-to-service).',
      'API Gateway terminates TLS and routes REST/GraphQL JSON or passes HTTP/2 streams to gRPC backends.',
      'Contract validation checks REST OpenAPI schema, GraphQL AST depth limits, or Protobuf binary fields.',
      'Server processes domain query and returns HTTP status + ETag (REST), typed graph slice (GraphQL), or Protobuf response (gRPC).',
    ],
    tradeOffs: [
      {
        topic: 'REST (HTTP JSON)',
        whenToUse: 'Public APIs, CRUD resources, CDN/HTTP caching via GET + ETag.',
        whenToAvoid: 'Deeply nested UI screens requiring 5+ chained round-trips.',
        alternative: 'GraphQL / BFF aggregation',
      },
      {
        topic: 'GraphQL',
        whenToUse: 'Mobile/web clients with diverse data shapes needing single-roundtrip field selection.',
        whenToAvoid: 'File uploads, simple high-QPS cacheable reads, or unbounded N+1 query graphs.',
        alternative: 'REST + query projection',
      },
      {
        topic: 'gRPC (Protobuf + HTTP/2)',
        whenToUse: 'Internal microservice meshes, bidirectional streaming, strict polyglot schemas.',
        whenToAvoid: 'Direct browser calls without gRPC-Web proxy or human-inspectable payloads.',
        alternative: 'REST over HTTP/2',
      },
    ],
    scaleBenchmarks: [
      { label: 'Protobuf vs JSON Payload', value: '3–5x smaller', note: 'Binary wire format cuts serialization CPU & bandwidth' },
      { label: 'gRPC P99 Internal Latency', value: '1–5 ms', note: 'Multiplexed HTTP/2 streams reuse persistent TCP' },
    ],
    rapidQA: [
      {
        id: 'sd-api-q1',
        question: 'Why does GraphQL struggle with standard CDN HTTP caching compared to REST?',
        answer:
          'Most GraphQL requests use HTTP POST with varying query bodies to a single /graphql endpoint, bypassing URL-keyed CDN GET caches unless Persisted Queries + GET are explicitly configured.',
      },
      {
        id: 'sd-api-q2',
        question: 'When should you prefer gRPC over REST between backend services?',
        answer:
          'When internal services exchange high-QPS payloads where strong backward-compatible Protobuf contracts, HTTP/2 multiplexing, and streaming outweigh browser human-readability.',
      },
    ],
    practicePrompt: 'Design API boundaries for an e-commerce checkout platform: external storefront vs internal inventory & payment services.',
  },
  {
    id: 'sd-dns-cdn',
    domain: 'system-design',
    title: 'DNS & CDN Edge Caching',
    subtitle: 'Routing users geographically and offloading static & semi-dynamic reads at the edge',
    level: 'beginner',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 15,
    summary:
      'Recursive DNS resolves domains using GeoDNS or Anycast IPs to point clients to the nearest CDN Point of Presence (PoP), cutting origin bandwidth and RTT.',
    architectureFlow: [
      'Browser checks local cache -> OS resolver -> ISP recursive DNS resolver.',
      'Authoritative nameserver returns Anycast IP of nearest CDN PoP via GeoDNS.',
      'Client hits CDN edge: Cache Hit serves asset in < 20ms with Cache-Control headers.',
      'Cache Miss triggers Origin Shield / Origin fetch, caches response according to TTL, and serves client.',
    ],
    tradeOffs: [
      {
        topic: 'Pull CDN',
        whenToUse: 'Most web traffic with dynamic/long-tail assets (on-demand origin fetch on first miss).',
        whenToAvoid: 'Predictable massive launch events without cache warming (thundering herd risk).',
        alternative: 'Origin Shield + Pre-warmed Push CDN',
      },
      {
        topic: 'Long Cache TTL + Content Hash',
        whenToUse: 'Immutable hashed JS/CSS bundles and media uploads (max-age=31536000, immutable).',
        whenToAvoid: 'Unversioned HTML manifests or rapidly mutating personalized feeds.',
        alternative: 'Short s-maxage + stale-while-revalidate',
      },
    ],
    scaleBenchmarks: [
      { label: 'CDN Edge Hit Latency', value: '10–30 ms', note: 'Versus 120–300 ms cross-continent origin trip' },
      { label: 'Origin Offload Ratio', value: '85–98%', note: 'For static media and cacheable API reads' },
    ],
    rapidQA: [
      {
        id: 'sd-cdn-q1',
        question: 'How do you invalidate stale files on a CDN instantly without waiting for TTL expiry?',
        answer:
          'Best practice is content-addressed versioned URLs (app.a8f31.js) so old and new assets coexist cleanly; use surrogate-key purges only for mutable metadata paths.',
      },
      {
        id: 'sd-cdn-q2',
        question: 'What role does Anycast play in modern CDNs and DNS?',
        answer:
          'Multiple global PoPs announce the same IP prefix via BGP; network routers naturally steer each client packet to the topologically closest healthy edge node.',
      },
    ],
    practicePrompt: 'Design asset delivery for a global SaaS dashboard serving 10TB/day of static bundles and user avatars.',
  },
  {
    id: 'sd-scaling',
    domain: 'system-design',
    title: 'Horizontal vs Vertical Scaling & Stateless Tiers',
    subtitle: 'Eliminating single-node ceilings and session affinity bottlenecks',
    level: 'beginner',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 12,
    summary:
      'Vertical scaling hits hardware cost and SPOF walls; horizontal scaling distributes load across commodity instances by keeping application nodes stateless and externalizing state.',
    architectureFlow: [
      'Move in-memory HTTP sessions and local uploads out of app servers into Redis and object storage (S3).',
      'Front fleet with a load balancer + autoscaling group driven by CPU, latency P99, or queue depth.',
      'Add new stateless replicas behind the load balancer with zero data migration overhead.',
      'Drain connections gracefully during scale-in using SIGTERM and readiness probes.',
    ],
    tradeOffs: [
      {
        topic: 'Vertical Scaling (Scale Up)',
        whenToUse: 'Early-stage monoliths or single-writer relational databases where distributed coordination hurts.',
        whenToAvoid: 'HA workloads (single machine = single point of failure) or elastic traffic spikes.',
        alternative: 'Horizontal read replicas + stateless app tier',
      },
      {
        topic: 'Horizontal Scaling (Scale Out)',
        whenToUse: 'Web/API tiers, workers, partitioned caches, and sharded data stores.',
        whenToAvoid: 'Small internal tools where ops simplicity of one box outweighs distributed complexity.',
        alternative: 'Right-sized single instance + automated snapshots',
      },
    ],
    scaleBenchmarks: [
      { label: 'Stateless Node Boot Target', value: '< 15–30 s', note: 'Fast container startup allows reactive autoscaling' },
      { label: 'Single Node Ceiling', value: '~10k–50k RPS', note: 'CPU/NIC limits make multi-instance pools mandatory' },
    ],
    rapidQA: [
      {
        id: 'sd-scale-q1',
        question: 'Why must web servers be stateless before adding an autoscaling group?',
        answer:
          'If session state or uploaded files live in a single instance RAM/disk, round-robin requests lose sessions and scale-in termination drops user data.',
      },
      {
        id: 'sd-scale-q2',
        question: 'What happens if you autoscale the API tier 10x without scaling the database connection pool?',
        answer:
          'Each new app server opens more DB connections, exhausting max_connections and crashing Postgres; you need a pooler like PgBouncer or DB read replicas.',
      },
    ],
    practicePrompt: 'Refactor a stateful single-server Express app (in-memory sessions + local disk uploads) to autoscale to 20 nodes.',
  },
  {
    id: 'sd-load-balancing',
    domain: 'system-design',
    title: 'Load Balancing (L4 vs L7, Consistent Hashing & Health Checks)',
    subtitle: 'Distributing traffic reliably with minimal tail latency and failover',
    level: 'beginner',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 15,
    summary:
      'L4 balancers forward raw TCP packets at line rate while L7 reverse proxies inspect HTTP paths/headers for smart routing, TLS termination, and graceful health-checked failover.',
    architectureFlow: [
      'Client connects to L4 NLB (IP/port) or L7 ALB/Nginx terminating TLS.',
      'Balancer applies routing algorithm: Round Robin, Least Connections, or Consistent Hash.',
      'Periodic active/passive health checks evict unhealthy targets automatically.',
      'Dual active/passive HA load balancers use VIP/DNS failover so the balancer itself is not a SPOF.',
    ],
    tradeOffs: [
      {
        topic: 'Layer 4 (Transport TCP/UDP)',
        whenToUse: 'Ultra-high packet throughput, WebSocket pass-through, minimal proxy latency.',
        whenToAvoid: 'Path-based routing (/api vs /static), header inspection, or HTTP rate limiting.',
        alternative: 'L7 Application Load Balancer',
      },
      {
        topic: 'Least Connections vs Round Robin',
        whenToUse: 'Heterogeneous request costs (AI inference, heavy reports) where some nodes stay busy longer.',
        whenToAvoid: 'Trivial uniform sub-millisecond requests where stateless Round Robin has lower overhead.',
        alternative: 'Weighted Round Robin / Power of Two Choices',
      },
    ],
    scaleBenchmarks: [
      { label: 'L4 Proxy Overhead', value: '< 1 ms', note: 'Kernel/DPDK packet forwarding handles millions of PPS' },
      { label: 'Consistent Hash Rebalance', value: 'O(K / N) keys', note: 'Only 1/N keys move when adding a cache/shard node' },
    ],
    rapidQA: [
      {
        id: 'sd-lb-q1',
        question: 'When does Round Robin cause uneven load across healthy backend nodes?',
        answer:
          'When request durations vary wildly (e.g., 5ms cache hits vs 4s PDF exports), a node receiving heavy requests accumulates queued sockets unless Least Connections is used.',
      },
      {
        id: 'sd-lb-q2',
        question: 'How do you keep a Load Balancer itself from becoming a Single Point of Failure?',
        answer:
          'Deploy LBs in redundant pairs (Active-Active behind DNS/Anycast or Active-Passive with VRRP/Floating IP health heartbeats).',
      },
    ],
    practicePrompt: 'Design a two-tier ingress layer handling TLS termination, canary header routing, and WebSocket streams.',
  },
  {
    id: 'sd-sql-nosql-indexing',
    domain: 'system-design',
    title: 'SQL vs NoSQL & Database Indexing',
    subtitle: 'Choosing relational ACID guarantees vs horizontal document/wide-column models',
    level: 'beginner',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 18,
    summary:
      'Relational databases enforce ACID joins and strict constraints via B+ Tree indexes; NoSQL stores trade arbitrary joins for predictable partition-key throughput and flexible schemas.',
    architectureFlow: [
      'Identify access patterns first: transactional invariants vs partition-scoped time-series/events.',
      'Select primary store: PostgreSQL for financial/relational integrity; DynamoDB/Cassandra/MongoDB for massive write scale or nested docs.',
      'Create composite B-Tree indexes matching equality-first, range-last WHERE clauses.',
      'Monitor query EXPLAIN plans to eliminate full table scans and write amplification on hot columns.',
    ],
    tradeOffs: [
      {
        topic: 'Relational (PostgreSQL / MySQL)',
        whenToUse: 'Complex multi-table joins, financial ledgers, ACID constraints, moderate scale.',
        whenToAvoid: 'Write-heavy telemetry streams needing 100k+ writes/sec across multi-region shards.',
        alternative: 'DynamoDB / Cassandra / ClickHouse',
      },
      {
        topic: 'NoSQL (Document / Wide-Column)',
        whenToUse: 'Known key/partition access patterns, horizontal sharding out of the box, semi-structured data.',
        whenToAvoid: 'Ad-hoc cross-entity reporting or multi-document ACID workflows by default.',
        alternative: 'Relational DB + JSONB columns',
      },
    ],
    scaleBenchmarks: [
      { label: 'Indexed Point Lookup', value: '< 2 ms', note: '3–4 B+ Tree page hops even at 100M+ rows' },
      { label: 'Single Postgres Write Node', value: '5k–15k TPS', note: 'Before requiring sharding or write offloading' },
    ],
    rapidQA: [
      {
        id: 'sd-db-q1',
        question: 'Why does adding 10 indexes slow down writes even as it speeds up reads?',
        answer:
          'Every INSERT, UPDATE, or DELETE on indexed columns must also update every secondary B+ Tree index structure synchronously on disk and WAL.',
      },
      {
        id: 'sd-db-q2',
        question: 'Can PostgreSQL handle semi-structured data without migrating to MongoDB?',
        answer:
          'Yes — PostgreSQL JSONB with GIN indexing supports flexible attributes inside ACID relational tables.',
      },
    ],
    practicePrompt: 'Choose storage engines and indexes for an order-management system (ACID payments + 50M immutable clickstream events/day).',
  },

  // ─── Intermediate ───
  {
    id: 'sd-caching-patterns',
    domain: 'system-design',
    title: 'Caching Patterns (Cache-Aside, Write-Through, LRU & Stampede Prevention)',
    subtitle: 'Keeping read-heavy workloads sub-millisecond without serving corrupted stale state',
    level: 'intermediate',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 18,
    summary:
      'Distributed in-memory caches absorb read spikes via Cache-Aside, enforce freshness with TTL + explicit invalidation, and survive cold misses using singleflight coalescing.',
    architectureFlow: [
      'Application checks Redis key first; on Cache Hit return parsed value immediately (< 2ms).',
      'On Cache Miss acquire per-key mutex/singleflight lock to prevent 1,000 requests hitting DB at once.',
      'Query primary DB once, populate Redis with base TTL + random jitter (preventing synchronized expiry).',
      'On write mutations update DB first, then delete/update Redis key.',
    ],
    tradeOffs: [
      {
        topic: 'Cache-Aside (Lazy Loading)',
        whenToUse: 'General read-heavy endpoints; cache only hot keys and survive Redis downtime gracefully.',
        whenToAvoid: 'First-request cold-start spikes unless mitigated with pre-warming.',
        alternative: 'Write-Through for predictable hot profiles',
      },
      {
        topic: 'Write-Behind (Write-Back)',
        whenToUse: 'High-frequency counters, view counts, or telemetry batched asynchronously to DB.',
        whenToAvoid: 'Financial or mission-critical state where Redis crash loses un-flushed writes.',
        alternative: 'Write-Through / Synchronous DB commit',
      },
    ],
    scaleBenchmarks: [
      { label: 'Redis Single-Core Throughput', value: '80k–100k ops/s', note: 'Sub-millisecond RAM lookup vs 5–20ms DB scan' },
      { label: 'Target Hit Ratio', value: '> 90%', note: 'Below 70% means wrong key granularity or short TTL' },
    ],
    rapidQA: [
      {
        id: 'sd-cache-q1',
        question: 'What is a cache stampede (thundering herd) and how do you stop it?',
        answer:
          'When a hot key expires under high concurrency, thousands of requests miss simultaneously and overload the DB. Prevent it with request coalescing (singleflight locks), TTL jitter, or background refresh.',
      },
      {
        id: 'sd-cache-q2',
        question: 'What is cache penetration and how does a Bloom filter prevent it?',
        answer:
          'Requests for non-existent IDs bypass both cache and DB repeatedly. Cache short-lived null tombstones or filter impossible keys upfront using an in-memory Bloom filter.',
      },
    ],
    practicePrompt: 'Protect a product catalog service (50k read QPS, 500 writes/sec) from hot-key expiry stampedes.',
  },
  {
    id: 'sd-replication-sharding',
    domain: 'system-design',
    title: 'Database Replication & Sharding',
    subtitle: 'Scaling read throughput, high availability, and petabyte-scale writes',
    level: 'intermediate',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 20,
    summary:
      'Replication duplicates data onto followers for reads and HA failover; sharding horizontally splits datasets across independent primaries using high-cardinality shard keys.',
    architectureFlow: [
      'Step 1 (Reads & HA): Stream WAL/binlog from Primary to Read Replicas asynchronously or semi-synchronously.',
      'Step 2 (Read-Your-Writes): Route a user’s reads immediately after mutation to Primary or pinned LSN replica.',
      'Step 3 (Writes Exceed Single Node): Partition table horizontally by shard key (e.g., tenantId or userId hash).',
      'Step 4 (Routing): Stateless query router / coordinator maps shard key to owning cluster.',
    ],
    tradeOffs: [
      {
        topic: 'Read Replicas Only',
        whenToUse: 'Read-to-write ratio > 10:1 where all writes fit comfortably on one primary.',
        whenToAvoid: 'Write bottlenecks or datasets larger than single-disk NVMe limits.',
        alternative: 'Vertical primary upgrade -> Functional partitioning -> Sharding',
      },
      {
        topic: 'Hash-Based vs Range-Based Sharding',
        whenToUse: 'Hash distributes celebrity writes evenly; Range supports efficient sequential time-window scans.',
        whenToAvoid: 'Range sharding monotonic timestamps (puts 100% of current writes on latest shard!).',
        alternative: 'Composite key (tenantHash + timestamp)',
      },
    ],
    scaleBenchmarks: [
      { label: 'Async Replication Lag', value: '10–200 ms', note: 'Cause of stale-read bugs after write' },
      { label: 'Cross-Shard Join Penalty', value: '10x+ latency', note: 'Requires scatter-gather + app-level merge' },
    ],
    rapidQA: [
      {
        id: 'sd-shard-q1',
        question: 'How do you fix read-your-own-writes inconsistency with async read replicas?',
        answer:
          'Route reads from a user within 1–2 seconds of their write to the Primary, or attach a monotonic commit LSN token so replicas wait until caught up.',
      },
      {
        id: 'sd-shard-q2',
        question: 'Why does sharding by created_at timestamp create a hot shard?',
        answer:
          'All live INSERT traffic lands on the newest time range while older shards sit idle; hash-salting or sharding by userId/tenantId spreads writes across every shard.',
      },
    ],
    practicePrompt: 'Partition a multi-tenant analytics DB growing 2TB/month while keeping per-tenant dashboards fast.',
  },
  {
    id: 'sd-async-queues',
    domain: 'system-design',
    title: 'Async Queues & Message Brokers (Kafka, RabbitMQ, BullMQ, DLQ)',
    subtitle: 'Decoupling spikes, smoothing backpressure, and handling poison messages safely',
    level: 'intermediate',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 18,
    summary:
      'Message queues buffer sudden bursts so downstream slow services stay resilient; idempotent consumers and Dead-Letter Queues (DLQs) guarantee at-least-once delivery without data loss.',
    architectureFlow: [
      'Producer validates request, persists domain state, and publishes event/job with unique idempotencyKey.',
      'Broker persists message in partitioned commit log (Kafka) or prioritized job queue (BullMQ/RabbitMQ).',
      'Worker pool pulls at controlled concurrency; slow spikes build queue lag instead of crashing origin APIs.',
      'Failed jobs retry with exponential backoff + jitter; exhausted failures route to DLQ for inspection.',
    ],
    tradeOffs: [
      {
        topic: 'Apache Kafka (Append-Only Partitioned Log)',
        whenToUse: 'High-throughput event streaming, multiple independent consumer groups, replayable history.',
        whenToAvoid: 'Simple delayed per-job priorities or ad-hoc single-task routing.',
        alternative: 'RabbitMQ / Redis BullMQ',
      },
      {
        topic: 'Task Queue (BullMQ / SQS / RabbitMQ)',
        whenToUse: 'Work queues (emails, video transcoding, webhooks) with ack-on-complete and delayed retries.',
        whenToAvoid: 'Replaying multi-week event streams to build fresh analytics materialized views.',
        alternative: 'Kafka / Pulsar',
      },
    ],
    scaleBenchmarks: [
      { label: 'Kafka Partition Throughput', value: '100k+ msgs/sec', note: 'Sequential disk I/O + zero-copy sendfile' },
      { label: 'DLQ Alert Threshold', value: '> 0 unacked', note: 'Poison pills must never block healthy partitions indefinitely' },
    ],
    rapidQA: [
      {
        id: 'sd-queue-q1',
        question: 'Why is exactly-once delivery usually implemented as at-least-once + idempotent consumers?',
        answer:
          'Network drops after processing but before ACK force brokers to redeliver. Storing processed message IDs or idempotency keys in the target DB makes duplicate processing harmless.',
      },
      {
        id: 'sd-queue-q2',
        question: 'What is a poison pill message and how does a DLQ save your worker fleet?',
        answer:
          'A malformed event that crashes workers on every attempt. Moving it to a Dead-Letter Queue after N bounded retries prevents infinite crash loops and unblocks remaining jobs.',
      },
    ],
    practicePrompt: 'Design an image-processing & webhook delivery pipeline absorbing 10x flash-sale spikes cleanly.',
  },
  {
    id: 'sd-rate-limiting-gateways',
    domain: 'system-design',
    title: 'Rate Limiting & API Gateways (Token Bucket, Sliding Window, Circuit Breakers)',
    subtitle: 'Protecting origin services against abuse, noisy neighbors, and cascading failure',
    level: 'intermediate',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 16,
    summary:
      'Distributed rate limiters in Redis Lua scripts cap abuse at the API gateway while Circuit Breakers trip quickly when downstream dependencies degrade.',
    architectureFlow: [
      'Incoming request hits API Gateway; extract client key (userId, API key, or IP).',
      'Gateway executes atomic Redis Lua check (Token Bucket or Sliding Window Counter).',
      'Under quota -> forward downstream; Over quota -> return HTTP 429 with Retry-After header.',
      'Downstream timeout rates > threshold trip Circuit Breaker Open -> fail fast in < 1ms instead of piling threads.',
    ],
    tradeOffs: [
      {
        topic: 'Token Bucket',
        whenToUse: 'Standard APIs allowing short legitimate bursts up to bucket capacity while averaging steady RPS.',
        whenToAvoid: 'Downstream legacy targets that cannot tolerate any short burst above steady rate.',
        alternative: 'Leaky Bucket (FIFO queue shaping)',
      },
      {
        topic: 'Sliding Window Log vs Fixed Window Counter',
        whenToUse: 'Sliding Window prevents 2x edge spikes across minute boundary resets.',
        whenToAvoid: 'Storing raw timestamps per request at millions of RPS per user.',
        alternative: 'Sliding Window Weighted Counter (O(1) memory)',
      },
    ],
    scaleBenchmarks: [
      { label: 'Redis Lua Limiter Overhead', value: '0.5–1.5 ms', note: 'Atomic eval avoids check-then-set race conditions' },
      { label: 'Circuit Breaker Half-Open Probe', value: '1–5 requests', note: 'Gradually verifies dependency recovery' },
    ],
    rapidQA: [
      {
        id: 'sd-rl-q1',
        question: 'Why does a Fixed Window counter allow double the intended rate limit at minute boundaries?',
        answer:
          'A user can send N requests at 12:00:59 and N more at 12:01:01 — firing 2N requests within 2 seconds cleanly.',
      },
      {
        id: 'sd-rl-q2',
        question: 'Should a rate limiter fail-open or fail-closed if Redis goes down temporarily?',
        answer:
          'For normal SaaS APIs, fail-open with local in-memory fallback limits avoids an outage; for payment/auth endpoints, fail-closed or strict fallback limits protect integrity.',
      },
    ],
    practicePrompt: 'Implement a multi-tier distributed rate limiter (per-user + per-IP) across 15 stateless gateway instances.',
  },
  {
    id: 'sd-realtime-transport',
    domain: 'system-design',
    title: 'Real-Time Transport (Polling, WebSockets & Server-Sent Events)',
    subtitle: 'Delivering live dashboards, chat, and presence updates at low overhead',
    level: 'intermediate',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: false,
    estimatedMinutes: 15,
    summary:
      'Choose SSE for unidirectional server push over standard HTTP, WebSockets for low-latency bidirectional frames, and short/long polling when proxy environments block upgrades.',
    architectureFlow: [
      'Client opens persistent SSE EventSource or upgrades HTTP connection to full-duplex WebSocket (101 Switching Protocols).',
      'Connection Gateway registers userId -> socket mapping in local memory + Redis Pub/Sub.',
      'Backend worker publishes event to Redis Pub/Sub / Kafka channel for target user/room.',
      'Gateway holding the live TCP socket pushes frame immediately; client reconnects with Last-Event-ID on drop.',
    ],
    tradeOffs: [
      {
        topic: 'Server-Sent Events (SSE)',
        whenToUse: 'Live notifications, telemetry feeds, LLM token streaming (built-in reconnect & HTTP/2 friendly).',
        whenToAvoid: 'Client-to-server high-frequency binary streaming (multiplayer gaming, audio).',
        alternative: 'WebSockets / WebRTC',
      },
      {
        topic: 'WebSockets',
        whenToUse: 'Bidirectional chat, collaborative editing (CRDT/OT), live trading terminals.',
        whenToAvoid: 'Rare server updates where stateful sticky connections complicate autoscaling.',
        alternative: 'SSE or Short Polling',
      },
    ],
    scaleBenchmarks: [
      { label: 'Concurrent Sockets / Node', value: '50k–200k', note: 'Limited mainly by file descriptors and RAM (~20KB/conn)' },
      { label: 'Heartbeat Interval', value: '15–30 s', note: 'Prevents NAT/load-balancer idle socket timeouts' },
    ],
    rapidQA: [
      {
        id: 'sd-rt-q1',
        question: 'How does Server A deliver a WebSocket message to a user connected to Server B?',
        answer:
          'Servers subscribe to a shared Pub/Sub backbone (Redis Pub/Sub or Kafka). Server A publishes to the recipient channel and Server B forwards it down the local open socket.',
      },
      {
        id: 'sd-rt-q2',
        question: 'Why use SSE over WebSockets for AI token streaming or live notifications?',
        answer:
          'SSE uses plain HTTP, inherits automatic reconnection with Last-Event-ID, traverses corporate proxies reliably, and needs zero custom framing when updates only flow server -> client.',
      },
    ],
    practicePrompt: 'Architect a live telemetry & notification fanout layer supporting 500k concurrent browser connections.',
  },

  // ─── Advanced ───
  {
    id: 'sd-monolith-vs-microservices',
    domain: 'system-design',
    title: 'Modular Monolith vs Microservices',
    subtitle: 'Balancing deployment independence and org scaling against distributed operational tax',
    level: 'advanced',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: false,
    estimatedMinutes: 16,
    summary:
      'Start with a well-bounded Modular Monolith to avoid network serialization, distributed tracing, and partial failure overhead; extract microservices only along clear scaling or team boundaries.',
    architectureFlow: [
      'Enforce strict module interfaces and separate DB schemas inside a single deployable Modular Monolith.',
      'Identify bottlenecks with high independent churn, asymmetric CPU/GPU needs, or compliance isolation.',
      'Extract candidate service using the Strangler Fig pattern behind an API Gateway.',
      'Replace shared in-process transactions with versioned RPC contracts and async domain events.',
    ],
    tradeOffs: [
      {
        topic: 'Modular Monolith',
        whenToUse: 'Small-to-mid teams (< 30 engineers), tightly coupled domains, rapid iteration.',
        whenToAvoid: 'Wildly different runtime/hardware requirements (e.g., GPU ML worker vs low-RAM Go edge API).',
        alternative: 'Core Monolith + isolated heavy workers',
      },
      {
        topic: 'Microservices',
        whenToUse: 'Large autonomous squads owning independent SLAs, databases, and release cadences.',
        whenToAvoid: 'Early-stage startups creating a "distributed monolith" with chatty synchronous chains.',
        alternative: 'Modular Monolith',
      },
    ],
    scaleBenchmarks: [
      { label: 'In-Process vs Network Hop', value: '~100 ns vs ~1–5 ms', note: 'Four orders of magnitude latency difference' },
      { label: 'Availability Math (10 Serial Calls)', value: '0.999^10 = 99.0%', note: 'Chained RPCs multiply outage blast radius' },
    ],
    rapidQA: [
      {
        id: 'sd-ms-q1',
        question: 'What is a Distributed Monolith and why is it the worst of both worlds?',
        answer:
          'Services deployed separately that still share one database or require lockstep deployments and synchronous RPC chains — giving network latency/failure without independent velocity.',
      },
      {
        id: 'sd-ms-q2',
        question: 'How does the Strangler Fig pattern safely migrate legacy systems?',
        answer:
          'Place a routing proxy in front of the monolith and incrementally peel off individual routes/domains to new services without a risky big-bang rewrite.',
      },
    ],
    practicePrompt: 'Decide which 2 services to extract first from a 15-engineer SaaS monolith and how to split their database tables.',
  },
  {
    id: 'sd-sagas-outbox',
    domain: 'system-design',
    title: 'Event-Driven Sagas & Transactional Outbox Pattern',
    subtitle: 'Maintaining cross-service business consistency without blocking distributed locks',
    level: 'advanced',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 20,
    summary:
      'Because a DB commit and Kafka publish cannot share an atomic transaction cleanly, write events to an Outbox table in the same local ACID transaction and coordinate multi-step workflows with compensating Sagas.',
    architectureFlow: [
      'Service begins local DB transaction: writes domain row (Order = PENDING) + inserts Outbox row atomically.',
      'CDC relay (Debezium) or polling publisher forwards Outbox rows to Kafka/broker with at-least-once guarantee.',
      'Saga orchestrator triggers step 2 (Reserve Inventory) and step 3 (Charge Card).',
      'If Charge fails, Saga executes compensating actions (Release Inventory, Order = CANCELLED) idempotently.',
    ],
    tradeOffs: [
      {
        topic: 'Choreography Saga (Events Only)',
        whenToUse: 'Simple 2–3 service flows where services react autonomously to domain events.',
        whenToAvoid: 'Complex 6+ step workflows where cyclic dependencies obscure state visibility.',
        alternative: 'Orchestration Saga (Central state machine)',
      },
      {
        topic: 'Transactional Outbox vs Two-Phase Commit (2PC)',
        whenToUse: 'Modern high-throughput microservices needing resilience across independent brokers/DBs.',
        whenToAvoid: 'Strict immediate linearizability across heterogeneous nodes on every read.',
        alternative: 'Single-shard local ACID or Spanner/CockroachDB',
      },
    ],
    scaleBenchmarks: [
      { label: 'Outbox CDC Publish Lag', value: '5–50 ms', note: 'Transaction log tailing avoids polling overhead' },
      { label: 'Compensating Recovery', value: 'Eventual (< 1 s)', note: 'Users see Pending -> Confirmed/Cancelled transitions' },
    ],
    rapidQA: [
      {
        id: 'sd-saga-q1',
        question: 'Why does calling db.save() followed by kafka.publish() cause silent data drift?',
        answer:
          'If db.save() commits and the process crashes or network blips before kafka.publish() succeeds, downstream services never learn of the state change. The Outbox table eliminates this dual-write bug.',
      },
      {
        id: 'sd-saga-q2',
        question: 'Why must every compensating transaction in a Saga be idempotent?',
        answer:
          'Retries from network timeouts mean RefundPayment or ReleaseStock may run twice; checking idempotency keys prevents double refunds.',
      },
    ],
    practicePrompt: 'Model an Order -> Inventory -> Payment -> Shipping checkout saga with failure rollback paths.',
  },
  {
    id: 'sd-multi-region',
    domain: 'system-design',
    title: 'Multi-Region Active-Active Replication & Failover',
    subtitle: 'Surviving entire cloud region outages while cutting global user RTT',
    level: 'advanced',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: false,
    estimatedMinutes: 20,
    summary:
      'Active-Passive standby cuts complexity using periodic WAL shipping, while Active-Active routes users to nearest regional stacks and resolves concurrent cross-region writes via Raft/Paxos or CRDTs.',
    architectureFlow: [
      'GeoDNS / Anycast LBs steer US users to us-east and EU users to eu-central.',
      'Each region runs stateless compute + local Redis cache for fast regional reads.',
      'Replicate writes: home-region ownership (GDPR/user pinned) or global consensus DB (Spanner/CockroachDB) / CRDTs.',
      'Regional health checks trigger automatic BGP/DNS failover within seconds if an entire region drops.',
    ],
    tradeOffs: [
      {
        topic: 'Active-Passive (Warm Standby)',
        whenToUse: 'Strong single-primary ACID workloads where regional failovers are rare DR events.',
        whenToAvoid: 'Global write latency SLA requirements (< 50ms in both Tokyo and Frankfurt).',
        alternative: 'User-sharded Regional Homes (Local primary per user)',
      },
      {
        topic: 'Active-Active Multi-Master',
        whenToUse: '99.999% uptime Tier-0 services or conflict-free counters/presence.',
        whenToAvoid: 'Financial uniqueness constraints unless backed by synchronous cross-region quorum.',
        alternative: 'Write-local-home-region / Async analytics sync',
      },
    ],
    scaleBenchmarks: [
      { label: 'Cross-Ocean Fiber RTT', value: '70–150 ms', note: 'Speed of light in fiber caps synchronous US<->EU consensus' },
      { label: 'DNS Failover Propagation', value: '30–60 s', note: 'Anycast BGP / health-checked global proxies fail over faster (~5s)' },
    ],
    rapidQA: [
      {
        id: 'sd-mr-q1',
        question: 'How do global apps avoid cross-continent write latency without losing consistency?',
        answer:
          'Pin each user or tenant to a Home Region (stored in a small global directory); local reads & writes stay inside their region unless they travel.',
      },
      {
        id: 'sd-mr-q2',
        question: 'What is a Split-Brain scenario during regional failover?',
        answer:
          'When a network partition breaks communication between Region A and B and both promote themselves to Primary, accepting diverging writes. Fencing tokens or Raft quorums prevent this.',
      },
    ],
    practicePrompt: 'Design a GDPR-compliant Active-Active workspace architecture spanning North America, Europe, and APAC.',
  },

  // ─── Case Studies ───
  {
    id: 'sd-case-url-shortener',
    domain: 'system-design',
    title: 'Case Study: URL Shortener (TinyURL)',
    subtitle: 'Read-heavy 100:1 service with Base62 short keys, Redis caching, and high-QPS redirects',
    level: 'case-study',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 20,
    summary:
      'Generate collision-free 7-character Base62 codes via pre-allocated KGS counter ranges, serve HTTP 301/302 redirects from Redis caches, and batch click analytics asynchronously.',
    architectureFlow: [
      'Write path: Client sends POST /shorten -> API claims unique counter ID from ZooKeeper/Redis range -> Base62-encode -> persist in DB.',
      'Read path: GET /:code checks Redis cache first; on miss queries DB by PK, warms cache, returns redirect.',
      'Redirect choice: HTTP 302 if tracking click analytics on origin; HTTP 301 for maximum browser caching.',
      'Analytics: Emit click event asynchronously to Kafka -> ClickHouse/OLAP so DB writes never block redirects.',
    ],
    tradeOffs: [
      {
        topic: 'HTTP 301 (Moved Permanently) vs 302 (Found)',
        whenToUse: '301 offloads traffic directly to browser cache; 302 preserves every click event for analytics.',
        whenToAvoid: 'Using 301 when per-click referrer analytics or editable destination URLs are required.',
        alternative: '302 + edge workers logging asynchronously',
      },
      {
        topic: 'Pre-allocated Counter Ranges vs Random Retry',
        whenToUse: 'Distributed counter ranges guarantee O(1) zero-collision keys with no uniqueness roundtrips.',
        whenToAvoid: 'Predictable sequential keys if enumerability is a security risk (pair with Feistel/HMAC scramble).',
        alternative: '7-char CSPRNG or scrambled Base62',
      },
    ],
    scaleBenchmarks: [
      { label: 'Capacity Math (5 yrs @ 100M/mo)', value: '6B URLs -> ~3 TB', note: '500 bytes/row; 62^7 = 3.5 trillion combinations' },
      { label: 'Read vs Write QPS (100:1)', value: '~4,000 read QPS / 40 write QPS', note: 'Top 20% hot links fit easily in < 20 GB Redis' },
    ],
    rapidQA: [
      {
        id: 'sd-url-q1',
        question: 'Why are 7 characters of Base62 [a-zA-Z0-9] sufficient for a global shortener?',
        answer:
          '62^7 = ~3.52 trillion unique codes; even generating 1,000 links per second takes over 110 years before exhaustion.',
      },
      {
        id: 'sd-url-q2',
        question: 'How do you prevent sequential URL scraping if you use an auto-increment ID + Base62?',
        answer:
          'Apply a reversible 42-bit integer permutation (Feistel cipher or multiplicative hash) before Base62 encoding so codes stay unique without revealing traffic volume.',
      },
    ],
    practicePrompt: 'Sketch complete read/write paths, storage math, and hotspot caching for 10B daily redirects.',
  },
  {
    id: 'sd-case-notification-pipeline',
    domain: 'system-design',
    title: 'Case Study: Notification Pipeline (Push / Email / SMS)',
    subtitle: 'Prioritized multi-channel delivery with user preferences, rate limits, and idempotent retries',
    level: 'case-study',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: false,
    estimatedMinutes: 20,
    summary:
      'Separate urgent OTPs from bulk promos using priority Kafka topics/queues, respect per-user opt-outs and vendor rate limits, and guarantee no duplicate billing/SMS via idempotency keys.',
    architectureFlow: [
      'Upstream services call Notification Gateway with notificationId (idempotency key), userId, priority, and template.',
      'Gateway checks Redis/DB dedup ledger + User Preferences & Quiet Hours before accepting.',
      'Router dispatches critical OTPs to high-priority channel workers and marketing blasts to isolated low-priority queues.',
      'Channel Workers (APNs/FCM, SES, Twilio) adaptively rate-limit vendor APIs, log delivery receipts, and move failures to DLQ.',
    ],
    tradeOffs: [
      {
        topic: 'Separate Queues by Priority & Channel',
        whenToUse: 'Prevent 1M promotional emails from delaying a 2-second login 2FA OTP SMS.',
        whenToAvoid: 'Tiny single-queue setups where marketing campaigns stall transactional alerts.',
        alternative: 'Dedicated Kafka topics per SLA tier',
      },
      {
        topic: 'Provider Abstraction + Multi-Vendor Fallback',
        whenToUse: 'High-SLA OTPs switching Twilio -> Vonage if vendor P99 or 5xx rate spikes.',
        whenToAvoid: 'Over-engineering failover before telemetry warrants it.',
        alternative: 'Circuit-broken single primary vendor + DLQ retry',
      },
    ],
    scaleBenchmarks: [
      { label: 'OTP P99 Delivery SLA', value: '< 3 seconds', note: 'Dedicated fast-lane workers' },
      { label: 'Deduplication Window', value: '24 hrs in Redis', note: 'Prevents embarrassing repeat push bursts on retry' },
    ],
    rapidQA: [
      {
        id: 'sd-notif-q1',
        question: 'How do you stop a retry from texting the user 5 times if Twilio timed out after actually sending?',
        answer:
          'Attach a deterministic idempotencyKey when supported by the vendor and persist per-notification dispatch state locally before retries.',
      },
      {
        id: 'sd-notif-q2',
        question: 'How do you keep a promotional campaign from starving OTP notifications?',
        answer:
          'Isolate queues and worker pools strictly by priority tier (High/Transactional vs Bulk) rather than sharing one FIFO queue.',
      },
    ],
    practicePrompt: 'Design multi-channel notification infrastructure handling 10M daily alerts with quiet-hour batching.',
  },
  {
    id: 'sd-case-realtime-chat',
    domain: 'system-design',
    title: 'Case Study: Real-Time Chat (WhatsApp / Slack)',
    subtitle: 'Stateful WebSocket gateways, causal message ordering, offline sync, and presence fanout',
    level: 'case-study',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 22,
    summary:
      'Maintain persistent WebSockets on Chat Servers mapped via Redis Presence/Routing, persist messages partitioned by conversationId with Snowflake sequence IDs, and push offline alerts via APNs/FCM.',
    architectureFlow: [
      'User opens TLS WebSocket to Chat Gateway; Gateway maps userId -> gatewayNode in Redis Session Store.',
      'Sender emits message -> Chat Service assigns monotonic time-ordered messageId (Snowflake/ULID) and appends to Wide-Column DB (Cassandra/Scylla) keyed by (channelId, messageId).',
      'Service looks up recipient gatewayNode -> delivers via RPC/PubSub to active WebSocket, or triggers Push Notification if offline.',
      'Client emits Delivered/Read ACKs asynchronously; offline reopen syncs delta messages > lastAckedMessageId.',
    ],
    tradeOffs: [
      {
        topic: 'Wide-Column Store (Cassandra/Scylla) vs SQL',
        whenToUse: 'Massive append-heavy time-ordered message history partitioned cleanly by conversationId.',
        whenToAvoid: 'Small workspace tools needing complex multi-channel full-text SQL joins directly.',
        alternative: 'Partitioned Postgres + ElasticSearch indexing',
      },
      {
        topic: 'Group Chat Fanout Limit',
        whenToUse: '1:1 & < 200 member chats push eagerly via PubSub; 100k-member channels page/pull deltas.',
        whenToAvoid: 'Broadcasting typing/presence heartbeats globally across huge channels.',
        alternative: 'Lazy presence heartbeat + debounced group updates',
      },
    ],
    scaleBenchmarks: [
      { label: 'Active Socket Memory', value: '~50k–100k conns / VM', note: 'Lightweight event-loop gateway (Go / Rust / Netty)' },
      { label: 'Message Delivery P95', value: '< 100 ms', note: 'Same-region WebSocket relay' },
    ],
    rapidQA: [
      {
        id: 'sd-chat-q1',
        question: 'Why rely on server-generated Snowflake IDs instead of client timestamps for chat ordering?',
        answer:
          'Client device clocks drift wildly and can be spoofed; Snowflake IDs embedded with server timestamps + sequence bits provide monotonic ordering within a partition.',
      },
      {
        id: 'sd-chat-q2',
        question: 'How does Online/Last Seen presence avoid overwhelming the database with writes?',
        answer:
          'Store ephemeral presence TTL keys (e.g. 30s) in Redis only for active sessions and fetch status on-demand for visible friends rather than broadcasting every ping.',
      },
    ],
    practicePrompt: 'Design delivery receipts (Sent, Delivered, Read) and multi-device sync for 50M daily active chat users.',
  },
  {
    id: 'sd-case-feed-fanout',
    domain: 'system-design',
    title: 'Case Study: Social News Feed Fan-Out (Twitter / X)',
    subtitle: 'Hybrid Fan-Out-on-Write vs Fan-Out-on-Read for regular authors vs mega-celebrities',
    level: 'case-study',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 20,
    summary:
      'Push normal users’ posts into followers’ precomputed Redis timeline lists at write time (O(1) read), while skipping push for celebrities (> 100k followers) and merging their posts at read time.',
    architectureFlow: [
      'Author posts tweet -> persisted in Post DB -> published to Fan-Out Queue.',
      'Normal user (< threshold followers): Fan-Out workers append postId into each active follower’s Redis timeline ZSET.',
      'Celebrity (> threshold followers): Skip follower list push to avoid 50M-write storms; keep in celebrity post cache.',
      'Feed Read: Fetch user’s precomputed Redis ZSET + merge recent posts from followed celebrities + hydrate Post metadata & rank.',
    ],
    tradeOffs: [
      {
        topic: 'Fan-Out-on-Write (Push Model)',
        whenToUse: 'Typical users with tens/hundreds of followers; feed loads are instant single Redis reads.',
        whenToAvoid: 'Users with 50M followers — causes massive write amplification and multi-minute lag.',
        alternative: 'Hybrid Push + Celebrity Pull',
      },
      {
        topic: 'Fan-Out-on-Read (Pull Model)',
        whenToUse: 'Celebrities or inactive users where precomputing unused timelines wastes RAM.',
        whenToAvoid: 'Regular users following 1,000+ accounts (N-way DB merge on every scroll).',
        alternative: 'Hybrid Fan-Out (Industry standard)',
      },
    ],
    scaleBenchmarks: [
      { label: 'Feed Read Latency Target', value: '< 100 ms', note: 'Enabled by precomputed top-800 post IDs per active user' },
      { label: 'Celebrity Cutover Threshold', value: '~50k–100k followers', note: 'Balances Redis RAM vs write worker spikes' },
    ],
    rapidQA: [
      {
        id: 'sd-feed-q1',
        question: 'Why store only post IDs (not full post objects) inside followers’ Redis timeline caches?',
        answer:
          'Saving 8-byte IDs shrinks Redis memory by > 20x, lets deleted/edited posts propagate cleanly during hydration, and separates ranking lists from post content.',
      },
      {
        id: 'sd-feed-q2',
        question: 'Should you waste Redis RAM keeping precomputed timelines for users who have not logged in for 6 months?',
        answer:
          'No — evict inactive user timelines via LRU or only push into timelines of users active within the last 14–30 days; rebuild cold feeds on login.',
      },
    ],
    practicePrompt: 'Balance Redis timeline memory and fan-out worker throughput for 300M MAU with 10k celebrity accounts.',
  },
  {
    id: 'sd-case-uber-geo',
    domain: 'system-design',
    title: 'Case Study: Uber Geo-Dispatch & Nearby Drivers',
    subtitle: 'High-frequency spatial indexing (Geohash / H3 / Quadtree) under 1M location pings/sec',
    level: 'case-study',
    track: 'system-design',
    isOptional: false,
    isHighFrequencyCrashCourse: false,
    estimatedMinutes: 22,
    summary:
      'Partition the world into spatial cells (Google S2 / Uber H3 hexagons or Quadtrees) in distributed in-memory Location Stores so rider queries inspect only nearby cells without scanning global DBs.',
    architectureFlow: [
      'Driver apps emit encrypted GPS ping every 3–5s -> UDP/gRPC Load Balancer -> Location Ingestion Service.',
      'Hasher maps (lat, lng) to H3/S2 spatial Cell ID and updates driver’s ephemeral entry in sharded Redis/In-Memory GeoIndex.',
      'Rider requests ride -> Dispatch queries driver locations in rider’s H3 Cell + 6 neighboring ring cells.',
      'Matching engine scores top candidates by ETA routing graph and uses distributed lock on driver offer to prevent double-booking.',
    ],
    tradeOffs: [
      {
        topic: 'Hexagonal H3 / S2 Grid vs Dynamic Quadtree',
        whenToUse: 'H3 fixed grids offer uniform neighbor distances and O(1) cell lookup; Quadtree adapts to Manhattan vs rural density.',
        whenToAvoid: 'Updating an unbalanced in-memory Quadtree node tree on 1M GPS moves/sec without batching.',
        alternative: 'H3 hierarchy (zoom resolution by city density)',
      },
      {
        topic: 'In-Memory Sharded GeoIndex vs Persistent SQL on Every Ping',
        whenToUse: 'Live GPS updates are ephemeral (stale in 5s); keep live index in RAM and flush trip breadcrumbs async to Kafka/OLAP.',
        whenToAvoid: 'Hitting disk-backed PostGIS B-Trees for 1M updates/sec.',
        alternative: 'RAM ring + async cold trip archive',
      },
    ],
    scaleBenchmarks: [
      { label: 'Driver Write Rate (1M active @ 4s)', value: '~250k writes/sec', note: 'Too fast for single RDBMS; requires sharded RAM cells' },
      { label: 'Dispatch Candidate Query', value: '< 10 ms', note: 'Lookup 1 center cell + 6–8 adjacent cells' },
    ],
    rapidQA: [
      {
        id: 'sd-geo-q1',
        question: 'Why does Geohash prefix matching fail near cell borders and how do you fix it?',
        answer:
          'Two drivers 10 meters apart across a Geohash boundary share almost no prefix. Always query the target cell PLUS all 8 surrounding neighbor cells (ring query).',
      },
      {
        id: 'sd-geo-q2',
        question: 'Why should two nearby drivers not simply be ranked by straight-line Haversine distance?',
        answer:
          'A river or one-way highway divider can turn 200m straight-line distance into a 15-minute drive; dispatch filters by spatial radius first, then ranks top K using road-network ETA.',
      },
    ],
    practicePrompt: 'Design the location update ingestion and atomic driver-offer locking flow for 2M concurrent drivers.',
  },
];
