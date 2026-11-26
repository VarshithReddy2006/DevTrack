import { describe, expect, it } from 'vitest';
import { SystemDesignSignalExtractor } from '../SystemDesignSignalExtractor.js';
import { parseDockerfile } from '../dockerfileParser.js';
import { parseKubernetesManifest } from '../k8sManifestParser.js';
import { ProjectIntelligenceEngine } from '../ProjectIntelligenceEngine.js';
import {
  parseCargoToml,
  parseComposeTopology,
  parseGoMod,
  parsePomXml,
  parsePyproject,
  parseRequirementsTxt,
} from '../manifestParsers.js';

const extract = (repo: Record<string, unknown>) => SystemDesignSignalExtractor.extractSignals([repo]);

describe('Dockerfile and Kubernetes manifest parsing', () => {
  it('extracts multi-stage, non-root, healthcheck and minimal-image Docker practices', () => {
    const content = [
      'FROM --platform=$BUILDPLATFORM node:20-alpine AS build',
      'RUN npm ci',
      'FROM gcr.io/distroless/nodejs20-debian12',
      'USER 10001:10001',
      'HEALTHCHECK --interval=30s CMD node healthcheck.js',
    ].join('\n');

    expect(parseDockerfile(content)).toEqual({
      hasMultiStageBuild: true,
      hasNonRootUser: true,
      hasHealthcheck: true,
      usesMinimalBaseImage: true,
    });
  });

  it('does not count a root user or disabled healthcheck as hardened practices', () => {
    expect(parseDockerfile('FROM node:20-alpine\nUSER 0\nHEALTHCHECK NONE')).toEqual({
      hasMultiStageBuild: false,
      hasNonRootUser: false,
      hasHealthcheck: false,
      usesMinimalBaseImage: true,
    });
  });

  it('parses multi-document Kubernetes YAML for scaling, reliability and TLS', () => {
    const content = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution: []
      containers:
        - name: api
          image: example/api:1
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 500m, memory: 512Mi }
          livenessProbe: { httpGet: { path: /health, port: 3000 } }
          readinessProbe: { httpGet: { path: /ready, port: 3000 } }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api
spec:
  minReplicas: 2
  maxReplicas: 8
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api
spec:
  tls:
    - hosts: [api.example.com]
      secretName: api-tls
`;

    expect(parseKubernetesManifest(content)).toEqual({
      isKubernetesManifest: true,
      hasResourceLimits: true,
      hasResourceRequests: true,
      hasHighAvailability: true,
      hasHealthProbes: true,
      hasAutoscaling: true,
      hasIngressTLS: true,
    });
  });

  it('ignores malformed and oversized Kubernetes manifests safely', () => {
    expect(() => parseKubernetesManifest('apiVersion: [\nkind: Deployment')).not.toThrow();
    expect(parseKubernetesManifest('apiVersion: [\nkind: Deployment')).toMatchObject({
      isKubernetesManifest: false,
    });
    expect(parseKubernetesManifest(`kind: Pod\n${' '.repeat(512 * 1024)}`).isKubernetesManifest).toBe(false);
  });

  it('integrates parsed container signals into the extractor and scoring matrix', () => {
    const signals = extract({
      files: ['Dockerfile', 'infra/app.yml'],
      fileContents: {
        Dockerfile: 'FROM node:20-alpine AS build\nFROM gcr.io/distroless/nodejs20\nUSER app\nHEALTHCHECK CMD node health.js',
        'infra/app.yml': `apiVersion: apps/v1
kind: Deployment
metadata: { name: app }
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: app
          image: example/app:1
          resources:
            requests: { cpu: 100m }
            limits: { cpu: 500m }
          readinessProbe: { tcpSocket: { port: 3000 } }
`,
      },
    });

    expect(signals.hasDocker).toBe(true);
    expect(signals.hasKubernetes).toBe(true);
    expect(signals.hasMultiStageDockerBuild).toBe(true);
    expect(signals.hasNonRootDockerUser).toBe(true);
    expect(signals.hasDockerHealthcheck).toBe(true);
    expect(signals.usesMinimalDockerBaseImage).toBe(true);
    expect(signals.hasKubernetesResourceLimits).toBe(true);
    expect(signals.hasKubernetesResourceRequests).toBe(true);
    expect(signals.hasKubernetesHighAvailability).toBe(true);
    expect(signals.hasKubernetesHealthProbes).toBe(true);

    expect(ProjectIntelligenceEngine.calculateDeploymentEvidence({
      hasDocker: true,
      hasNonRootDockerUser: true,
    })).toBe(45);
    expect(ProjectIntelligenceEngine.calculateInfrastructureSophistication({
      hasKubernetes: true,
      hasKubernetesAutoscaling: true,
    })).toBe(25);
  });
});

const MULTI_SERVICE_COMPOSE = `
# local stack
version: "3.9"
services:
  web:
    build: ./web
    ports:
      - "3000:3000"
    depends_on:
      - api
  api:
    build:
      context: ./api
    environment:
      REDIS_URL: redis://cache:6379   # not a comment on the key
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started
      queue:
        condition: service_started
  db:
    image: "postgres:16-alpine"
    volumes:
      - pgdata:/var/lib/postgresql/data
  cache:
    image: redis:7-alpine
  queue:
    image: rabbitmq:3-management
volumes:
  pgdata:
`;

describe('SystemDesignSignalExtractor docker-compose topology', () => {
  it('reads services, images and depends_on from a multi-service compose file', () => {
    const topology = parseComposeTopology(MULTI_SERVICE_COMPOSE);

    expect(topology.services.map(s => s.name)).toEqual(['web', 'api', 'db', 'cache', 'queue']);
    expect(topology.services.find(s => s.name === 'db')?.image).toBe('postgres:16-alpine');
    expect(topology.services.find(s => s.name === 'web')?.dependsOn).toEqual(['api']);
    expect(topology.services.find(s => s.name === 'api')?.dependsOn).toEqual(['db', 'cache', 'queue']);
  });

  it('turns compose services into cache, queue, database and service-count signals', () => {
    const signals = extract({
      files: ['docker-compose.yml'],
      fileContents: { 'docker-compose.yml': MULTI_SERVICE_COMPOSE },
    });

    expect(signals.hasRedis).toBe(true);
    expect(signals.hasCaching).toBe(true);
    expect(signals.hasPostgreSQL).toBe(true);
    expect(signals.hasRabbitMQ).toBe(true);
    expect(signals.hasQueueSystems).toBe(true);
    expect(signals.hasDocker).toBe(true);
    expect(signals.composeServiceCount).toBe(5);
    expect(signals.hasMultiServiceTopology).toBe(true);

    expect(signals.hasMongoDB).toBe(false);
    expect(signals.hasKafka).toBe(false);
    expect(signals.hasMySQL).toBe(false);
  });

  it('handles list and inline depends_on, CRLF line endings and compose.yaml', () => {
    const content = [
      'services:',
      '  app:',
      '    build: .',
      '    depends_on: [mongo, "kafka"]',
      '  worker:',
      '    build: .',
      '    depends_on:',
      '    - mongo',
      '  mongo:',
      '    image: mongo:7',
      '  kafka:',
      '    image: bitnami/kafka:3.7',
      '',
    ].join('\r\n');

    const topology = parseComposeTopology(content);
    expect(topology.services.find(s => s.name === 'app')?.dependsOn).toEqual(['mongo', 'kafka']);
    expect(topology.services.find(s => s.name === 'worker')?.dependsOn).toEqual(['mongo']);

    const signals = extract({ files: ['compose.yaml'], fileContents: { 'compose.yaml': content } });
    expect(signals.hasMongoDB).toBe(true);
    expect(signals.hasKafka).toBe(true);
    expect(signals.hasQueueSystems).toBe(true);
    expect(signals.composeServiceCount).toBe(4);
  });

  it('uses the service name when a service has no image and ignores admin UIs', () => {
    const signals = extract({
      files: ['docker-compose.yml'],
      fileContents: {
        'docker-compose.yml': [
          'services:',
          '  redis:',
          '    build: ./redis',
          '  mongo-ui:',
          '    image: mongo-express:latest',
          '  cache-ui:',
          '    image: rediscommander/redis-commander',
        ].join('\n'),
      },
    });

    expect(signals.hasRedis).toBe(true);
    expect(signals.hasMongoDB).toBe(false);
  });

  it('does not infer infra from a compose file name alone', () => {
    const signals = extract({ files: ['docker-compose.yml'] });

    expect(signals.hasDocker).toBe(true);
    expect(signals.hasRedis).toBe(false);
    expect(signals.hasPostgreSQL).toBe(false);
    expect(signals.composeServiceCount).toBe(0);
    expect(signals.hasMultiServiceTopology).toBe(false);
  });

  it('merges override files instead of double counting services', () => {
    const signals = extract({
      files: ['docker-compose.yml', 'docker-compose.prod.yml'],
      fileContents: {
        'docker-compose.yml': 'services:\n  api:\n    build: .\n  cache:\n    image: redis:7\n',
        'docker-compose.prod.yml': 'services:\n  api:\n    image: registry.example.com/api:1\n  db:\n    image: postgres:16\n',
      },
    });

    expect(signals.composeServiceCount).toBe(3);
    expect(signals.hasRedis).toBe(true);
    expect(signals.hasPostgreSQL).toBe(true);
  });

  it('keeps the largest service count across repositories', () => {
    const signals = SystemDesignSignalExtractor.extractSignals([
      { files: ['docker-compose.yml'], fileContents: { 'docker-compose.yml': MULTI_SERVICE_COMPOSE } },
      { files: ['docker-compose.yml'], fileContents: { 'docker-compose.yml': 'services:\n  app:\n    build: .\n' } },
    ]);

    expect(signals.composeServiceCount).toBe(5);
  });
});

describe('SystemDesignSignalExtractor monorepo layout', () => {
  const monorepo = {
    files: [
      './services/api/Dockerfile',
      'services\\worker\\Dockerfile.prod',
      'apps/web/package.json',
      'services/worker/go.mod',
      'services/ml/requirements.txt',
      'infra/k8s/deployment.yaml',
      'services/api/prometheus.yml',
    ],
    fileContents: {
      'apps/web/package.json': JSON.stringify({
        dependencies: { ioredis: '^5.0.0', bullmq: '^5.0.0' },
        devDependencies: { vitest: '^1.0.0' },
      }),
      'services/worker/go.mod': [
        'module example.com/worker',
        '',
        'go 1.22',
        '',
        'require (',
        '\tgithub.com/segmentio/kafka-go v0.4.47',
        '\tgithub.com/jackc/pgx/v5 v5.5.5',
        '\tgithub.com/rs/zerolog v1.33.0',
        '\tgithub.com/some/transitive v1.0.0 // indirect',
        ')',
      ].join('\n'),
      'services/ml/requirements.txt': [
        '# pinned',
        'celery[redis]==5.3.6',
        'psycopg2-binary>=2.9',
        'prometheus_client',
        '-r base.txt',
      ].join('\n'),
    },
  };

  it('finds nested Dockerfiles, manifests and config files and parses their dependencies', () => {
    const signals = extract(monorepo);

    expect(signals.hasDocker).toBe(true);
    expect(signals.hasKubernetes).toBe(true);
    // nested package.json (npm detectors)
    expect(signals.hasBullMQ).toBe(true);
    expect(signals.hasRedis).toBe(true);
    // nested go.mod
    expect(signals.hasKafka).toBe(true);
    expect(signals.hasPostgreSQL).toBe(true);
    expect(signals.hasLogging).toBe(true);
    // nested requirements.txt
    expect(signals.hasQueueSystems).toBe(true);
    expect(signals.hasMetrics).toBe(true);
    // nested prometheus.yml is found by name, not only at the root
    expect(signals.hasMonitoring).toBe(true);
  });

  it('does not count go.mod indirect dependencies or npm devDependencies as signals', () => {
    const signals = extract({
      files: ['go.mod'],
      fileContents: {
        'go.mod': 'module x\n\nrequire (\n\tgithub.com/redis/go-redis/v9 v9.0.0 // indirect\n)\n',
        'package.json': JSON.stringify({ devDependencies: { ioredis: '1.0.0' } }),
      },
    });

    expect(signals.hasRedis).toBe(false);
  });
});

describe('SystemDesignSignalExtractor Dockerfile-only repositories', () => {
  it('flags Docker for a repo with only a Dockerfile and nothing else', () => {
    const signals = extract({ files: ['Dockerfile', 'src/main.go'] });

    expect(signals.hasDocker).toBe(true);
    expect(signals.composeServiceCount).toBe(0);
    expect(signals.hasMultiServiceTopology).toBe(false);
    expect(signals.hasRedis).toBe(false);
    expect(signals.hasKubernetes).toBe(false);
    expect(signals.hasQueueSystems).toBe(false);
  });

  it.each([
    'services/api/Dockerfile',
    'build/Dockerfile.prod',
    'docker/api.Dockerfile',
    'apps/web/.dockerignore',
  ])('detects %s', file => {
    expect(extract({ files: [file] }).hasDocker).toBe(true);
  });

  it('does not treat unrelated file names as Docker', () => {
    expect(extract({ files: ['docs/Dockerfile-notes.md', 'src/dockerfileParser.ts'] }).hasDocker).toBe(false);
  });
});

describe('SystemDesignSignalExtractor multi-language manifests', () => {
  it('maps Python requirements.txt dependencies to cache, queue and database signals', () => {
    const signals = extract({
      files: ['requirements.txt'],
      fileContents: {
        'requirements.txt': 'redis==5.0.1\ncelery>=5\nasyncpg\npymongo[srv]\nelasticsearch>=8\nsentry-sdk\n',
      },
    });

    expect(signals.hasRedis).toBe(true);
    expect(signals.hasCaching).toBe(true);
    expect(signals.hasQueueSystems).toBe(true);
    expect(signals.hasPostgreSQL).toBe(true);
    expect(signals.hasMongoDB).toBe(true);
    expect(signals.hasElasticsearch).toBe(true);
    expect(signals.hasMonitoring).toBe(true);
  });

  it('maps Go go.mod requirements (single line and block form)', () => {
    const signals = extract({
      files: ['go.mod'],
      fileContents: {
        'go.mod': [
          'module example.com/svc',
          'require github.com/redis/go-redis/v9 v9.5.1',
          'require (',
          '\tgithub.com/rabbitmq/amqp091-go v1.9.0',
          '\tgithub.com/go-sql-driver/mysql v1.8.1',
          '\tgo.opentelemetry.io/otel v1.27.0',
          ')',
        ].join('\n'),
      },
    });

    expect(signals.hasRedis).toBe(true);
    expect(signals.hasRabbitMQ).toBe(true);
    expect(signals.hasMySQL).toBe(true);
    expect(signals.hasTracing).toBe(true);
  });

  it('maps pyproject.toml (PEP 621 and Poetry), Cargo.toml and pom.xml', () => {
    const pep621 = extract({
      files: ['pyproject.toml'],
      fileContents: {
        'pyproject.toml': [
          '[project]',
          'name = "svc"',
          'dependencies = [',
          '  "psycopg[binary]>=3.1",',
          '  "aiokafka",',
          ']',
          '',
          '[project.optional-dependencies]',
          'cache = ["pymemcache"]',
        ].join('\n'),
      },
    });
    expect(pep621.hasPostgreSQL).toBe(true);
    expect(pep621.hasKafka).toBe(true);
    expect(pep621.hasMemcached).toBe(true);

    const poetry = extract({
      files: ['pyproject.toml'],
      fileContents: {
        'pyproject.toml': '[tool.poetry.dependencies]\npython = "^3.11"\nredis = "^5"\ndramatiq = { version = "^1.16" }\n',
      },
    });
    expect(poetry.hasRedis).toBe(true);
    expect(poetry.hasQueueSystems).toBe(true);

    const cargo = extract({
      files: ['services/gateway/Cargo.toml'],
      fileContents: {
        'services/gateway/Cargo.toml': [
          '[package]',
          'name = "gateway"',
          '[dependencies]',
          'redis = { version = "0.25", features = ["tokio-comp"] }',
          'lapin = "2"',
          '[dependencies.tokio-postgres]',
          'version = "0.7"',
          '[dev-dependencies]',
          'mongodb = "2"',
        ].join('\n'),
      },
    });
    expect(cargo.hasRedis).toBe(true);
    expect(cargo.hasRabbitMQ).toBe(true);
    expect(cargo.hasPostgreSQL).toBe(true);
    expect(cargo.hasMongoDB).toBe(true);

    const pom = extract({
      files: ['pom.xml'],
      fileContents: {
        'pom.xml': `<project><dependencies>
          <dependency><groupId>redis.clients</groupId><artifactId>jedis</artifactId></dependency>
          <dependency>
            <groupId>org.springframework.kafka</groupId>
            <artifactId>spring-kafka</artifactId>
          </dependency>
          <dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency>
        </dependencies></project>`,
      },
    });
    expect(pom.hasRedis).toBe(true);
    expect(pom.hasKafka).toBe(true);
    expect(pom.hasPostgreSQL).toBe(true);
  });

  it('parses each manifest format into plain dependency names', () => {
    expect(parseRequirementsTxt('Django_Rest>=3 ; python_version>"3"\n# c\n-e .\nfoo[bar]==1 # trailing')).toEqual([
      'django-rest',
      'foo',
    ]);
    expect(parseGoMod('require (\n\ta.com/x v1.0.0\n\tb.com/y v1.0.0 // indirect\n)\nrequire c.com/z v2.0.0')).toEqual([
      'a.com/x',
      'c.com/z',
    ]);
    expect(parsePyproject('[project]\ndependencies = ["a>=1", "b"]')).toEqual(['a', 'b']);
    expect(parseCargoToml('[dependencies]\nserde = "1"\n[features]\nfoo = []')).toEqual(['serde']);
    expect(parsePomXml('<dependency><groupId>g</groupId><artifactId>a</artifactId></dependency>')).toEqual(['g:a']);
  });
});

describe('SystemDesignSignalExtractor malformed input', () => {
  const MALFORMED = [
    '',
    'services:',
    'services: [',
    'services:\n  - just\n  - a list\n',
    'services:\n  api:\n    image: [unclosed\n    depends_on: {{{\n',
    'services:\n\tapi:\n\t\timage: redis\n',
    ':::\n  - - -\n\t\t#\n"unterminated',
    'services:\n  api:\n    depends_on:\n      - \n      -\n',
    '\u0000\u0001\u0002 binary \uffff',
    `services:\n${'  x:\n    image: a\n'.repeat(50)}`,
  ];

  it.each(MALFORMED.map((content, index) => [index, content]))('does not throw for malformed compose sample %i', (_i, content) => {
    expect(() => parseComposeTopology(content as string)).not.toThrow();
    expect(() => extract({ files: ['docker-compose.yml'], fileContents: { 'docker-compose.yml': content } })).not.toThrow();
  });

  it('still reports Docker from the file name when the compose content is garbage', () => {
    const signals = extract({
      files: ['docker-compose.yml'],
      fileContents: { 'docker-compose.yml': 'services: [\n  : - {' },
    });

    expect(signals.hasDocker).toBe(true);
    expect(signals.composeServiceCount).toBe(0);
    expect(signals.hasRedis).toBe(false);
  });

  it('does not throw for broken manifests or unexpected input shapes', () => {
    expect(() => extract({
      files: ['package.json', 'go.mod', 'Cargo.toml', 'pom.xml', 'pyproject.toml', 'requirements.txt', 42, null],
      fileContents: {
        'package.json': '{ not json',
        'go.mod': 'require (\n\tnot closed',
        'Cargo.toml': '[dependencies\nfoo ===',
        'pom.xml': '<dependency><groupId>',
        'pyproject.toml': '[project]\ndependencies = [\n  "a",',
        'requirements.txt': '\u0000\u0000',
        'extra.txt': 123,
      },
    })).not.toThrow();
    expect(() => extract({ files: 'nope', fileContents: 'nope' })).not.toThrow();
    expect(() => SystemDesignSignalExtractor.extractSignals([])).not.toThrow();
  });

  it('skips oversized contents instead of parsing them', () => {
    const huge = `services:\n  cache:\n    image: redis\n${'#'.repeat(600 * 1024)}`;
    const signals = extract({ files: ['docker-compose.yml'], fileContents: { 'docker-compose.yml': huge } });

    expect(signals.hasRedis).toBe(false);
    expect(signals.hasDocker).toBe(true);
  });
});

describe('SystemDesignSignalExtractor existing behaviour', () => {
  it('still reads npm dependencies and root files as before', () => {
    const signals = extract({
      dependencies: ['ioredis', 'bullmq', 'mongoose'],
      files: ['Dockerfile', 'vercel.json', '.github/workflows/ci.yml'],
    });

    expect(signals.hasRedis).toBe(true);
    expect(signals.hasBullMQ).toBe(true);
    expect(signals.hasMongoDB).toBe(true);
    expect(signals.hasDocker).toBe(true);
    expect(signals.hasCDN).toBe(true);
    expect(signals.hasDeploymentPipelines).toBe(true);
    expect(signals.composeServiceCount).toBe(0);
  });
});
