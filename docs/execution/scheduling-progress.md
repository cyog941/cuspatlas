# Scheduling and patients execution ledger (workstream S)

Branch: `codex/s-patients` in an isolated worktree outside the OneDrive-synced checkout. Base SHA: `e3f18b4` (verified foundation head). A sibling worktree builds S7/S9 on `codex/s-resources`; the orchestrator merges both. Status values: not started, in progress, blocked with cause, verified. Nothing is prechecked.

Authorization basis: user instruction on 2026-11-04 to build workstream S on synthetic data. Scope of this branch: S-S1, S4, S5, S6 and the shared negative harness. Synthetic patients only; no real patient data, no cloud connection, no host installs. Decisions S-S1, S-D2, S-D3, S-D4 and S-D8 need human reviewers who were not available: they are recorded as **recommended-pending-approval** in [ADR 0003](../adr/0003-patient-identity.md) and implemented behind per-tenant configuration. Nothing here is clinically validated, approved or deployed.

## Batch status

| Task | Status | Head SHA | Notes |
|---|---|---|---|
| S-S1 patient identity decision record | recommended-pending-approval (no reviewer) | ed71feb | ADR 0003 |
| S4 patient identity core + negative harness | verified on synthetic data (Windows host); decisions pending approval | 7bde1cf | 382 tests |
| S5 guardian, guarantor and proxy relationships | verified on synthetic data (Windows host); decisions pending approval | 1a54fe8 | 409 tests |
| S6 duplicate review, merge and unmerge | verified on synthetic data (Windows host); decisions pending approval | 45bcce2 | 438 tests |
| S-S3, S7, S9 (resources track) | verified on synthetic data (Windows host); decisions pending approval | 7929f77 | see Resources track |
| Batch 2 merge of both tracks | verified on synthetic data (Windows host) | 6bf3114 | 518 tests |
| S8 appointment requests | verified on synthetic data (Windows host); decisions pending approval | 62ac4d3 | 564 tests |
| S10 booking, holds, conflict result | verified on synthetic data (Windows host); decisions pending approval | 7e0b5c6 | 612 tests |
| S11 attendance (+ S10 contention fix) | verified on synthetic data (Windows host); decisions pending approval | 8648aa9 | 644 tests |
| Review hardening of S4-S9 | verified on synthetic data (Windows host) | 427979e | 655 tests |
| S12 visit context (container; producer-bound cases open on C8/C10/C11/C13/C16) | container verified on synthetic data (Windows host); clinical producers absent | see S12 | 696 tests + 6 todo |
| S13 recurrence series with cap | verified on synthetic data (Windows host); S-D1/R1/R2 pending approval | see S13 | 729 tests + 6 todo |
| S14 notification intent (channel none; E6/E7 cases open) | verified on synthetic data (Windows host); S-S2/S-D5 blocked-on-discovery | see S14 | 745 tests + 12 todo |
| S15 waitlist + PT-02 cancellation recovery | verified on synthetic data (Windows host); S-D6 pending approval | see S15 | 817 tests + 12 todo |
| S16 recall + PT-03 follow-up (S part) | verified on synthetic data (Windows host); S-D7 pending; completion basis blocked on C14 | see S16 | 854 tests + 13 todo |
| S17 parity (77 ops), harness, ordinary day, export round trip, downtime runbook | verified on synthetic data (Windows host) | see S17 | 941 tests + 13 todo |
| Review hardening of S8-S11 | verified on synthetic data (Windows host) | see hardening | 953 tests + 13 todo |

## Command log

### S-S1

- Wrote `docs/adr/0003-patient-identity.md`: question list Q1-Q13, two synthetic duplicate pairs (P1 shared household phone; P2 same name, different birth date) used as fixtures in S4 and S6, every answer marked recommended-pending-approval with the reviewer role named, unresolved items with owners.
- Deviation: the plan's read-only walkthrough with reception and practice-management reviewers did not happen (no reviewer, no permitted environment). Reviewer sign-off is pending; the reviewer register is empty.

### S4 (patient identity core)

Acceptance cases (tests/integration/patient-identity.test.ts, 16 tests, every denial under the runtime role `cuspatlas_app`):

1. minimum create returns version 1; patient, status fact, one audit row (`patients.create`, `patient`, v1) and one field-names-only outbox row commit together;
2. same Idempotency-Key replays the same patient (`replayed: true`), one patient and one audit row; changed body under the key is 409 `idempotency_conflict`;
3. pair P1 (shared household phone and address): two records after creation and after phone search; no merge proposed; no `candidates` field;
4. deceased and inactive stay readable; `assertPatientSchedulable` (the guard S8/S10 must call) refuses with 409 `conflict` and `detail.reason` `patient_deceased` / `patient_inactive`; leaving deceased needs `entered_in_error` (`status_transition_denied`); a future effective instant is 422; status history keeps both facts;
5. another tenant's read, update and status change are 404 with a body identical to a missing ref (attempt row `resource_hidden_or_missing`, tenant beta); its search is 200 with an empty page;
6. absent groups are stored and returned as `{known:false, reason:'not_provided'}`; empty strings and an unknown group without reason are 400; the database refuses empty strings structurally (`patient_group_valid`).

Failure cases: (1) revoked outbox INSERT grant → 500 and patients/audit/outbox/status counts unchanged; (2) two concurrent updates with one `expectedVersion` → one 200, one 409 `stale_version` (`currentVersion: 2`); (3) precision `week` → 400; value/precision mismatch, impossible date, future date and unknown IANA zone → 422 with nothing written; (4) no contact block → `contactable: false` and contact explicitly unknown; a contact with only `avoid` points is also not contactable.

Also: updates replace only provided groups and track provenance; name-prefix, birth-date and phone search, cursor pagination, limit > 100 refused, tenant field refused; tenant-wide identity with a location-restricted member able to name only its own home location (403 otherwise); sensitive-read rows for read and search with references and filter names only; MCP create replays over REST with the same key; the marker in names, preferred name, email, address and a distinctive phone never reaches logs, refusal bodies, audit, outbox, attempts, idempotency or sensitive-read rows.

Negative harness (tests/integration/negative-harness.test.ts, 17 tests, table-driven, `COMMANDS` is append-only for later tasks and the sibling S7/S9 branch): every S4 command cross-tenant (404 hidden, empty page for search, own tenant only for create), revoked membership (403 `membership_inactive`), downgraded role (403 `scope_missing`) on REST and MCP with identical codes, attempt rows, unchanged state and no marker in refusals; owner control case; caller-supplied `tenantId` refused on every body and tool.

- Red: `corepack pnpm test -- patient-identity` before implementation → exit 1, 16 failed (16).
- Green: `corepack pnpm test -- patient-identity` → exit 0, 16 passed; `corepack pnpm test -- negative-harness` → exit 0, 17 passed (written after S4 code existed, so it was not seen red; it is regression coverage).
- `corepack pnpm typecheck` → exit 0; `corepack pnpm lint` → exit 0; `corepack pnpm contract:check` → exit 0; `corepack pnpm test` → exit 0, 21 files, 382 tests (342 at start + 16 identity + 17 harness + 1 contract drift + 6 tool drift).

Deviations: one contract file `packages/contracts/src/patient.schema.json` for S4-S6 instead of three proposed files (one drift check and one MCP closure); the plan's `readPatient`/`searchPatients` names are kept, search is `POST /v1/patients/search` so terms stay out of URLs. A status-change effective instant may be backdated before the registration instant (the first draft refused it as out of order; removed because a status can legitimately predate registration, for example a deceased patient registered from records). Existing shared tests changed minimally: RLS table inventory (+3 tables), MCP tool list (+5 names), tool-drift synthetic filter.

Decisions taken under pending recommendations: S-D8 tenant-wide identity (Q1); explicit-unknown representation; match keys as SHA-256 digests.

Unresolved: S8/S10 must call `assertPatientSchedulable`; the refusal reaches the caller as 409 `conflict` with `detail.reason`, which those tasks may map into `Conflict.kind = patient_inactive`.

### S5 (guardian, guarantor and proxy relationships)

Acceptance cases (tests/integration/patient-relationships.test.ts, 11 tests, denials under the runtime role):

1. a guardian of a synthetic minor (born 2016-05-05) with `demographics` and `scheduling` resolves to exactly those scopes, can read and update on the minor's behalf (provenance `guardian_reported`), and its authority ends at the computed age of majority (2034-05-05, default 18); `clinical_read` and `clinical.sign` are not permitted and `requireRelationshipScope(..., 'clinical.sign')` is 403 `relationship_scope_missing`;
2. a proxy whose window ended (server clock) is denied (403 `relationship_expired`, attempt row) while the patient stays readable and the relationship is listed as `expired`/`window_ended`;
3. a guardian revoked after the session token was issued is denied on the next command; the row is kept with its revocation instant and reason; a second revocation is 409 `relationship_already_revoked`;
4. an adult revoking a proxy (revocation through MCP) produces an identical refusal body on REST and MCP for `patients.updateDemographics` with `requestedBy` (403, `relationship_revoked`, one attempt row per surface); MCP read on behalf is denied too;
5. a counterparty from another tenant is 404 with a body identical to a missing one; beta cannot attach to an alpha subject; no row written;
6. two active guardians are allowed; a second unrevoked guarantor is 409 `exclusive_guarantor_exists` with the blocking relationship in `blockingRefs`.

Failure cases: (1) no clock parameter is accepted (`asOf`/`now` give 400), the revoke body cannot carry a window (400), and the runtime role cannot UPDATE `effective_until` or DELETE a relationship even with direct SQL (SQLSTATE 42501); (2) a revocation in flight (row locked, uncommitted) when the next on-behalf command arrives makes that command wait and then fail closed (403 `relationship_revoked`); the earlier committed update keeps its audit row and version; (3) relinking on merge is covered in S6 (tests/integration/patient-merge.test.ts).

Also: per-kind scope rules, proxy end required and bounded by `proxy_max_days`, already-ended windows, self-relationships, unknown kinds/scopes and duplicate scopes refused; a new guardian for an adult is refused (`subject_reached_majority`); an unknown birth date needs an explicit end (`guardian_requires_birth_date_or_end`); lowering the tenant's `age_of_majority_years` ends guardian authority immediately (`age_of_majority_reached`); future grants are `pending`; relationship create replays under its key; the marker in patient names never reaches logs or audit/outbox/attempt/idempotency/sensitive-read rows.

Negative harness: 4 rows appended (add, list, revoke, resolve), each cross-tenant, revoked and downgraded on REST and MCP (12 tests).

- Red: `corepack pnpm test -- patient-relationships` before implementation: exit 1, 11 failed (11).
- Green: `corepack pnpm test -- patient-relationships`: exit 0, 11 passed. One fixture correction during green: the test that simulates elapsed time through the superuser must bump `version`, because the relationship trigger applies to every role that cannot disable triggers.
- `corepack pnpm typecheck`, `lint`, `contract:check`: exit 0; `corepack pnpm test`: exit 0, 22 files, 409 tests.

Deviations: the counterparty is a patient-identity record of the same tenant (no non-patient person register; ADR 0003 Q13). `resolvePatientAccess(ctx, patientRef, {counterpartyRef})` takes the counterparty explicitly because no portal principal exists; E1 is the named consumer. `dependent` carries no scopes. Relationship scope names are used exactly as in the SHARED-CONTRACTS "Relationship scopes" table; nothing new was minted.

Decisions taken under pending recommendations: S-D4 (Q10-Q12): guardian until age of majority (default 18, per tenant), proxy time-boxed (default maximum 365 days, per tenant), renewal is a new grant, one unrevoked guarantor.

Unresolved: no write command for `patient_policy_settings` (needs `admin.configure`); jurisdiction review of majority, emancipation and evidence requirements; E1 portal principal mapping.

### S6 (duplicate candidate review, merge and unmerge)

Acceptance cases (tests/integration/patient-merge.test.ts, 13 tests, denials under the runtime role):

1. candidates for a true duplicate (same legal name, birth date and phone) list exactly that patient with reasons `same_birth_date`, `same_legal_name`, `same_phone` and score 85, a summary without contact values and no audit, outbox, merge or patient change; pair P1 (shared phone and address, different names) never qualifies; pair P2 (same name, birth dates 2003-02-03 and 1973-02-03) is below the default threshold 40 and, with the tenant threshold lowered to 5, is listed with score 10 and reasons `same_legal_name`, `birth_date_conflict`;
2-3. a merge moves every enumerated record (a relationship where the merged patient is counterparty and one where it is subject), each listed with record class, reference field, prior and new owner; the merged record reads as 409 `patient_merged`, is excluded from search and stays reachable through merge history from both refs; the history's moves and count equal the result's; both rows are kept; the relinked guardian authority now names the survivor; audit rows per correlation: 2 patient, 1 merge, 2 relationship;
4. tampered, forged, other-pair and other-reviewer tokens are 403 `confirmation_invalid`; a missing token is 400; a read-only member is 403; a service principal with `patients.merge` is 403 `principal_kind_denied`; a change after review is 409 `confirmation_stale`; candidate review needs the merge scope; a reviewer with its own token merges;
5. a cross-tenant merge returns a body identical to a merge naming a random ref; another tenant's patient is 404 for candidates and history and never a candidate;
6. unmerge inside the window (ordinary merge role) restores the relinked record, appends a reversal, keeps the merge link and refuses a second reversal (`merge_already_reversed`); outside the window (tenant window 0) the ordinary role gets 403 `unmerge_requires_reconciliation_review`, the elevated role without a review reference 422 `reconciliation_review_required`, and with one 200 (`elevated: true`);
7. the moved relationship's content digest is unchanged and equals the recorded before/after digests; every foreign key to `patients` is registered or excluded; the database refuses a move whose digests differ (SQLSTATE 23514).

Failure cases: (1) revoked INSERT on `patient_merge_moves` gives 500 and leaves relationships, patients, merges, audit and outbox unchanged; the same token then merges; (2) two concurrent merges absorbing the same patient into different survivors give one 201 and one 409, one merge row and one move for the shared relationship; the remaining survivor then absorbs the third record; (3) a relationship between the pair, or two unrevoked guardians that would collapse into a duplicate, give 409 `merge_blocked` with exactly the blocking relationship in `blockingRefs` and nothing written; (4) merging an already-merged patient is 409; candidate review of a merged patient is 409 `patient_merged`; unmerging a merge whose survivor was merged later is 409 `survivor_merged`.

Also: with a post-merge clinical-fact probe (test stand-in; no clinical class exists yet) the ordinary role is refused and the elevated role with a review reference succeeds; an expired token is 403 `confirmation_expired`; merge and unmerge through MCP call the same handlers, a replay under the same key returns the recorded merge without a second merge, and MCP and REST merge history are identical; the marker in names never reaches logs, audit, outbox, attempt, idempotency, sensitive-read, merge or move rows.

Negative harness: 4 rows appended (find, merge, unmerge, history), each cross-tenant, revoked and downgraded on REST and MCP (12 tests). Cross-tenant merge is denied with `merge_confirmation_invalid` before any lookup (new harness mode `confirmation_denied`).

- Red: `corepack pnpm test -- patient-merge` before implementation: exit 1, 13 failed (13).
- Green: `corepack pnpm test -- patient-merge`: exit 0, 13 passed. One fixture correction during green: pair P2 got a birth date no other fixture shares (with the threshold lowered to 5, an exact shared birth date alone, score 30, legitimately qualified other fixtures). ADR 0003 updated to the same dates.
- `corepack pnpm typecheck`, `lint`, `contract:check`: exit 0; `corepack pnpm test`: exit 0, 23 files, 438 tests.

Deviations: function names `findDuplicateCandidates`, `mergePatients`, `unmergePatients`, `listMergeHistory` as in the plan; `MergeResult` moves use the record's public reference field name (`subjectRef`, `counterpartyRef`). The confirmation token is issued by candidate review (no separate prepare command). Merge field precedence: survivor wins and nothing is copied (ADR 0003 Q4).

Decisions taken under pending recommendations: S-D3 (Q2, Q3) candidate scoring with reasons, never automatic, contact-only overlap never qualifies, default threshold 40; S-D2 (Q7, Q8) reversible within 30 days and without new clinical/financial facts, otherwise elevated role plus review reference; Q5/Q6 confirmation token and human-only merge.

Limitation (record classes merge does not cover yet): appointment requests and bookings (S8, S10), clinical records (C), financial records (B), images (I) and portal grants (E1) do not exist; each must register in `MERGE_RECORD_CLASSES` (the foreign-key test enforces it). The post-merge fact rule has no real clinical or financial class to count yet.

Unresolved: reviewer sign-off for every ADR 0003 row; a write command for `patient_policy_settings`; unique-index collisions when restoring a record during unmerge after an identical record was created for the restored patient are not prechecked (they fail closed as a 500 and roll back).

### Branch gate

- `corepack pnpm run ci` at 45bcce2: exit 0 (typecheck, lint, contract drift, 23 files / 438 tests, privacy scan of 187 tracked files and the artifacts, SBOM 270 components, evidence manifest and verification: unreviewed, not certified). Re-run after this ledger entry; see the commit containing it.
- Shared files touched (for the orchestrator's merge with `codex/s-resources`): `apps/api/src/app.ts`, `apps/api/src/contract-drift.ts` (+ test), `apps/api/src/routes/manifest.ts`, `apps/mcp/src/server.ts` (TOOLS, REF_PARAMS, service wiring), `apps/mcp/src/tools/synthetic-tasks.ts` (ToolDeps.patients, KNOWN_PROPERTIES), `apps/mcp/src/tool-drift.test.ts` (synthetic filter + patient block), `docs/api/openapi.yaml`, `packages/contracts/src/{context.ts,index.ts,package.json,synthetic-task.schema.json}` (RefusalDetail `reason`/`blockingRefs`, security reason codes), `packages/domain/src/{index.ts,commands/execute-once.ts,policy/authorize.ts}`, `tests/integration/{tenant-isolation,mcp-parity}.test.ts`, `docs/SHARED-CONTRACTS.md` (scope registry line), `docs/execution/foundation-contract-decisions.md` (appended S4-S6 records). The negative harness `COMMANDS` table is append-only.

## Resources track (S-S3, S7, S9), merged from `codex/s-resources` at 7929f77

Appended verbatim from the former `docs/execution/scheduling-progress-resources.md` (headings demoted one level). The resources-track negative rows it cites now live in `tests/integration/negative-harness.test.ts` (see the batch 2 merge entry below).

Branch `codex/s-resources`, based on `e3f18b4` (verified foundation head). Synthetic data only; embedded PostgreSQL 17 on one Windows host; no Supabase cloud connection. The orchestrator merges these sections into the S ledger. Status words follow AGENTS.md: everything here is **tested on synthetic data**, nothing is approved, deployed, compliant or clinically validated.

Baseline before any change: `corepack pnpm run typecheck` 0, `lint` 0, `contract:check` 0, `corepack pnpm test` 0 with 19 files / 342 tests.

### S-S3 policy record

Commit `34e3d6b`. `docs/adr/0009-scheduling-policy.md` records S-D1 (26 per request, ceiling 52, explicit `extendSeries`), S-D6 (offer = short-lived hold with expiry; never books without acceptance), S-D7 (interval per practice and category; already-booked exclusion default on; due list states policy version and freshness), R1 month-end clamp to the last day with the anchor day kept, R2 daylight-saving "compatible" rule (gap moves forward, repeated time takes the earlier instant, real elapsed durations), R3 search bounds. Every item is `recommended-pending-approval`; deciding roles named (practice manager, clinical lead, E communications owner) and **pending**. No decision-maker was available; nothing is `decided`.

### S7 resource, operatory and time-block model

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

### S9 availability search

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

### Commits and final verification

- `34e3d6b` S-S3 policy record (ADR 0009).
- `74bc1d8` S7 resources, operatories and time blocks.
- `21c86ce` S9 availability search.
- This ledger commit follows `21c86ce`; it changes only this file.

Final `corepack pnpm run ci` at `21c86ce`: exit 0 (typecheck, lint, contract:check, 24 files / 423 tests, test summary, privacy scan, SBOM, evidence manifest generated and verified: controls unreviewed, not certified). Counts: 342 baseline + 81 new (S7: 17 resources + 32 negative + 1 contract-drift case + 11 scheduling tool-drift; S9: 12 availability + 3 negative rows + 4 zoned-time + 1 tool-drift).

Pending decisions (ADR 0009, all recommended-pending-approval, no decision-maker available): S-D1, S-D6, S-D7, R1 month-end, R2 DST, R3 search bounds. Unresolved: read-access audit for searches; zone migration path; scheduling outbox events have no consumer; btree_gist and the DST tests not yet run on Linux CI for this branch; reviewer sign-off.

## Batch 2 integration (branch `codex/scheduling-patients`)

### Merge 1: `codex/s-patients` (1b387f4)

`git merge --no-ff codex/s-patients` onto `e3f18b4`: no textual conflicts. Commit: the first merge commit on this branch.

### Merge 2: `codex/s-resources` (7929f77)

`git merge --no-ff -X diff-algorithm=histogram` (diff3 conflict style) produced 27 conflict hunks in 14 shared files. Every hunk was additive and resolved by keeping both sides:

- `packages/contracts/src/context.ts` and the Refusal schema in `synthetic-task.schema.json`: `RefusalDetail` keeps all three optional fields `reason`, `blockingRefs` (patients) and `conflicts` (resources) plus `ResourceRef`/`Conflict`.
- `apps/api/src/contract-drift.ts`: both `patient:` and `scheduling:` reference prefixes (nested ternary), both schema sources, both closed-body and shared-definition checks. `manifest.ts`, `openapi.yaml`: both route sets. `packages/contracts/package.json`: both schema exports.
- `apps/mcp/src/server.ts`: TOOLS = synthetic + proposal + patient + scheduling; REF_PARAMS is the union; both services wired into ToolDeps. `tools/synthetic-tasks.ts`: both deps and property sets. `tool-drift.test.ts` auto-merged with a duplicated `SYNTHETIC_TOOLS` declaration (both branches introduced it); one copy removed.
- `packages/domain`: `executeOnce` codecs = task + patient + scheduling; policy rows, exports, migrations (20261105000000-020000 patients, 20261105100000 resources) all kept.
- `tests/integration/tenant-isolation.test.ts`: both table lists.

`tests/integration/resources-negative.test.ts` was folded into `tests/integration/negative-harness.test.ts` (11 S7/S9 rows plus the live-downgrade test; new cross-tenant mode `tenant_own_data` for tenant-scoped listings and a beta location define). No assertion was weakened: the harness checks the exact security-attempt reason per refused call (the old file counted rows), its state snapshot now covers every scheduling table plus audit/outbox/idempotency, refusals and own-tenant successes are scanned for the marker and for every alpha fixture reference. The matrix-length self-check of the old file was dropped (it only counted its own pushes). `seedSchedulingScopes` now tolerates `seedPatientScopes` having created the shared synthetic principal a5 (`ON CONFLICT DO NOTHING`). The resources ledger was appended above and its file deleted.

Verification: `corepack pnpm install --frozen-lockfile` exit 0 (lockfile unchanged); before the fold `corepack pnpm test` exit 0, 28 files / 519 tests (342 + 96 + 81); after the fold `corepack pnpm run ci` exit 0, 27 files / 518 tests (the 35 resources-negative tests became 34 harness tests).

### S8 appointment request as a separate fact

Files: `supabase/migrations/20261106000000_appointment_requests.sql`, `packages/domain/src/scheduling/{appointment-base,appointments,requests}.ts`, `apps/api/src/routes/{appointments,appointment-manifest}.ts`, `apps/mcp/src/tools/appointments.ts`, S8 definitions in `packages/contracts/src/scheduling.schema.json`, `tests/integration/appointment-requests.test.ts`, `tests/integration/support/appointment-fixtures.ts`.

Acceptance cases (`appointment-requests.test.ts`, REST under the runtime role):

1. a request is created in `open` (version 1) with no appointment row, no occupancy row, and availability search still offers the requested window; urgency is a boolean flag; the note (carrying the marker) never reaches audit, outbox, attempts, idempotency or logs;
2. the same key replays the same request (`replayed: true`); a second request for the patient is independent; both are listed;
3. inactive and deceased patients are 409 `conflict` with `detail.reason` `patient_inactive` / `patient_deceased` (via `assertPatientSchedulable`), nothing written;
4. another tenant's patient or location is 404 with the same body as a random reference;
5. closing as `scheduled` without `appointmentRef` is 422 (`/appointmentRef` `required`) and changes nothing; review then decline produces three transitions (`null→open`, `open→in_review`, `in_review→declined` with reason) and three audit rows; the declined request is on the unbooked report, an open one is not;
6. `expired` without a configured expiry policy is 422 `expiryPolicyNotConfigured`; with the tenant policy configured, a missing or different `expiryPolicyRef` is 422 and the matching one closes as `expired`;
plus preference updates under `expectedVersion` (stale is 409 `stale_version`) and the stated-preference rule (422 `preferenceRequired`).

Failure cases: (1) a merge re-points an open request to the survivor (registered in `MERGE_RECORD_CLASSES` as `appointmentRequest.subject_patient_id`, listed in merge history) and it stays open; (2) a deactivated location is 422 `/locationRef` `locationInactive`; (3) two concurrent closes of one request give 200 and 409 and exactly one closing transition; (4) reopening needs a reason code (400 without), works from a closed state and is 409 `request_not_closed` from `open`. A location-restricted scheduler gets 403 creating at another location (the location is named by the caller) and 404 reading another location's request (indistinguishable from missing), and never sees it listed.

Negative harness: 8 rows (create, list, read, updatePreferences, review, close, reopen, unbookedReport) x cross-tenant / revoked / downgraded on REST and MCP; the harness state snapshot now covers `appointment_requests` and its transitions.

- Red: `corepack pnpm test -- tests/integration/appointment-requests.test.ts` before implementation: exit 1, 13 failed / 1 passed (the cross-tenant case passed vacuously because the route returned 404 before it existed).
- Green: same command exit 0, 14 passed. `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 28 files / 564 tests.

Deviations: S8, S10 and S11 definitions live in `scheduling.schema.json` (one `scheduling:` drift prefix) instead of separate `appointment-request|booking|attendance.schema.json` files. `linkRequestToBooking` and close-as-`scheduled` need a booking, so they are completed in S10 (until then a named appointment is 404). Operation names are `scheduling.requests.*`. `origin` is a server parameter of `createRequest` (staff routes pass `staff`), never a body field. Other-location requests are 404 for location-restricted readers (the S7 resources returned 403; see the review hardening task).

Unresolved: request reads are not written to the sensitive-read log (no scheduling read-audit decision exists); the request note is free text up to 500 characters with no classification beyond "never copied out of the request row"; there is no automatic expiry job (expiry is an explicit command under the configured policy, as the plan requires).

### S10 booking, holds and the inspectable conflict result

Files: `supabase/migrations/20261106010000_appointment_booking.sql`, `packages/domain/src/scheduling/booking.ts` (plus the link hook in `appointments.ts` and the booking-path attempt recorder in `appointment-base.ts`), S10 definitions in `scheduling.schema.json`, booking routes and MCP tools, `tests/integration/booking-conflicts.test.ts`.

Acceptance cases (`booking-conflicts.test.ts`):

1. two concurrent identical bookings: one 201 `booked`, one 409 `conflict` (`booking_conflict`) listing `resource_overlap` on the provider and the operatory with `existingRef` = the winner (the caller may read bookings); one appointment row;
2. a conflicting booking leaves appointment, occupancy, outbox and audit counts unchanged and exactly one attempt row (`scheduling.appointments.book`, `booking_conflict`);
3. another tenant's patient, provider or operatory: 404 with the same body as a random reference; neither foreign reference appears in the response;
4. outside availability: two overrideable `outside_availability` conflicts; with an override, a caller without `scheduling.override` is 403; a1 with `provider_approved` + reason books, the override row records code, reason, kinds and actor, and audit has the booking and the override record in the same correlation; the same window again with an override is still refused (`resource_overlap` is never overrideable);
5. a hold blocks a booking (conflict names the hold to a reader); after expiry (test-only clock shift on the synthetic hold row) the same slot books without staff action and the hold is `released` with reason `expired`; booking from a hold converts it (hold `converted`, hold occupancy released, appointment occupancy live); a booking longer than its hold is `insufficient_duration`;
6. reschedule with a stale version is 409 `stale_version` with `currentVersion` 1; with the right version the original becomes `rescheduled` (version 2, `rescheduledTo`), the new booking has `rescheduledFrom`, and the original slot is bookable again;
7. cancel records status and reason, releases occupancy, writes the outbox event `{changedFields: [status, notificationIntent]}` and keeps the row; a second cancel is 409 `appointment_not_booked`; the slot books again.

Also: no operatory requires a typed reason (422 `/noOperatoryReason` `required`, and `onlyWithoutOperatory` when both are given) and is stored as `operatory: null`; an inactive patient is a `patient_inactive` conflict; a booking from a request links both records and a reopen is refused (`booking_still_active`) until the booking is cancelled; close-as-`scheduled` links an existing booking (forward and backward link checked in the database); a writer without `scheduling.read` sees `resourceRef` but no `existingRef` and never the winner's reference; a merge re-points a booking; the marker in an invalid body never reaches logs, audit, outbox, attempts or idempotency.

S9 seam (observable condition): for one synthetic day, search returns N windows; booking the first leaves exactly N-1 and excludes it; rebooking it is a conflict; the next window still offered books.

Failure cases: (1) retry under the same key returns the recorded booking (`replayed: true`); (3) two overlapping holds: 201 and 409 `resource_overlap`; reconciliation releases an expired hold (`released` >= 1, reason `expired`); an explicit release records its reason and a second release is 409 `hold_not_active`; (4) a resource deactivated between search and commit is a conflict naming it (`outside_availability`, "The resource is inactive.", not overrideable). Failure case (2) (deadlock retried within a bounded budget): the occupancy insert maps 40P01/40001 to a retryable 409 and never commits a partial booking; a reproducing deadlock test is not included (lock order is deterministic: location, then resources by id, then occupancy rows by resource id), see Unresolved.

Concurrency loop (10 parallel attempts per slot, 5 slots, REST and MCP alternating, runtime role, pool of 12), three repeated runs, each: `[{"loop":0..4,"booked":1,"conflicts":9,"audits":1}]` with 9 `booking_conflict` attempt rows per loop; every conflict named the blocking provider/operatory and the winner. No double booking observed.

Negative harness: 7 rows (book, read, reschedule, cancel, holds create/release/reconcile); the state snapshot covers appointments, holds, live occupancy, overrides and lifecycle events.

- Red: `corepack pnpm test -- tests/integration/booking-conflicts.test.ts` before implementation: exit 1, 19 failed / 1 passed.
- Green: same command exit 0, 20 passed; concurrency case re-run 3 times, exit 0 each. `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 29 files / 612 tests.
- Fixed during green: two audit rows for one resource version (override now audited as its own `appointmentOverride` record); hold conversion released the hold range after inserting the booking (now before); `restore-smoke` found a foreign-key cycle (back-links lost their foreign keys, documented in the migration).

Deviations: the cancel notification intent is the outbox event (no `NotificationIntent` record or `channel: 'none'` row until S14/E exist); conflicts on inactive non-provider resources use `outside_availability` (no dedicated kind exists); booking-from-request links inside the booking transaction (no separate link route; close-as-`scheduled` is the explicit link command); conflict detail uses the shared `Conflict` shape rather than a separate `Denial` object (denials are 403/404 refusals with an attempt row carrying the reason).

Unresolved: no deadlock-reproduction test; override, cancellation and appointment-type vocabularies are proposals; holds carry no patient (S15 offers will reference the hold); appointment reads are not sensitive-read logged.

### S11 attendance, arrival and exception states

Files: `supabase/migrations/20261106020000_appointment_attendance.sql`, `packages/domain/src/scheduling/attendance.ts` (plus the booking guard wired in `appointments.ts`), S11 definitions in `scheduling.schema.json`, attendance routes and MCP tools, `tests/integration/attendance.test.ts`.

Acceptance cases (`attendance.test.ts`):

1. automated confirmation, arrival, in-chair and left-without-treatment are four transitions with sequence, actor and server instant; each earlier prefix of the history is unchanged after later appends; visit status returns the separated facts: booking `booked` v1, attendance `left_without_treatment` with `confirmation: automated`, and `clinicalCompletion` / `billing` as `{ref: null, owner}` placeholders (owners C5 and B1);
2. `confirmed_automated` needs `provenanceRef` (422 otherwise) and records `source: automation`; `confirmed_manual` records `source: staff` and no provenance; the daily worklist counts `confirmedManual` and `confirmedAutomated` separately;
3. a no-show without a reason is 422 `required`, with an unconfigured reason 422 `notConfigured`; with a configured reason and a note it is recorded; the note (carrying the marker) never reaches audit, outbox, attempts, idempotency or logs, and no clinical-note table exists to receive it;
4-5. `treatment_complete`, `completed`, `checked_out`, `billed`, `paid` and extra fields (`clinicalCompletionRef`, `billingRef`, `procedureCodes`) are 400 and write nothing; structurally, recording a transition changes only `appointment_attendance_transitions`, `audit_events`, `outbox_events` and `command_idempotency` (row counts of every table compared), the table columns are exactly the attendance columns, and the runtime role holds only SELECT and INSERT on it;
6. cross-tenant is 404 and read-only is 403, each with one attempt row and no transition;
7. arrival keeps the server instant and the separate client-claimed instant.

Failure cases: (1) `in_care`, `waiting`, `left_without_treatment` before arrival are 409 `attendance_transition_invalid`; after a no-show an arrival is refused too; (2) the same transition under the same key is recorded once (`replayed: true`); (3) a correction is an amendment naming the latest effective transition with a configured reason (422 without), the amended row stays, only the latest effective transition can be amended (409 `amend_latest_only`), and the runtime role cannot UPDATE the table; (4) cancellation is the booking command, which appends `cancelled` with `source: booking_command` in its transaction; recording `cancelled` directly is 422 `useBookingCommand`; afterwards attendance is closed. A started visit (arrived) cannot be cancelled (409 `attendance_started`). The daily worklist returns each booking status, derived attendance state, confirmation kind and operatory, identically on REST and MCP.

Negative harness: 4 rows (record, list, visitStatus, daily worklist); the state snapshot covers attendance transitions. `contract:check` now also requires every S8/S10/S11 request body, list query and nested input to be a closed object.

S10 fix found during this task (full-suite runs): under load, concurrent inserts of overlapping occupancy rows deadlocked inside the exclusion check (40P01) and the victim returned a 409 with an empty conflict list. Fixes: (a) booking and hold commands now lock the named resource rows `FOR NO KEY UPDATE` in id order, so contenders queue per resource and the later contender's pre-check sees the committed winner (deadlock-free; foreign-key KEY SHARE locks of other commands are not blocked; deactivation still serializes); (b) the occupancy insert retries a deadlock victim up to 5 times, then re-reads committed occupancy and, if no winner is visible, returns a retryable conflict naming each contended resource, so a conflict list is never empty. Unit test `packages/domain/src/scheduling/booking-occupancy.test.ts` (3 cases, scripted transaction) covers retry, budget exhaustion and retry-then-23P01. Red evidence for this fix: full `corepack pnpm test` exit 1 twice (concurrency case: `expected 0 to be greater than 0`, then `existingRef undefined`); the unit test was written after the code fix (not seen red). Green: full suite exit 0 three consecutive times; the concurrency case alone 5 consecutive runs, each 5 loops of 1 booked / 9 conflicts / 1 audit.

- Red: `corepack pnpm test -- tests/integration/attendance.test.ts` before implementation: exit 1, suite setup failed (`scheduling_attendance_reasons` missing), 13 skipped.
- Green: same command exit 0, 13 passed. `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 31 files / 644 tests.

Deviations: attendance uses `scheduling.write` / `scheduling.read` (no separate attendance scope exists in the registry); the transition guard table is proposed (not in ADR 0009); `cancelled` and `rescheduled` are attendance kinds appended only by the booking commands; the amendment is an attribute of a transition (`amendsTransitionRef`) rather than an extra kind; the reason vocabulary is a per-tenant table without a write command (tests seed it).

Unresolved: no reinstate command for a cancelled appointment exists (the "reinstated" half of failure case 4 is not implemented; after cancellation attendance stays closed); the transition guards, reason vocabulary and confirmation provenance format need practice review; attendance and worklist reads are not sensitive-read logged.

### Review hardening of S4-S9 (independent review of 1b387f4 / 7929f77)

Test file: `tests/integration/review-hardening-s.test.ts` (11 cases, runtime role, synthetic data). Red: `corepack pnpm test -- tests/integration/review-hardening-s.test.ts` before the fixes: exit 1, 9 failed / 1 passed (the location-wide-block case already held); each failure reproduced the reviewed defect (`allowed` instead of `forbidden:relationship_revoked`; unmerge 500 twice; two equal-tenant match-key sets; crossing relationship adds and crossing merges 500; second unmerge `merge_state_inconsistent`; 403 vs 404 oracle; `existingRef` leaked). The revoked-by freeze case was shown red separately by running it without the new migration (exit 1, 1 failed). Green: exit 0, 11 passed.

REQUIRED

1. Revocation race (fails open). `packages/domain/src/policy/patient-access.ts`: any non-null `revoked_at` is revoked (the revoking transaction's clock can be later than an older evaluating transaction's `now()`), and the evaluation clock is `clock_timestamp()`. Test: the command transaction begins first (`SELECT now()`), the revocation commits through REST on another connection, then the command evaluates under its row lock: denied `relationship_revoked`.
2. Unmerge after a post-merge lifecycle change. Relationship digests exclude `revoked_at`, `revoked_by`, `revoke_reason` (S8/S10 classes already excluded their lifecycle columns); any remaining digest mismatch is a typed 409 `conflict` with `detail.reason` `unmerge_blocked` and `blockingRefs` naming the records (never a 500). Tests: merge B into A moving R, revoke R, unmerge succeeds and R stays revoked under B; a forced content change (superuser fixture path) yields the typed refusal naming R.

SHOULD

3. Match keys: `createMatchKeyer(pepper, tenantId)` = HMAC-SHA-256 over tenant id, prefix and normalized value, truncated to 128 bits; `PatientServiceDeps.matchKeyPepper` is required; `resolveMatchKeyPepper(env, configured)` accepts the test-only pepper only under `synthetic-test` and refuses a missing pepper (or the test pepper) elsewhere; the API reads `CUSPATLAS_MATCH_KEY_PEPPER` (base64, >= 32 bytes). Migration path: no schema change; the pepper is not available to SQL, so rows re-key on their next write; only synthetic rows exist (recorded in `20261106030000_review_hardening_s.sql`). Tests: the same identity in alpha and beta shares no key and no key equals the old bare SHA-256; pepper and tenant both change a key; a short pepper is refused; the MCP server refuses development without a pepper and with the test pepper.
4. Deadlocks: merge relink locks every affected row of each registered table in one statement in id order before updating; `addRelationship` locks subject and counterparty `FOR UPDATE` in id order; unmerge locks the pair before re-reading the merge state; the tenant transaction runner maps 40P01/40001 to a retryable 409 `conflict`. Tests: 6 pairs of concurrent A->B / B->A adds all end 201/409; two merges over crossing relationships both 201; two concurrent unmerges give 200 and 409 `merge_already_reversed`.
5. Same-tenant oracle: `resolveResourceRefs`, `getResource` and `deactivateResource` hide other-location resources as 404; `changeLocationTimeZone` hides a location outside the caller's policy before any lookup; S7/S9 conflicts include `existingRef` only for callers holding `scheduling.read` (probed before the transaction), as S10 does. Tests: a3 (loc-north) gets the same 404 body for another location's resource and for a random one (read, time-zone change, availability search); a time-block conflict names the blocking booking to a1 but not to a writer without `scheduling.read`. Existing expectation changed: `resources.test.ts` other-location read 403 -> 404.

NITS

- `revoked_by` is frozen once revoked (guard trigger replaced in `20261106030000_review_hardening_s.sql`; test: even the fixture superuser cannot rewrite it).
- Age-of-majority check in `addRelationship` uses the database clock (`clock_timestamp()`), not the app clock. The window pre-check before the transaction still uses the app clock (documented; it only validates input shape).
- `createTimeBlock` locks named resources `FOR SHARE` (serializes with deactivation and with bookings, which hold them `FOR NO KEY UPDATE`).
- Concurrency test: a location-wide block and a booking at the same location and window, 5 rounds in parallel: always one 201 and one 409 (passed before the change too; it is evidence for the S7 FOR UPDATE / S10 FOR SHARE design).
- Not done: computing the age-of-majority instant in the practice or patient zone (still UTC midnight; tenants carry no zone and patient zone is optional). Recorded as unresolved.

Existing tests updated for the new rules: `patient-merge.test.ts` digest expression (revocation columns excluded) and two direct `createPatientService` constructions (explicit test pepper); `mcp-parity.test.ts` development build passes a configured pepper and asserts both refusals.

Verification: `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 32 files / 655 tests.

### Batch 2 gate

`corepack pnpm run ci` at 427979e: exit 0 (typecheck, lint, contract drift, 32 files / 655 tests, privacy scan of 222 tracked files and the artifacts, SBOM 270 components, evidence manifest and verification: unreviewed, not certified). Re-run on the commit containing this entry. Nothing here is approved, deployed, compliant or clinically validated; every ADR 0003 / ADR 0009 item and every proposed vocabulary (override, cancellation, attendance transitions and reasons) remains recommended-pending-approval.

## Batch 3 (S12-S17, branch `codex/scheduling-patients`)

Base: 4b1a2e2 (655 tests). `origin/main` d2610d8 (docs only: PRACTICE-TIME-AND-AUTOMATION.md and plan additions) merged first as cdf756c. Every S12-S16 operation is declared once in `apps/api/src/routes/scheduling-ops.ts` (`SCHEDULING_OPS`: route contract, MCP tool name, domain call); REST registration, MCP tools, the closed-body drift check and the OpenAPI entries are derived from it.

### S12 appointment visit context

Files: `supabase/migrations/20261107000000_visit_context.sql`, `packages/domain/src/scheduling/visit-context.ts`, `packages/domain/src/scheduling/ext-codecs.ts`, S12 definitions in `scheduling.schema.json`, `apps/api/src/routes/scheduling-ops.ts` + `scheduling-ops-routes.ts`, `apps/mcp/src/tools/scheduling-ops.ts`, `tests/integration/visit-context.test.ts`, `tests/integration/support/domain-harness.ts`.

Design: the context is a container of references. Producer port `VisitContextProducers` (domain `SchedulingDeps.visitContextProducers`) per item: medical history (C8), forms (C13; intake forms are E4), note drafts (C10), lab cases (C16), treatment-plan items (C11). No producer is deployed, so through REST/MCP every item is `{status: 'unavailable', owner, reason: 'producer_not_deployed'}` and `readiness.complete` is false; unavailable never counts as resolved. Commands bound to an absent producer are 409 `conflict` `producer_unavailable` (checked before the idempotency handler, so a later deployment is not answered from a stored refusal) and write nothing. `visit_context_items` holds producer references, the pinned version and provenance reference only (column list asserted), with runtime SELECT/INSERT and column UPDATE of the end fields only; a guard trigger allows only active -> ended once by the acting principal; the pin is immutable.

Acceptance cases through the deployed transports (`visit-context.test.ts`): 5 (every item unavailable with owner and reason; REST = MCP), the producer-bound commands refused 409 with one attempt row and no write, 4 (cross-tenant and other-location 404 identical to missing; malformed ref 404), 6 (cancelled context readable and marked `acceptsChanges: false`), read-only member reads but cannot assign (403), the structural reference-only column list and grants.

Container mechanics against a synthetic producer stub injected at the domain port only (not a C producer): pin names the captured version and survives a later producer version; a second pin 409 `already_pinned`; 2 (same form twice -> one row, `created` true then false; unassign needs a reason and stays in history); 3 (lab case bound elsewhere 409 `lab_case_bound_elsewhere` naming the other appointment only when the caller may see it; relink ends the old binding naming the new one and the new one names the old); 4 (another tenant's producer record is 404); failure 1 (voided record resolves `voided`, never omitted; readiness incomplete); failure 2 (a fault after the write rolls back the item, audit and outbox); failure 3 and 6 (a cancelled appointment keeps its active forms and refuses a new assignment `appointment_not_open`).

Open (it.todo, blocked on C): C8 real pin with provenance; C8 change produces a new version; C13 real form assignment; C10 note drafts; C16 real lab case and foreign-tenant case; C11 treatment-plan items. The visit-workspace claim stays open until these pass.

- Red: `corepack pnpm test -- tests/integration/visit-context.test.ts` before implementation: exit 1, 12 failed / 1 passed / 6 todo (the cross-tenant case passed only because the route did not exist).
- Green: same command exit 0, 13 passed / 6 todo. `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 33 files / 696 passed / 6 todo.
- Harness: 7 rows added (`visitRows()`); the state snapshot covers `visit_context_items`. Explicit lists updated: MCP tool names (`mcp-parity.test.ts`), RLS table list (`tenant-isolation.test.ts`).

Deviations: patient status is not part of the context projection (a scheduling reader without `patients.read` must not learn deceased/merged; the patient reference only). Form ownership is named C13 although intake forms are E4; the owner string is one value per item. Reads are not sensitive-read logged (as S10/S11).

### S13 recurrence series with a deliberate cap

Files: `supabase/migrations/20261107010000_appointment_recurrence.sql`, `packages/domain/src/scheduling/recurrence.ts` (the S10 insert path lifted to `insertBookingIn` in `booking.ts`), S13 definitions in `scheduling.schema.json`, `limit` and `occurrences` on the shared refusal detail (`context.ts`, `synthetic-task.schema.json`), five `SCHEDULING_OPS` rows, `tests/integration/recurrence.test.ts`.

Rules (ADR 0009, all recommended-pending-approval): per-request limit `scheduling.series.occurrenceLimit` = `scheduling_policy_settings.series_occurrence_limit` (default 26, CHECK 1-52); the configuration ceiling 52 is also the schema maximum of `count` (53 is a 400); continuation only through `extendSeries`. The plan leaves atomic vs partial open only as "a documented flag may create only the conflict-free occurrences": implemented as atomic by default plus `skipConflicts: true`. Month-end S-S3-R1 (`occurrenceDate`: anchor kept, last day of a short month). Daylight saving S-S3-R2 through the existing `localToInstant` (compatible disambiguation), with the location's zone (the series takes no client zone).

Acceptance cases: 1 (26 creates 26 individually readable bookings at version 1; 27 is 422 `validation_failed` `series_limit_exceeded` with `detail.limit = {name: 'scheduling.series.occurrenceLimit', value: 26}` and zero rows in series, occurrences, appointments and audit; 53 is 400); 2 (rescheduling occurrence 2 and cancelling occurrence 3 leave occurrence 1 at version 1; the series shows exceptions `[2, rescheduled]`, `[3, cancelled]` and follows the reschedule chain to the standing booking); 3 (plan returns per-occurrence conflicts and the limit `{value 26, ceiling 52}`; series, appointments, audit, idempotency and outbox counts unchanged); 4 (a later conflict refuses the whole series with `detail.occurrences` naming occurrence 3 and its start, no appointment written; with `skipConflicts` 3 created + 1 skipped (`resource_overlap`) = 4 requested, recorded as a `skipped` occurrence); 5 (2031-01-31 -> 02-28 -> 03-31 -> 04-30; 2032-01-31 -> 02-29 -> 03-31); 5b (America/New_York 02:30 on 2031-03-02/09/16 -> 07:30Z, 07:30Z (03:30 EDT), 06:30Z; 01:30 for 60 minutes on 2031-10-26/11-02/11-09 -> 05:30-06:30Z, 05:30-06:30Z (first 01:30, ends 01:30 EST), 06:30-07:30Z); 6 (same key replays the same series and occurrence refs, no new appointment); 7 (another tenant reads 404, creating with a foreign provider is 404, no appointment references a foreign resource).

Failure cases: 1 (a fault after the last occurrence is written rolls back series, occurrences, appointments, audit and outbox); 2 (limit lowered to 10: the existing 12-occurrence series is untouched, a new 11 and an extension of 11 are refused naming 10); continuation (`extend` books occurrences 3-4 from where the series stopped, version 2; a stale version is 409 `stale_version`); 3 (S7 refuses deactivating a provider with future bookings (409), so the provider leaves through an availability version with no hours: extending is a 409 booking conflict; `endSeries` sets `ended` and returns the still-booked future occurrences in `openOccurrenceRefs` for explicit reassignment, nothing is cancelled; extending an ended series is 409 `series_not_active`); 4 (two concurrent creations of the same slots: one 201 and one 409 whose `occurrences` are 1, 2 and 3; exactly 3 appointments on the provider).

Found and fixed during green: a refused series' per-occurrence detail exceeded the 2 KiB idempotency result bound (500). Series conflicts are now `replayable: false` (new `RefusalInit.replayable`, honoured by `executeOnce`): a resource conflict another command can clear is neither stored nor replayed, so a same-key retry is evaluated again. Terminal validation refusals (the limit) are still stored.

- Red: `corepack pnpm test -- tests/integration/recurrence.test.ts` before implementation: exit 1, 13 failed.
- Green: same command exit 0, 13 passed. `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 34 files / 729 passed / 6 todo.
- Harness: 5 rows (`seriesRows()`, fixture series `alphaSeries`); snapshot covers series, occurrences and exceptions. Merge registry: `appointment_series.subject_patient_id` registered (`appointmentSeries`).

Deviations: overrides are not available for series occurrences (no override field); `count` per request counts skipped occurrences too; S-D1/R1/R2 remain recommended-pending-approval.

### S14 notification intent separated from booking

Files: `supabase/migrations/20261107020000_notification_intents.sql`, `packages/domain/src/scheduling/notification-intent.ts`, `packages/domain/src/work-items/index.ts` (proposed shared work-item model), S14 and `WorkItem`/`WorkCoverage`/`WorkItemList` definitions in `scheduling.schema.json`, two `SCHEDULING_OPS` rows, `docs/integrations/notifications-qualification.md` (S-S2: every channel row `unknown` with an owner role, no vendor), `tests/integration/notification-separation.test.ts`.

Design: `insertBookingIn` (book, reschedule, series occurrence) records one `reminder` intent and `cancelAppointment` one `cancellation` intent, in the command transaction, `channel: 'none'`, delivery key `<purpose>:<subjectRef>` (unique per tenant), policy `notification-intent-pending-approval-1`. A reschedule's reminder and a cancellation supersede the earlier reminder (`superseded_intent_id`; the table is append-only). `suppression_decision_ref` is a NULL placeholder: the decision is E6's and is reported as `{ref: null, owner: 'E6', state: 'undecided'}`; delivery is reported as `{owner: 'E7', state: 'not_sent_no_verified_channel'}`. No send path, no consent read.

Acceptance cases: a booking records exactly one intent (`reminder`, `none`, placeholder decision, `reminder:<ref>`), the delivery-receipt count is unchanged, and the worklist shows it as a work item (`notification_without_channel`, `no_verified_channel`, evidence = the appointment, queue `front_desk`, owed by `practice`, due = the appointment start, `contact_patient_manually`, blocked on `S-S2`, `E6`, `E7`); 6 (cancel records one `cancellation` intent superseding the reminder; the worklist lists the cancellation and no longer the reminder; no send); reschedule (one reminder for the new booking superseding the old one, none for the old); a series of 3 records 3 intents and a same-key replay none; 5 (structural: every SQL statement of a book, reschedule and cancel run under a capturing runtime-role transaction runner is free of `consent|opt_out|suppression_decision|quiet_hours`; no table named like consent, opt-out or suppression exists; the intent column list is fixed; the module source reads no consent table).

Failure cases: 1 (a conflict refusal and a fault after the handler both leave no intent); 2 (an intent without a decision is `undecided`, NULL decision reference, channel none, and listed); cross-tenant 404 and absent from the beta worklist; a3 (loc-north only) sees north's intents and gets 404 for another location's intent; REST and MCP worklists list the same items; coverage `available`.

Open (it.todo, owned by E): E6 suppressed decision with reference and reason; E7 exactly-once delivery through the fake provider; opt-out between intent and delivery; E6 vocabulary for missing contact data vs quiet hours; E6 suppression of intents derived from a cancelled appointment; E7 withdrawn template and post-acceptance crash reconciliation.

- Red: `corepack pnpm test -- tests/integration/notification-separation.test.ts` before implementation: exit 1, 8 failed / 6 todo.
- Green: same command exit 0, 8 passed / 6 todo. `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 35 files / 745 passed / 12 todo.
- Existing test updated: `booking-conflicts.test.ts` case 4 audit rows now include the booking's `notificationIntent` row (same correlation).
- Harness: 2 rows (read, worklist as `tenant_own_data`); snapshot covers `notification_intents`.

Deviations: purpose `cancellation` is added to the plan's `NotificationIntent.purpose` enum (`reminder | waitlist_offer | recall`), because the plan's case 6 records a cancellation intent; the S10 cancel outbox event (`changedFields: [status, notificationIntent]`) is kept and the intent row now exists beside it; the intent subject is the appointment (not the patient), so no patient reference needs merge registration.

### S15 waitlist, with PT-02 cancellation recovery

Files: `supabase/migrations/20261107030000_waitlist.sql`, `packages/domain/src/scheduling/waitlist.ts`, `packages/domain/src/scheduling/waitlist-offers.ts`, hold helpers lifted in `booking.ts` (`createHoldIn`, `convertHoldIn`, `releaseHoldIn`; `expireHolds` now expires the offer of an expired hold), S15/PT-02 definitions in `scheduling.schema.json`, 13 `SCHEDULING_OPS` rows, `tests/integration/waitlist.test.ts`, `tests/integration/cancellation-recovery.test.ts`.

Rules (ADR 0009 S-D6, recommended-pending-approval): an offer is a hold (occupancy `hold`) whose TTL comes from the per-location `scheduling_offer_policies` row (no row, no offer: 409 `offer_policy_missing`, not replayed); the offer has an outcome (`accepted | declined | expired | withdrawn`) and only `scheduling.waitlist.respond` with `accepted` books, through `insertBookingIn` from the hold (hold `converted`). A hold that belongs to a live offer cannot be booked through `bookAppointment` or released through `releaseHold` (409 `hold_belongs_to_offer`). Expiry by any path (lazy release in a booking, `holds.reconcile`, `waitlist.reconcileOffers`) records `expired` / `hold_expired` and reopens the entry. One live offer per entry (partial unique index); one live offer per slot is the exclusion constraint of the hold occupancy. Each offer records a `waitlist_offer` intent with channel none.

Acceptance cases (`waitlist.test.ts`): 1 (adding an entry leaves appointments, holds and occupancy counts unchanged); 2 (offer hold with an expiry of about 15 minutes; a second offer of the same range is 409 `booking_conflict` naming the first hold; the intent is `waitlist_offer`, channel none, subject = the offer); 3 (after a test-only clock shift on the hold, the service principal reconcile records `expired` / `hold_expired`, the entry is `active` again and a direct booking of the slot succeeds); 4 (a patient already booked elsewhere in the window: 409 with a `patient_unavailable` conflict); 5 (another tenant: offering an alpha entry and adding an entry at an alpha location are 404, the beta list holds no alpha entry); 6 (an offer left alone ends `expired` with no appointment for the patient). Observable condition: one slot offered to entry 1 (priority 1) while entry 2 cannot be offered; declined (hold `released` / `offer_declined`); re-offered to entry 2 and accepted: one booked appointment for the slot (count asserted), hold `converted`, entry 1 `active`, entry 2 `booked`; REST and MCP list the same entries.

Failure cases: 1 (a fault after the handler leaves no offer, hold, occupancy or intent); 2 (accepting after the hold expired in flight is 409 `offer_expired`, no appointment); 3 (merging the patient of an entry into a duplicate relinks the entry to the survivor; `waitlist_entries.subject_patient_id` registered as merge class `waitlistEntry`); 4 (a location without an offer policy is 409 `offer_policy_missing`); removal is explicit with a reason and a live offer must be answered first (409 `offer_pending`).

PT-02 cancellation recovery (`cancellation-recovery.test.ts`; requirement from docs/PRACTICE-TIME-AND-AUTOMATION.md): cancelling a future booking opens a `cancellation_recoveries` row in the cancel transaction; `scheduling.recovery.list` returns work items (`cancellation_recovery`, `slot_freed_by_cancellation`, queue `scheduling`, due = slot start, `review_waitlist_candidates`); `scheduling.recovery.read` prepares ranked candidates (priority, then age) and explains exclusions (`duration_exceeds_slot`, `outside_desired_window`, `provider_mismatch`, `patient_not_schedulable`, `patient_already_booked`, `offer_pending`, `entry_expired`), with consent as the E6 placeholder `{owner: E6, state: undecided}` and the automation mode. Mode prepare-for-approval (default): a person executes the prepared offer (`scheduling.recovery.execute` with `entryRef`); the invitation is a hold plus an intent, writes no attendance and no appointment until accepted; acceptance fills the recovery (it leaves the list). Policy-authorized: a service principal without a live standing policy is 403 `standing_policy_required` and writes nothing; a person with `admin.configure` grants a policy (owner = granter, grantee = one service principal, operation `scheduling.recovery.execute`, location scope, `maxOffersPerRecovery`, expiry at most 90 days; a service principal cannot grant); the service principal execution picks the first prepared candidate and the offer records the policy reference and version 1; the limit refuses a second offer for the same recovery (409 `standing_policy_limit`); after revocation, and after expiry, execution is 403 `standing_policy_required`; two concurrent executions for one recovery give one 201 and one 409 (`stale_version`, recovery row lock) and one live offer; cross-tenant list, read and execute are 404 or absent; REST and MCP read the same recovery.

- Red: `corepack pnpm test -- tests/integration/waitlist.test.ts` before implementation: exit 1, suite setup failed (`scheduling_offer_policies` missing), 12 skipped; `corepack pnpm test -- tests/integration/cancellation-recovery.test.ts`: exit 1, setup failed, 8 skipped.
- Green: both files exit 0, 20 passed. Fixed during green: test fixtures only (the hold clock shift must bump the hold version; the policy expiry shift disables the guard trigger for one statement as the fixture superuser; the policy test asserts the first prepared candidate, because earlier entries of the shared location rank first).
- `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 37 files / 817 passed / 12 todo.
- Harness: 13 rows (`waitlistRows()`), with a fixture offer policy, live offer, idle entry, recovery and standing policy; the snapshot covers entries, offers, recoveries and standing policies.

Deviations: offer answers are recorded by staff (no portal path until E3/E5). Offer delivery is an intent with channel none (no send). The waitlist entry has no flexibility vocabulary beyond the desired window, duration, provider preference and priority. Standing policies are a minimal S-owned record (proposed shared contract; A owns standing-policy registration per PRACTICE-TIME-AND-AUTOMATION.md); they do not reuse the F proposal tables, which are bound to the synthetic task operations. The automation mode in a recovery read reports any live policy for the location, not only one naming the reader.

### S16 recall policy and due worklists, with the PT-03 follow-up worklist (S part)

Files: `supabase/migrations/20261107040000_recall.sql`, `packages/domain/src/scheduling/recall.ts`, `attendanceStatesOf` in `attendance.ts`, S16 definitions and `WorkItemList.notCovered` in `scheduling.schema.json`, six `SCHEDULING_OPS` rows, `tests/integration/recall.test.ts`.

Rules (ADR 0009 S-D7, recommended-pending-approval): a policy is a versioned row per tenant and category (interval in months, basis, optional appointment types, already-booked exclusion default on); each definition of a category is the next version. Implementable basis `attended_visit`: the latest booking at or before the as-of instant whose derived S11 attendance is `arrived`, `waiting` or `in_care` (a no-show or left-without-treatment visit does not qualify). The due date is the visit date in its own zone plus the interval (month-end clamped as S-S3-R1). The completed-procedure basis is refused (409 `basis_unavailable`): **blocked on C14**. The due computation reads stored state only, writes nothing, states the policy (with version) and `freshness = {computedAt, basis: computed_from_stored_state, sourceAgeSeconds: 0}` (it is computed on read, never a cached projection). Visibility: a tenant-wide caller sees every unmerged patient; a location-restricted caller (or a query naming a location) sees only patients with a booking at its locations and only events and bookings there.

Acceptance cases: 1 (a patient past the interval is due with the visit as `lastEventRef`; a patient with a future booking is `excluded` / `already_booked` with the rule on, and due with `exclusionNotApplied: already_booked` under a policy with the rule off); 2 (a patient with no visit and a patient whose only visit was not attended are in `noBaseline`, not in `due`, and `counts.due` equals the due rows); 3 (two computations for the same as-of and version are identical except `freshness`; MCP returns the same rows); 4 (computing leaves tasks, intents, appointments, audit, outbox and idempotency counts unchanged; `createTask` writes a task at policy version 1, one `recallTask` audit row and a `recall` intent with channel none); 5 (a3, restricted to loc-north, naming loc-recall is 403; without a location it sees no loc-recall patient; another tenant asking for the category is 404); 6 (deceased and inactive patients are excluded as `patient_deceased` / `patient_inactive`); the completion basis is refused.

Failure cases: 1 (redefining a category makes version 2; the list under version 2 differs; the task created under version 1 keeps `policy_version` 1; creating with the old expected version is 409 `stale_version`); 2 (freshness basis and age are stated with the explicit as-of); 3 (a task whose patient books afterwards stays open, is flagged `patient_booked_since_task` / `resolve_task` in the follow-up worklist, and is resolved with a reason, never deleted); 4 (creating the same task twice under one policy version returns the recorded task with `created: false`); a patient who is not due cannot be given a task (409 `not_due`).

PT-03 (S part) follow-up worklist `scheduling.followUp.worklist`: open recall tasks (`recall_task_open`; reasons `recall_contact_due`, `patient_booked_since_task`, `patient_merged`; queue `recall`; due at the due date), open or in-review requests (`request_unbooked` / `request_open_unbooked`, `offer_appointment`, urgent requests flagged urgent), and scheduled requests whose booking was cancelled or ended in a no-show without a rebook (`request_booking_lost` / `linked_booking_cancelled` or `linked_booking_no_show`, `rebook_or_close_request`; this also covers the batch-2 review finding about orphaned scheduled requests). `notCovered` lists accepted-unscheduled treatment (C11), lab returns (C16) and referral responses (C17) as `producer_not_deployed`, so the list never presents those areas as empty. Test: both request items appear with their kinds and reasons, the three C areas are listed, and a3 (loc-north) sees none of the loc-recall items.

- Red: `corepack pnpm test -- tests/integration/recall.test.ts` before implementation: exit 1, 13 failed / 1 todo.
- Green: same command exit 0, 13 passed / 1 todo (C14). `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 38 files / 854 passed / 13 todo.
- Harness: 6 rows (`recallRows()`; the due row uses a category only alpha defines), fixture policy, attended visit and open task; snapshot covers alpha recall policies and recall tasks.

Deviations: synthetic visits are dated in 2030 (bookings refuse a past start), so every computation passes an explicit as-of instant; the qualifying-event rule (attended visit) and the population rule for restricted callers are proposals; `recall_tasks.subject_patient_id` is a deliberate merge exclusion (a task stays with its identity, is flagged `patient_merged` and recall is recomputed for the survivor) because the one-open-task-per-patient-and-policy index could collide on relink; recall reads are not sensitive-read logged. Open: the C14 completion basis (it.todo).

### S17 workstream parity, negative matrix, ordinary day, export round trip and downtime runbook

Files: `tests/integration/scheduling-parity.test.ts`, `tests/integration/scheduling-export.test.ts`, `tests/scenarios/ordinary-day-scheduling.test.ts` (run by the integration project, which now includes `tests/scenarios/*.test.ts` so the scenario shares the one embedded database server), `packages/domain/src/scheduling/export.ts` (`scheduling.export`), `packages/db/src/scheduling-import.ts` (`importSchedulingExport`), `SCHEDULING_EXPORT_FORMAT` / `SCHEDULING_EXPORT_TABLES` in contracts, `docs/runbooks/downtime-scheduling.md`, the negative-harness export row, `a5` (no patient or scheduling scope) in the appointment harness. OpenAPI entries for every `SCHEDULING_OPS` row were added per task by the generator and drift-checked (`contract:check` exit 0).

Parity matrix (`scheduling-parity.test.ts`): the S operation list is derived from the route manifest (`patients.*`, `scheduling.*`) and the registered MCP tools; the first case fails if any route lacks a tool or any tool lacks a route. Every one of the **77** S operations is attempted on both surfaces under the runtime role: (1) by a member without patient or scheduling scopes: identical 403 `forbidden` and exactly one `scope_missing` attempt row on REST and on MCP (77/77); (2) by an authorized member with an unknown body or query property or a random reference: identical typed outcome on both surfaces (57 x 400 `invalid_request`, 15 x 404 `not_found`, 5 parameterless reads 200 = 200). Worker path: none; no S operation is executed by the outbox worker (its policy denies unknown operations) and automated S execution runs through REST/MCP under a service principal and a standing policy (PT-02). The matrix is printed by the test run (`S PARITY MATRIX (77 of 77 operations)`).

Negative harness: every S12-S16 command and the export have rows (S12 7, S13 5, S14 2, S15/PT-02 13, S16 6, S17 1 = 34 new rows; 77 commands, 234 harness tests); each is attempted cross-tenant, with a revoked membership and with a downgraded role on REST and MCP, with the state snapshot extended to every new table.

Ordinary day (`tests/scenarios/ordinary-day-scheduling.test.ts`, 8 steps, REST and MCP, runtime role): location and resources configured; five patients registered and a guardian relationship recorded through MCP; an appointment request, an availability search and a booking from the request; a double booking refused with the conflict naming the booking; further bookings and a reschedule; check-in through confirmed, arrived, waiting and in care (visit status keeps clinical completion `null`), a left-without-treatment visit and a no-show through MCP; a cancellation recovered (prepared candidate, offer as hold plus intent, acceptance books); end of day: the daily worklist shows the separated attendance states, the recall due list (one attended patient due, no-show and new patients in no-baseline), notification work items (all `no_verified_channel`, zero delivery receipts), the follow-up worklist (with the three C areas not covered) and the export (6 appointments). Assertions: no overlapping live occupancy anywhere; structurally the scenario source contains exactly two superuser writes, the configuration rows that have no command yet (attendance reasons, offer policy); every other write goes through the transports.

Export round trip (`scheduling-export.test.ts`): `GET /v1/scheduling/export` (MCP `scheduling_export`) returns `cuspatlas-scheduling-export/1` with one row array per S table (32 tables in foreign-key order, deterministic order, no `tenant_id`, no tenant identifier anywhere); REST and MCP equal; a member without `admin.configure` and a location-restricted member are 403; another tenant exports only its own rows. `importSchedulingExport` (privileged, synthetic database names only, known format and tables only, one transaction with `session_replication_role = replica` for in-table self-references) loads the export into a freshly migrated synthetic database with seeded tenancy; the export taken from the target through the API is identical to the source export (every identifier preserved), and a booking read by its reference through the target API equals the source read. An unknown format version is refused. This is the S-scope check; M1 owns the full export contract, manifest, completeness validation and the migration import.

Downtime runbook: `docs/runbooks/downtime-scheduling.md` (proposed): read-only continuity from retrieved worklists and work lists, manual downtime numbering, no second write path, reconciliation through the ordinary commands (`claimedAt` for paper times), verification by counts; not exercised in a real outage.

- Red: `corepack pnpm test -- tests/integration/scheduling-parity.test.ts tests/integration/scheduling-export.test.ts tests/scenarios/ordinary-day-scheduling.test.ts` before the export operation existed: exit 1, 6 failed / 72 passed / 4 skipped (export suite setup failed on the missing import; the parity probe exposed a REST/MCP difference for parameterless GETs, fixed in the test by sending unknown properties only to GETs that have a query definition; the scenario failed on the missing export).
- Fixed during green: a second vitest project for scenarios started a second embedded server and crashed a worker; scenarios now run in the integration project. The export fixture offer body carried `timeZone` (400, closed schema). The export harness row uses `own_tenant_only`, because the beta export legitimately contains the marker the harness wrote into beta.
- Green: the three files exit 0 (78 + 5 tests). `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 41 files / 941 passed / 13 todo.

### Review hardening of S8-S11 (independent review of 4b1a2e2; no MUST-FAIL)

Test file: `tests/integration/review-hardening-s2.test.ts` (12 cases, runtime role, synthetic data); `booking-conflicts.test.ts` 10 x 5 loop tightened; `attendance.test.ts` updated for SHOULD 3.

1. Replay preempted by validation: `bookAppointment` and `rescheduleAppointment` now run `prepareWindow` (window, duration, start-in-future, resource resolution) inside the idempotent handler, as `holdSlot` does. Tests: a same-key booking retry after its start passed returns the recorded booking (201, `replayed: true`, same reference); a same-key reschedule retry after the new start passed returns the recorded result (200, replayed); a same-key retry with a different, invalid window is 409 `idempotency_conflict` (was 422); booking-specific same key with a different valid payload is 409 `idempotency_conflict`.
2. Stored conflict detail: booking resource conflicts (`bookingConflict`) are `replayable: false` (not stored, so a conflict cleared by a cancellation books on the same-key retry: test); refusals that are still stored (validation, other terminal conflicts such as S7 time-block conflicts) are stored without the visibility-filtered `existingRef` (`withoutVisibilityRefs` in `execute-once.ts`), so a caller downgraded after the first attempt never sees a reference on replay (test, and no stored row contains `existingRef`). Decision: resource conflicts are not terminal; validation refusals stay terminal.
3. Confirmation provenance: `confirmed_automated` requires a service principal and `confirmed_manual` a person (403 `forbidden`, attempt reason `principal_kind_denied`; tests for both refusals and for the service principal recording `source: automation`). S11 tests now record automated confirmations as the service principal.
4. Orphaned requests: scheduled requests whose booking was cancelled or ended in a no-show without a rebook appear in the follow-up worklist as `request_booking_lost` with `linked_booking_cancelled` / `linked_booking_no_show` (implemented and tested with S16 / PT-03). `unbookedReport` is unchanged (terminal requests without a booking).
5. Expired-hold mismatch: `createTimeBlock` reaps expired holds on its resources before the pre-check (as every booking path does), and a 23P01 with no visible occupant names the contended resources, so the conflict list is never empty. Test: a time block over an expired, unreaped hold is created and the hold is `released` / `expired`.
6. Concurrency tests: the 10 x 5 loop distinguishes terminal (names the winner, `retryable: false`) from retryable (no winner visible, `retryable: true`, resources only) 409s and asserts no booking conflict is stored as a replayable refusal; hold conversion vs release (5 rounds: exactly one wins, state consistent), conversion vs reconciliation of an expired hold (3 rounds: 409 and `released` / `expired`, never a booking), reschedule vs a booking into the vacated slot (5 rounds: no overlapping live occupancy), cancel vs an attendance transition (5 rounds: exactly one succeeds).

Nits: conflict explanations no longer reveal patient status to a caller without `patients.read` (generic `patient_unavailable`, "The patient cannot be scheduled."; test with the service principal downgraded); with `patients.read` the specific kind stays. Not changed, decided and recorded: hold ownership (any member with `scheduling.write` at a visible location may convert or release a hold; a waitlist offer hold only through the offer response); refusing `arrived` / `no_show` for appointments starting beyond a tolerance in the future (not implemented: every synthetic fixture is future-dated because bookings refuse a past start, and a tolerance needs a clock seam; recorded as unresolved); a single lock order request -> appointment -> patient across close, reschedule and merge (not changed: no deadlock reproduced; the order in force is location -> request -> hold -> resources -> patient for bookings and is documented here).

- Red: `corepack pnpm test -- tests/integration/review-hardening-s2.test.ts tests/integration/booking-conflicts.test.ts` before the fixes: exit 1, 9 failed / 23 passed (each failure reproduced a reviewed defect: 422 on replay after start, 422 instead of `idempotency_conflict`, 409 replayed after the blocker was cancelled, `existingRef` in the replay, human automated confirmation accepted, 409 for a time block over an expired hold, patient status in the explanation, 19 stored booking conflicts).
- Green: the hardening file exit 0 (12 passed), `booking-conflicts` and `attendance` exit 0. `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 42 files / 953 passed / 13 todo.

## Workstream S handoff (batch 3 close)

Honest status: everything below is **tested on the Windows host against embedded PostgreSQL 17 with synthetic data only**. Nothing is approved, deployed, compliant, clinically validated or production-ready; no real patient data, cloud connection or outbound message was involved. Every decision record (ADR 0003, ADR 0009) is recommended-pending-approval.

### Built (S4-S17)

- S4-S6 patient identity, relationships, duplicate review, merge and unmerge; S7 resources, operatories and time blocks; S8 appointment requests; S9 availability search; S10 booking, holds and the inspectable conflict result; S11 attendance (batches 1-2, see above).
- S12 visit-context container (references only; every producer-bound item explicit `unavailable`); S13 recurrence series with the cap, explicit continuation, atomic or documented partial creation, month-end and DST rules; S14 notification intents (channel `none`, E6 placeholder, no send, structural no-consent test) and the S-S2 qualification note; S15 waitlist offers as holds with explicit acceptance; PT-02 cancellation recovery with prepare-for-approval and the standing-policy gate; S16 recall policy, due list and recall tasks; PT-03 (S part) follow-up worklist; S17 parity matrix (77 operations), negative harness (77 commands, 234 tests), ordinary-day scenario, export round trip, downtime runbook; review hardening of S8-S11.
- Single operation table for S12-S17 (`SCHEDULING_OPS`), proposed shared work-item model (`packages/domain/src/work-items/`) and standing-policy record.

### Pending approval (no reviewer available)

ADR 0003: S-S1 identity matching and merge workflow, S-D2 merge reversibility, S-D3 candidate presentation, S-D4 guardian and proxy terms, S-D8 patient scope. ADR 0009: S-D1 recurrence cap (26 / ceiling 52 / explicit continuation), S-D6 offer hold semantics and duration (synthetic 15 / 30 / 1440 minutes in tests only), S-D7 recall basis and exclusion default, S-S3-R1 month-end rule, S-S3-R2 daylight-saving rule, S-S3-R3 search horizon. Plan S-D5 first-release channels (recommended intent-only). Proposed vocabularies and rules: override policy, cancellation reasons, attendance transition guards and reason vocabulary, confirmation provenance, recall qualifying event (attended visit) and restricted-caller population, waitlist ranking (priority then age) and exclusion reasons, standing-policy limits (1-3 offers, 90 days), notification policy reference, work-item kinds and next actions, downtime procedure.

### Blocked on discovery or another workstream

- S-S2 notification channels: every channel `unknown` (no vendor); E7 delivery blocked; S14 runs with channel `none`.
- C8, C10, C11, C13, C16 producers: S12 producer-bound cases (6 it.todo) and the visit-workspace claim stay open.
- C14 completed procedures: S16 completion basis refused (`basis_unavailable`, 1 it.todo).
- C11, C16, C17: PT-03 accepted-unscheduled treatment, lab returns and referral responses (reported as `notCovered`).
- E6 consent and suppression: decision placeholder `undecided` (6 S14 it.todo for E6/E7); E1/E3/E5 portal paths for requests, offer answers and messaging.
- A: standing-policy registration and adoption of the work-item model (both S-owned proposals for now); AI evaluation gates (no model in S).
- M1: full export contract, manifest and completeness validation (S export is the minimal round-trip check); M import pipeline.
- F worker: no S operation runs on the outbox worker; S automation runs through REST/MCP under a service principal.
- Deployment (ADR 0002): roles, maintenance, protected storage for downtime lists, sensitive-read logging of scheduling reads (not implemented for appointment, attendance, recall and worklist reads; the export is logged).

### Unresolved inside S

No deadlock-reproduction test (S10); no reinstate command for a cancelled appointment (S11 failure 4 half); no arrival tolerance for future appointments; age of majority computed at UTC midnight; recall tasks are merge-excluded (flagged `patient_merged`); appointment-type rules are not modelled; per-tenant configuration commands are missing for attendance reasons, offer policies and series limits (fixtures write them).

### Practice-time and usability requirements (docs/PRACTICE-TIME-AND-AUTOMATION.md)

- Consumed: PT-02 (cancellation recovery: provider, resource, duration, window and booking checks; consent referenced as E6; race-safe offers as holds; recorded intents with channel none; invitation is not attendance; prepare-for-approval default; policy-authorized execution under a revocable standing policy rechecked at execution and recorded); PT-03 S part (recall tasks and unbooked or lost-booking requests with owner, reason, due time and next action); exception-first work items (reason code, safe explanation, evidence, owner queue, due time, priority rationale, next action, who owes it, blocking dependencies; unavailable distinct from empty via `coverage` and `notCovered`) for intents without a channel, cancellation recoveries, recall and request follow-up; UX-01 in contract terms (plain-language explanations, consistent operation names, sensible defaults such as exclusion on); UX-02 in contract terms (automatic offers are inspectable with policy reference and version; revocation is the pause mechanism).
- Not consumed (owner): PT-01 huddle preparation (S/E with B for balances and eligibility, C for forms and labs); PT-03 treatment, lab and referral parts (C11, C16, C17); PT-04 documentation drafting (C); PT-05 balances and reconciliation (B); PT-06 analytics (A reporting); UX-01/UX-02 interaction design (deferred UI); UX-03 role-based usability measurement (R); waitlist offer outcomes as measured filled or attended cancellations (R, with E for outreach); MG-01..MG-05 (M), CL-01..CL-12 (B).

Head at the time of this entry: the commit containing it (`git log -1`); the batch 3 gate is recorded below.

### Batch 3 gate

`corepack pnpm run ci` at 4524362: exit 0 (typecheck, lint, contract drift, 42 files / 953 passed / 13 todo, privacy scan of 254 tracked files and the artifacts, SBOM 270 components, evidence manifest and verification: unreviewed, not certified). Commits of batch 3: cdf756c (merge of origin/main), b873e98 (S12), d2d139a (S13), d43a9e8 (S14), 26faa00 (S15 and PT-02), 9a45f56 (S16 and PT-03), a22cfcf (S17), 4524362 (review hardening of S8-S11 and the handoff). Re-run on the commit containing this entry. Not pushed. Nothing here is approved, deployed, compliant or clinically validated.

### Review hardening of S12-S17 (batch 3, independent review)

Commit "Harden S12-S17 after independent review". Each finding was written as a failing test first; the list below states what changed.

- Standing-policy bypass (must-fix): acceptance of a waitlist offer is a person's command (a service principal gets 403 `principal_kind_denied`; patient acceptance arrives later through the E portal principals, the seam is documented in `respondToOffer`). A direct offer by a service principal passes the same live standing-policy gate as `executeRecovery` (`requireLivePolicy`, FOR SHARE, policy id and version recorded on the offer, 403 `standing_policy_required` otherwise); the limit for a direct offer is `maxOffersPerRecovery` per waitlist entry (409 `standing_policy_limit`). `reconcileOffers` stays service-allowed (it only expires). Harness test added for both.
- The notification worklist lists only intents whose subject is still open: future appointment without attendance, live offer, open recall task; stale intents no longer crowd out new ones under the 500 limit.
- Lazy offer expiry: write paths reap expired offers first (`offerSlot`, `removeFromWaitlist` per entry; `executeRecovery` per location, before the recovery lock); reads derive expiry from the hold (`readOffer`, `listRecoveries`, `readRecovery` offers and candidates) without writing.
- One lock order everywhere: recovery, hold, offer, entry (`respondToOffer` re-ordered; `expireHolds` already took hold, offer, entry). A residual deadlock victim is already mapped to the retryable 409 by the tenant-transaction runner.
- Time-block conflicts (`conflicts()` in resources.ts) are not replayed from the idempotency key.
- Export import tests now cover a non-synthetic database name, a non-superuser role and a cross-tenant identifier collision (rollback). The import validates every foreign key of the imported tables, composite (id, tenant_id) keys included, before commit (replica mode does not enforce them) and rolls back on an orphan or cross-tenant reference.
- Recall due: patient status reasons and the no-baseline patient list need `patients.read`; other callers receive counts only. 23505 races in `createRecallTask` (answer with the recorded open task) and `defineRecallPolicy` (typed retryable 409 `policy_version_taken`) are handled.
- Series with `skipConflicts` carry `partial` (true when occurrences were skipped); still 201.
- `grantStandingPolicy` validates that the grantee is a service principal with a live membership in this tenant (422 `notServicePrincipal` for a person, another tenant's, an unknown or a revoked principal) through `SchedulingDeps.memberships` (RLS hides other principals from the runtime role; a SECURITY DEFINER function was not introduced).
- Nits: stored refusals keep their `reasonCode` on replay; `planSeries` takes no resource row locks. Not done: recall `sourceAgeSeconds` stays 0 (an existing test pins it; a real value needs a defined source clock), and `listWaitlist` still shows an offered entry whose hold lapsed until the next write path or reconcile reaps it.

## Operational read models (S18, S20, S21, S22)

Spec: `docs/superpowers/specs/2026-11-04-operational-read-models.md`; plan: `docs/superpowers/plans/2026-11-04-operational-read-models.md`. Decisions OR-D1 to OR-D6 accepted by the user on 2026-11-04. Synthetic data only; branch `codex/or-scheduling`. Status words: built and tested on synthetic data; nothing here is approved, deployed or clinically validated.

**List envelope seam (A20).** A20 is not built. `ListEnvelope` (OR-01: `asOf`, `appliedFilters`, `scope`, `limit`, `truncated`, `nextCursor`, `ordering {key, direction, tieBreak}`, `count {exact} | {atLeast}`) is defined locally in `packages/contracts/src/scheduling.ts` and as `$defs/ListEnvelope` in `scheduling.schema.json`. Every list these tasks add carries it as an `envelope` property; A20 can lift the definition into the shared contract and retrofit older lists without changing these responses.

### S18 availability filters (OR-04, OR-D6)

- `POST /v1/availability/search` (MCP `availability_search`) gains `weekdays` (ISO 1-7), `timeWindows` (local `HH:MM` ranges in the location zone; the whole appointment must fit), `preferredProviderRefs` (tried first, in order, for a pooled provider requirement; another tenant's is 404, another location's 422), and `next` (next-N mode: the first N openings from `from`; `to` optional and defaults to the end of the maximum window; no cursor).
- Maximum window: configurable (`SchedulingDeps.availabilityMaxWindowDays`), default 60 local days, replacing the 31-day cap. A longer range is refused `validation_failed` with `violations [/to beyondHorizon]` and `limit {name: availabilityMaxWindowDays, value}`. ADR 0009 S-S3-R3 updated to note the accepted change.
- Response adds `envelope` and echoes the applied filters in `constraints` (`maxWindowDays`, `weekdays`, `timeWindows`, `preferredProviderRefs`, `next`). Still read-only (no executor, no write).
- Tests: `tests/integration/availability.test.ts` (weekday set + morning window, next-3, provider preference and foreign provider, above-maximum refusal); negative-harness row for the filtered search (cross-tenant 404, revoked, downgraded, REST and MCP). Red: 5 failing before the change; green after.

### S20 bounded staging list (OR-05, OR-D2)

- Migration `20261127000000_scheduling_staging_list.sql`: `scheduling_staging_lists` (per location, `capacity` default 10, 1-100) and `scheduling_staging_entries` (subject = exactly one of a booked appointment or a request; state `staged -> moved | removed`, forward only, never deleted; one staged entry per subject). RLS forced; no patient column (merge registration not needed: patients are reached through the registered appointment/request), so the merge-class mirror is unchanged.
- Operations (REST and MCP from `SCHEDULING_OPS`): `scheduling.staging.list` (GET `/v1/scheduling/staging?locationRef=`, OR-01 envelope, ordering `stagedAt` asc, tie-break `entryRef`), `.configure` (admin.configure), `.add`, `.remove`, `.move`. Add/remove/move/configure are audited (`schedulingStagingEntry` / `schedulingStagingList`).
- The staged appointment keeps its booking and occupancy (staging writes no occupancy row). Over capacity is `409 conflict` with `reason staging_capacity_reached` and `limit {name: stagingCapacity, value}`; the list row is locked by every add so the check is serialized.
- Move = the S10 reschedule (`rescheduleWith` in `appointments.ts`): the entry lock, entry version check and the entry update run as a guard inside the reschedule transaction, so a window conflict rolls back both and leaves the original booking and the entry intact. The reschedule's own appointment-version check is replaced by the entry version check for this path (`versionCheckedByGuard`), which keeps the same-key replay stable. Two concurrent moves of one entry: one 200, the other a typed 409 (`appointment_not_booked` or `stale_version`). A request entry is refused `staging_entry_is_request` with `alternative: scheduling.appointments.book`.
- Tests: `tests/integration/staging-list.test.ts` (5), negative-harness rows for all five operations, tenant-isolation table list. Red before implementation (all routes 404/500), green after.
- Open: entries whose appointment was cancelled or rescheduled outside staging stay `staged` and show the current `subjectStatus`; a reaper or a predicate exclusion is a later choice. The new tables are not yet in the S17/M export table set (export-import is owned elsewhere).

### S21 floor view, provider request and team presence (OR-06, OR-D1)

- Migration `20261127010000_scheduling_floor_presence.sql`: `scheduling_provider_requests` (open -> acknowledged -> cleared, forward only, one live request per appointment, never deleted) and `scheduling_staff_presence` (one row per principal; `available | busy | away`, optional operatory, `expires_at`; RLS lets a principal insert or update only its own row).
- Operations (REST and MCP): `scheduling.floor.read` (GET `/v1/scheduling/floor?locationRef=&projection=`), `scheduling.floor.providerRequests`, `scheduling.floor.requestProvider` (POST `.../appointments/{ref}/provider-requests`), `.acknowledgeProviderRequest`, `.clearProviderRequest`, `scheduling.presence.set`, `scheduling.presence.list`. Provider-request commands and presence are human-only.
- Floor read (OR-D1: built now, release decision with the clinical reviewer): per active operatory, the booked appointment whose S11 attendance state is `arrived | waiting | in_care`, with plain label, `since`, `elapsedMinutes`, next actions (S11 transitions plus provider-request actions) and the live provider request. Composed on read; writes nothing. Patient is `{patientRef}` with `patients.read`, else `restricted` (never omitted).
- Internal notification only: `requestProvider` records an audited outbox fact (`scheduling.floor.requestProvider`) and appears in the provider-request queue; it records no notification intent, so nothing is patient-facing. Seam: E's internal staff notice consumes the outbox event (not wired here).
- Shared display (A18 seam): A18's display principal does not exist yet, so the rule is an explicit `projection=anonymized` read: no patient or appointment reference in the body. When A18 lands, a display principal should be forced to this projection.
- Tests: `tests/integration/floor-view.test.ts` (arrival -> in care -> provider requested -> acknowledged -> cleared; anonymized projection; presence self-set, audited, expiry; REST/MCP parity; cross-tenant 404), negative-harness rows for all seven operations. Red: routes absent; green after.
- Open: S11 has no checked-out kind, so the floor visit ends only at a terminal attendance state (the spec scenario's "checked out" step is not representable yet). No provider-resource-to-principal link exists, so "acknowledged by that provider" is recorded as the acting staff member, not enforced to be the provider.
