import { logger } from '../../../shared/logger.js';
import {
  ComposeTopology,
  MAX_MANIFEST_BYTES,
  baseName,
  isComposeFileName,
  isDockerfileName,
  normalizePath,
  parseCargoToml,
  parseComposeTopology,
  parseGoMod,
  parsePackageJson,
  parsePomXml,
  parseRequirementsTxt,
  parsePyproject,
} from './manifestParsers.js';

export interface SystemDesignSignals {
  // Caching Systems
  hasRedis: boolean;
  hasMemcached: boolean;
  hasCaching: boolean;
  
  // Queue Systems
  hasBullMQ: boolean;
  hasRabbitMQ: boolean;
  hasKafka: boolean;
  hasSQS: boolean;
  hasQueueSystems: boolean;
  
  // Real-time Communication
  hasSSEWebSockets: boolean;
  hasSocketIO: boolean;
  hasWebRTC: boolean;
  
  // Containerization & Deployment
  hasDocker: boolean;
  hasKubernetes: boolean;
  hasDeploymentPipelines: boolean;
  hasInfraOrchestration: boolean;
  /** Distinct services declared across the repositories' docker-compose files (largest repo). */
  composeServiceCount: number;
  /** True when a docker-compose file declares two or more services. */
  hasMultiServiceTopology: boolean;
  
  // Monitoring & Observability
  hasMonitoring: boolean;
  hasLogging: boolean;
  hasTracing: boolean;
  hasMetrics: boolean;
  
  // CDN & Edge
  hasCDN: boolean;
  hasEdgeComputing: boolean;
  
  // Database Systems
  hasPostgreSQL: boolean;
  hasMongoDB: boolean;
  hasMySQL: boolean;
  hasElasticsearch: boolean;
  
  // API Design
  hasGraphQL: boolean;
  hasREST: boolean;
  hasgRPC: boolean;
  
  // Security
  hasAuthSystem: boolean;
  hasRateLimiting: boolean;
  hasEncryption: boolean;
}

type BooleanSignal = {
  [K in keyof SystemDesignSignals]: SystemDesignSignals[K] extends boolean ? K : never;
}[keyof SystemDesignSignals];

/**
 * Dependency names from Python, Go, Java and Rust manifests (lower-cased; Go module paths,
 * Maven "group:artifact", crate names) mapped to the same signals the npm detectors set.
 */
const MANIFEST_SIGNAL_RULES: Array<[RegExp, BooleanSignal[]]> = [
  // Caching
  [/redis|jedis|lettuce|rueidis|valkey/, ['hasRedis', 'hasCaching']],
  [/memcache/, ['hasMemcached', 'hasCaching']],
  [/cachetools|caffeine|ehcache|bigcache|ristretto|go-cache|groupcache|dogpile|^moka$/, ['hasCaching']],
  // Queues
  [/^(celery|rq|dramatiq|huey|arq|taskiq|kombu)$|asynq|riverqueue|machinery|activemq|artemis/, ['hasQueueSystems']],
  [/rabbitmq|amqp|lapin|^(pika|aio-pika|aiormq)$/, ['hasRabbitMQ', 'hasQueueSystems']],
  [/kafka|sarama|redpanda/, ['hasKafka', 'hasQueueSystems']],
  [/sqs|elasticmq/, ['hasSQS', 'hasQueueSystems']],
  // Databases
  [/postgres|psycopg|asyncpg|pg8000|pgx|lib\/pq$|go-pg/, ['hasPostgreSQL']],
  [/mongo|^(motor|beanie|odmantic)$/, ['hasMongoDB']],
  [/mysql|mariadb|asyncmy/, ['hasMySQL']],
  [/elasticsearch|opensearch/, ['hasElasticsearch']],
  // Observability
  [/prometheus|micrometer|statsd|datadog|ddtrace|newrelic/, ['hasMonitoring', 'hasMetrics']],
  [/sentry|bugsnag|rollbar|honeybadger/, ['hasMonitoring']],
  [/opentelemetry|jaeger|zipkin|otel/, ['hasTracing', 'hasMonitoring']],
  [/^(structlog|loguru|python-json-logger|tracing|tracing-subscriber|tracing-appender|env-logger|flexi-logger)$|logrus|zerolog|go\.uber\.org\/zap|logback|log4j|slf4j/, ['hasLogging']],
];

/** Image (or service name) fragments in a docker-compose file mapped to signals. */
const COMPOSE_SIGNAL_RULES: Array<[RegExp, BooleanSignal[]]> = [
  [/(?:^|[/_.{:-])(redis|valkey|keydb|dragonfly)/, ['hasRedis', 'hasCaching']],
  [/(?:^|[/_.{:-])memcached/, ['hasMemcached', 'hasCaching']],
  [/(?:^|[/_.{:-])(postgres|postgis|timescaledb|pgvector)/, ['hasPostgreSQL']],
  [/(?:^|[/_.{:-])mongo/, ['hasMongoDB']],
  [/(?:^|[/_.{:-])(mysql|mariadb|percona)/, ['hasMySQL']],
  [/(?:^|[/_.{:-])(elasticsearch|opensearch)/, ['hasElasticsearch']],
  [/(?:^|[/_.{:-])rabbitmq/, ['hasRabbitMQ', 'hasQueueSystems']],
  [/(?:^|[/_.{:-])(kafka|redpanda)/, ['hasKafka', 'hasQueueSystems']],
  [/(?:^|[/_.{:-])elasticmq/, ['hasSQS', 'hasQueueSystems']],
  [/(?:^|[/_.{:-])nats/, ['hasQueueSystems']],
  [/(?:^|[/_.{:-])(prometheus|grafana|victoriametrics)/, ['hasMonitoring', 'hasMetrics']],
  [/(?:^|[/_.{:-])(jaeger|jaegertracing|zipkin|opentelemetry|otel)/, ['hasTracing', 'hasMonitoring']],
];

/** Admin UIs and exporters share an infra name but do not mean the service itself is used. */
const COMPOSE_IGNORED = /commander|insight|exporter|express|admin|gui|webui/;

export const SystemDesignSignalExtractor = {
  /**
   * Extracts comprehensive infrastructure and system design maturity from repository artifacts.
   * Explicitly avoids self-declared skills - only verified engineering artifacts count.
   */
  extractSignals(repositories: any[]): SystemDesignSignals {
    const signals: SystemDesignSignals = {
      // Caching Systems
      hasRedis: false,
      hasMemcached: false,
      hasCaching: false,
      
      // Queue Systems
      hasBullMQ: false,
      hasRabbitMQ: false,
      hasKafka: false,
      hasSQS: false,
      hasQueueSystems: false,
      
      // Real-time Communication
      hasSSEWebSockets: false,
      hasSocketIO: false,
      hasWebRTC: false,
      
      // Containerization & Deployment
      hasDocker: false,
      hasKubernetes: false,
      hasDeploymentPipelines: false,
      hasInfraOrchestration: false,
      composeServiceCount: 0,
      hasMultiServiceTopology: false,
      
      // Monitoring & Observability
      hasMonitoring: false,
      hasLogging: false,
      hasTracing: false,
      hasMetrics: false,
      
      // CDN & Edge
      hasCDN: false,
      hasEdgeComputing: false,
      
      // Database Systems
      hasPostgreSQL: false,
      hasMongoDB: false,
      hasMySQL: false,
      hasElasticsearch: false,
      
      // API Design
      hasGraphQL: false,
      hasREST: false,
      hasgRPC: false,
      
      // Security
      hasAuthSystem: false,
      hasRateLimiting: false,
      hasEncryption: false,
    };

    repositories.forEach(repo => {
      const manifests = this.readManifests(repo);
      const files = manifests.files;
      const deps = [...(repo.dependencies || []), ...manifests.npmDependencies];
      const devDeps = [...(repo.devDependencies || []), ...manifests.npmDevDependencies];
      const scripts = repo.scripts || {};
      
      // Detect Caching Systems
      this.detectCachingSignals(deps, signals);
      
      // Detect Queue Systems
      this.detectQueueSignals(deps, signals);
      
      // Detect Real-time Communication
      this.detectRealtimeSignals(deps, signals);
      
      // Detect Containerization & Deployment
      this.detectDeploymentSignals(files, deps, scripts, signals);
      
      // Detect Monitoring & Observability
      this.detectMonitoringSignals(deps, devDeps, files, signals);
      
      // Detect CDN & Edge
      this.detectCDNSignals(deps, files, signals);
      
      // Detect Database Systems
      this.detectDatabaseSignals(deps, signals);
      
      // Detect API Design Patterns
      this.detectAPISignals(deps, files, signals);
      
      // Detect Security Patterns
      this.detectSecuritySignals(deps, files, signals);

      // Detect signals from non-npm manifests and docker-compose service topology
      this.detectManifestSignals(manifests.foreignDependencies, signals);
      this.detectComposeSignals(manifests.compose, signals);
    });

    return signals;
  },

  /**
   * True when a file with this exact name exists at any depth in the repo.
   */
  hasFileNamed(files: string[], name: string): boolean {
    return files.some(file => baseName(file) === name);
  },

  /**
   * Normalises the repo's file list (monorepo paths included) and reads the optional
   * `fileContents` map (path -> text) for compose files and dependency manifests.
   * Contents are optional: with only paths, just the file-name signals apply.
   */
  readManifests(repo: any): {
    files: string[];
    compose: ComposeTopology;
    npmDependencies: string[];
    npmDevDependencies: string[];
    foreignDependencies: string[];
  } {
    const contents = new Map<string, string>();
    const rawContents = repo?.fileContents;
    if (rawContents && typeof rawContents === 'object') {
      for (const [path, text] of Object.entries(rawContents)) {
        if (typeof text === 'string' && text.length <= MAX_MANIFEST_BYTES) {
          contents.set(normalizePath(path), text);
        }
      }
    }

    const files = Array.from(new Set([
      ...(Array.isArray(repo?.files) ? repo.files : [])
        .filter((file: unknown): file is string => typeof file === 'string')
        .map(normalizePath),
      ...contents.keys(),
    ]));

    const serviceByName = new Map<string, ComposeTopology['services'][number]>();
    const npmDependencies: string[] = [];
    const npmDevDependencies: string[] = [];
    const foreignDependencies: string[] = [];

    for (const [path, text] of contents) {
      const name = baseName(path);
      if (isComposeFileName(name)) {
        parseComposeTopology(text).services.forEach(service => {
          const known = serviceByName.get(service.name);
          // override files repeat service names, so merge instead of double counting
          serviceByName.set(service.name, known
            ? {
                name: service.name,
                image: service.image ?? known.image,
                dependsOn: Array.from(new Set([...known.dependsOn, ...service.dependsOn])),
              }
            : service);
        });
      } else if (name === 'package.json') {
        const parsed = parsePackageJson(text);
        npmDependencies.push(...parsed.dependencies);
        npmDevDependencies.push(...parsed.devDependencies);
      } else if (name === 'requirements.txt' || /^requirements[-.\w]*\.txt$/.test(name)) {
        foreignDependencies.push(...parseRequirementsTxt(text));
      } else if (name === 'pyproject.toml') {
        foreignDependencies.push(...parsePyproject(text));
      } else if (name === 'go.mod') {
        foreignDependencies.push(...parseGoMod(text));
      } else if (name === 'Cargo.toml') {
        foreignDependencies.push(...parseCargoToml(text));
      } else if (name === 'pom.xml') {
        foreignDependencies.push(...parsePomXml(text));
      }
    }

    return {
      files,
      compose: { services: Array.from(serviceByName.values()) },
      npmDependencies,
      npmDevDependencies,
      foreignDependencies,
    };
  },

  /**
   * Signals from Python, Go, Java and Rust dependency names (caching, queues, databases,
   * observability).
   */
  detectManifestSignals(dependencyNames: string[], signals: SystemDesignSignals): void {
    dependencyNames.forEach(dep => {
      const normalized = dep.toLowerCase();
      MANIFEST_SIGNAL_RULES.forEach(([pattern, flags]) => {
        if (pattern.test(normalized)) flags.forEach(flag => { signals[flag] = true; });
      });
    });
  },

  /**
   * Signals from a parsed docker-compose topology: infra images (redis, postgres, rabbitmq,
   * kafka, ...) and the number of declared services.
   */
  detectComposeSignals(compose: ComposeTopology, signals: SystemDesignSignals): void {
    const { services } = compose;
    if (services.length === 0) return;

    signals.hasDocker = true;
    signals.composeServiceCount = Math.max(signals.composeServiceCount, services.length);
    if (services.length >= 2) signals.hasMultiServiceTopology = true;

    const defined = new Set(services.map(service => service.name));
    const refs: string[] = [];
    services.forEach(service => {
      // The image says what a service runs; fall back to the name for build-only services
      refs.push(service.image ?? service.name);
      // depends_on can point at an infra service that is declared elsewhere (extends/override)
      service.dependsOn.filter(name => !defined.has(name)).forEach(name => refs.push(name));
    });

    refs.forEach(ref => {
      const normalized = ref.toLowerCase().replace(/@.*$/, '').replace(/:[^/:]*$/, '');
      if (COMPOSE_IGNORED.test(normalized)) return;
      COMPOSE_SIGNAL_RULES.forEach(([pattern, flags]) => {
        if (pattern.test(normalized)) flags.forEach(flag => { signals[flag] = true; });
      });
    });
  },

  /**
   * Detect caching system signals
   */
  detectCachingSignals(deps: string[], signals: SystemDesignSignals): void {
    const cacheDeps = ['redis', 'ioredis', 'redis-mock', '@redis/client', 'memcached', 'node-cache', 'lru-cache'];
    
    deps.forEach(dep => {
      const normalized = dep.toLowerCase();
      if (normalized.includes('redis')) {
        signals.hasRedis = true;
        signals.hasCaching = true;
      }
      if (normalized.includes('memcached')) {
        signals.hasMemcached = true;
        signals.hasCaching = true;
      }
      if (cacheDeps.some(cache => normalized.includes(cache))) {
        signals.hasCaching = true;
      }
    });
  },

  /**
   * Detect queue system signals
   */
  detectQueueSignals(deps: string[], signals: SystemDesignSignals): void {
    deps.forEach(dep => {
      const normalized = dep.toLowerCase();
      if (normalized.includes('bullmq')) {
        signals.hasBullMQ = true;
        signals.hasQueueSystems = true;
      }
      if (normalized.includes('amqplib') || normalized.includes('rabbitmq')) {
        signals.hasRabbitMQ = true;
        signals.hasQueueSystems = true;
      }
      if (normalized.includes('kafka') || normalized.includes('kafkajs')) {
        signals.hasKafka = true;
        signals.hasQueueSystems = true;
      }
      if (normalized.includes('sqs') || normalized.includes('aws-sdk')) {
        signals.hasSQS = true;
        signals.hasQueueSystems = true;
      }
    });
  },

  /**
   * Detect real-time communication signals
   */
  detectRealtimeSignals(deps: string[], signals: SystemDesignSignals): void {
    deps.forEach(dep => {
      const normalized = dep.toLowerCase();
      if (normalized.includes('socket.io')) {
        signals.hasSocketIO = true;
        signals.hasSSEWebSockets = true;
      }
      if (normalized.includes('ws') || normalized.includes('websocket')) {
        signals.hasSSEWebSockets = true;
      }
      if (normalized.includes('webrtc') || normalized.includes('simple-peer')) {
        signals.hasWebRTC = true;
        signals.hasSSEWebSockets = true;
      }
    });
  },

  /**
   * Detect deployment and containerization signals
   */
  detectDeploymentSignals(files: string[], deps: string[], scripts: any, signals: SystemDesignSignals): void {
    // Docker detection (any directory, so services/api/Dockerfile counts in a monorepo)
    if (files.some(file => {
      const name = baseName(file);
      return isDockerfileName(name) || isComposeFileName(name) || name === '.dockerignore';
    })) {
      signals.hasDocker = true;
    }
    
    // Kubernetes detection
    const k8sFiles = ['kubernetes/', 'k8s/', 'deployment.yaml', 'service.yaml'];
    if (k8sFiles.some(file => files.some(f => f.includes(file)))) {
      signals.hasKubernetes = true;
      signals.hasInfraOrchestration = true;
    }
    
    // CI/CD detection
    const ciFiles = ['.github/workflows/', '.gitlab-ci.yml', 'Jenkinsfile', 'circleci/'];
    if (ciFiles.some(file => files.some(f => f.includes(file)))) {
      signals.hasDeploymentPipelines = true;
    }
    
    // Infrastructure as Code
    const iacDeps = ['terraform', 'pulumi', 'aws-cdk', 'serverless'];
    if (iacDeps.some(dep => deps.some(d => d.toLowerCase().includes(dep)))) {
      signals.hasInfraOrchestration = true;
    }
    
    // Cloud providers
    const cloudDeps = ['aws-sdk', '@aws-sdk/client-', 'gcp', '@google-cloud/', 'azure'];
    if (cloudDeps.some(dep => deps.some(d => d.toLowerCase().includes(dep)))) {
      signals.hasInfraOrchestration = true;
    }
  },

  /**
   * Detect monitoring and observability signals
   */
  detectMonitoringSignals(deps: string[], devDeps: string[], files: string[], signals: SystemDesignSignals): void {
    const allDeps = [...deps, ...devDeps];
    
    allDeps.forEach(dep => {
      const normalized = dep.toLowerCase();
      
      // Monitoring
      if (normalized.includes('datadog') || normalized.includes('prometheus') || 
          normalized.includes('newrelic') || normalized.includes('appdynamics')) {
        signals.hasMonitoring = true;
        signals.hasMetrics = true;
      }
      
      // Logging
      if (normalized.includes('winston') || normalized.includes('pino') || 
          normalized.includes('bunyan') || normalized.includes('morgan')) {
        signals.hasLogging = true;
      }
      
      // Tracing
      if (normalized.includes('jaeger') || normalized.includes('zipkin') || 
          normalized.includes('opentelemetry') || normalized.includes('@opentelemetry/')) {
        signals.hasTracing = true;
        signals.hasMonitoring = true;
      }
      
      // Error tracking
      if (normalized.includes('sentry') || normalized.includes('bugsnag') || 
          normalized.includes('rollbar')) {
        signals.hasMonitoring = true;
      }
    });
    
    // Check for monitoring configuration files
    const monitoringFiles = ['prometheus.yml', 'datadog.json', 'sentry.js'];
    if (monitoringFiles.some(file => this.hasFileNamed(files, file))) {
      signals.hasMonitoring = true;
    }
  },

  /**
   * Detect CDN and edge computing signals
   */
  detectCDNSignals(deps: string[], files: string[], signals: SystemDesignSignals): void {
    deps.forEach(dep => {
      const normalized = dep.toLowerCase();
      if (normalized.includes('cloudflare') || normalized.includes('fastly') || 
          normalized.includes('akamai') || normalized.includes('cdn')) {
        signals.hasCDN = true;
      }
      if (normalized.includes('cloudflare-workers') || normalized.includes('vercel') || 
          normalized.includes('netlify') || normalized.includes('edge-')) {
        signals.hasEdgeComputing = true;
        signals.hasCDN = true;
      }
    });
    
    // Check for CDN configuration
    const cdnFiles = ['vercel.json', 'netlify.toml', '_redirects'];
    if (cdnFiles.some(file => this.hasFileNamed(files, file))) {
      signals.hasCDN = true;
    }
  },

  /**
   * Detect database system signals
   */
  detectDatabaseSignals(deps: string[], signals: SystemDesignSignals): void {
    deps.forEach(dep => {
      const normalized = dep.toLowerCase();
      
      if (normalized.includes('pg') || normalized.includes('postgres') || 
          normalized.includes('postgresql')) {
        signals.hasPostgreSQL = true;
      }
      if (normalized.includes('mongoose') || normalized.includes('mongodb') || 
          normalized.includes('mongodb-driver')) {
        signals.hasMongoDB = true;
      }
      if (normalized.includes('mysql') || normalized.includes('mysql2')) {
        signals.hasMySQL = true;
      }
      if (normalized.includes('elasticsearch') || normalized.includes('@elastic/elasticsearch')) {
        signals.hasElasticsearch = true;
      }
    });
  },

  /**
   * Detect API design pattern signals
   */
  detectAPISignals(deps: string[], files: string[], signals: SystemDesignSignals): void {
    deps.forEach(dep => {
      const normalized = dep.toLowerCase();
      
      if (normalized.includes('graphql') || normalized.includes('apollo')) {
        signals.hasGraphQL = true;
      }
      if (normalized.includes('express') || normalized.includes('fastify') || 
          normalized.includes('koa') || normalized.includes('rest')) {
        signals.hasREST = true;
      }
      if (normalized.includes('grpc') || normalized.includes('@grpc')) {
        signals.hasgRPC = true;
      }
    });
    
    // Check for API definition files
    const apiFiles = ['openapi.yaml', 'swagger.yaml', 'graphql.schema'];
    if (apiFiles.some(file => this.hasFileNamed(files, file))) {
      signals.hasREST = true;
    }
  },

  /**
   * Detect security pattern signals
   */
  detectSecuritySignals(deps: string[], files: string[], signals: SystemDesignSignals): void {
    deps.forEach(dep => {
      const normalized = dep.toLowerCase();
      
      // Authentication
      if (normalized.includes('passport') || normalized.includes('jsonwebtoken') || 
          normalized.includes('auth0') || normalized.includes('firebase-auth')) {
        signals.hasAuthSystem = true;
      }
      
      // Rate limiting
      if (normalized.includes('rate-limiter') || normalized.includes('express-rate-limit') || 
          normalized.includes('redis-rate-limit')) {
        signals.hasRateLimiting = true;
      }
      
      // Encryption
      if (normalized.includes('crypto') || normalized.includes('bcrypt') || 
          normalized.includes('argon2') || normalized.includes('encryption')) {
        signals.hasEncryption = true;
      }
    });
    
    // Check for security configuration files
    const securityFiles = ['.env.example', 'security.md', 'auth.config.js'];
    if (securityFiles.some(file => this.hasFileNamed(files, file))) {
      signals.hasAuthSystem = true;
    }
  },
};
