# Workstream M progress ledger (migration and practice operations)

Branch `codex/m-migration-1`. Synthetic data only. Real source exports stay **blocked-on-discovery**
(M-S1 authorised export availability and rights, M-S2 lawful archive, M-S3 recovery objective). Every
mapping, reconciliation and sign-off rule below is **recommended-pending-approval**; nothing here is
approved, deployed, compliant or clinically validated. Evidence class of every design choice: proposed.

## Synthetic source format `cuspatlas-synthetic-legacy/1` (fabricated)

A JSON package `{ format, sourceSystem (syn-…), practiceRef (syn-practice-…), producedAt, manifest:
{ entities: [{ name, declaredCount, artifactDigest (SHA-256 of the table text) }] }, tables: { name:
CSV text } }`. Known tables (adapter version 1, `packages/domain/src/migration/adapter.ts`):
`patients` (patient_id, last_name, first_name, birth_date day/month/year, phone, guarantor_id),
`appointments` (appt_id, patient_id, start_local, time_zone, duration_min, legacy status),
`procedures` (proc_id, patient_id, legacy_code, service_date, fee_minor), `ledger_balances`
(balance_id, account_id = guarantor, patient_id, balance_minor, currency, as_of),
`unapplied_credits` (payment_id, account_id, patient_id, amount_minor, currency, received_on),
`open_claims` (claim_id, patient_id, payer_name, state, outstanding_minor, currency). The generator is
the deterministic test fixture `tests/integration/support/migration-fixtures.ts`. It is not a vendor
format; a real adapter is a new format/version in `SOURCE_ADAPTERS` (MG-01).

## Tasks

| Task | State | Evidence |
|---|---|---|
| M2 intake and mapping | tested (synthetic) | `tests/integration/migration-intake.test.ts`; negative-harness rows |
| M3 dry run and staged import | tested (synthetic) | `tests/integration/migration-import.test.ts`; harness rows |
| M4 identity and provenance | tested (synthetic) | `tests/integration/migration-identity.test.ts`; harness rows |
| M5 opening balances and open items | tested (synthetic); financial sign-off pending | `tests/integration/migration-opening-balances.test.ts`; harness rows |
| M6 reconciliation report and sign-off gate | tested (synthetic); approval pending | `tests/integration/migration-reconciliation.test.ts`; harness rows |

### M2

- Source profiles are versioned (`migration.sourceProfiles.register`); intake must name the latest
  version (`stale_profile`). Intake (`migration.packages.intake`, human, `migration.write`, audited)
  refuses `unregistered_source`, `cross_practice` (authorisation or package names another practice
  than the profile), `count_mismatch`, `digest_mismatch`, `missing_entity`, `undeclared_entity`,
  `unreadable_package`; nothing is staged on refusal. Missing authorisation is a schema refusal (400).
- Every row is staged; an unknown entity is staged unmapped; empty/malformed and repeated source ids
  are flagged per row (never collapsed). Field mappings carry confidence and provenance; validated
  ones apply automatically, while unknown fields/entities, legacy terminology (per distinct code),
  ambiguous money (negative balance, currency mismatch, non-integer minor units) and future
  appointments are queued as review items (MG-02). The same package twice returns the same package.
- Review decisions (`migration.reviewItems.resolve`) are resolved once, only from the decisions the
  item allows; the DB guard forbids edit and delete. Every decision bumps the package change sequence.
- Red/green: the first run failed (exit 1, 500 from the statement guard on an advisory-lock call,
  removed); then 9/9 green. The implementation was written before this file was executed, so the
  red phase is the guard failure rather than a missing feature (recorded honestly).
- Deviation: the raw package is kept in `migration_packages.raw` (dedicated staging store) rather
  than an I1 object; I1 bytes storage is not needed for CSV text and stays untouched.

### M3

- `migration.imports.plan` (dry run, read scope, human or service): a pure function of the staged
  rows, the review decisions and the adapter version; returns per-entity staged/planned/applied/
  excluded/blocked counts, exceptions with the required action, and the plan digest. Proven to leave
  every application table's row count unchanged (no sensitive-read row either: no source values).
- `migration.imports.apply` (write scope, human or service): refuses `plan_digest_changed`; applies
  one bounded batch (1..200) in plan order (patients first). One `migration_applied_records` row per
  source record (unique staged record, append-only): a re-run applies nothing twice. Patients only via
  S4 `createPatient` (idempotency key per staged record) with a `prior_system` identifier and a
  per-record `external_record` identifier, so a crashed run finds the patient it already created
  even after idempotency rows expire (tested with a simulated crash after the S4 commit).
- Historical appointments and procedures are archive references (`historicalReference`, minute/day
  precision, legacy status/code kept): no S10 booking, S11 attendance or C clinical fact is created
  (separate facts). Procedures need a reviewed legacy code (`archiveOnly`); future appointments are
  queued for rebooking through scheduling and never booked by the import.
- The apply route validates the Idempotency-Key but relies on per-record idempotency (it is not a
  stored-result command); every applied batch is audited and bumps the change sequence.
- Red: 6/6 failing (exit 1, routes absent). Green: 6/6; full suite 2860/2860.
- Owning-scope note: the operator also needs `patients.write` (S4 authorizes its own command).

### M4

- Identity candidates are computed at intake with S6's own `scoreCandidate` over the same
  tenant-bound HMAC match keys (no plaintext stored), within the package and against existing tenant
  patients; contact-only overlap (shared household phone/guarantor) never qualifies. Each group is one
  `identity` review item with a stated basis and candidates; `automaticMerge: false` always.
- Decisions: `distinct` (create), `sameAsExisting` (link to a proposed, live candidate only;
  `patient_not_candidate` otherwise; no creation), `mergeAfterImport` (create, then merge).
- `migration.identity.merge` delegates verbatim to S6 `mergePatients` with S6's confirmation token
  (S6 enforces `patients.merge` and the human principal); M defines no confirmation of its own.
  Reversal is S6 `unmergePatients` (S6's tested command; not re-tested here).
- Provenance: `migration.provenance.read` lists source system/id/entity/action/precision for a
  patient and its merge set; a merge keeps both source identifiers. The same source id from two
  source systems resolves to two patients (identifier keys carry the issuer).
- Red: 4/4 failing (exit 1). Green: 4/4 plus M2/M3 (19/19).
- Full-suite note: the full run under heavy machine load (~49 postgres / 48 node processes from
  parallel workers) hit hook timeouts in 13 unrelated files; every one passed on rerun with
  `--maxWorkers=2` (10 files, 246 tests) or alone; no assertion failure. Recorded, not hidden.

### M5

- New B1 entry kind wiring: `openingBalance` (which `billing_check_entry` previously failed closed
  for) may touch only three new accounts keyed on a migration opening item: `opening_receivable`
  (never negative), `opening_credit` (never positive) and `opening_equity` (balancing side). New
  `billing_journal_lines.opening_item_id` dimension; the DB check requires exactly two lines naming
  one opening item of the same patient, amount and kind, posted once, never a reversal. The domain
  sign table mirrors it. Opening entries cannot touch charge, revenue, payment or allocation accounts,
  so an opening balance can never be posted as a charge (`charge_path_forbidden` structurally); the B
  reversal command refuses them (`opening_balance_correction_via_migration`, 409, not a 500).
- `migration_opening_items` (append-only): one per source row, kind balance / unappliedCredit (per
  source payment, age basis kept) / openClaim (reference only, no claim row, never submittable),
  as-of `day` or `approximate` (never a fabricated date). Duplicate balance per patient, currency
  and as-of is excluded in the plan (`duplicate_opening`) and unique in the DB. Currency must equal
  the tenant billing currency (a mismatch is review-only, `exclude`). A negative legacy balance is
  posted as unapplied credit only after staff accept the proposal.
- `migration.openingItems.list`: items plus per-guarantor source vs imported balance and credit, and
  the explicit difference (BigInt arithmetic, integer minor units).
- Contract touch: `LedgerAccount` and billing.schema.json `Account` gain the three opening accounts;
  `postEntry` writes `openingItemId`. Pending B seam: B balance/statement projections do not yet
  include opening receivable or opening credit (opening credit is not allocatable to charges yet);
  superseding correction of an opening figure is not built.
- Red: 4/4 failing (exit 1). First green attempt: 500 from `billing_journal_entries.external_ref`
  pattern (fixed to `syn-mig-<staged ref>`). Green: 23/23 migration tests; full suite with
  `--maxWorkers=4`: 2877/2877.

### M6

- `migration.reports.build` (write scope): the report is a projection (never a financial
  authority): per-entity declared (manifest) / staged / applied / excluded / blocked counts,
  per-guarantor Money comparison with the part explained by excluded or blocked source rows,
  unapplied credit source vs imported, exceptions by category, blocking exceptions with a required
  action (open review items, blocked rows, planned-but-unapplied rows, unexplained differences) and
  the not-imported count. Its digest binds the package digest and change sequence. An unchanged run
  returns the same version; a changed run appends a superseding version (never deleted).
- `migration.signoffs.record` (`migration.signoff`, human only) binds one report version and digest
  in one role (`financialReviewer`, `operationsReviewer`); refused `stale_report_version`,
  `unresolved_exception` (approval with blocking exceptions), `separate_reviewer_required` (same
  person, second role). `migration.cutover.advance` (human, sign-off scope) needs the current
  version approved in both roles by two distinct humans and no blocking exception
  (`sign_off_incomplete`, `sign_off_rejected`); it marks `readyForCutover` only, not a cutover.
- Any later import change (apply batch, review decision, delegated S6 merge) bumps the change
  sequence: cutover returns to `reconciling`, the report is stale and every sign-off is invalid
  (tested with a real delegated merge after readiness). Reports and sign-offs are append-only.
- The reviewer set is "holders of `migration.signoff`" (role is declared per sign-off); a configured
  per-role reviewer list is a pending decision.
- Red: 4/4 failing (exit 1). Green after two fixes (sign-off audit row used the report's resource
  version, colliding with the build audit; test expected 200 for a 201 route): 4/4.

## Hardening H2

Independent review findings on M2-M6, fixed on `codex/hardening-migration` (synthetic only;
recommended-pending-approval). Tests in `tests/integration/migration-hardening.test.ts`.

- M-1 apply never wedges: the planner checks the `amount_minor` cap (99,999,999,999) on every
  financial row, real calendar days (`as_of`, `received_on`, patient birth day/month), and the
  opening-balance key of the unique index (patient after link decisions, currency,
  `coalesce(as_of, 1900-01-01)`) within the plan and against posted balances of other packages.
  Offenders are `excluded` (`validation_failed`; a key collision keeps the more precise
  `duplicate_opening`, both visible in the plan and report). Red: 1/1 failing (exit 1); green 1/1.
- M-2 database guards (`20261128500000_migration_db_guards.sql`, all SECURITY INVOKER): an opening
  item needs an apply-run row of the same transaction, package and actor (`migration_apply_runs`,
  written by `applyImport`) and must repeat its staged record exactly (package, source id, currency,
  validated amount and sign, accepted-negative review, applied patient); `cutover_state` changes only
  by a change-sequence bump of one (reset to `reconciling`) or `reconciling -> readyForCutover` with
  the latest report on the current change sequence, no blocking exception, no rejection and approvals
  of both roles by two signers on that digest; a sign-off must repeat the latest report's digest on
  the current change sequence and come from a human with a live `migration.signoff` membership.
  Runtime-role tests: forged item (no run, changed amount, other patient), forged cutover, skipped
  change sequence, forged digest and service signer all 42501. Red 2/3 failing; green 3/3.
