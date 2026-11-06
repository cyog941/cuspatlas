# Synthetic foundation execution runbook

Status: execution planning only, 2026-11-03. User requested planning the execution, not starting implementation. This document sequences the [foundation plan](2026-11-03-platform-foundation.md); its task numbers remain authoritative. UI, patient modules and production deployment remain out of scope. Broad incumbent research is closed.

## Outcome and boundaries

A developer can start an isolated synthetic environment, authenticate two tenants and scoped principals, call the same bounded business commands through REST and MCP, prove isolation and safe retries, exercise approval/worker failures, restore a backup, and reproduce the evidence from a clean checkout. This is infrastructure readiness, not a usable dental PMS or certification.

Permitted on subsequent foundation build authorization: service/workspace files, pinned dependencies, synthetic tenancy/task/audit/outbox/idempotency/proposal migrations, fake integrations, tests, CI and developer runbooks. Excluded: clinical schemas, patient import, UI/native companion, real model calls, messaging/payments/claims, production credentials and production deployment. Managed cloud mutations need an identified, explicitly authorized development target; a browser's current project is never the target selector.

## Verified preflight snapshot

Read-only checks on 2026-11-03: Node v24.13.1 and Git 2.53.0.windows.1 are available; pnpm and gh resolve on PATH. Docker and Supabase CLI do not resolve on PATH. This does not prove they are uninstalled, that WSL is configured, or that a database daemon is running. No package was installed and no service started. Verify supported versions and compatibility at execution rather than adopting this snapshot as the pinned toolchain.

The repository records cuspatlas-dev as project `pfnuigldoshdldetkaqk`; provisioning status in SETUP.md is historical until reread live. No cloud credentials were inspected here. Cloud access is optional for initial local tests; do not connect to any other existing project.

## Execution checkpoints

| Batch | Source tasks | Concrete output | Exit gate |
|---|---|---|---|
| E0: environment and baseline | Preflight, before Task 1 | Clean isolated branch/worktree, selected toolchain, verified disposable database target and execution record | Real PostgreSQL test path works; identity of target documented without secrets; no production resource involved |
| E1: reproducible service | Task 1 | Locked workspace, schema/context boundary, safe errors, health endpoint, runtime ADR | Fresh install/typecheck/lint and boundary tests pass; no sensitive marker in errors |
| E2: identity and contracts | Tasks 2–3 | Synthetic tenants/memberships/tasks, restricted DB role and RLS, domain policy, REST schema | Positive plus cross-tenant, forged-context, revoked-role and pooled-connection tests pass using runtime credentials |
| E3: trustworthy mutations | Tasks 4–5 | Atomic committed audit/outbox, separate attempt audit, durable idempotency and optimistic concurrency | Rollback and denial audit behave correctly; concurrent duplicate request yields one mutation; replay reauthorizes |
| E4: durable integrations | Task 6 | Leased worker, fake provider receipts, retry/reconciliation and dead-letter state | Crash-after-provider-success, timeout, revoke-after-enqueue and duplicate/out-of-order tests pass |
| E5: programmatic control | Tasks 7–7a | Authenticated MCP parity and synthetic prepare/approve/commit | REST/MCP expose the same allowed/denied behavior; agent cannot self-approve; stale/forged/replayed proposal cannot execute |
| E6: reproducibility and recovery | Task 8 + assurance additions | CI, clean rebuild, isolated restore, SBOM/evidence manifest and developer handoff | Full suite, restore reconciliation, secret/privacy checks and evidence integrity pass; limitations recorded |

Tasks 3 and 5 have a staged dependency: Task 3 establishes schemas and policy outcomes; saved-result replay tests become enforceable in Task 5. Task 7a adds worker approval cases after Task 6 exists. No skipped dependency is recorded as passing. Keep implementation sequential across these shared boundaries to avoid competing versions of policy, transactions and contracts.

## E0 procedure after build instruction

1. Fetch remote, inspect AGENTS.md and current diffs, preserve user/DSH changes. Create `codex/foundation-core` or an isolated worktree from the current accepted main commit. Record base SHA; do not rewrite shared history.
2. Read the execution skill required by the foundation plan. Check the actual Node/package-manager/DB/CLI versions and required licenses. Select supported versions, pin dependencies and lockfile in Task 1; no floating latest versions in reproducible CI.
3. Prefer a dedicated local PostgreSQL/Supabase test stack. Inspect available runtime paths before choosing setup. If local containers require unavailable OS capabilities, use an explicitly scoped isolated test environment; do not silently switch to the open browser's cloud project. Record setup limitations and any required host action.
4. Separate privileged migration credentials from a non-owner, non-BYPASSRLS runtime role. Run negative tests with runtime credentials. Synthetic fixture creation uses an explicit test-only path; production auth must never accept test headers or unsigned fake tokens. Exercise issuer, audience, signature, expiry and session/membership checks with a local test issuer or qualified local auth service.
5. Establish two tenants, distinct users/service principals, one revoked principal and test-only task records. No real names, patient records, terminology datasets or external provider credentials.
6. Narrow the existing blanket SQL ignore rule only when migrations are created: track authored migration SQL while continuing to ignore dumps/backups and local exports. Confirm staged files explicitly. Keep secrets outside Git and use placeholders in examples.
7. Add a target guard for destructive test/reset/restore operations: dedicated test database allowlist, synthetic marker and checked target identity. Restore only into a separate disposable database, never over the source. Refuse when identity is ambiguous.

## Contract details to settle in E1 before dependent code

- Follow SHARED-CONTRACTS for transport references (`taskRef`, not generic public `id`) and safe refusal mapping; trusted persistence retains tenant keys. A tenant string from the caller never establishes authority.
- Separate successful `CommandResult<T>` from typed refusals. Normalize typed policy exceptions at the command boundary; test REST status and MCP tool-error parity. No domain refusal is an HTTP 200.
- Define committed-change audit separately from `SecurityAttemptEvent`: the latter has a unique attempt reference and may lack actor/tenant when unauthenticated. Never fabricate identity to satisfy a required field. Bind only authenticated context, safe operation/reason and correlation metadata.
- Freeze idempotency retention and key scoping, canonical payload digest, retry/unknown-result rules and concurrency assertions in an ADR or task record before dependent worker code. Reauthorize before returning cached results.
- Start with a non-clinical synthetic task domain. Demonstrating a protected synthetic approval is not evidence that prescribing or financial execution is approved.

## Working and verification protocol

For each batch: record task IDs and acceptance cases; demonstrate the relevant failing test; implement the smallest boundary; run focused checks; review diff/credentials/permissions; commit with evidence. Once checks pass, expand testing only for changed boundaries or unresolved risks. Full regression is required at E6 and before merge.

Maintain a future `docs/execution/foundation-progress.md` ledger with base/head SHA, task status, changed artifacts, exact commands/exit codes, safe result summaries, unresolved issues and next step. Status values: not started, in progress, blocked with cause, verified. Do not precheck completion boxes. CI/evidence uploads must exclude secrets, database dumps, private URLs, prompts and raw patient data. Use synthetic marker scans as acceptance tests.

Per-batch commits remain reviewable. If upstream changes arrive, fetch/reconcile and rerun affected checks rather than force-pushing. Open a draft PR when the implementation has a concrete boundary to review; merging is not implied by planning. CI must use ephemeral services and least permissions, with no production secrets in pull-request jobs. Configure required checks only after those checks exist and work.

## Stop or defer rules

Stop the affected batch on ambiguous database target, missing real database tests, failed isolation/revocation, unexplained duplicate side effects, unauditable mutation, sensitive output leakage, incompatible schema contract or new destructive host requirement. Preserve progress and report exact cause. Never skip a security test to keep the sequence moving.

Do not block synthetic foundation on sensor SDK access, clearinghouse agreements, clinical chart semantics, certification purchase or UI design. These remain named follow-on gates. If a dependency genuinely changes a foundation invariant, record the issue and resolve the narrow contract rather than reopening broad reference PMS research.

## Definition of completion and handoff

- Clean checkout reproduces install, typecheck, lint, schema/contract checks and the documented integration suite against isolated real PostgreSQL.
- Two-tenant policy, revocation, pool cleanup, atomicity, durable attempt audit, replay safety, worker recovery and approval boundaries have recorded positive/negative evidence.
- API/MCP parity is proven for the synthetic operations; no SQL, arbitrary shell/HTTP proxy or privileged DB secret reaches an agent.
- Restore preserves task versions, tenant isolation, audit/outbox/idempotency and proposal safety; restored pending external work does not blindly repeat side effects.
- Release artifacts include SBOM/provenance and the AS-01–04 synthetic evidence manifest with stale/tampered/forged-evidence tests. No ISO or PHI-readiness claim.
- PR/handoff lists passed checks, environment versions, residual limitations and rollback instructions. No silent expansion into S/C/B/I/E/A/M/R product functionality. User receives the next scoped implementation recommendation; UI remains deferred.

Current execution state: E0–E6 verified on one local Windows host, a clean clone, and GitHub Actions Linux CI (draft PR #9), after independent review cycles. Embedded PostgreSQL on hosted Windows runners is an open issue. Not approved, not deployed, not compliant, not clinically validated. The batch table in [the execution ledger](../../execution/foundation-progress.md) is authoritative.
