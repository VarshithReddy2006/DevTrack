# Shared contracts and OpenAPI

Install the existing npm workspaces from the repository root with `npm ci`.

```sh
npm run contracts:build-openapi
npm run contracts:check-openapi
npm run test --workspace @devtrack/contracts
```

The equivalent `pnpm contracts:build-openapi` and
`pnpm --filter @devtrack/contracts build:openapi` commands also work after
installing dependencies. `pnpm-workspace.yaml` mirrors the existing npm workspace
list; npm and `package-lock.json` remain the CI installation path.

`src/openapi/build.ts` writes `openapi.json` deterministically, independent of the
working directory. `--check` compares bytes without writing and fails if the
artifact is missing or stale. After editing schemas or route registration, run
the build and commit the resulting JSON. The independent **OpenAPI Contract
Drift** job runs contract tests, regenerates the document, requires a tracked
artifact and rejects its diff. A regression test changes an actual schema in an
isolated copy, checks the failing exit code, then regenerates and checks recovery.

Every exported Zod schema is included in components. Parameters, request bodies,
response media and authentication are registered explicitly against existing
backend routes; adding an export does not invent a new endpoint. The normal
contract build excludes the CLI so applications do not need its development-only
generator or validator dependencies. OpenAPI tooling has a separate typecheck.

## Current coverage and limits

Current shared modules are common, focus, contests and revision. Auth and SSE
entries describe the existing runtime handshake and event endpoints. The document
lists pending shared modules under `x-pending-contract-modules`: DSA, portfolio,
readiness, interview and leagues. It is a specification of these registered
contracts, **not the entire backend or a claim that all planned v2 contracts
exist**. Extend it when those actual contracts land.

Most routes currently use `/api/v1`. Revision analytics also advertises its real
`/api/v2` mount. Focus creation returns 201. The contests controller returns an
array and currently consumes only `platform`; its pagination schema is exported
as a component but is not advertised as working endpoint pagination. Untyped
response payloads remain unspecified. Legacy error variants and the shared error
envelope are both represented. None of this changes runtime validation.

JSON Schema cannot express arbitrary Zod transforms or cross-field JavaScript
refinements, including contest end-after-start validation. Existing query
pipelines retain the intersection of their numeric constraints; OpenAPI clients
serialize those canonical numeric values to the wire. Arbitrary transformations
still require runtime validation. The Zod 3-compatible
converter is a compatibility bridge: its upstream recommends native JSON Schema
generation when the repository migrates to Zod 4.

Tests validate against the official OpenAPI 3.1 meta-schema, resolve local
references, check representative schema constraints and authentication, and prove
that generation is stable. This is not a full Spectral lint or a live API test.
Backend/frontend services and production secrets are not needed to run it.

## Test fixture attribution

`test/fixtures/openapi-3.1-schema.json` is the unmodified official
[2022-10-07 OpenAPI 3.1 JSON meta-schema](https://spec.openapis.org/oas/3.1/schema/2022-10-07),
vendored so tests do not make network requests. It is distributed by the
[OpenAPI Initiative](https://github.com/OAI/spec.openapis.org) under Apache-2.0;
the license is retained in `test/fixtures/LICENSE-openapi.txt`.
