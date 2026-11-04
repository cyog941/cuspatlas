# Scheduling and patients execution ledger (workstream S)

Branch: `codex/s-patients` in an isolated worktree outside the OneDrive-synced checkout. Base SHA: `e3f18b4` (verified foundation head). A sibling worktree builds S7/S9 on `codex/s-resources`; the orchestrator merges both. Status values: not started, in progress, blocked with cause, verified. Nothing is prechecked.

Authorization basis: user instruction on 2026-11-04 to build workstream S on synthetic data. Scope of this branch: S-S1, S4, S5, S6 and the shared negative harness. Synthetic patients only; no real patient data, no cloud connection, no host installs. Decisions S-S1, S-D2, S-D3, S-D4 and S-D8 need human reviewers who were not available: they are recorded as **recommended-pending-approval** in [ADR 0003](../adr/0003-patient-identity.md) and implemented behind per-tenant configuration. Nothing here is clinically validated, approved or deployed.

## Batch status

| Task | Status | Head SHA | Notes |
|---|---|---|---|
| S-S1 patient identity decision record | recommended-pending-approval (no reviewer) | ed71feb | ADR 0003 |
| S4 patient identity core + negative harness | verified on synthetic data (Windows host); decisions pending approval | 7bde1cf | 382 tests |
| S5 guardian, guarantor and proxy relationships | verified on synthetic data (Windows host); decisions pending approval | the commit containing this row | 409 tests |

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
