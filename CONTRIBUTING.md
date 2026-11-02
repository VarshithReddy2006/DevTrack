# Contributing to DevTrack

Thank you for your interest in contributing to DevTrack! DevTrack is a developer productivity and career readiness platform that combines DSA tracking, project management, resume intelligence, readiness analytics, and gamification.

We welcome meaningful contributions that improve correctness, reliability, accessibility, performance, security, documentation, and developer experience.

This repository participates in Nexus Winter of Code (NWoC) 2026 only where confirmed by the project maintainer. Programme-specific rules below apply to contributions submitted under NWoC 2026.

---

## Table of Contents

1. [Code of Contribution](#code-of-contribution)
2. [Repository Layout](#repository-layout)
3. [Getting Started](#getting-started)
4. [Development Conventions](#development-conventions)
5. [Testing Requirements](#testing-requirements)
6. [NWoC 2026 Issue Labels and Points](#nwoc-2026-issue-labels-and-points)
7. [NWoC 2026 Issue and PR Workflow](#nwoc-2026-issue-and-pr-workflow)
8. [Pull Request Requirements](#pull-request-requirements)
9. [Code Review and Quality Control](#code-review-and-quality-control)
10. [Commit and Branch Conventions](#commit-and-branch-conventions)
11. [Security and Environment Variables](#security-and-environment-variables)
12. [Questions and Support](#questions-and-support)

---

## Code of Contribution

All contributors are expected to:

- Communicate respectfully and constructively.
- Read the relevant documentation before starting work.
- Work on an issue assigned to them before submitting a pull request.
- Submit focused changes that solve the issue's stated problem.
- Write maintainable code and appropriate tests.
- Respond to review feedback and explain significant design decisions.
- Avoid duplicate, misleading, unrelated, or artificially inflated contributions.
- Respect the project's security, licensing, and contribution requirements.

A pull request is not guaranteed to be accepted simply because it contains code. Every contribution must provide meaningful value and pass the applicable review requirements.

## Repository Layout

DevTrack is organised as a monorepo.

| Directory | Stack | Responsibility |
|---|---|---|
| `backend/` | Express 5, TypeScript, Mongoose, BullMQ, Clerk | API server, domain modules, and background workers |
| `frontend/` | React 19, Vite, TypeScript, Zustand, Tailwind CSS 4 | Web application and user interface |
| `dev-orchestrator/` | TypeScript | Local development orchestration |
| `docs/` | Markdown | Architecture, deployment, and operational documentation |
| `Codex/` | Project reference documentation | AI-assisted development context and project maps |

Follow the existing architecture and module conventions when adding or modifying functionality.

## Getting Started

### Prerequisites

- Node.js 22.13.0 or newer in the 22 series, or 24.0.0+. The locked frontend dependencies do not support Node 23.
- npm 9 or later.
- Docker Desktop for local MongoDB and Redis.
- Git and a GitHub account.
- Clerk development credentials for authenticated application flows.

Some integrations and AI features require optional API credentials.

### Installation

1. Fork the repository on GitHub.
2. Clone your fork and enter the repository:

   ```bash
   git clone https://github.com/<your-username>/DevTrack.git
   cd DevTrack
   ```

3. Install dependencies:

   ```bash
   npm run install-all
   ```

4. Create local environment files:

   ```bash
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env
   ```

   On Windows PowerShell, use `Copy-Item` if `cp` is unavailable.

5. Configure the required variables using your own development credentials:

   - `backend/.env`: `CLERK_SECRET_KEY`
   - `frontend/.env`: `VITE_CLERK_PUBLISHABLE_KEY`
   - `frontend/.env`: `VITE_API_BASE_URL`

   The documented local API base URL is `http://localhost:3001/api`.

6. Start MongoDB and Redis:

   ```bash
   npm run dev:infra
   ```

7. Start the application:

   ```bash
   npm run dev
   ```

   To start the full stack with workers, use:

   ```bash
   npm run dev:all
   ```

   Windows contributors can also use:

   ```powershell
   .\start-dev.ps1
   ```

Refer to the main README and `docs/` for further setup details. Verify the available scripts in the relevant `package.json` before running commands if the repository has changed.

## Development Conventions

### Backend

Backend feature modules belong under:

```text
backend/src/modules/<module-name>/
├── index.ts
├── <module-name>.routes.ts
├── <module-name>.controller.ts
├── <module-name>.service.ts
└── <module-name>.validation.ts
```

Follow these conventions:

- Register new API routes in `backend/src/routes/index.ts`.
- Mount API routes under `/api/v1` unless an existing compatibility requirement dictates otherwise.
- Validate external request inputs with Zod.
- Use the existing authentication middleware for protected routes.
- Follow established error-handling and `asyncHandler` patterns.
- Use the shared logger instead of `console.log`.
- Prefer `.lean()` for suitable read-only Mongoose queries.
- Use atomic database updates where appropriate.
- Consider indexes, pagination, validation, and query performance when modifying data access.
- Follow existing BullMQ worker, retry, and failure-handling conventions.

### Frontend

- Use existing components and feature modules before introducing new abstractions.
- Place generic UI primitives under `frontend/src/components/ui/`.
- Place domain-specific functionality under `frontend/src/features/`.
- Keep route-level pages under `frontend/src/pages/`.
- Use the existing Axios service modules for API requests instead of introducing raw `fetch` calls that bypass established patterns.
- Use TanStack Query for server state and Zustand for appropriate client-side UI state.
- Reuse the existing SSE hook for real-time updates. Do not create separate `EventSource` connections in individual components when the shared hook is appropriate.
- Follow the Tailwind CSS 4 design tokens and existing design-system conventions.
- Use the established motion system rather than introducing arbitrary animation values.
- Ensure interactive components are keyboard-accessible and provide appropriate accessible names and states.

### General

- Keep changes scoped to the assigned issue.
- Avoid unnecessary dependencies and unrelated refactoring.
- Follow existing TypeScript and naming conventions.
- Update documentation when behaviour, configuration, or public interfaces change.
- Do not commit credentials, generated artifacts, local environment files, or unrelated formatting changes.

## Testing Requirements

Choose tests appropriate to the change.

### Backend

Run from the `backend/` directory:

```bash
npm run build
npm run test:unit
npm run test:integration
```

Integration tests provision a fresh temporary MongoDB instance per test file using
`mongodb-memory-server` (also used by the unit suite). Do not set `MONGODB_URI` in
the shell or CI when running them: inherited URIs are rejected before connection,
even if the database name contains `test`. The application `.env` URI is overridden
before application modules load. Only the owned instance's fixtures are cleared;
teardown stops that instance and removes its temporary files without dropping a
database on a shared server. The first run may download MongoDB 7.0.14; an existing
binary can be selected with `MONGOMS_SYSTEM_BINARY`.

Redis is still required for full integration coverage. URI/ownership regression
tests run without database infrastructure via `npm run test:safety` and are also
included in `npm run test:unit`.

### Frontend

Run from the `frontend/` directory:

```bash
npm run build
npm run test:unit
```

End-to-end tests require the running application stack:

```bash
npm run test:e2e
```

### Testing expectations

- Add or update tests for changed behaviour.
- Include regression coverage for bug fixes where practical.
- Test relevant success and failure cases.
- Clean up database connections, timers, and other resources in tests.
- Avoid tests that depend unnecessarily on external services or live AI API credentials.
- Do not weaken or delete existing tests simply to make CI pass.
- Report any checks that could not be run and explain why.

Check the current package scripts and CI workflow for the authoritative commands.

## NWoC 2026 Issue Labels and Points

For issues and pull requests submitted under the programme, the following four labels are mandatory.

| Label | Points | Intended scope |
|---|---:|---|
| `nsoc26` | Mandatory tag | Every programme issue and PR |
| `level1` | 3 | Documentation, typo fixes, and other small tasks |
| `level2` | 5 | UI, frontend components, layouts, styling, and page-level changes |
| `level3` | 10 | Core logic, database changes, and complex features |

The point values above follow the supplied programme guidelines. The maintainer assigns the appropriate level based on the actual complexity of the task.

### Labelling rules

- Every programme issue must have the `nsoc26` label and exactly one level label.
- Programme pull requests must have the `nsoc26` label and the appropriate level label before merging.
- Do not assign Level 2 or Level 3 to a task that is genuinely a small documentation or typo fix.
- Maintainers must assign levels consistently and honestly.
- Add the required labels promptly. Do not leave merged programme PRs unlabelled.
- If a programme PR is missing `nsoc26`, request that the contributor correct it before merging.
- Optional labels such as `good first issue`, `help wanted`, `bug`, `feature`, and `docs` may be used alongside the mandatory labels.

The level label determines the programme points according to the supplied guidelines. Creating GitHub labels alone does not automatically award points.

## NWoC 2026 Issue and PR Workflow

The following workflow applies to programme contributions.

### 1. Open an issue

Before starting work, identify an existing issue or open a new issue describing the proposed change.

An issue should contain:

- A clear title and problem statement.
- Relevant context and reproduction steps for bugs.
- Expected behaviour or acceptance criteria.
- The likely affected modules or files, where known.
- Testing expectations.
- The mandatory programme and level labels.

Do not begin a substantial change without maintainer approval and assignment.

### 2. Wait for assignment

Contributors must wait for the maintainer to assign the issue before starting work.

Under the supplied NWoC guidelines, pull requests submitted without the required issue assignment are invalid and must be closed.

Maintainers should check for duplicate issues, confirm scope, select the appropriate level, and assign work before accepting a contribution.

### 3. Keep the assignment active

Contributors should communicate progress and raise blockers promptly.

If an assigned contributor is inactive for seven days, the maintainer will unassign the issue according to the programme rules. The issue may then become available to another contributor.

### 4. Use one branch per issue

Create a dedicated branch for each assigned issue.

Examples:

```bash
git checkout -b feat/dsa-heatmap-filter
git checkout -b fix/sse-reconnect
git checkout -b docs/deployment-guide
```

Keep unrelated changes out of the branch.

### 5. Submit a linked pull request

Open a PR against the appropriate base branch and reference the assigned issue using GitHub's closing syntax:

```text
Closes #<issue-number>
```

For example:

```text
Closes #42
```

Include a concise summary, implementation details, relevant testing results, and any known limitations.

### 6. Review and merge

Maintainers will:

1. Confirm the PR corresponds to an assigned issue.
2. Verify that the change is relevant and meaningful.
3. Review the implementation and test coverage.
4. Check applicable CI results and repository quality requirements.
5. Request corrections where necessary.
6. Add the required `nsoc26` and level labels.
7. Merge only after the applicable requirements are satisfied.

Maintainers must watch for fake PRs, bulk PRs, and AI-generated PRs that do not represent genuine contributions. Such submissions must not be merged under the programme rules.

AI tools may be used as development aids where permitted, but they do not replace understanding, testing, attribution, or meaningful human contribution. Follow any additional programme-specific AI policy.

## Pull Request Requirements

Before requesting review, confirm that:

- [ ] The PR addresses an assigned issue.
- [ ] The PR contains only changes relevant to that issue.
- [ ] The issue is linked using `Closes #<issue-number>`.
- [ ] Backend and frontend builds pass where applicable.
- [ ] Relevant unit and integration tests pass.
- [ ] Tests have been added or updated for changed behaviour where appropriate.
- [ ] No debug statements, accidental generated files, or unrelated commented-out code remain.
- [ ] New routes are registered correctly and documented when public-facing.
- [ ] Environment variable changes are reflected in the appropriate `.env.example` file.
- [ ] No secrets or credentials have been committed.
- [ ] The PR includes a clear summary and testing evidence.
- [ ] The required NWoC labels are applied before merging.

## Code Review and Quality Control

Maintainers and reviewers should verify the following.

### Correctness

- Does the implementation solve the issue's stated problem?
- Are edge cases and failure paths handled?
- Is the change consistent with existing application behaviour?

### Security

- Are external inputs validated?
- Are authentication and authorization requirements preserved?
- Are secrets protected?
- Are database operations and API endpoints safe?

### Maintainability

- Does the change follow existing module and component patterns?
- Are responsibilities separated appropriately?
- Are unnecessary dependencies or abstractions avoided?
- Is the documentation consistent with the implementation?

### Performance and reliability

- Are database indexes and query patterns appropriate?
- Are background jobs, retries, and failure handling correct?
- Are real-time connections and subscriptions managed properly?
- Are resources cleaned up in tests and application code?

### Quality gates

- Review the relevant CI checks before merging.
- Require corrections for failing tests or significant review findings.
- Do not merge work solely to award programme points.
- Do not merge fake, duplicate, bulk, or otherwise invalid submissions.
- Keep feedback specific, respectful, and actionable.

## Commit and Branch Conventions

Use descriptive branch names.

| Type | Pattern | Example |
|---|---|---|
| Feature | `feat/<description>` | `feat/dsa-heatmap-filter` |
| Bug fix | `fix/<description>` | `fix/sse-reconnect` |
| Documentation | `docs/<description>` | `docs/deployment-guide` |
| Hardening | `harden/<description>` | `harden/rate-limit-sync` |

Follow conventional commit messages:

```text
feat(readiness): add roadmap gap analyzer
fix(auth): correct Clerk token validation on SSE
chore(repo): update deployment documentation
test(ops): add dead-letter queue resilience cases
```

Use concise, descriptive commit messages that explain the change.

## Security and Environment Variables

- Never commit `.env` files, access tokens, passwords, private keys, or other secrets.
- Use the supplied `.env.example` files as templates.
- Use your own development credentials.
- Do not include real user data or sensitive production information in tests or issues.
- Report suspected vulnerabilities privately through an appropriate maintainer or repository security contact rather than publicly disclosing exploitable details.
- Do not weaken authentication, authorization, rate limiting, or validation to make a feature easier to implement.

## Questions and Support

Before asking for help:

1. Read this guide and the relevant documentation.
2. Search existing issues and pull requests for related discussions.
3. Check the setup instructions and applicable test commands.
4. Provide a concise explanation of the problem, the steps attempted, and any relevant error output.

For contribution questions, open an appropriately labelled issue or use the repository's designated support channel.

Thank you for helping make DevTrack more reliable, useful, and welcoming to developers.

---

**Maintainer note:** Before opening the repository to external contributions, ensure the project's licence and contribution terms clearly permit the intended contributions. Programme participation and the availability of a public repository do not, by themselves, establish an open-source licence.
