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
| Batch 2 merge of both tracks | verified on synthetic data (Windows host) | merge commit | 518 tests |

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
