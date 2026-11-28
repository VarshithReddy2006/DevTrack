import type { ConceptDefinition } from './concepts.types.js';

export const CS_CONCEPTS_CATALOG: ConceptDefinition[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // PRIMARY TRACK: CORE CS FUNDAMENTALS (OS, DBMS, COMPUTER NETWORKS)
  // Always scored on Core CS Placement Radar axis (isOptional: false)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Operating Systems ───
  {
    id: 'cs-os-processes-threads',
    domain: 'cs-concepts',
    title: 'Processes vs Threads & Context Switching',
    subtitle: 'Virtual address space isolation, PCB vs TCB, and mode switch cost',
    level: 'beginner',
    track: 'core-cs',
    subTrack: 'os',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 14,
    summary:
      'Processes own isolated virtual memory and kernel descriptors; threads share heap/code/open files within a process while keeping independent registers and call stacks.',
    architectureFlow: [
      'Process creation (fork) allocates a new Page Table, PCB, file descriptor table, and copy-on-write memory map.',
      'Thread creation shares the same virtual address space & page directory, only allocating a new stack and TCB.',
      'Context switch between threads saves registers + PC without flushing the TLB memory translation cache.',
      'Process switch additionally swaps CR3 page directory pointer, causing cold TLB and CPU L1/L2 misses.',
    ],
    tradeOffs: [
      {
        topic: 'Multi-Process (Workers / Chrome Tabs)',
        whenToUse: 'Fault isolation, security sandboxing, zero shared-memory race conditions.',
        whenToAvoid: 'Tiny fast tasks needing tight sub-microsecond shared heap access.',
        alternative: 'Worker Thread Pool',
      },
      {
        topic: 'Multi-Threading / Event Loop Async I/O',
        whenToUse: 'Shared in-memory caches, lower memory footprint, cheap inter-worker data sharing.',
        whenToAvoid: 'Untrusted plugins where a single segfault crashes the whole process.',
        alternative: 'IPC + Worker Processes',
      },
    ],
    scaleBenchmarks: [
      { label: 'Thread vs Process Context Switch', value: '~1–3 us vs ~10–30 us', note: 'TLB flush makes cross-process switching much pricier' },
      { label: 'Default Thread Stack Size', value: '1–8 MB virtual / OS', note: '10k blocking threads burn GBs of RAM -> use async pools/fibers' },
    ],
    rapidQA: [
      {
        id: 'cs-proc-q1',
        question: 'What resources are shared vs private among threads inside the same process?',
        answer:
          'Shared: Code segment, global heap, open file descriptors, and virtual address space. Private per thread: Stack, CPU registers, program counter, and thread-local storage.',
      },
      {
        id: 'cs-proc-q2',
        question: 'Why does switching between threads of different processes cost more than threads of the same process?',
        answer:
          'Switching processes swaps the virtual memory page table (CR3 register), invalidating cached TLB address translations and warming cold CPU caches.',
      },
    ],
    practicePrompt: 'Contrast Node.js single-threaded event loop + libuv worker threads against Go goroutines (M:N scheduling).',
  },
  {
    id: 'cs-os-cpu-scheduling',
    domain: 'cs-concepts',
    title: 'CPU Scheduling Algorithms (FCFS, SJF, Round Robin, MLFQ)',
    subtitle: 'Balancing turnaround time, response latency, and starvation prevention',
    level: 'beginner',
    track: 'core-cs',
    subTrack: 'os',
    isOptional: false,
    isHighFrequencyCrashCourse: false,
    estimatedMinutes: 12,
    summary:
      'OS schedulers arbitrate CPU bursts across runnable queues: SJF optimizes average wait, Round Robin ensures fair interactivity, and Multi-Level Feedback Queues adapt dynamically.',
    architectureFlow: [
      'Runnable thread moves from Waiting -> Ready queue when I/O completes.',
      'Preemptive timer interrupt triggers scheduler check when time quantum expires or higher-priority job wakes.',
      'MLFQ demotes CPU hogs to lower queues with larger quantums while keeping interactive I/O threads in high-priority fast queues.',
      'Aging gradually boosts neglected ready tasks so low-priority jobs never starve indefinitely.',
    ],
    tradeOffs: [
      {
        topic: 'Shortest Job First (SJF / SRTF)',
        whenToUse: 'Batch analytics with known duration bounds (provably minimal average waiting time).',
        whenToAvoid: 'Interactive desktops (unknown burst length + starvation risk for long jobs).',
        alternative: 'MLFQ / Linux CFS',
      },
      {
        topic: 'Round Robin (RR)',
        whenToUse: 'Predictable bounded response time across interactive requests.',
        whenToAvoid: 'Quantum set too tiny -> excessive context switch thrashing.',
        alternative: 'Weighted Fair Queueing',
      },
    ],
    scaleBenchmarks: [
      { label: 'Typical Time Quantum', value: '4–20 ms', note: 'Large enough that context switch overhead stays < 1%' },
      { label: 'Convoy Effect Penalty', value: 'High tail latency', note: 'FCFS stalls short I/O bursts behind a 10s CPU batch' },
    ],
    rapidQA: [
      {
        id: 'cs-sched-q1',
        question: 'What is the Convoy Effect in First-Come First-Served (FCFS) scheduling?',
        answer:
          'When one long CPU-bound job monopolizes the core while dozens of tiny interactive I/O tasks wait behind it, crashing throughput and interactive responsiveness.',
      },
      {
        id: 'cs-sched-q2',
        question: 'How does MLFQ keep UI/network handlers snappy without starving batch compilers?',
        answer:
          'Threads yielding early for I/O stay in top priority queues; CPU hogs get demoted down queues, and periodic priority boost resets prevent starvation.',
      },
    ],
    practicePrompt: 'Explain why gaming MLFQ by yielding right before time-slice expiration was patched using total CPU slice accounting.',
  },
  {
    id: 'cs-os-deadlocks',
    domain: 'cs-concepts',
    title: 'Deadlocks (Coffman Conditions, Prevention & Recovery)',
    subtitle: 'Eliminating circular wait cycles in kernel mutexes and database transactions',
    level: 'intermediate',
    track: 'core-cs',
    subTrack: 'os',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 14,
    summary:
      'Deadlock occurs when threads wait cyclically for locks held by one another; breaking any of the 4 Coffman conditions — most practically Circular Wait via global lock ordering — guarantees progress.',
    architectureFlow: [
      'Identify all 4 necessary conditions: Mutual Exclusion, Hold & Wait, No Preemption, Circular Wait.',
      'Enforce canonical global lock ordering (e.g., always lock lower accountId before higher accountId).',
      'Alternatively acquire locks with bounded timeouts / tryLock backoff (preemption on failure).',
      'In databases, detect lock wait-for graph cycles periodically and abort youngest victim transaction cleanly.',
    ],
    tradeOffs: [
      {
        topic: 'Global Lock Ordering (Prevention)',
        whenToUse: 'Transfer/wallet locks or multi-mutex code where all lock targets can be sorted upfront.',
        whenToAvoid: 'Dynamic opaque callback locks where target IDs are unknown ahead of time.',
        alternative: 'Deadlock detection + Retry',
      },
      {
        topic: 'Wait-For Graph Detection & Abort',
        whenToUse: 'Relational DBMS (Postgres / InnoDB) supporting optimistic rollback on cycle detection.',
        whenToAvoid: 'Kernel C threads with side effects that cannot automatically roll back.',
        alternative: 'Lock hierarchy enforcement',
      },
    ],
    scaleBenchmarks: [
      { label: 'Postgres deadlock_timeout', value: '1,000 ms default', note: 'Waits 1s before scanning lock graph to save CPU' },
      { label: 'Livelock Risk', value: 'Avoid fixed retry', note: 'Use randomized exponential backoff on lock collision' },
    ],
    rapidQA: [
      {
        id: 'cs-dl-q1',
        question: 'Which Coffman condition is easiest to break in production application code?',
        answer:
          'Circular Wait — assign every lockable resource a deterministic total order (e.g., sort account IDs ascending) and always acquire locks in that exact sequence.',
      },
      {
        id: 'cs-dl-q2',
        question: 'What is the difference between Deadlock and Livelock?',
        answer:
          'In deadlock, threads stay completely blocked forever; in livelock, threads actively retry/yield to each other in sync and burn CPU while making zero forward progress.',
      },
    ],
    practicePrompt: 'Fix a concurrent bank transfer function transfer(fromAccount, toAccount, amount) that deadlocks under parallel reverse transfers.',
  },
  {
    id: 'cs-os-virtual-memory',
    domain: 'cs-concepts',
    title: 'Virtual Memory, Paging, Page Tables & TLB',
    subtitle: 'Address translation, demand paging, copy-on-write, and avoiding thrashing',
    level: 'intermediate',
    track: 'core-cs',
    subTrack: 'os',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 16,
    summary:
      'MMU hardware maps isolated process virtual pages onto physical RAM frames via multi-level Page Tables accelerated by an ultra-fast on-chip TLB cache.',
    architectureFlow: [
      'CPU issues virtual address split into Virtual Page Number (VPN) and 4KB Page Offset.',
      'MMU probes Translation Lookaside Buffer (TLB); hit resolves physical frame in ~1 cycle.',
      'TLB miss triggers hardware Page Table walk; if Present bit = 0, CPU raises Page Fault trap to OS kernel.',
      'Kernel loads page from disk/swap (major fault) or allocates zeroed/COW frame (minor fault) and restarts instruction.',
    ],
    tradeOffs: [
      {
        topic: '4KB Standard Pages vs 2MB HugePages',
        whenToUse: 'HugePages cut TLB misses drastically on multi-GB databases (Redis, Postgres) and JVMs.',
        whenToAvoid: 'Small short-lived utilities where 2MB alignment increases internal fragmentation.',
        alternative: 'Transparent Huge Pages (careful with latency spikes on Redis)',
      },
      {
        topic: 'Copy-on-Write (fork)',
        whenToUse: 'Instant Redis BGSAVE snapshots and fast subprocess spawning sharing read-only frames.',
        whenToAvoid: 'Heavy concurrent writes right after fork (causes O(RAM) page copy amplification).',
        alternative: 'POSIX spawn / threaded workers',
      },
    ],
    scaleBenchmarks: [
      { label: 'TLB Hit vs Disk Page Fault', value: '0.5 ns vs ~100 us–10 ms', note: 'Major swap faults are 100,000x slower than RAM!' },
      { label: 'Standard Page Size', value: '4 KB (x86_64)', note: 'HugePages = 2 MB / 1 GB' },
    ],
    rapidQA: [
      {
        id: 'cs-vm-q1',
        question: 'What causes virtual memory Thrashing and how do you stop it in production?',
        answer:
          'When active working sets exceed physical RAM, the kernel spends all its time swapping pages in and out instead of executing instructions. Disable swap for latency-critical tiers and cap OOM concurrency.',
      },
      {
        id: 'cs-vm-q2',
        question: 'Why does Redis warn against Transparent Huge Pages during BGSAVE?',
        answer:
          'When Redis writes 1 key after fork(), Copy-on-Write copies an entire 2MB huge page instead of 4KB, amplifying memory usage and latency pauses.',
      },
    ],
    practicePrompt: 'Walk through every hardware and OS step when accessing an unallocated virtual heap pointer inside mmap.',
  },
  {
    id: 'cs-os-concurrency',
    domain: 'cs-concepts',
    title: 'Concurrency Primitives (Mutex, Semaphore, Monitors & Condition Variables)',
    subtitle: 'Safe mutual exclusion, bounded resource counting, and wait/notify coordination',
    level: 'advanced',
    track: 'core-cs',
    subTrack: 'os',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 16,
    summary:
      'Mutexes enforce strict single-owner mutual exclusion; semaphores signal N-slot capacity across threads; monitors pair a mutex with condition variables to sleep cleanly without busy-wait spinning.',
    architectureFlow: [
      'Thread enters critical section via Mutex lock (ownership bound: only locking thread unlocks).',
      'If condition is not yet met (e.g., queue empty), thread calls wait(condVar, mutex) releasing mutex atomically while sleeping.',
      'Producer inserts item and signals condVar; consumer wakes up, re-acquires mutex, and re-checks predicate in a while loop.',
      'Counting Semaphore tracks available slots across DB connection pools or rate semaphores without single-owner restriction.',
    ],
    tradeOffs: [
      {
        topic: 'Mutex vs Counting Semaphore',
        whenToUse: 'Mutex for protecting critical-section shared invariants (single owner); Semaphore for N-slot signaling.',
        whenToAvoid: 'Using a binary semaphore as a mutex (lacks owner safety & priority inheritance).',
        alternative: 'Mutex + Condition Variable',
      },
      {
        topic: 'Spinlock vs Blocking Mutex',
        whenToUse: 'Spinlock for tiny < 1 microsecond multi-core kernel critical sections where sleep/wake overhead exceeds spin.',
        whenToAvoid: 'User-space I/O locks or single-core CPUs where spinning steals core from lock holder.',
        alternative: 'Adaptive futex (Linux pthread_mutex)',
      },
    ],
    scaleBenchmarks: [
      { label: 'Uncontended Futex Acquire', value: '~15–30 ns', note: 'Atomic user-space CAS skips syscall completely unless contended' },
      { label: 'RWLock Read Concurrency', value: 'N readers parallel', note: 'Must guard against writer starvation' },
    ],
    rapidQA: [
      {
        id: 'cs-conc-q1',
        question: 'Why must Condition Variable wait() ALWAYS be wrapped in a while loop instead of an if check?',
        answer:
          'Due to spurious OS wakeups and another waiting consumer stealing the item between notify() and mutex re-acquisition, you must re-verify the condition predicate.',
      },
      {
        id: 'cs-conc-q2',
        question: 'How is a Mutex fundamentally different from a Binary Semaphore?',
        answer:
          'A mutex enforces strict ownership (only the thread that acquired it can release it and benefits from priority inheritance), whereas any thread can signal/release a semaphore.',
      },
    ],
    practicePrompt: 'Design a thread-safe bounded blocking producer-consumer queue using 1 mutex and 2 condition variables.',
  },

  // ─── DBMS & Storage Engines ───
  {
    id: 'cs-dbms-acid-isolation',
    domain: 'cs-concepts',
    title: 'ACID Properties & Transaction Isolation Levels (MVCC)',
    subtitle: 'Trade-offs between Read Committed, Repeatable Read, Serializable, and lock contention',
    level: 'beginner',
    track: 'core-cs',
    subTrack: 'dbms',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 18,
    summary:
      'ACID balances reliability via WAL Durability and Isolation; MVCC keeps old row snapshots so readers never block writers while preventing dirty, non-repeatable, or phantom anomalies.',
    architectureFlow: [
      'Transaction begins and obtains a monotonic Transaction ID (xmin) + snapshot view under MVCC.',
      'Updates write new tuple versions tagged with creator txId rather than mutating pages in place blindly.',
      'WAL (Write-Ahead Log) appends dirty changes sequentially with fsync before confirming COMMIT.',
      'Read queries inspect tuple visibility against snapshot rules dictated by Isolation Level.',
    ],
    tradeOffs: [
      {
        topic: 'Read Committed (Postgres Default)',
        whenToUse: 'General OLTP web apps balancing fresh non-dirty reads with zero multi-statement snapshot holds.',
        whenToAvoid: 'Multi-step financial balance checks or reports needing a frozen point-in-time snapshot.',
        alternative: 'Repeatable Read / Snapshot Isolation',
      },
      {
        topic: 'Repeatable Read (MVCC) vs Serializable (SSI / 2PL)',
        whenToUse: 'Repeatable Read handles point-in-time analytics cleanly; Serializable stops subtle write skew.',
        whenToAvoid: 'Serializable blindly on hot counters (raises serialization retry errors under high contention).',
        alternative: 'Repeatable Read + SELECT ... FOR UPDATE',
      },
    ],
    scaleBenchmarks: [
      { label: 'WAL Sequential Write', value: '< 1 ms SSD fsync', note: 'Turns random table writes into fast append I/O' },
      { label: 'MVCC Vacuum Requirement', value: 'Dead tuple cleanup', note: 'Un-vacuumed dead versions bloat table size & scan speed' },
    ],
    rapidQA: [
      {
        id: 'cs-acid-q1',
        question: 'What is Write Skew and why does Snapshot Isolation / Repeatable Read allow it?',
        answer:
          'Two concurrent transactions read overlapping sets (e.g., ensuring >= 1 on-call doctor remains), check the invariant passes, and update DISJOINT rows — violating the invariant together without triggering a write-write conflict.',
      },
      {
        id: 'cs-acid-q2',
        question: 'How does MVCC prevent SELECT readers from blocking concurrent INSERT/UPDATE writers?',
        answer:
          'Writers create new row versions while existing readers inspect consistent older tuple snapshots tagged by commit transaction IDs.',
      },
    ],
    practicePrompt: 'Prevent double-spending an account balance in SQL without resorting to global table locks.',
  },
  {
    id: 'cs-dbms-btree-lsm',
    domain: 'cs-concepts',
    title: 'Storage Engines: B+ Trees vs LSM Trees',
    subtitle: 'Read-optimized in-place balanced pages vs write-optimized append-only SSTables',
    level: 'intermediate',
    track: 'core-cs',
    subTrack: 'dbms',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 16,
    summary:
      'B+ Trees update 4–16KB sorted pages in place for ultra-fast predictable point & range reads; LSM Trees absorb massive writes into an in-memory MemTable + WAL and compact sorted SSTables asynchronously.',
    architectureFlow: [
      'B+ Tree: Traverse internal fanout routing keys (3–4 levels) down to linked doubly-linked Leaf Pages; update page in buffer pool.',
      'LSM Tree Write: Append to WAL on disk + insert key into sorted red-black/skiplist MemTable (zero random seeks!).',
      'LSM Flush & Compact: Immutable full MemTables flush as sorted SSTables; background compaction merges overlapping SSTables.',
      'LSM Read: Check MemTable -> Bloom Filters (skip missing SSTables) -> binary search candidate SSTable index blocks.',
    ],
    tradeOffs: [
      {
        topic: 'B+ Tree (PostgreSQL, MySQL InnoDB)',
        whenToUse: 'Predictable read latency, balanced OLTP mixed workloads, heavy secondary indexes.',
        whenToAvoid: 'Petabyte-scale random ingest bursts bottlenecked by random 4KB page read-modify-writes.',
        alternative: 'LSM Tree (RocksDB, Cassandra)',
      },
      {
        topic: 'LSM Tree (RocksDB, Cassandra, Scylla)',
        whenToUse: 'Write-heavy telemetry, chat logs, time-series ingest with sequential disk compaction.',
        whenToAvoid: 'Workloads sensitive to periodic background compaction I/O spikes or slow cold misses without Bloom filters.',
        alternative: 'B+ Tree',
      },
    ],
    scaleBenchmarks: [
      { label: 'B+ Tree Depth @ 1B Rows', value: '4 levels', note: 'Branching factor ~500 per 16KB page; root + 1 internal fit in RAM' },
      { label: 'LSM Write Amplification vs B+ Tree', value: 'Higher compression', note: 'Dense SSTable blocks often use 2–4x less disk than fragmented B-Trees' },
    ],
    rapidQA: [
      {
        id: 'cs-lsm-q1',
        question: 'Why are Bloom Filters critical in LSM-Tree databases for missing-key lookups?',
        answer:
          'Without Bloom Filters, looking up a non-existent key requires scanning index blocks across dozens of SSTable files on disk. A Bloom filter answers "definitely not in this SSTable" in RAM.',
      },
      {
        id: 'cs-lsm-q2',
        question: 'Why do B+ Trees beat plain Binary Search Trees or B-Trees for disk-backed databases?',
        answer:
          'B+ Trees push all row values to linked leaf pages, maximizing internal node fanout per 16KB page and supporting fast sequential range scans across leaf pointers.',
      },
    ],
    practicePrompt: 'Explain why Cassandra/Scylla use LSM Trees while InnoDB MySQL uses B+ Trees for primary storage.',
  },
  {
    id: 'cs-dbms-query-plans-indexing',
    domain: 'cs-concepts',
    title: 'Query Execution Plans, Composite Indexes & Covering Scans',
    subtitle: 'Reading EXPLAIN ANALYZE, leftmost prefix ordering, and selectivity traps',
    level: 'intermediate',
    track: 'core-cs',
    subTrack: 'dbms',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 15,
    summary:
      'Composite indexes obey the Leftmost Prefix rule and equality-before-range sorting; Covering Indexes (INCLUDE) answer queries directly from index pages without touching the main heap table.',
    architectureFlow: [
      'Planner estimates row cardinality via table histograms and picks Seq Scan vs Index Scan vs Index-Only Scan.',
      'Composite Index (status, created_at): equality filters narrow to contiguous leaf slice ordered by range column.',
      'Range filter placed first (created_at, status) breaks sorted order for subsequent equality columns.',
      'INCLUDE/Covering Index embeds queried non-key projection columns into index leaves -> avoids random heap lookups.',
    ],
    tradeOffs: [
      {
        topic: 'Index-Only (Covering) Scan',
        whenToUse: 'High-QPS listing endpoints reading just 2–3 narrow summary fields.',
        whenToAvoid: 'Wide text/JSON columns (bloats index RAM footprint and write cost).',
        alternative: 'Standard Index Scan + Heap fetch',
      },
      {
        topic: 'Composite Index Column Ordering',
        whenToUse: 'Order equality predicates first, sort/ORDER BY next, range filters last.',
        whenToAvoid: 'Indexing low-cardinality booleans first when filtering alone scans 50% of table.',
        alternative: 'Partial Index (WHERE archived = false)',
      },
    ],
    scaleBenchmarks: [
      { label: 'Index vs Seq Scan Crossover', value: '~5–15% selectivity', note: 'Above ~15% of rows, sequential page scan beats random index jumps' },
      { label: 'Index-Only Speedup', value: '3–10x faster', note: 'Eliminates random heap I/O roundtrips' },
    ],
    rapidQA: [
      {
        id: 'cs-idx-q1',
        question: 'Given composite index (user_id, created_at), which queries can use it effectively?',
        answer:
          'WHERE user_id = ? (yes), WHERE user_id = ? AND created_at > ? (yes), and ORDER BY created_at for a single user_id (yes). WHERE created_at > ? alone skips the leftmost key and cannot use it cleanly.',
      },
      {
        id: 'cs-idx-q2',
        question: 'Why does wrapping an indexed column in LOWER(email) or DATE(created_at) cause a full table scan?',
        answer:
          'The index stores raw values, not transformed outputs; rewrite as explicit range bounds (created_at >= start AND created_at < end) or build an expression index.',
      },
    ],
    practicePrompt: 'Optimize SELECT id, total FROM orders WHERE tenant_id = ? AND status = "PAID" ORDER BY created_at DESC LIMIT 20.',
  },

  // ─── Computer Networks ───
  {
    id: 'cs-net-osi-tcpip',
    domain: 'cs-concepts',
    title: 'OSI vs TCP/IP Model & Packet Encapsulation',
    subtitle: 'Tracing frames, IP packets, TCP segments, and HTTP payloads across hops',
    level: 'beginner',
    track: 'core-cs',
    subTrack: 'networks',
    isOptional: false,
    isHighFrequencyCrashCourse: false,
    estimatedMinutes: 12,
    summary:
      'Every network hop encapsulates payloads down from L7 Application -> L4 TCP Segment -> L3 IP Packet -> L2 Ethernet Frame, rewriting only MAC headers at switches while keeping end-to-end IP.',
    architectureFlow: [
      'Application writes HTTP bytes -> OS Transport splits into MTU-sized TCP segments with src/dst ports.',
      'Network layer prepends src/dst IP headers and checks routing table for next gateway hop.',
      'Link layer (ARP) resolves gateway MAC address and wraps frame with L2 trailer checksum.',
      'Routers inspect IP header & decrement TTL at each WAN hop; L4/L7 balancers terminate sockets to route.',
    ],
    tradeOffs: [
      {
        topic: 'MTU Sizing (1500B Standard vs 9000B Jumbo Frames)',
        whenToUse: 'Jumbo frames inside isolated cloud VPCs reduce per-packet interrupt CPU overhead for bulk storage.',
        whenToAvoid: 'Public internet paths where Path MTU Discovery issues trigger packet fragmentation.',
        alternative: '1500B standard Ethernet MTU',
      },
    ],
    scaleBenchmarks: [
      { label: 'Ethernet MTU / MSS', value: '1500B / 1460B', note: '20B IP + 20B TCP header subtracted per segment' },
      { label: 'BGP Internet Hops', value: '10–25 hops avg', note: 'TTL decremented per L3 router hop' },
    ],
    rapidQA: [
      {
        id: 'cs-osi-q1',
        question: 'When a packet crosses 5 routers to reach your API server, which header changes at every hop?',
        answer:
          'Layer 2 source and destination MAC addresses change on every physical hop along with IP TTL decrement; end-to-end IP addresses stay constant unless NAT is involved.',
      },
      {
        id: 'cs-osi-q2',
        question: 'Which OSI layers do an L2 switch, L3 router, and L7 API gateway inspect?',
        answer:
          'Switch inspects L2 MAC frames; Router inspects L3 IP destination prefixes; L7 API gateway terminates TCP/TLS and reads HTTP URLs and headers.',
      },
    ],
    practicePrompt: 'Trace packet headers from your browser behind home NAT to an HTTPS Load Balancer in AWS us-east-1.',
  },
  {
    id: 'cs-net-tcp-handshake',
    domain: 'cs-concepts',
    title: 'TCP 3-Way Handshake, Flow & Congestion Control',
    subtitle: 'SYN/SYN-ACK/ACK establishment, TIME_WAIT sockets, and AIMD windows',
    level: 'intermediate',
    track: 'core-cs',
    subTrack: 'networks',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 16,
    summary:
      'TCP ensures reliable ordered delivery via sequence numbers, receiver-bounded rwnd flow control, and network-probing cwnd congestion control (Slow Start + AIMD), closing into TIME_WAIT cleanly.',
    architectureFlow: [
      'Client sends SYN(seq=x) -> Server replies SYN-ACK(seq=y, ack=x+1) -> Client sends ACK(ack=y+1).',
      'Slow Start exponentially doubles congestion window (cwnd) each RTT until ssthresh or packet loss.',
      'Receiver advertises rwnd (Flow Control) so fast sender never overflows slow app socket buffer.',
      'Connection closes via 4-way FIN/ACK; active closer holds TIME_WAIT for 2*MSL to absorb delayed duplicate packets.',
    ],
    tradeOffs: [
      {
        topic: 'Persistent Connection Pooling (Keep-Alive)',
        whenToUse: 'Microservices & DB clients avoiding repeated 1-RTT TCP + TLS handshakes per query.',
        whenToAvoid: 'Unbounded idle connections exhausting OS ephemeral port limits without idle eviction.',
        alternative: 'Keep-Alive pool with bounded idle TTL',
      },
    ],
    scaleBenchmarks: [
      { label: 'Connection Setup Penalty', value: '1 RTT TCP + 1 RTT TLS 1.3', note: '200ms WAN adds ~400ms before first byte on cold socket' },
      { label: 'Ephemeral Port Pool Ceiling', value: '~28k–60k per IP', note: 'Socket churn enters TIME_WAIT exhaustion quickly without reuse' },
    ],
    rapidQA: [
      {
        id: 'cs-tcp-q1',
        question: 'Why does the client wait in TIME_WAIT after sending the final ACK of connection teardown?',
        answer:
          'Two reasons: (1) ensure the server receives the final ACK in case retransmission of FIN arrives, and (2) let delayed in-flight segments expire before reusing that 4-tuple port.',
      },
      {
        id: 'cs-tcp-q2',
        question: 'Distinguish TCP Flow Control from TCP Congestion Control.',
        answer:
          'Flow control (rwnd) protects a slow receiver buffer from overflowing; Congestion control (cwnd) prevents flooding intermediate internet routers.',
      },
    ],
    practicePrompt: 'Diagnose why a backend calling an external API at 2,000 QPS without HTTP Keep-Alive hits EADDRNOTAVAIL.',
  },
  {
    id: 'cs-net-tcp-vs-udp',
    domain: 'cs-concepts',
    title: 'TCP vs UDP Transport Trade-Offs',
    subtitle: 'Ordered byte streams vs connectionless low-latency datagrams',
    level: 'beginner',
    track: 'core-cs',
    subTrack: 'networks',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 10,
    summary:
      'TCP guarantees in-order reliable delivery at the cost of head-of-line blocking and handshake RTT; UDP sends raw unacknowledged datagrams ideal for VoIP, gaming, DNS, and QUIC.',
    architectureFlow: [
      'TCP: Establishes stateful connection, buffers out-of-order packets in OS, and stalls delivery until missing seq arrives.',
      'UDP: Wraps 8-byte header (ports, length, checksum) and dispatches packet immediately with zero connection state.',
      'Real-time media protocols drop late UDP voice frames instead of freezing live playback to retransmit stale audio.',
      'Modern protocols like QUIC (HTTP/3) add encryption & independent stream reliability on top of UDP.',
    ],
    tradeOffs: [
      {
        topic: 'TCP',
        whenToUse: 'HTTP APIs, file transfers, database connections, email — anywhere dropped bytes corrupt state.',
        whenToAvoid: 'Live audio/video calls or multiplayer state ticks where 2s-old retransmits are useless.',
        alternative: 'UDP / WebRTC / QUIC',
      },
      {
        topic: 'UDP',
        whenToUse: 'DNS queries (1 RTT), WebRTC media, real-time game telemetry, QUIC transport.',
        whenToAvoid: 'Workloads needing built-in ordering/retransmission without custom app framing.',
        alternative: 'TCP / HTTP/2',
      },
    ],
    scaleBenchmarks: [
      { label: 'Header Overhead', value: '20B TCP vs 8B UDP', note: 'UDP adds minimal wire overhead per frame' },
      { label: 'Head-of-Line Latency', value: 'TCP stalls all streams', note: 'One lost packet freezes everything behind it' },
    ],
    rapidQA: [
      {
        id: 'cs-udp-q1',
        question: 'Why do video calls (Zoom/Meet) prefer UDP even though packets can arrive out of order or drop?',
        answer:
          'Live video prefers a slight 20ms visual glitch over freezing the entire call for 400ms while waiting on TCP retransmission of an already stale frame.',
      },
      {
        id: 'cs-udp-q2',
        question: 'Why does standard DNS run over UDP first and switch to TCP only for large payloads?',
        answer:
          'Most DNS queries fit inside a single UDP packet requiring just 1 round-trip without TCP 3-way handshake overhead; responses > 512B/EDNS fallback cleanly to TCP.',
      },
    ],
    practicePrompt: 'Contrast TCP vs UDP for online multiplayer game positional updates at 60Hz.',
  },
  {
    id: 'cs-net-http-evolution',
    domain: 'cs-concepts',
    title: 'HTTP/1.1 vs HTTP/2 vs HTTP/3 (QUIC)',
    subtitle: 'Solving connection bloat, header verbosity, and TCP head-of-line blocking',
    level: 'intermediate',
    track: 'core-cs',
    subTrack: 'networks',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 15,
    summary:
      'HTTP/1.1 opens 6 parallel TCP sockets due to sequential blocking; HTTP/2 multiplexes concurrent binary streams + HPACK headers over one TCP socket; HTTP/3 moves to UDP-based QUIC eliminating TCP HOL blocking.',
    architectureFlow: [
      'HTTP/1.1: Plaintext headers; requires 6 browser sockets per domain to parallelize CSS/JS/API fetches.',
      'HTTP/2: Binary frames + HPACK header compression multiplex dozens of streams across 1 TLS/TCP connection.',
      'HTTP/2 bottleneck: A single dropped TCP packet stalls ALL HTTP/2 multiplexed streams at OS level.',
      'HTTP/3 (QUIC): Runs over UDP with built-in TLS 1.3 (1-RTT/0-RTT setup) and independent stream recovery.',
    ],
    tradeOffs: [
      {
        topic: 'HTTP/2',
        whenToUse: 'Web edge CDN -> browser and internal gRPC meshes over low-loss wired fiber.',
        whenToAvoid: 'Lossy cellular networks where 1 dropped packet freezes multiplexed assets.',
        alternative: 'HTTP/3 (QUIC)',
      },
      {
        topic: 'HTTP/3 (QUIC)',
        whenToUse: 'Mobile clients roaming WiFi <-> 5G (Connection ID survives IP changes!).',
        whenToAvoid: 'Enterprise firewalls blocking outbound UDP port 443 (browsers gracefully race & fallback to H2).',
        alternative: 'HTTP/2 fallback',
      },
    ],
    scaleBenchmarks: [
      { label: 'Cold Connection Handshake', value: 'H1/H2: 2–3 RTT vs H3: 1 RTT', note: 'QUIC merges transport + TLS 1.3 handshake' },
      { label: 'Header Size Compression', value: 'HPACK / QPACK ~80%', note: 'Avoids resending repetitive Cookie/User-Agent strings' },
    ],
    rapidQA: [
      {
        id: 'cs-http-q1',
        question: 'If HTTP/2 supports multiplexing, why did Google still create HTTP/3 over QUIC?',
        answer:
          'HTTP/2 multiplexing runs inside a SINGLE kernel TCP stream, so one dropped packet stalls every independent HTTP/2 stream (TCP head-of-line blocking). QUIC gives each stream independent recovery over UDP.',
      },
      {
        id: 'cs-http-q2',
        question: 'How does QUIC keep mobile streams alive when a phone switches from WiFi to 5G?',
        answer:
          'QUIC identifies connections via a Connection ID rather than the source IP:Port tuple, allowing seamless connection migration without re-handshaking.',
      },
    ],
    practicePrompt: 'Explain why domain sharding and CSS spriting became anti-patterns once HTTP/2 rolled out.',
  },
  {
    id: 'cs-net-tls-dns',
    domain: 'cs-concepts',
    title: 'TLS 1.3 Handshake & Recursive DNS Resolution',
    subtitle: 'Symmetric session key exchange, certificate chains, and 1-RTT authentication',
    level: 'advanced',
    track: 'core-cs',
    subTrack: 'networks',
    isOptional: false,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 16,
    summary:
      'Recursive resolvers traverse Root -> TLD -> Authoritative nameservers before browsers negotiate ephemeral ECDHE symmetric encryption keys and verify X.509 certificate chains in one round-trip with TLS 1.3.',
    architectureFlow: [
      'Recursive DNS checks browser/OS/ISP cache -> queries Root (.) -> .com TLD -> Authoritative NS -> caches A/AAAA up to TTL.',
      'TLS 1.3 ClientHello sends supported cipher suites + ECDHE key_share immediately on first flight.',
      'Server replies ServerHello + key_share + encrypted Certificate Chain + Finished -> shared AES-GCM key derived via HKDF.',
      'Client verifies CA signature + hostname SAN and starts sending encrypted HTTP application payload on RTT 1.',
    ],
    tradeOffs: [
      {
        topic: 'TLS 1.3 vs TLS 1.2',
        whenToUse: 'Always prefer TLS 1.3 — 1-RTT setup, mandates forward-secret ECDHE, drops weak RSA/CBC ciphers.',
        whenToAvoid: 'Only keeping TLS 1.2 enabled for legacy embedded/enterprise clients.',
        alternative: 'TLS 1.3 with TLS 1.2 fallback',
      },
      {
        topic: '0-RTT Session Resumption',
        whenToUse: 'Idempotent GET requests skipping even 1 handshake RTT via pre-shared ticket.',
        whenToAvoid: 'Non-idempotent POST/payment mutations — 0-RTT early data is vulnerable to replay attacks.',
        alternative: '1-RTT full/resumed handshake for mutations',
      },
    ],
    scaleBenchmarks: [
      { label: 'TLS 1.2 vs TLS 1.3 RTT', value: '2 RTT vs 1 RTT', note: 'Halves cold TLS connection latency' },
      { label: 'Asymmetric vs Symmetric Speed', value: 'AES-NI ~10+ GB/s', note: 'Public-key RSA/ECDSA runs ONLY during handshake' },
    ],
    rapidQA: [
      {
        id: 'cs-tls-q1',
        question: 'Why does HTTPS use asymmetric cryptography only during handshake and symmetric encryption afterward?',
        answer:
          'Asymmetric crypto (ECDSA/ECDHE) lets strangers agree on a secret safely and verify certificates, while hardware-accelerated symmetric AES-GCM encrypts bulk traffic orders of magnitude faster.',
      },
      {
        id: 'cs-tls-q2',
        question: 'What security guarantee does Ephemeral Diffie-Hellman (ECDHE) provide if a server private key leaks later?',
        answer:
          'Forward Secrecy: each session generates ephemeral private keys wiped right after handshake, so captured past ciphertext cannot be decrypted using the stolen long-term certificate key.',
      },
    ],
    practicePrompt: 'Walk through every RTT and cryptographic message from typing a new HTTPS URL to rendering byte #1.',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // OPTIONAL TRACK: DISTRIBUTED SYSTEMS ("Additional · If Interested")
  // Explicitly marked isOptional: true — NEVER penalizes Core CS Radar score!
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'cs-ds-cap-pacelc',
    domain: 'cs-concepts',
    title: 'CAP Theorem & PACELC Trade-Offs',
    subtitle: 'Understanding CP vs AP under partitions and Latency vs Consistency in normal operation',
    level: 'intermediate',
    track: 'distributed-systems',
    subTrack: 'distributed-systems',
    isOptional: true,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 16,
    summary:
      'Network partitions (P) are inevitable in real clusters, forcing systems to choose between Availability (AP) or Linearizable Consistency (CP); PACELC adds that even without partitions, systems trade Latency (EL) for Consistency (EC).',
    architectureFlow: [
      'Normal operation (Else in PACELC): decide whether writes replicate synchronously (EC: higher latency, linearizable) or asynchronously (EL: fast response, eventual consistency).',
      'Partition occurs (P in CAP): link drops between minority and majority nodes.',
      'CP system (ZooKeeper, etcd, HBase) rejects/blocks writes on partitioned minority to protect invariants.',
      'AP system (Cassandra, Dynamo) accepts writes on both sides and reconciles conflicts via LWW / CRDTs later.',
    ],
    tradeOffs: [
      {
        topic: 'CP Systems (etcd, ZooKeeper, Spanner)',
        whenToUse: 'Leader leases, financial balances, distributed locks, unique usernames.',
        whenToAvoid: 'Shopping carts or feed views that must remain writable during partial network splits.',
        alternative: 'AP with eventual conflict resolution',
      },
      {
        topic: 'AP / PA-EL Systems (Cassandra, DynamoDB default)',
        whenToUse: 'Always-writable telemetry, carts, sessions where availability outranks strict freshness.',
        whenToAvoid: 'Atomic bank transfers unless upgraded per-query to Quorum/Strong reads.',
        alternative: 'PC/EC consensus DB',
      },
    ],
    scaleBenchmarks: [
      { label: 'PACELC Real-World Split', value: 'PA/EL vs PC/EC', note: 'Most systems sacrifice strict consistency even when healthy to keep p99 low' },
    ],
    rapidQA: [
      {
        id: 'cs-cap-q1',
        question: 'Why is "CA" (Consistent + Available without Partition tolerance) impossible in distributed databases?',
        answer:
          'Packets drop and switches fail in every multi-node network. Because partitions cannot be prevented, any distributed store must choose C or A when a split happens.',
      },
      {
        id: 'cs-cap-q2',
        question: 'What crucial dimension does PACELC capture that CAP ignores?',
        answer:
          'When NO partition exists (99.9% of runtime), replicating data across zones still creates a trade-off between Latency (async EL) and Consistency (sync EC).',
      },
    ],
    practicePrompt: 'Classify DynamoDB (eventual vs strong reads), PostgreSQL single-primary, and ZooKeeper under PACELC.',
  },
  {
    id: 'cs-ds-logical-vector-clocks',
    domain: 'cs-concepts',
    title: 'Physical Clocks vs Lamport & Vector Clocks',
    subtitle: 'Tracking happens-before causality without synchronized global wall clocks',
    level: 'advanced',
    track: 'distributed-systems',
    subTrack: 'distributed-systems',
    isOptional: true,
    isHighFrequencyCrashCourse: false,
    estimatedMinutes: 16,
    summary:
      'NTP wall clocks drift and jump backwards; Lamport clocks give total causal partial order, while Vector Clocks detect true concurrent conflicts (siblings) in leaderless systems.',
    architectureFlow: [
      'Local wall clocks suffer NTP skew -> trusting raw timestamps for Last-Write-Wins silently drops newer writes.',
      'Lamport clock increments counter per event and sets C = max(C_local, C_msg) + 1 on receive.',
      'Vector Clock maintains array [N1, N2, ..., Nk] incrementing caller index on updates.',
      'Comparing V(a) and V(b) distinguishes clear causality (V(a) < V(b)) from true concurrency (sibling conflict).',
    ],
    tradeOffs: [
      {
        topic: 'Last-Write-Wins (Wall Clock LWW)',
        whenToUse: 'Cache keys or ephemeral telemetry where occasional clock skew overwrites are acceptable.',
        whenToAvoid: 'Collaborative shopping carts or critical document edits.',
        alternative: 'Hybrid Logical Clocks (HLC) / CRDTs / Vector Clocks',
      },
      {
        topic: 'Vector Clocks / Version Vectors',
        whenToUse: 'Detecting sibling concurrent mutations across leaderless multi-replica stores.',
        whenToAvoid: 'Unbounded client IDs unless pruned/bounded by server actor IDs (Dotted Version Vectors).',
        alternative: 'Single-leader serialization or Raft term indexes',
      },
    ],
    scaleBenchmarks: [
      { label: 'NTP Drift Envelope', value: '1–50 ms', note: 'Far too noisy for sub-millisecond conflict ordering' },
      { label: 'TrueTime GPS/Atomic Bound', value: '< 7 ms', note: 'Google Spanner waits out uncertainty epsilon before committing' },
    ],
    rapidQA: [
      {
        id: 'cs-clk-q1',
        question: 'What can a Vector Clock tell you that a scalar Lamport timestamp cannot?',
        answer:
          'If L(A) < L(B) in a Lamport clock, A and B might STILL be concurrent! Vector Clocks distinguish exact causal ancestry from concurrent sibling writes.',
      },
      {
        id: 'cs-clk-q2',
        question: 'Why does Last-Write-Wins using client wall timestamps silently lose data?',
        answer:
          'A node whose NTP clock runs 100ms fast stamps older writes higher than a slower node’s genuinely later update, causing the earlier value to overwrite newer work.',
      },
    ],
    practicePrompt: 'Trace vector clocks across two clients concurrently modifying the same shopping cart across partitioned replicas.',
  },
  {
    id: 'cs-ds-dynamo-quorums',
    domain: 'cs-concepts',
    title: 'Leaderless Replication & Dynamo Quorums (W + R > N)',
    subtitle: 'Tuning tunable consistency, sloppy quorums, and read repair across N replicas',
    level: 'intermediate',
    track: 'distributed-systems',
    subTrack: 'distributed-systems',
    isOptional: true,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 16,
    summary:
      'Leaderless stores write to W of N replicas and read from R of N replicas; guaranteeing W + R > N ensures read sets overlap the newest write quorum, patched dynamically by Read Repair.',
    architectureFlow: [
      'Coordinator fans out write with version/timestamp to all N replicas and acks client once W reply.',
      'Read coordinator queries R replicas in parallel; at least one replica holds newest version when W + R > N.',
      'Coordinator returns newest version and triggers async Read Repair to stale replicas.',
      'If > N - W nodes fail, Sloppy Quorum hints temporary standby nodes (Hinted Handoff) for availability.',
    ],
    tradeOffs: [
      {
        topic: 'Balanced Quorum (N=3, W=2, R=2)',
        whenToUse: 'Strong overlap tolerating 1 down node while reading & writing.',
        whenToAvoid: 'Ultra-low-latency cross-WAN writes where waiting for W=2 hurts availability.',
        alternative: 'N=3, W=1, R=3 or LOCAL_QUORUM',
      },
      {
        topic: 'Strict Quorum vs Sloppy Quorum',
        whenToUse: 'Strict quorum protects W+R>N freshness; Sloppy quorum prioritizes writes remaining accepted during outages.',
        whenToAvoid: 'Assuming sloppy quorum still guarantees fresh reads (it does NOT!).',
        alternative: 'Strict Quorum inside DC',
      },
    ],
    scaleBenchmarks: [
      { label: 'Classic Dynamo Overlap', value: 'W + R > N (3: 2+2 > 3)', note: 'Pigeonhole principle forces intersection' },
    ],
    rapidQA: [
      {
        id: 'cs-quo-q1',
        question: 'Does satisfying W + R > N guarantee linearizable reads in Cassandra/Dynamo by itself?',
        answer:
          'Surprisingly no in edge cases: concurrent partial writes or sloppy quorums can return stale values unless paired with Read Repair blocking or Consensus/LWT.',
      },
      {
        id: 'cs-quo-q2',
        question: 'What is Hinted Handoff?',
        answer:
          'When a target replica is unreachable during a write, another cluster node temporarily holds the write with a hint header and replays it once the primary replica recovers.',
      },
    ],
    practicePrompt: 'Configure N, W, R values for (a) read-heavy configuration store vs (b) high-availability sensor write pipeline.',
  },
  {
    id: 'cs-ds-consistent-hashing',
    domain: 'cs-concepts',
    title: 'Consistent Hashing & Virtual Nodes',
    subtitle: 'Scaling distributed caches and shards with minimal key movement',
    level: 'intermediate',
    track: 'distributed-systems',
    subTrack: 'distributed-systems',
    isOptional: true,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 14,
    summary:
      'Hash nodes and keys onto a [0, 2^32 - 1] ring so adding or removing a server only redistributes 1/N keys; virtual nodes smooth out hotspots and heterogeneous hardware weights.',
    architectureFlow: [
      'Hash each physical server (plus V=100-200 virtual node tokens) onto sorted circular hash ring.',
      'Hash incoming request/key and walk clockwise (binary search on token ring) to find owning server.',
      'When node K fails or joins, ONLY keys immediately counter-clockwise to its virtual tokens relocate.',
      'Adjust virtual node count proportionally so beefier machines hold more ring slices cleanly.',
    ],
    tradeOffs: [
      {
        topic: 'Virtual Nodes vs Single Point per Server',
        whenToUse: 'Always use 100–200 vnodes per node — prevents skewed shard hotspots with few physical servers.',
        whenToAvoid: 'Extreme metadata constraints with millions of tiny clients (prefer Rendezvous / Jump Consistent Hash).',
        alternative: 'Jump Consistent Hash / Bounded-Load Consistent Hash',
      },
    ],
    scaleBenchmarks: [
      { label: 'Modulo hash(k)%N Remap', value: '~(N-1)/N keys move', note: 'Triggers massive cache-miss storm on scaling' },
      { label: 'Consistent Hash Remap', value: '~1/N keys move', note: 'Adding 10th cache node invalidates just ~10% of cache' },
    ],
    rapidQA: [
      {
        id: 'cs-ch-q1',
        question: 'How do Virtual Nodes fix two major flaws of basic consistent hashing?',
        answer:
          '(1) Even load spread: with 3 physical nodes, one could accidentally own 70% of the ring without vnodes; and (2) rebalance work spreads across ALL healthy peers if a server crashes.',
      },
      {
        id: 'cs-ch-q2',
        question: 'How do you handle a single mega-popular celebrity key ("hotkey") even on a balanced consistent hash ring?',
        answer:
          'Consistent hashing balances key count, not traffic per key. Fix hotkeys with key salting (key#0..key#7 across shards) or local in-process micro-caches.',
      },
    ],
    practicePrompt: 'Trace key ownership across a 4-node Redis cluster with 100 vnodes when node-3 drops unexpectedly.',
  },
  {
    id: 'cs-ds-raft-consensus',
    domain: 'cs-concepts',
    title: 'Raft Consensus Intuition (Leader Election & Log Replication)',
    subtitle: 'Understanding etcd, CockroachDB, and Kubernetes state machine replication',
    level: 'advanced',
    track: 'distributed-systems',
    subTrack: 'distributed-systems',
    isOptional: true,
    isHighFrequencyCrashCourse: false,
    estimatedMinutes: 18,
    summary:
      'Raft breaks distributed consensus into understandable phases: randomized election timeouts prevent split votes, a single Leader orders log entries, and majority commit (N/2 + 1) makes committed data permanent.',
    architectureFlow: [
      'Leader sends periodic AppendEntries heartbeats with monotonic Term number.',
      'If Follower misses heartbeat beyond randomized timeout (e.g. 150–300ms), it becomes Candidate in Term+1.',
      'Candidate requests votes; only up-to-date logs win, guaranteeing Election Safety (max 1 leader per term).',
      'Leader replicates client command to Followers; once majority ACK, entry commits and advances state machine.',
    ],
    tradeOffs: [
      {
        topic: 'Raft Quorum (e.g., 3 or 5 nodes)',
        whenToUse: 'Configuration stores, Kubernetes etcd, distributed locks, Raft-sharded SQL metadata.',
        whenToAvoid: 'Multi-region writes if WAN RTT > 100ms makes majority quorum writes too slow.',
        alternative: 'Partitioned Multi-Raft per range (CockroachDB / TiKV)',
      },
    ],
    scaleBenchmarks: [
      { label: 'Fault Tolerance Formula', value: 'N = 2F + 1 nodes', note: '3 nodes tolerate 1 crash; 5 nodes tolerate 2 crashes' },
      { label: 'Randomized Election Window', value: '150–300 ms', note: 'Breaks symmetry so split votes resolve within ~1 round' },
    ],
    rapidQA: [
      {
        id: 'cs-raft-q1',
        question: 'Why must Raft clusters contain an ODD number of voting members (3, 5, 7) instead of 4?',
        answer:
          'A 4-node cluster needs majority = 3, tolerating only 1 crash — identical fault tolerance to 3 nodes while paying higher quorum replication cost.',
      },
      {
        id: 'cs-raft-q2',
        question: 'How does Raft prevent two candidates from tying split votes forever?',
        answer:
          'Each node picks a randomized election timeout (e.g., 150–300ms); one candidate times out slightly earlier and gathers a majority before peers restart.',
      },
    ],
    practicePrompt: 'Explain why an isolated old Raft Leader cannot serve stale reads if ReadIndex / Leader Leases are used.',
  },
  {
    id: 'cs-ds-2pc-vs-saga',
    domain: 'cs-concepts',
    title: 'Distributed Transactions: Two-Phase Commit (2PC) vs Saga Pattern',
    subtitle: 'Blocking atomic lock coordination vs asynchronous compensating workflows',
    level: 'advanced',
    track: 'distributed-systems',
    subTrack: 'distributed-systems',
    isOptional: true,
    isHighFrequencyCrashCourse: true,
    estimatedMinutes: 16,
    summary:
      '2PC uses Prepare + Commit phases to achieve atomic cross-partition commit at the cost of holding locks if the Coordinator crashes; Sagas break transactions into local ACID steps + compensating rollbacks for high availability.',
    architectureFlow: [
      '2PC Phase 1 (Prepare): Coordinator asks participants to execute, write UNDO/REDO logs, hold locks, and vote Yes/No.',
      '2PC Phase 2 (Commit): Once all vote Yes, Coordinator logs decision permanently and broadcasts Commit -> locks release.',
      '2PC Failure: If Coordinator dies after Prepare votes, participants stay blocked holding locks until Coordinator recovers!',
      'Saga Alternative: Commit each service locally right away and run compensating reversal steps asynchronously on later failure.',
    ],
    tradeOffs: [
      {
        topic: 'Two-Phase Commit (2PC)',
        whenToUse: 'Internal homogeneous shard partitions inside a fast datacenter DB (pair coordinator with Raft for HA).',
        whenToAvoid: 'External microservices or third-party Stripe/Shipping APIs (blocks locks across slow/flaky HTTP).',
        alternative: 'Saga + Outbox Pattern',
      },
      {
        topic: 'Saga Pattern',
        whenToUse: 'Cross-microservice workflows spanning DBs, payment gateways, and queues.',
        whenToAvoid: 'Strict isolation invariants where dirty intermediate reads cannot be tolerated without semantic locks.',
        alternative: 'Semantic Reservations ("PENDING" hold) + Saga',
      },
    ],
    scaleBenchmarks: [
      { label: '2PC Sync Round-Trips', value: '2+ network RTTs under lock', note: 'Kills throughput on hot cross-shard rows' },
    ],
    rapidQA: [
      {
        id: 'cs-2pc-q1',
        question: 'Why is classic 2PC considered a blocking protocol?',
        answer:
          'If a participant votes YES in Phase 1 and the Coordinator crashes before Phase 2, that participant CANNOT unilaterally commit or abort and must lock its rows indefinitely until recovery.',
      },
      {
        id: 'cs-2pc-q2',
        question: 'How do Sagas handle missing Isolation (the I in ACID) during multi-step orders?',
        answer:
          'Use semantic locks/status flags (e.g., reservation = HELD, balance = PENDING) combined with commutative operations and idempotent compensation.',
      },
    ],
    practicePrompt: 'Choose between 2PC and Saga for booking a flight + hotel + rental car across three external partner APIs.',
  },
  {
    id: 'cs-ds-gossip-merkle',
    domain: 'cs-concepts',
    title: 'Gossip Protocols, Failure Detection & Merkle Trees',
    subtitle: 'Decentralized O(log N) cluster membership and fast anti-entropy sync',
    level: 'advanced',
    track: 'distributed-systems',
    subTrack: 'distributed-systems',
    isOptional: true,
    isHighFrequencyCrashCourse: false,
    estimatedMinutes: 15,
    summary:
      'Nodes avoid central registry bottlenecks by exchanging cluster state with K random peers every second (infecting N nodes in O(log N) rounds) and comparing key ranges swiftly via Merkle hash trees.',
    architectureFlow: [
      'Every second, node sends compact heartbeat generation map to 3 random peers (Gossip / SWIM protocol).',
      'Information disseminates exponentially across 1,000+ node rings in ~10 rounds without a central registry.',
      'To repair silent bit-rot or missed hints between replicas, nodes maintain Merkle hash trees over key ranges.',
      'Comparing top-level root hashes skips identical replicas instantly and narrows divergence down to O(log keys) buckets.',
    ],
    tradeOffs: [
      {
        topic: 'Gossip Membership vs Central Consensus (etcd/ZooKeeper)',
        whenToUse: 'Massive peer-to-peer rings (Cassandra, Dynamo, Consul SWIM) where eventual membership converges cheaply.',
        whenToAvoid: 'Strict linearizable configuration or distributed lock election (use Raft CP store instead).',
        alternative: 'Raft/Paxos coordinator',
      },
    ],
    scaleBenchmarks: [
      { label: 'Gossip Convergence Rounds', value: 'O(log N)', note: '1,000 nodes learn failure or join status within seconds' },
      { label: 'Merkle Anti-Entropy Cost', value: 'O(1) on sync match', note: 'Only diverging hash branches cross the network' },
    ],
    rapidQA: [
      {
        id: 'cs-gos-q1',
        question: 'How do Merkle Trees cut network bandwidth during replica anti-entropy synchronization?',
        answer:
          'Each node hashes key buckets hierarchically into a binary tree. Two synchronized replicas compare only their top root hash (a few bytes) and descend only branches where hashes differ.',
      },
      {
        id: 'cs-gos-q2',
        question: 'Why does Cassandra avoid electing a single master node with Gossip + Consistent Hashing?',
        answer:
          'Every node shares equal cluster topology via Gossip so any coordinator can route writes directly to owning replicas — giving zero single-point-of-failure downtime.',
      },
    ],
    practicePrompt: 'Explain how a 200-node Cassandra ring detects a dead node and heals missed writes after 2 hours offline.',
  },
];
