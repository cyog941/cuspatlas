# Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a future execution plan, not authorization to start.

**Goal:** Build the minimum synthetic-data platform that can enforce identity, isolation, contracts, audit, idempotency and background-work guarantees before any clinical feature is added.

**Architecture:** Modular TypeScript service with PostgreSQL as transactional authority. Browser and MCP transports share domain policy. Supabase supplies identity/storage services behind explicit boundaries; the native bridge is a later independently reviewed component.

**Tech Stack:** Supported Node LTS, TypeScript, Fastify, PostgreSQL/Supabase, JSON Schema/OpenAPI, Vitest and SQL integration tests. Pin versions and lockfiles in Task 1; no dependencies exist yet.

**Spec:** [Product design](../specs/2026-11-03-dental-pms-design.md), [API contract](../../API-AND-MCP.md), [security gates](../../SECURITY-AND-READINESS.md).

## Global Constraints

- US general dentistry first.
- No real patient records in development, fixtures, logs, Git or issues.
- No application implementation until explicit authorization; UI design remains the last planning stage.
- Normal DB application role is non-owner and non-BYPASSRLS.
- UI/API/MCP/jobs share policy and domain logic.
- No production deployment, real messages, payments or clinical writes in this phase.
- Supabase development provisioning is complete; see docs/SETUP.md. Local synthetic integration tests remain independent of managed cloud availability.

## Research gate before executing this plan

Apply the [hardware and claims qualification gates](../../HARDWARE-AND-CLAIMS-QUALIFICATION.md) to follow-on I/B plans. Foundation adapters must support protected external references, versioned payload digests, partial/unknown outcomes, deduplicated receipts and reconciliation. Task 6's fake-provider tests must include timeout after acceptance and duplicate/out-of-order delivery. Do not infer clearinghouse or device readiness from foundation tests. H1/H2/C1/C2/R1 can be researched before implementation; actual integrations need their own reviewed plans and build authorization.

Broad incumbent research is closed by user direction on 2026-11-03. DSH records authenticated REA/Craft attachment; repeated attachment or exhaustive Tab32 exploration is not a foundation prerequisite. See [analysis coverage](../../TAB32-ANALYSIS-COVERAGE.md) for retained limitations. Foundation execution uses synthetic data after explicit build authorization, with UI deferred. Unresolved clinical semantics, partner behavior and hardware compatibility gate their affected module tasks and release, not this synthetic foundation.

Translate the observed workflow states into synthetic acceptance cases: payment-plan missing signature/default/void versus collection, statement generation versus delivery/freshness, claims assignment versus appeal status, and audit search versus restoration. Test authorization separately for each operation across UI/API/MCP/jobs. Record unresolved vendor behavior explicitly and obtain clinical/financial validation before replacement release.

## Implementation review focus

The [AI PMS architecture contract](../../AI-PMS-ARCHITECTURE.md) is an input to this plan. Foundation work must support controlled proposals and accountable automation without implementing clinical assistants or connecting live models. Subsequent module plans must inherit its capability dependencies and evaluation gates.

- Reused pool connection retains another tenant's context: Task 2 must reject leakage across sequential and concurrent transactions.
- Membership revoked after token issuance or job enqueue: Tasks 2 and 6 must deny execution using fresh authorization.
- Same idempotency key with altered payload: Task 5 returns conflict, never previous unrelated result.
- Transaction commits but worker/network fails: Tasks 4–6 retain a single durable intent and reconcile retry.
- Error/telemetry includes a sensitive fixture marker: Tasks 1 and 8 fail the privacy check.

## Proposed file structure (create only during authorized execution)

`apps/api/src/` hosts transports and composition. `packages/contracts/` owns JSON Schema and generated types. `packages/domain/` owns policy and commands. `packages/db/` owns connection/transaction adapters. `apps/worker/` owns leased delivery. `apps/mcp/` owns protocol translation. `supabase/migrations/` owns schema changes. `tests/integration/` proves isolation and invariants. UI and native projects are not scaffolded in this phase.

## Shared interfaces

These are proposed contract definitions to create in Task 1, not code already present:

- `ActorContext = { tenantId: string; actorId: string; principal: 'human' | 'service'; sessionId: string; scopes: readonly string[]; correlationId: string }`.
- `authorize(ctx: ActorContext, action: string, resource: { tenantId: string; id: string; locationId?: string }): Promise<void>` throws a typed denial; checks live membership/session and required action policy.
- `withTenantTransaction<T>(ctx: ActorContext, work: (tx: TenantTransaction) => Promise<T>): Promise<T>` validates context and guarantees transaction-local database state and cleanup.
- `CommandEnvelope<T> = { operation: string; idempotencyKey: string; expectedVersion?: number; payload: T }`.
- `CommandResult<T> = { data: T; version: number; correlationId: string; replayed: boolean }`.
- `AuditEvent = { tenantId: string; actorId: string; operation: string; resourceId: string; correlationId: string; outcome: 'allowed' | 'denied' | 'committed'; occurredAt: string }`; no PHI body.
- `OutboxEvent = { id: string; tenantId: string; actorId: string; operation: string; aggregateId: string; aggregateVersion: number; occurredAt: string; payload: unknown }`; payload classified and minimized, never logged automatically.

### Task 1: Reproducible synthetic-only service boundary

Files: root package/workspace/lock configuration, `packages/contracts/src/context.ts`, `apps/api/src/app.ts`, `apps/api/src/errors.ts`, `tests/integration/service-boundary.test.ts`, `docs/adr/0001-runtime.md`.

Consumes: reviewed spec. Produces: shared types above; `buildApp(deps): FastifyInstance`; scripts `test`, `test:integration`, `typecheck` and `lint` with locked dependencies.

- [ ] Select supported versions, pin exact dependencies, define workspace and commit lockfile. Record runtime support and license audit; do not add a UI framework yet.
- [ ] Write a test expecting `/healthz` to return only `{status:'ok'}` and an invalid request to return a typed safe error without the injected marker `SYNTHETIC_SECRET_42`.
- [ ] Run `pnpm test -- service-boundary`; confirm the missing app behavior fails.
- [ ] Implement service creation, shared contract types and safe error mapping; no patient endpoint.
- [ ] Run `pnpm typecheck` and `pnpm test -- service-boundary`; expect both pass. Commit this boundary.

### Task 2: Tenant identity and isolation

Files: `packages/domain/src/policy/authorize.ts`, `packages/db/src/tenant-transaction.ts`, generated migration via `supabase migration new tenancy_foundation`, `tests/integration/tenant-isolation.test.ts`.

Consumes: ActorContext. Produces: `authorize`, `withTenantTransaction`, TenantTransaction; tenant/membership and synthetic fixture tables with grants/RLS, no clinical schema.

- [ ] Write integration cases: tenant A cannot read/update tenant B; forged resource tenant denied; revoked membership denied despite valid token; reused pooled connection never carries A into B; service account cannot impersonate staff.
- [ ] Run `pnpm test:integration -- tenant-isolation`; confirm failure before policies exist.
- [ ] Implement a restricted runtime role, transaction-local context established only after authentication/authorization, explicit grants and default-deny RLS. Keep privileged provisioning separate.
- [ ] Run the same suite under actual runtime credentials, not the database owner; expect all denies and allowed cases to pass. Run security advisors and commit reviewed migration/policies.

### Task 3: Versioned transport contract and authorization parity

Files: `packages/contracts/src/synthetic-task.schema.json`, `packages/domain/src/synthetic-tasks.ts`, `apps/api/src/routes/synthetic-tasks.ts`, `tests/integration/transport-policy.test.ts`, `docs/api/openapi.yaml`.

Consumes: Task 2 policy/transaction. Produces: `createSyntheticTask(ctx, envelope): Promise<CommandResult<{id:string; label:string}>>` as a non-clinical test domain used only in synthetic environments.

- [ ] Write tests for schema rejection, unknown properties, bounded label length (1–120), location denial, forged tenant, safe pagination and no sensitive error echo.
- [ ] Run `pnpm test:integration -- transport-policy`; confirm unimplemented behavior fails.
- [ ] Implement JSON Schema validation and minimal protected domain route; derive tenant from context. Publish matching OpenAPI and generated types.
- [ ] Run schema/contract drift checks plus test suite; expect documented errors and policy parity. Verify shared HTTP refusal mapping, hidden-resource non-disclosure, and fresh authorization before replay. Commit.

### Task 4: Atomic audit and outbox

Files: `packages/domain/src/events/record-command.ts`, `packages/db/src/outbox.ts`, migration via `supabase migration new audit_outbox`, `tests/integration/atomic-events.test.ts`.

Consumes: TenantTransaction, AuditEvent, OutboxEvent. Produces: `recordCommand(tx, audit, event): Promise<void>` with append-only audit permissions and transactional outbox insert.

- [ ] Write tests that command failure rolls back domain change/committed-change audit/outbox together; successful commit records all three; app role cannot update/delete audit; ordinary logs exclude payloads. Separately prove denied and failed attempts survive rollback through the independent durable security-attempt path in SHARED-CONTRACTS. Test unknown actor, forged tenant, duplicate attempt ID, separate retry attempts, sink outage and recovery; audit failure never permits a denied operation.
- [ ] Run `pnpm test:integration -- atomic-events`; confirm failure.
- [ ] Implement atomic committed-change recording plus independent minimized attempt recording after rollback, with event version, trace IDs and protected access. Document crash-window limits, safe alerts and fail-closed sink-outage handling. Production audit retention remains a later deployment gate.
- [ ] Run suite and security advisors; expect pass; commit.

### Task 5: Idempotency and concurrent updates

Files: `packages/domain/src/commands/execute-once.ts`, migration via `supabase migration new command_idempotency`, `tests/integration/idempotency.test.ts`.

Consumes: context, command envelope, atomic recordCommand. Produces: `executeOnce<T>(ctx, envelope, handler): Promise<CommandResult<T>>`, scoped by tenant/principal/operation/key with canonical payload digest and bounded retention.

- [ ] Write tests: duplicate concurrent same-key/same-body yields one mutation and a replay; different body conflicts; tenant B cannot replay A; stale expectedVersion conflicts; crash after commit recovers recorded result.
- [ ] Run `pnpm test:integration -- idempotency`; confirm failure.
- [ ] Implement durable reservation/result handling in transactions. Specify pending/committed/failed retry semantics and cleanup retention before publishing the API contract.
- [ ] Run suite repeatedly with controlled concurrency; expect exactly one committed result/event; commit.

### Task 6: Durable worker with fresh policy

Files: `apps/worker/src/lease.ts`, `apps/worker/src/dispatch.ts`, `packages/domain/src/integrations/adapter.ts`, `tests/integration/worker-recovery.test.ts`.

Consumes: OutboxEvent and authorize. Produces: `dispatchEvent(event, adapter): Promise<'delivered' | 'retry' | 'denied' | 'dead-letter'>`; adapter accepts stable delivery key and returns a typed receipt.

- [ ] Write cases: worker dies after external fake-provider success but before acknowledgement; lease expires; membership revoked after enqueue; duplicate delivery; provider timeout with unknown outcome; max retries dead-letter.
- [ ] Run `pnpm test:integration -- worker-recovery`; confirm failure.
- [ ] Implement leasing, fresh authorization, backoff/jitter, adapter receipts/deduplication, explicit unknown-result reconciliation and dead-letter review. Use fake providers only.
- [ ] Run fault-injection tests; expect one external logical action and visible recoverable state. Commit.

### Task 7: MCP parity on the synthetic domain

Files: `apps/mcp/src/server.ts`, `apps/mcp/src/auth.ts`, `apps/mcp/src/tools/synthetic-tasks.ts`, `tests/integration/mcp-parity.test.ts`.

Consumes: published contracts, authorize and executeOnce. Produces: bounded list/create synthetic-task tools using identical handlers, authenticated transport and no arbitrary SQL/HTTP/shell tools.

- [ ] Write tests: unauthorized tenant denied via both API and MCP; insufficient scope denied; repeated command returns same result; malformed audience/token denied; tool errors exclude secrets.
- [ ] Run `pnpm test:integration -- mcp-parity`; confirm failure.
- [ ] Implement adapter and supported MCP authorization revision; log actor/tool/correlation only. Keep all inputs schema-validated outside the model.
- [ ] Run protocol and parity suite with a local synthetic client; expect pass. Commit.

### Task 7a: Synthetic proposal and approval boundary

Files: `packages/contracts/src/action-proposal.schema.json`, `packages/domain/src/commands/proposals.ts`, `tests/integration/proposal-policy.test.ts`, `docs/adr/0010-automation-policy.md`. Create only during authorized execution.

Consumes: Tasks 2–7. Produces: prepare/approve/commit behavior over the non-clinical synthetic task domain, with no live AI provider or outbound side effects.

- [ ] Define proposal states and actor/approver policy; bind tenant, operation, canonical payload digest, source/resource versions, policy version and expiry. Store protected provenance separately from ordinary logs.
- [ ] Write failing cases for altered payload, expired proposal, stale resource, cross-tenant approval, forged approval, agent self-approval of an elevated action, revoked approver/executor and policy change between approval and commit.
- [ ] Implement server-owned proposals and approval records; reauthorize at commit; connect the existing command/idempotency/audit boundary. A committed proposal cannot execute twice, even under concurrent retries.
- [ ] Run the same allow/deny cases through REST, MCP and deferred worker execution. Verify read/prepare never causes the synthetic mutation, unauthorized callers cannot read proposal contents, and a valid approved execution creates one result and audit trail.
- [ ] Record the synthetic evidence and future operation-specific policy requirements. Live models, clinical signing, financial posting and messaging remain outside this foundation task. Commit after review.

### Task 8: Foundation release and recovery proof

Files: `tests/integration/restore-smoke.test.ts`, `tests/integration/privacy-log.test.ts`, CI workflows, `docs/runbooks/development.md`, `docs/runbooks/restore.md`, `docs/adr/0002-deployment.md`.

Consumes: Tasks 1–7a. Produces: repeatable synthetic deployment/test/backup/restore instructions and CI evidence; no PHI-ready release claim.

- [ ] Write restore checks: tenant counts, synthetic record versions, audit/outbox invariants and denied cross-tenant access survive restore; forbidden marker absent in ordinary logs/artifacts.
- [ ] Include protected proposal/approval state in restore and privacy checks; restored stale/expired proposals fail closed and completed proposals cannot replay their mutation.
- [ ] Run tests and verify they detect deliberately incomplete synthetic backups and unsafe logging.
- [ ] Implement versioned backup/restore procedure, local environment verification, CI least permissions and dependency/license/security checks. Use no production secrets in pull-request jobs.
- [ ] Run all scripts, isolated restore and secret scan; record versions and results. Commit and obtain review before any domain expansion.

## Plan self-review and scope boundary

This plan implements platform guarantees only. Capability rows are intentionally owned by later workstreams in [ROADMAP](../../ROADMAP.md). It does not pretend to specify unvalidated payer, clinical or device contracts. Follow-on plans must include concrete schemas, transition rules and acceptance tests before coding those modules. No UI layout, component implementation, production cutover or clinical migration is included here.

