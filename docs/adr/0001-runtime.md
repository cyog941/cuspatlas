# ADR 0001: Runtime, toolchain and test database

Status: accepted for the synthetic foundation, 2026-11-03 (F Task 1). Evidence category: configured and tested on one Windows host; Linux CI is a Task 8 gate and not yet evidenced.

## Decision

| Concern | Choice | Pinned version |
|---|---|---|
| Runtime | Node.js LTS 24.x, `engines: ">=24.13 <25"`, `engine-strict=true` | host: 24.13.1 |
| Package manager | pnpm via corepack, `packageManager` field | pnpm 10.18.3 |
| Language | TypeScript, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, no emit (sources run through tsx/vitest) | typescript 5.9.3 |
| HTTP | Fastify (bundles pino logger) | fastify 5.12.8 (pino 10.4.0 transitive) |
| Validation | JSON Schema 2020-12 through Ajv, strict mode, no coercion, no defaults | ajv 8.20.0, ajv-formats 3.0.1 |
| Tokens | JWT verification with jose, EdDSA (Ed25519) only | jose 6.2.15 |
| PostgreSQL client | node-postgres | pg 8.23.1, @types/pg 8.23.1 |
| Tests | Vitest projects `unit` and `integration` | vitest 4.1.12 |
| Test database | embedded-postgres (PostgreSQL 17.11 binaries as npm packages) | embedded-postgres 17.11.0-beta.19 |
| Lint/format | Biome, recommended rules | @biomejs/biome 2.6.4 |
| Script runner | tsx | tsx 4.23.15 |
| YAML (contract drift check) | yaml | yaml 2.9.1 |
| Node types | @types/node on the 24.x line to match the runtime | @types/node 24.19.2 |

All direct dependencies are exact versions (`save-exact=true`); `pnpm-lock.yaml` is committed and CI must install with `--frozen-lockfile`. Newer majors were visible at selection time (TypeScript 7, Vitest 5, @types/node 26) and were not adopted: the foundation prefers the line already proven on this host, and a major upgrade is its own reviewed change.

Install scripts are allowed only for the packages listed under `onlyBuiltDependencies` in `pnpm-workspace.yaml`: the `@embedded-postgres/*` platform packages (their postinstall rehydrates binary symlinks) and `esbuild` (verifies its platform binary). pnpm blocks every other dependency lifecycle script.

`@modelcontextprotocol/sdk` is deferred to Task 7. No UI framework is present.

## Why embedded-postgres

E0 found no Docker, no psql and no Supabase CLI, and host package installation would require privileges this run does not have. embedded-postgres runs a real PostgreSQL 17.11 server (not a mock) from npm-delivered binaries, so RLS, roles, `set_config`, `DISCARD ALL` and concurrency behave as in production PostgreSQL. One server starts per integration run in Vitest `globalSetup`, with its data directory under `os.tmpdir()` (never inside the repository or the OneDrive-synced checkout), on a free loopback port, `persistent: false`, and is removed on teardown. Every database it creates is named with `cuspatlas_synthetic`.

Limits: the binaries' provenance is the npm package integrity hash in the lockfile, not a PostgreSQL project signature. It is a `beta` tagged package line. It is test infrastructure only; nothing in the application depends on it. Supabase-managed PostgreSQL may differ in extensions and default roles; migrations therefore avoid Supabase-only roles and the `auth` schema (see the frozen contract decisions).

## Runtime support policy

- Track the active Node LTS line; move to the next LTS within one quarter of it entering active LTS, never to an odd-numbered release.
- PostgreSQL major used in tests must match the managed target major before any non-synthetic deployment.
- Dependency upgrades are explicit commits that update the lockfile and this table; `pnpm audit` and the license summary below are re-run on each.

## License audit (2026-11-03)

Command: `corepack pnpm licenses list --json` over the full installed tree (production and dev, Windows host; other platform binary packages share their parent's license).

| License | Count | Notes |
|---|---|---|
| MIT | 100 | fastify, pino, ajv, ajv-formats, jose, pg, vitest, vite, esbuild, tsx, embedded-postgres and most transitive packages |
| ISC | 7 | fastq, pg-int8, picocolors, semver, siginfo, split2, yaml |
| BSD-3-Clause | 4 | fast-uri, light-my-request, secure-json-parse, source-map-js |
| Apache-2.0 | 3 | typescript, detect-libc, expect-type |
| MIT OR Apache-2.0 | 2 | @biomejs/biome and its CLI binary |
| MPL-2.0 | 2 | lightningcss (dev-only, transitive through vite; not distributed with the service) |

All are compatible with distribution under AGPL-3.0-or-later. The PostgreSQL binaries inside `@embedded-postgres/*` are under the PostgreSQL License (permissive); they are dev/test-only. `corepack pnpm audit` reported no known vulnerabilities at selection time. This is a point-in-time inventory, not an SBOM; the SBOM and provenance manifest are Task 8 deliverables.
