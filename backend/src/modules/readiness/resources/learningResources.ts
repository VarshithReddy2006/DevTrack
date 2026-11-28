export interface CrashCourseQA {
  question: string;
  answer: string;
}

export interface CrashCourseContent {
  revisionMinutes: number;
  paretoPriority: number;
  coreConcepts: string[];
  gotchas: string[];
  rapidQA: CrashCourseQA[];
  mustSolveTopics?: string[];
}

export interface LearningResource {
  skill: string;
  whyLearn: string;
  estimatedTime: string;
  practiceProject: {
    title: string;
    description: string;
  };
  resources: Array<{
    title: string;
    type: 'docs' | 'course' | 'video' | 'article';
    url: string;
    provider: string;
  }>;
  crashCourse: CrashCourseContent;
  isFallback?: boolean;
}

function buildFallbackCrashCourse(skill: string): CrashCourseContent {
  return {
    revisionMinutes: 15,
    paretoPriority: 6,
    coreConcepts: [
      `Core mental model and primary use-cases of ${skill}`,
      `Common architecture trade-offs and scaling boundaries in ${skill}`,
      `Failure handling, observability, and testing strategies for ${skill}`,
      `How ${skill} integrates cleanly with adjacent backend/frontend layers`,
    ],
    gotchas: [
      `Choosing ${skill} defaults blindly without measuring latency, memory, or throughput limits`,
      `Skipping error-path tests and timeout configuration in production ${skill} setups`,
    ],
    rapidQA: [
      {
        question: `When should an engineering team choose ${skill} over simpler alternatives?`,
        answer: `Choose ${skill} when its strengths directly address your primary bottleneck—such as concurrency, consistency, or maintainability. Always weigh operational complexity against measurable workload requirements.`,
      },
      {
        question: `What is the first bottleneck or failure mode you check when debugging ${skill} in production?`,
        answer: `Start by inspecting latency percentiles, resource saturation (CPU, memory, connections), and recent configuration or schema changes. Isolate whether the bottleneck stems from I/O contention, unindexed lookups, or missing timeouts.`,
      },
    ],
    mustSolveTopics: ['arrays', 'hashing'],
  };
}

export const STATIC_RESOURCES: Record<string, LearningResource> = {
  'node.js': {
    skill: 'Node.js',
    whyLearn: 'Node.js is the foundation for building scalable, high-performance backend APIs using JavaScript.',
    estimatedTime: '2-3 Weeks',
    practiceProject: {
      title: 'RESTful API with Auth',
      description: 'Build a user authentication API with JWT, password hashing, and express-validator for input validation.'
    },
    resources: [
      { title: 'Node.js Official Documentation', type: 'docs', url: 'https://nodejs.org/en/docs/', provider: 'Official' },
      { title: 'Node.js Crash Course', type: 'video', url: 'https://www.youtube.com/watch?v=fBNz5xF-Kx4', provider: 'Traversy Media' },
      { title: 'Node.js and Express Tutorial', type: 'course', url: 'https://www.freecodecamp.org/news/free-8-hour-node-express-course/', provider: 'freeCodeCamp' }
    ],
    crashCourse: {
      revisionMinutes: 20,
      paretoPriority: 9,
      coreConcepts: [
        'Single-threaded event loop phases: timers → pending callbacks → poll → check → close',
        'Microtasks (Promise.then, queueMicrotask) and process.nextTick drain between phases',
        'Non-blocking libuv thread pool handles fs, crypto, and DNS; network I/O uses OS epoll/kqueue',
        'Streams and backpressure (.pipe / pipeline) prevent memory spikes on large payloads',
        'Graceful shutdown drains active HTTP requests before closing DB/Redis connections',
      ],
      gotchas: [
        'CPU-heavy synchronous work (JSON.parse on huge payloads, tight loops, sync crypto) blocks every concurrent request',
        'Unbounded Promise.all without concurrency limits exhausts DB pools and memory',
        'Forgetting stream error handlers crashes the process with unhandled error events',
      ],
      rapidQA: [
        {
          question: 'How does process.nextTick differ from setImmediate and Promise callbacks?',
          answer: 'process.nextTick runs immediately after the current operation before the event loop moves on, even ahead of Promise microtasks. setImmediate schedules callbacks in the check phase after the poll phase completes.',
        },
        {
          question: 'How do you handle CPU-intensive tasks without blocking the Node.js event loop?',
          answer: 'Offload CPU work to worker_threads or a background job queue like BullMQ running in separate worker processes. Keep the main API event loop dedicated to lightweight I/O orchestration.',
        },
        {
          question: 'Why does stream.pipeline beat chaining .pipe() in production?',
          answer: 'stream.pipeline automatically forwards errors and cleans up all underlying streams when any stage fails or aborts. Raw .pipe() does not destroy upstream/downstream streams on error, causing silent file-descriptor leaks.',
        },
      ],
      mustSolveTopics: ['queue', 'heaps'],
    },
  },
  'react': {
    skill: 'React',
    whyLearn: 'React is the industry standard for building dynamic, component-driven user interfaces.',
    estimatedTime: '3-4 Weeks',
    practiceProject: {
      title: 'E-commerce Dashboard',
      description: 'Build an interactive dashboard with state management, routing, and data fetching from a mock API.'
    },
    resources: [
      { title: 'React Official Documentation', type: 'docs', url: 'https://react.dev/', provider: 'Official' },
      { title: 'React Full Course for free', type: 'video', url: 'https://www.youtube.com/watch?v=bMknfKXIFA8', provider: 'freeCodeCamp' },
      { title: 'Epic React', type: 'course', url: 'https://epicreact.dev/', provider: 'Kent C. Dodds' }
    ],
    crashCourse: {
      revisionMinutes: 25,
      paretoPriority: 10,
      coreConcepts: [
        'Reconciliation diffs virtual trees by element type and stable list keys',
        'Hooks rely on consistent top-level call order across renders; never call conditionally',
        'Separate server state (React Query/SWR) from ephemeral UI state to avoid stale sync bugs',
        'useEffect is for synchronizing with external systems, not deriving renderable values',
        'Concurrent features (useTransition, Suspense) keep inputs responsive during heavy UI updates',
      ],
      gotchas: [
        'Using array index as key on reorderable/filterable lists corrupts component state and focus',
        'Stale closures inside setInterval or async effects missing dependencies read outdated state',
        'Creating inline objects/callbacks inside JSX negates React.memo optimizations downstream',
      ],
      rapidQA: [
        {
          question: 'When should you derive values during render instead of storing them with useEffect + useState?',
          answer: 'Whenever a value can be computed directly from existing props or state, compute it during render (optionally with useMemo if expensive). Using useEffect adds an unnecessary second render pass and risks brief UI flicker.',
        },
        {
          question: 'Why do missing cleanup functions in useEffect cause race conditions on rapid navigation or typing?',
          answer: 'An earlier slow fetch can resolve after a newer request and overwrite fresh state with stale data. Returning an AbortController abort or cancellation flag in cleanup guarantees only the latest request updates state.',
        },
        {
          question: 'What actually triggers a React component re-render?',
          answer: 'A component re-renders when its own state changes, a consumed Context value updates, or its parent re-renders without memoization blocking it. Props changing alone only matter when the parent passes new values during its render.',
        },
      ],
      mustSolveTopics: ['trees', 'recursion'],
    },
  },
  'mongodb': {
    skill: 'MongoDB',
    whyLearn: 'MongoDB is a leading NoSQL database perfect for flexible, document-oriented data storage in modern web apps.',
    estimatedTime: '1-2 Weeks',
    practiceProject: {
      title: 'Blog CMS Database',
      description: 'Design a schema for users, posts, and comments, then implement CRUD operations using Mongoose.'
    },
    resources: [
      { title: 'MongoDB Manual', type: 'docs', url: 'https://www.mongodb.com/docs/manual/', provider: 'Official' },
      { title: 'MongoDB in 100 Seconds', type: 'video', url: 'https://www.youtube.com/watch?v=-bt_y4Loofg', provider: 'Fireship' },
      { title: 'MongoDB University Courses', type: 'course', url: 'https://learn.mongodb.com/', provider: 'Official' }
    ],
    crashCourse: {
      revisionMinutes: 15,
      paretoPriority: 8,
      coreConcepts: [
        'Embed tightly coupled 1-to-few data; reference unbounded 1-to-many data to respect 16MB doc limit',
        'Compound index ESR rule: Equality fields first, Sort fields second, Range fields last',
        'Verify query plans with explain("executionStats") to eliminate COLLSCAN on hot paths',
        'Multi-document ACID transactions require replica sets and carry extra lock/latency overhead',
      ],
      gotchas: [
        'Unindexed regex or leading-wildcard queries trigger full collection scans at scale',
        'Use .lean() in Mongoose read paths when full hydration/save methods are unnecessary',
      ],
      rapidQA: [
        {
          question: 'What is the ESR rule for MongoDB compound indexes?',
          answer: 'Order compound index keys by Equality filters first, Sort fields second, and Range operators last. This minimizes scanned index keys and avoids expensive in-memory sorting.',
        },
        {
          question: 'When should you embed subdocuments versus referencing another collection?',
          answer: 'Embed when child data is bounded, owned exclusively by the parent, and usually read together. Reference when arrays grow unboundedly or subdocuments need independent querying and updates.',
        },
      ],
      mustSolveTopics: ['hashing', 'arrays'],
    },
  },
  'docker': {
    skill: 'Docker',
    whyLearn: 'Required for deployment and containerization. Ensures your application runs consistently across any environment.',
    estimatedTime: '1-2 Weeks',
    practiceProject: {
      title: 'Containerize a Node.js REST API',
      description: 'Write a Dockerfile and docker-compose.yml to containerize a Node.js app alongside a Redis or MongoDB database.'
    },
    resources: [
      { title: 'Docker Official Docs', type: 'docs', url: 'https://docs.docker.com/', provider: 'Official' },
      { title: 'Docker Crash Course', type: 'video', url: 'https://www.youtube.com/watch?v=pg19Z8LL06w', provider: 'TechWorld with Nana' },
      { title: 'Docker for Beginners', type: 'course', url: 'https://www.freecodecamp.org/news/docker-crash-course-for-absolute-beginners/', provider: 'freeCodeCamp' }
    ],
    crashCourse: {
      revisionMinutes: 15,
      paretoPriority: 9,
      coreConcepts: [
        'Copy lockfiles and run npm ci BEFORE copying app source to maximize Docker layer cache hits',
        'Multi-stage builds discard compilers and devDependencies, cutting image size by 60-80%',
        'Run containers as a non-root USER with a defined HEALTHCHECK and .dockerignore',
        'Container filesystems are ephemeral; persist stateful databases with named volumes',
      ],
      gotchas: [
        'Using shell-form CMD wraps PID 1 in /bin/sh, swallowing SIGTERM during graceful shutdown',
        'Leaving secrets in ENV or build ARG layers exposes them permanently in image history',
      ],
      rapidQA: [
        {
          question: 'Why does copying package.json before COPY . . drastically speed up Docker builds?',
          answer: 'Docker caches each layer invalidated only when its inputs change. Copying lockfiles and installing dependencies before source files reuses the cached dependency layer across code-only edits.',
        },
        {
          question: 'Why do production Dockerfiles prefer exec-form CMD ["node", "dist/index.js"] over shell-form?',
          answer: 'Exec-form runs Node directly as PID 1 so SIGTERM/SIGINT signals reach the application immediately for graceful shutdown. Shell-form spawns /bin/sh as PID 1, which often fails to forward termination signals.',
        },
      ],
      mustSolveTopics: ['graphs'],
    },
  },
  'redis': {
    skill: 'Redis',
    whyLearn: 'Critical for high-performance applications. Used for caching, session storage, and message brokering to dramatically speed up APIs.',
    estimatedTime: '1 Week',
    practiceProject: {
      title: 'API Request Caching',
      description: 'Integrate Redis into an Express app to cache expensive database queries and third-party API calls.'
    },
    resources: [
      { title: 'Redis Documentation', type: 'docs', url: 'https://redis.io/docs/', provider: 'Official' },
      { title: 'Redis Crash Course', type: 'video', url: 'https://www.youtube.com/watch?v=jgpVdJB2sKQ', provider: 'Traversy Media' },
      { title: 'Redis as a Database', type: 'article', url: 'https://redis.com/redis-enterprise/use-cases/redis-as-a-database/', provider: 'Redis' }
    ],
    crashCourse: {
      revisionMinutes: 20,
      paretoPriority: 9,
      coreConcepts: [
        'Cache-aside pattern: check cache → on miss load DB and set with jittered TTL → invalidate on write',
        'Core structures: Strings, Hashes, Sorted Sets (ZSET for leaderboards/rate-limit windows), Streams',
        'Eviction policies: use allkeys-lru for caches, never noeviction for pure cache or noeviction only for BullMQ queues',
        'Stampede defense: single-flight coalescing / mutex lock + randomized TTL jitter',
      ],
      gotchas: [
        'Running KEYS * in production blocks the single-threaded Redis server; always use SCAN',
        'Sharing one Redis instance with volatile-lru eviction for both cache and BullMQ loses queued jobs',
      ],
      rapidQA: [
        {
          question: 'How do you prevent a cache stampede when a popular key expires?',
          answer: 'Coalesce concurrent misses per key with an in-process or distributed lock so only one worker recomputes the value, add TTL jitter so keys do not expire simultaneously, and optionally serve stale-while-revalidate.',
        },
        {
          question: 'Why must BullMQ / job-queue Redis instances use noeviction while cache Redis uses LRU?',
          answer: 'LRU/LFU eviction silently drops keys under memory pressure, which would delete queued jobs or distributed locks. Cache instances should evict safely with allkeys-lru, whereas queues require noeviction.',
        },
      ],
      mustSolveTopics: ['hashing', 'heaps'],
    },
  },
  'ci/cd': {
    skill: 'CI/CD',
    whyLearn: 'Continuous Integration and Deployment automates testing and releases, ensuring code quality and rapid delivery.',
    estimatedTime: '2 Weeks',
    practiceProject: {
      title: 'Automated Deployment Pipeline',
      description: 'Set up GitHub Actions to automatically run unit tests and deploy a Dockerized app to a cloud provider on push to main.'
    },
    resources: [
      { title: 'GitHub Actions Documentation', type: 'docs', url: 'https://docs.github.com/en/actions', provider: 'GitHub' },
      { title: 'CI/CD Pipeline with GitHub Actions', type: 'video', url: 'https://www.youtube.com/watch?v=R8_veQiYBjI', provider: 'TechWorld with Nana' },
      { title: 'Continuous Integration', type: 'article', url: 'https://martinfowler.com/articles/continuousIntegration.html', provider: 'Martin Fowler' }
    ],
    crashCourse: {
      revisionMinutes: 15,
      paretoPriority: 7,
      coreConcepts: [
        'Fast fail pipeline stages: lint/typecheck → unit tests → build artifact → integration/E2E → deploy',
        'Cache dependency stores (npm/pip) keyed by lockfile hash and run immutable builds once',
        'Deployment strategies: blue-green, canary rollouts, and health-check-gated automated rollbacks',
        'Store credentials exclusively in masked CI secrets with least-privilege OIDC tokens where possible',
      ],
      gotchas: [
        'Deploying directly from PR forks with write secrets exposes credentials to untrusted code',
        'Database schema migrations must stay backward-compatible with both N-1 and N app versions',
      ],
      rapidQA: [
        {
          question: 'How do you perform zero-downtime database migrations in a CI/CD pipeline?',
          answer: 'Use expand-and-contract migrations: first deploy additive backward-compatible schema changes, roll out the new code writing both formats, and remove old columns in a follow-up deploy.',
        },
      ],
      mustSolveTopics: ['graphs'],
    },
  },
  'testing': {
    skill: 'Testing',
    whyLearn: 'Automated testing prevents regressions and ensures code reliability, an absolute must for senior-level engineering.',
    estimatedTime: '2-3 Weeks',
    practiceProject: {
      title: 'TDD API Development',
      description: 'Build an API strictly using Test-Driven Development (TDD) with Jest and Supertest, achieving 80%+ coverage.'
    },
    resources: [
      { title: 'Jest Documentation', type: 'docs', url: 'https://jestjs.io/docs/getting-started', provider: 'Official' },
      { title: 'Testing Node.js with Jest', type: 'video', url: 'https://www.youtube.com/watch?v=FgnxcUQ5vho', provider: 'Web Dev Simplified' },
      { title: 'JavaScript Testing Best Practices', type: 'article', url: 'https://github.com/goldbergyoni/javascript-testing-best-practices', provider: 'Yoni Goldberg' }
    ],
    crashCourse: {
      revisionMinutes: 15,
      paretoPriority: 8,
      coreConcepts: [
        'Testing Trophy: static types + fast unit tests + real-contract integration tests + critical E2E flows',
        'Test observable behavior and failure paths (4xx/5xx, race conditions, timeouts), not private internals',
        'Isolate flaky clocks/network boundaries cleanly while keeping database/router contracts real in integration tests',
      ],
      gotchas: [
        'Over-mocking internal helpers gives 100% green tests even when SQL/Mongo queries or routes are broken',
        'Using real wall-clock sleeps (setTimeout) makes CI suites slow and flaky under load',
      ],
      rapidQA: [
        {
          question: 'What is the difference between a stub, a mock, and a fake, and when should you avoid mocks?',
          answer: 'Stubs return canned answers, mocks verify call interactions, and fakes provide lightweight working implementations (like in-memory DBs). Avoid mocking core domain logic or DB contracts in integration tests so schema and query bugs are caught.',
        },
      ],
      mustSolveTopics: ['recursion', 'backtracking'],
    },
  },
  'system design': {
    skill: 'System Design',
    whyLearn: 'Essential for architecting large-scale, distributed systems and passing senior technical interviews.',
    estimatedTime: '4-8 Weeks',
    practiceProject: {
      title: 'Design a URL Shortener',
      description: 'Architect a highly available, scalable URL shortener (like bit.ly) addressing load balancing, database sharding, and caching.'
    },
    resources: [
      { title: 'System Design Primer', type: 'article', url: 'https://github.com/donnemartin/system-design-primer', provider: 'GitHub' },
      { title: 'Grokking the System Design Interview', type: 'course', url: 'https://www.educative.io/courses/grokking-the-system-design-interview', provider: 'Educative' },
      { title: 'System Design Interview Channel', type: 'video', url: 'https://www.youtube.com/c/SystemDesignInterview', provider: 'ByteByteGo' }
    ],
    crashCourse: {
      revisionMinutes: 25,
      paretoPriority: 10,
      coreConcepts: [
        'Framework: clarify functional + non-functional scale (QPS, storage, latency) → API/schema → high-level design → bottlenecks',
        'Read scaling: CDN → load balancer → stateless API → Redis cache-aside → read replicas',
        'Write scaling: partitioning/sharding + consistent hashing + async queues + idempotency keys',
        'Reliability: rate limiting (token bucket / sliding window), circuit breakers, and transactional outbox',
      ],
      gotchas: [
        'Hot keys/celebrity partitions overload a single shard despite consistent hashing unless salted or cached',
        'Dual writes to DB and Kafka/Redis without an outbox pattern lose events on partial failure',
      ],
      rapidQA: [
        {
          question: 'How does the Transactional Outbox pattern solve dual-write failures?',
          answer: 'The service writes domain state and an outbox event row in the same ACID database transaction. A separate relay worker polls or streams the outbox and publishes idempotently to the broker, guaranteeing at-least-once delivery.',
        },
        {
          question: 'Compare Token Bucket vs Sliding Window Log rate limiting.',
          answer: 'Token Bucket allows controlled short bursts up to bucket capacity using O(1) memory per key, making it ideal for API gateways. Sliding Window Log tracks exact timestamps for strict precision at higher memory cost.',
        },
      ],
      mustSolveTopics: ['hashing', 'arrays'],
    },
  },
  'typescript': {
    skill: 'TypeScript',
    whyLearn: 'Provides static typing to JavaScript, catching errors at compile-time and significantly improving DX and code maintainability.',
    estimatedTime: '2 Weeks',
    practiceProject: {
      title: 'Migrate a JS Project to TS',
      description: 'Take an existing JavaScript project and migrate it to TypeScript, creating custom interfaces for all data models.'
    },
    resources: [
      { title: 'TypeScript Handbook', type: 'docs', url: 'https://www.typescriptlang.org/docs/handbook/intro.html', provider: 'Official' },
      { title: 'TypeScript Course for Beginners', type: 'video', url: 'https://www.youtube.com/watch?v=d56mG7DezGs', provider: 'freeCodeCamp' },
      { title: 'Total TypeScript', type: 'course', url: 'https://www.totaltypescript.com/', provider: 'Matt Pocock' }
    ],
    crashCourse: {
      revisionMinutes: 15,
      paretoPriority: 8,
      coreConcepts: [
        'Discriminated unions + exhaustive never checks catch unhandled state variants at compile time',
        'Prefer unknown + Zod/type-guards over any at network and JSON boundaries',
        'Structural typing vs nominal branding, generics with extends constraints, and utility types (Pick, Omit, Record)',
      ],
      gotchas: [
        'TypeScript types vanish at runtime—API payloads still need runtime schema validation (e.g., Zod)',
        'Type assertions (`as Foo`) silence the compiler without validating the underlying object',
      ],
      rapidQA: [
        {
          question: 'Why should external API responses be parsed into unknown or Zod instead of cast with `as`?',
          answer: 'TypeScript assertions are erased at compile time and perform zero runtime checks. Validating external data with unknown and a schema like Zod prevents malformed responses from causing runtime crashes downstream.',
        },
      ],
      mustSolveTopics: ['trees'],
    },
  },
  'python': {
    skill: 'Python',
    whyLearn: 'The dominant language for AI, machine learning, and data engineering, known for its readability and massive ecosystem.',
    estimatedTime: '3-4 Weeks',
    practiceProject: {
      title: 'Data Analysis Pipeline',
      description: 'Write a Python script using Pandas to ingest CSV data, clean it, and output statistical summaries and visualizations.'
    },
    resources: [
      { title: 'Python Official Tutorial', type: 'docs', url: 'https://docs.python.org/3/tutorial/index.html', provider: 'Official' },
      { title: 'Python for Beginners', type: 'video', url: 'https://www.youtube.com/watch?v=rfscVS0vtbw', provider: 'Programming with Mosh' },
      { title: '100 Days of Code: The Complete Python Pro Bootcamp', type: 'course', url: 'https://www.udemy.com/course/100-days-of-code/', provider: 'Udemy' }
    ],
    crashCourse: {
      revisionMinutes: 15,
      paretoPriority: 8,
      coreConcepts: [
        'Mutable default arguments in def f(x=[]): are evaluated once at function definition, not per call',
        'GIL limits CPU-bound threading (use multiprocessing), while asyncio scales high-concurrency I/O',
        'Generators (yield) evaluate lazily in O(1) memory; dict/set lookups average O(1)',
      ],
      gotchas: [
        'Blocking synchronous requests/time.sleep inside async def freezes the entire asyncio event loop',
        'Shallow copy (.copy()) shares nested mutable lists/dicts unless copy.deepcopy is used',
      ],
      rapidQA: [
        {
          question: 'How does the Python GIL affect threads vs asyncio vs multiprocessing?',
          answer: 'The GIL ensures only one thread executes Python bytecode at a time, so threads do not parallelize CPU work. Use asyncio or threads for I/O-bound concurrency and multiprocessing for CPU-bound parallelism.',
        },
      ],
      mustSolveTopics: ['arrays', 'hashing'],
    },
  },
  'sql': {
    skill: 'SQL',
    whyLearn: 'Relational databases remain the backbone of transactional consistency, reporting, and complex relational queries.',
    estimatedTime: '2 Weeks',
    practiceProject: {
      title: 'Indexed Orders & Ledger Schema',
      description: 'Design normalized tables with foreign keys, composite B-tree indexes, and ACID transactions, verified via EXPLAIN ANALYZE.'
    },
    resources: [
      { title: 'PostgreSQL Official Documentation', type: 'docs', url: 'https://www.postgresql.org/docs/', provider: 'Official' },
      { title: 'SQL Indexing and Tuning', type: 'article', url: 'https://use-the-index-luke.com/', provider: 'Markus Winand' },
    ],
    crashCourse: {
      revisionMinutes: 20,
      paretoPriority: 9,
      coreConcepts: [
        'B-tree index leftmost-prefix rule; covering indexes enable fast Index-Only Scans',
        'ACID isolation levels (Read Committed, Repeatable Read, Serializable) and MVCC snapshots',
        'Window functions (ROW_NUMBER, RANK, SUM OVER) avoid slow self-joins for analytics',
        'Avoid N+1 queries by batching with JOINs or WHERE id = ANY(...) / IN clauses',
      ],
      gotchas: [
        'Wrapping indexed columns in functions like LOWER(email) prevents B-tree index usage without expression indexes',
        'OFFSET pagination scans and discards rows linearly; use keyset/cursor pagination for deep pages',
      ],
      rapidQA: [
        {
          question: 'Why does keyset pagination outperform OFFSET/LIMIT on large tables?',
          answer: 'OFFSET forces the database to scan and discard all preceding rows before returning results, degrading to O(N). Keyset pagination uses an indexed WHERE (created_at, id) < cursor filter to seek directly in O(log N).',
        },
      ],
      mustSolveTopics: ['binarySearch', 'arrays'],
    },
  },
  'express': {
    skill: 'Express',
    whyLearn: 'Express is the minimalist, battle-tested web framework powering a huge share of Node.js REST APIs.',
    estimatedTime: '1 Week',
    practiceProject: {
      title: 'Hardened Express API Gateway',
      description: 'Build a modular Express router with Zod request validation, rate limiting, structured logging, and a 4-arg error middleware.'
    },
    resources: [
      { title: 'Express Official Guide', type: 'docs', url: 'https://expressjs.com/en/guide/routing.html', provider: 'Official' },
    ],
    crashCourse: {
      revisionMinutes: 15,
      paretoPriority: 8,
      coreConcepts: [
        'Middleware executes strictly in registration order; error handlers must have 4 parameters (err, req, res, next)',
        'Always bound request bodies (express.json({ limit })) and validate inputs before controller logic',
        'Wrap async route handlers in Express 4 so rejected promises forward to next(err)',
      ],
      gotchas: [
        'Mounting 404/error middleware before route routers shadows downstream routes',
        'Trusting X-Forwarded-For without configuring app.set("trust proxy", ...) breaks IP rate limiters',
      ],
      rapidQA: [
        {
          question: 'How does Express distinguish regular middleware from error-handling middleware?',
          answer: 'Express inspects Function.length and treats middleware with four arguments (err, req, res, next) as an error handler. Regular three-argument middleware is skipped once next(err) is invoked.',
        },
      ],
      mustSolveTopics: ['arrays', 'strings'],
    },
  },
  'authentication': {
    skill: 'Authentication',
    whyLearn: 'Secure authentication and authorization protect user data and prevent critical privilege-escalation vulnerabilities.',
    estimatedTime: '1-2 Weeks',
    practiceProject: {
      title: 'JWT + Refresh Rotation Auth Service',
      description: 'Implement Argon2/bcrypt password hashing, short-lived JWT access tokens, rotating refresh tokens, and RBAC guards.'
    },
    resources: [
      { title: 'OWASP Authentication Cheat Sheet', type: 'docs', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html', provider: 'OWASP' },
    ],
    crashCourse: {
      revisionMinutes: 20,
      paretoPriority: 9,
      coreConcepts: [
        'Authentication (who you are) vs Authorization/RBAC (what you can access on every resource)',
        'Hash passwords with per-user salt using Argon2id or bcrypt; never store plaintext or fast SHA hashes',
        'Short-lived access tokens + HttpOnly/SameSite/Secure refresh cookies with reuse detection',
      ],
      gotchas: [
        'Checking req.user exists without verifying resource ownership causes IDOR vulnerabilities',
        'Storing JWTs in localStorage exposes them directly to any XSS script',
      ],
      rapidQA: [
        {
          question: 'How do you mitigate both XSS token theft and CSRF in browser authentication?',
          answer: 'Store tokens in HttpOnly, Secure cookies so JavaScript cannot read them via XSS, and pair them with SameSite=Lax/Strict plus CSRF tokens or origin validation on state-changing requests.',
        },
      ],
      mustSolveTopics: ['hashing'],
    },
  },
};

export function getResourceForSkill(skill: string): LearningResource {
  if (!skill) {
    return {
      skill: '',
      whyLearn: '',
      estimatedTime: '',
      practiceProject: { title: '', description: '' },
      resources: [],
      crashCourse: buildFallbackCrashCourse('Engineering'),
      isFallback: true
    };
  }
  
  const normalized = skill.toLowerCase().trim();
  if (STATIC_RESOURCES[normalized]) {
    return STATIC_RESOURCES[normalized];
  }
  
  // Fallback
  return {
    skill: skill,
    whyLearn: 'This skill is important for your target career path and was identified as a roadmap priority.',
    estimatedTime: 'Varies',
    practiceProject: {
      title: `${skill} Mini Project`,
      description: `Build a focused, testable project applying ${skill} fundamentals and document trade-offs in a README.`
    },
    resources: [
      {
        title: 'Official Documentation Search',
        type: 'docs',
        url: `https://www.google.com/search?q=${encodeURIComponent(skill + ' official documentation')}`,
        provider: 'Official Docs'
      },
      {
        title: 'YouTube Tutorial Search',
        type: 'video',
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(skill + ' tutorial')}`,
        provider: 'YouTube'
      },
      {
        title: 'Hands-on Guide Search',
        type: 'article',
        url: `https://www.google.com/search?q=${encodeURIComponent(skill + ' best practices guide')}`,
        provider: 'Google'
      }
    ],
    crashCourse: buildFallbackCrashCourse(skill),
    isFallback: true
  };
}
