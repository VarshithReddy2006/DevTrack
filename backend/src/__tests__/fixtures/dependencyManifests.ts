// Sample dependency manifests for dependencyAnalyzer.test.ts. Kept as strings so no real
// package.json ends up inside the source tree.

export const NODE_FULLSTACK_PACKAGE_JSON = JSON.stringify({
  name: 'shop',
  dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', express: '^5.1.0', '@prisma/client': '^6.0.0', zod: '^3.25.0' },
  devDependencies: { vitest: '^4.0.0', '@playwright/test': '^1.50.0', typescript: '^5.9.0', eslint: '^9.0.0', prisma: '^6.0.0' },
}, null, 2);

export const NODE_TOY_PACKAGE_JSON = JSON.stringify({
  name: 'todo',
  dependencies: { lodash: '^4.17.21', chalk: '^5.3.0' },
});

export const NODE_LEGACY_PACKAGE_JSON = JSON.stringify({
  name: 'legacy-api',
  dependencies: { express: '^4.17.1', mongoose: '^5.0.0', request: '^2.88.2', 'node-sass': '^4.14.1', moment: '^2.29.4' },
  devDependencies: { tslint: '^6.1.3', '@testing-library/react': '^12.0.0' },
});

// Trailing comma and a missing closing brace.
export const MALFORMED_PACKAGE_JSON = '{\n  "name": "broken",\n  "dependencies": { "react": "^19.0.0", }\n';

export const PYTHON_REQUIREMENTS = [
  'fastapi==0.115.0',
  'SQLAlchemy>=2.0',
  'psycopg2-binary',
  '# testing',
  'pytest>=8.0',
  'pycrypto==2.6.1',
  '-r base.txt',
  '==1.0 not a requirement',
  '',
].join('\n');

export const PYPROJECT_TOML = `[project]
name = "blog"
dependencies = ["django>=5.0", "psycopg[binary]>=3.1"]

[project.optional-dependencies]
dev = ["pytest", "ruff"]
`;

export const GO_MOD = `module github.com/alex/api

go 1.22

require (
\tgithub.com/gin-gonic/gin v1.10.0
\tgorm.io/gorm v1.25.10
\tgithub.com/stretchr/testify v1.9.0
\tgithub.com/dgrijalva/jwt-go v3.2.0+incompatible
\tgolang.org/x/sys v0.20.0 // indirect
)
`;

export const GO_MOD_ECHO = `module github.com/alex/edge

go 1.22

require github.com/labstack/echo/v4 v4.12.0
`;

export const CARGO_TOML = `[package]
name = "worker"
version = "0.1.0"

[dependencies]
axum = "0.7"
sqlx = { version = "0.8", features = ["postgres", "runtime-tokio"] }
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
proptest = "1"
`;

export const POM_XML = `<project>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency>
    <dependency><groupId>log4j</groupId><artifactId>log4j</artifactId><version>1.2.17</version></dependency>
  </dependencies>
</project>
`;
