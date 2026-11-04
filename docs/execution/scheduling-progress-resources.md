# Workstream S progress: resources track (S-S3, S7, S9)

Branch `codex/s-resources`, based on `e3f18b4` (verified foundation head). Synthetic data only; embedded PostgreSQL 17 on one Windows host; no Supabase cloud connection. The orchestrator merges these sections into the S ledger. Status words follow AGENTS.md: everything here is **tested on synthetic data**, nothing is approved, deployed, compliant or clinically validated.

Baseline before any change: `corepack pnpm run typecheck` 0, `lint` 0, `contract:check` 0, `corepack pnpm test` 0 with 19 files / 342 tests.

## S-S3 policy record

Commit `34e3d6b`. `docs/adr/0009-scheduling-policy.md` records S-D1 (26 per request, ceiling 52, explicit `extendSeries`), S-D6 (offer = short-lived hold with expiry; never books without acceptance), S-D7 (interval per practice and category; already-booked exclusion default on; due list states policy version and freshness), R1 month-end clamp to the last day with the anchor day kept, R2 daylight-saving "compatible" rule (gap moves forward, repeated time takes the earlier instant, real elapsed durations), R3 search bounds. Every item is `recommended-pending-approval`; deciding roles named (practice manager, clinical lead, E communications owner) and **pending**. No decision-maker was available; nothing is `decided`.

## S7 resource, operatory and time-block model

Red: `corepack pnpm test -- tests/integration/resources` with the new tests and no implementation, exit 1 (2 files failed, 52 tests skipped at setup: `POST /v1/scheduling/locations` was 404).

Green: `corepack pnpm test -- tests/integration/resources.test.ts` exit 0, 17 tests; `tests/integration/resources-negative.test.ts` exit 0, 32 tests (10 rows x 3 cases on REST and MCP, plus a live downgrade and the matrix check). Full suite before the S7 commit: typecheck 0, lint 0, contract:check 0, test 0 with 22 files / 403 tests.

Acceptance cases (`tests/integration/resources.test.ts`):

1. Provider and operatory with two effective-dated versions; the read shows both, the first with `effectiveUntil` = the second's `effectiveFrom`.
2. `8. NO SHOW`, `9. CANCELLED APPTS.`, `Checked-In`, `asap`, `Treatment Complete` refused 422 `validation_failed` `/displayLabel` `reservedStateLabel`, no row written; the CHECK constraint refuses the same insert on the superuser path (23514).
2b. Data-quality report for the synthetic fixture: `{"vocabularyVersion":"scheduling-state-labels.1","resourcesChecked":4,"stateLabelledCount":0,"stateLabelled":[]}`. A look-alike (`Synthetic No Show Room`) passes the exact-match constraint and is listed (`matchedTerm: "no show"`); the report respects location policy.
3. Time block with reason and no patient (no patient column exists) appears in `scheduling_busy` under the runtime role; a location-wide block (no resources) is accepted.
4. Booking-side contract: `AppointmentOperatoryAssignment` accepts `{operatory: null, noOperatoryReason: 'no_show'|'cancelled'}` and an operatory ref; refuses null without a reason, an untyped reason, a provider in the operatory slot, and a reason next to an operatory.
5. Another tenant's resource: read 404 identical to missing and malformed; never listed; time block and availability naming it 404, nothing written; the tenant-consistent foreign key refuses a cross-tenant occupancy row even on the superuser path (23503).
6. Deactivation with a future booking: 409 `conflict` with `detail.conflicts` naming the booking (`existingRef`) and the resource; resource stays active; ending availability at a date (empty weekly set) succeeds.

Failure and recovery cases: (1) same-day and earlier versions 409 `availabilityOverlap`, overlapping or reversed intervals 422, no rows; (2) zone change under future occupied time 409 with conflicts (`policy_override_required`, not overrideable); a location without future occupied time changes zone (version 2); stale version 409 with `currentVersion`; unknown zone 422 `unknownTimeZone`; (3) a deactivated resource stays readable with history; new availability and time blocks on it 422 `resourceInactive`; reactivation refused by trigger (42501); (4) a time block over a booking 409 listing exactly the overlapping booking; nothing written (time blocks, occupancy, audit, outbox counts unchanged); a location-wide block over a booking 409 the same way.

Database enforcement and policy: `btree_gist` present; constraint `scheduling_occupancy_no_overlap` is `EXCLUDE USING gist (tenant_id WITH =, resource_id WITH =, during WITH &&) WHERE (released_at IS NULL)`; an overlapping superuser insert fails 23P01, an adjacent half-open one succeeds; 4 concurrent identical time blocks yield exactly one 201 and three 409 `conflict`. Location-restricted admin cannot configure or read another location; a scheduler without `admin.configure` cannot define resources but can block time. Replay with one key returns `replayed: true`; a changed payload is `idempotency_conflict`; a missing key is 400. Audit/outbox rows carry field names only; the marker never reaches audit, outbox, attempts, idempotency rows, responses or logs. The runtime role cannot delete resources, occupancy or time blocks, rewrite availability or change a kind (42501).

Negative rows (`tests/integration/resources-negative.test.ts`): every S7 operation x {cross-tenant, revoked, downgraded} on REST and MCP: same status and code on both transports (404 `not_found` for targeted cross-tenant calls; 403 `forbidden` for revoked and downgraded), no row written in any scheduling, audit or outbox table, exactly one security attempt per refused call. Tenant-scoped listings and a beta `define` return or write beta data only and never carry an alpha identifier. A role downgraded after token issue is refused on the next REST and MCP command.

Overlap-enforcement mechanism: GiST exclusion constraint (btree_gist) per resource over `tstzrange`, verified available in the pinned embedded PostgreSQL 17 Windows build; Linux CI not yet run on this branch. Location-wide blocks have no occupancy row; they serialize through a `FOR UPDATE` lock on the location row (S10 bookings must take `FOR SHARE`).

Busy-interval seam for S10: view `cuspatlas.scheduling_busy (tenant_id, location_id, resource_id, during, source_kind, source_id)` with `security_invoker`; S10 inserts `hold`/`appointment` occupancy rows into `scheduling_occupancy` (kinds already allowed by the CHECK) and adds the `released_at` UPDATE grant with its release command. `resolveResourceRefs` and `loadLocation` in `packages/domain/src/scheduling/resources.ts` are exported for S10.

Shared files touched (append-only where possible): `packages/contracts/src/context.ts` (ResourceRef, Conflict, `RefusalDetail.conflicts`), `packages/contracts/src/synthetic-task.schema.json` (Refusal `detail.conflicts`), `packages/contracts/src/index.ts`, `packages/contracts/package.json` (export), `packages/domain/src/index.ts`, `packages/domain/src/policy/authorize.ts` (policy rows), `packages/domain/src/commands/execute-once.ts` (default codecs include scheduling), `apps/api/src/app.ts`, `apps/api/src/routes/manifest.ts`, `apps/api/src/contract-drift.ts` (+ test case), `docs/api/openapi.yaml`, `apps/mcp/src/server.ts` (TOOLS, REF_PARAMS, deps), `apps/mcp/src/tools/synthetic-tasks.ts` (ToolDeps.scheduling, KNOWN_PROPERTIES), `apps/mcp/src/tool-drift.test.ts` (filtered to synthetic tools), `apps/mcp/src/index.ts`, `tests/integration/tenant-isolation.test.ts` (table inventory), `tests/integration/mcp-parity.test.ts` (tool names), `docs/execution/foundation-contract-decisions.md` (S7 record).

Deviations: (a) the plan's "audit records a read" for search is not implemented; there is no foundation read-audit path and the orchestrator's no-persisted-side-effect rule wins (recorded as unresolved). (b) The no-operatory reason vocabulary is a published contract enum, not per-tenant configuration. (c) The explicit recorded zone migration is not implemented; zone changes under future occupied time are refused. (d) "Booking that names another tenant's operatory is refused" is proved through the shared resolver (time blocks, availability) and the foreign key, because bookings are S10.

Unresolved: scheduling outbox events have no delivery consumer yet (the worker would reauthorize and deliver them to whatever adapter is configured); Linux CI on this branch; reviewer sign-off for ADR 0009.

## S9 availability search

Red: `corepack pnpm test -- tests/integration/availability.test.ts tests/integration/resources-negative.test.ts` with the tests and no implementation, exit 1 (15 failed: all 12 availability tests and the 3 search rows of the negative file; `POST /v1/availability/search` was 404).

Green: the same command exit 0, 47 tests. Unit `packages/domain/src/scheduling/zoned-time.test.ts` 4 tests. Full suite before the S9 commit: typecheck 0, lint 0, contract:check 0, test 0 with 24 files / 423 tests.

Acceptance cases (`tests/integration/availability.test.ts`):

1. Windows are free for duration plus buffer on every required resource: with a booking 09:30-10:00 and a 15-minute buffer, 08:45 is offered and 09:00/09:30/09:45/11:30 are not; without a named operatory the search falls through to Operatory 2 during the booking.
2a. Effective-dated hours (provider 09:00-11:00 from 2030-02-04), a resource time block (10:00-10:30 removed) and a location-wide holiday (`none_free`) are applied.
2b. Spring-forward 2030-03-10, Sunday hours 00:30-04:00 local (150 real minutes), 60-minute windows every 30 minutes. Recorded output:
    `[["2030-03-10T05:30:00.000Z","2030-03-10T00:30:00-05:00","2030-03-10T01:30:00-05:00",60],["2030-03-10T06:00:00.000Z","2030-03-10T01:00:00-05:00","2030-03-10T03:00:00-04:00",60],["2030-03-10T06:30:00.000Z","2030-03-10T01:30:00-05:00","2030-03-10T03:30:00-04:00",60],["2030-03-10T07:00:00.000Z","2030-03-10T03:00:00-04:00","2030-03-10T04:00:00-04:00",60]]`
2c. Fall-back 2030-11-03, the same hours (270 real minutes): 8 windows, each exactly 3600 s; recorded output:
    `[["2030-11-03T04:30:00.000Z","2030-11-03T00:30:00-04:00","2030-11-03T01:30:00-04:00"],["2030-11-03T05:00:00.000Z","2030-11-03T01:00:00-04:00","2030-11-03T01:00:00-05:00"],["2030-11-03T05:30:00.000Z","2030-11-03T01:30:00-04:00","2030-11-03T01:30:00-05:00"],["2030-11-03T06:00:00.000Z","2030-11-03T01:00:00-05:00","2030-11-03T02:00:00-05:00"],["2030-11-03T06:30:00.000Z","2030-11-03T01:30:00-05:00","2030-11-03T02:30:00-05:00"],["2030-11-03T07:00:00.000Z","2030-11-03T02:00:00-05:00","2030-11-03T03:00:00-05:00"],["2030-11-03T07:30:00.000Z","2030-11-03T02:30:00-05:00","2030-11-03T03:30:00-05:00"],["2030-11-03T08:00:00.000Z","2030-11-03T03:00:00-05:00","2030-11-03T04:00:00-05:00"]]`
    A Los Angeles display zone changes only the rendering (`2030-11-02T21:30:00-07:00`).
2d. Month-end: 2030-01-31 (Thu) to 2030-02-01 (Fri) and 2030-02-28 (Thu) to 2030-03-03 (Sun) produce exactly the weekday windows.
3. No side effect: three searches leave the row count of every `cuspatlas` table unchanged (outbox, audit, idempotency, occupancy included; security attempts excluded); the response is `advisory` and lists what was not considered.
4. Another tenant's resource 404 identical to missing; beta never sees alpha identifiers; beta naming an alpha resource 404; a loc-north scheduler searching another location 403.
5. Duration 0, 4 and 481 are 400; a malformed zone 400; an unknown zone 422 `unknownTimeZone`; 2030-02-30 422.
6. 32 days 422 `beyondHorizon`, reversed range 422, 31 days 200; pages concatenate to the full list; a cursor reused with another query, from another tenant or altered is 400; `limit` 101 is 400.

Failure and recovery cases: (1) after a booking lands in a returned window the next search omits it and a second occupant for the stale window is refused by the exclusion constraint (23P01): the search is advisory, the constraint is authoritative; (2) a deactivated resource is absent with `coverage.excludedResources` `inactive` and outcome `no_eligible_resource`; (3) a location without availability returns `no_availability_configured` with the excluded resource named, not an empty list.

Negative rows: `scheduling.availability.search` added to `tests/integration/resources-negative.test.ts` (cross-tenant 404, revoked 403, downgraded 403 on REST and MCP, nothing written, one attempt row per refusal): 11 rows x 3 cases, 35 tests in the file.

Shared files touched by S9: `apps/api/src/routes/manifest.ts`, `apps/api/src/contract-drift.ts` (closed-body list), `docs/api/openapi.yaml`, `tests/integration/mcp-parity.test.ts` (tool name), `docs/execution/foundation-contract-decisions.md` (S9 record).

Deviations: plan case 3 says "the audit records a read"; not implemented (no read-audit path; the orchestrator's no-side-effect assertion wins). Appointment types, credentials, equipment eligibility, patient availability and payer rules are stated as not considered rather than modelled.
