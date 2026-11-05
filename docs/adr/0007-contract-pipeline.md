# ADR 0007: Contract pipeline, operation catalog and generated client (synthetic build)

Status: accepted for the synthetic build, 2026-11-04 (workstream A batch 1: A1, A3, A4, A5, A6, A7).
Evidence category: configured and tested on synthetic data on one Windows host. Not approved for any
production use; A-D1 (deprecation window), A-D2 (scope granularity and default role grants) and A-D3
(tools a deployment may disable) remain open human decisions. A-S1 (remote MCP authorization revision)
is still blocked-on-discovery; nothing here asserts a transport qualification.

## Context

Seven workstreams each grew their own route manifest, MCP tool table, policy rows, OpenAPI fragments
and parity test. The plan requires one contract pipeline: one operation set, one scope registry, one
authorization path per principal class, a generated client and change control, without a
hand-maintained second copy of any contract.

## Decision

Source of truth stays in code, next to the handlers that implement it:

| Source | Owns |
|---|---|
| `packages/domain/src/policy/authorize.ts` `ACTION_POLICIES` | staff scope and principal kinds per action |
| `apps/api/src/routes/*manifest*.ts` and the per-workstream ops tables | REST method, path, schema refs, refusal statuses |
| `apps/mcp/src/tools/*` (`TOOLS`) | MCP tool name and its operation |
| literal `authorize(ctx, '<action>')` calls in `apps/worker/src` | worker operations |
| `packages/contracts/src/*.schema.json` | request and result JSON Schemas (runtime validation) |
| `docs/SHARED-CONTRACTS.md` "Roles and scopes" | the human scope registry of record |
| `packages/contracts/src/catalog/deprecations.json` | deprecations and sunset dates (hand-edited) |

One generator, `pnpm catalog:generate` (`scripts/catalog/`), derives every artifact from those sources:
the operation catalog (`operations.json`), the scope registry (`scopes.json`), the change-control
baseline check input, the generated client (`packages/client/src/generated.ts`) and the documents
`docs/api/operation-catalog.md`, `docs/api/scopes.md` and `docs/api/sunset-register.md`. It builds
everything in memory and validates the catalog first; a failure writes nothing, so the previous
artifacts stay in place. `pnpm catalog:check` (part of `contract:check` and `ci`) fails when any
committed artifact differs from a fresh build, so a hand edit of a generated file is overwritten by the
build and rejected by CI.

OpenAPI: the existing `docs/api/openapi.yaml` (with its billing and imaging generated blocks) is kept
and checked rather than regenerated wholesale in this batch. The contract drift check
(`apps/api/src/contract-drift.ts`) compares it with the route manifests and JSON Schemas, and the A1
gate compares its operations with the catalog exactly. Replacing the per-workstream OpenAPI generators
with one generator is deferred; the conformance checks make the two agree in the meantime.

Shared representations are linted over every schema definition reachable from a catalog operation:
no tenant field, no bare `<entity>Id` (opaque `<entity>Ref`), no scalar money (Money is
`{ currency, minor }`), timestamps `format: date-time` with an offset, request objects closed
(`additionalProperties: false`), one shared Refusal body. Unreachable adapter-internal definitions
with a defect are listed explicitly (currently the fake clearinghouse's `RemittanceAdvice`).

Change control (A5) classifies the difference between the committed baseline
(`packages/contracts/src/catalog/baseline.json`) and the current catalog plus schemas:

| Class | Examples | Gate |
|---|---|---|
| additive | new operation, new optional request property, wider enum, larger maximum | passes |
| deprecating | operation listed in `deprecations.json` with a sunset date | passes; REST `Deprecation`/`Sunset` headers, MCP notice |
| breaking | operation removed or renamed, transport dropped, new required property, removed property, narrowed enum, smaller maximum length or value, nullable made non-null, scope changed | fails unless the operation carries a deprecation entry whose sunset date has passed |

A change the classifier cannot classify fails rather than defaulting to additive. Accepting a change
is an explicit `pnpm catalog:baseline` commit, reviewed like any contract change.

## Consequences

- A new route, tool, policy row or worker operation without regeneration fails CI; the new-operation
  procedure (`docs/api/new-operation.md`) names the five steps the checklist test enforces.
- The authorization path is recorded per operation, not assumed: staff REST, MCP and worker operations
  authorize through `authorize`; portal operations through the S5 relationship policy; bridge
  operations through the live device row and allowlist. The forbidden-operation matrix proves the
  refusals for every operation and principal kind on the real app under the runtime role.
- The generated client is types plus an operation table; the transport is a small hand-written file
  with no business logic.
