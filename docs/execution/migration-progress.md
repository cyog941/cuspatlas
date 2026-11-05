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
- M-3 merge and bump are atomic: S6 `mergePatients` takes an internal-only `within(tx)` callback run in
  the merge transaction after the merge (never on a replay, never reachable from REST/MCP); the
  migration merge bumps the change sequence and records its command there. Test: a simulated crash
  at the bump rolls back the merge; the retry with the same key merges and bumps once; a further
  replay bumps nothing. Red 1/1 failing (merge committed without bump); green 4/4.
- M-4 no orphans, no stale links: `applyImport` is one transaction (package lock, plan-digest
  re-check, S4 `createPatient` through its new internal `within` transaction parameter, applied rows,
  apply-run row), so a refused or crashed run leaves no patient; a patient left by a pre-fix run is
  adopted by its per-record `external_record` identifier. The plan follows a linked patient's
  `merged_into` chain to the survivor (the digest changes, so a stale apply is refused), and the apply
  locks each linked patient `FOR SHARE` against a concurrent merge. Red 2/3 failing (orphan left,
  link to merged patient); the adoption test is regression coverage (passed before); green 7/7.
- M-5 reviewer list (`20261128510000_migration_reviewer_assignments.sql`): per-tenant
  `migration_reviewer_assignments` (principal, `financialReviewer`/`operationsReviewer`, assigned by,
  revocable). Decision recorded (recommended-pending-approval): the default reviewer set is any holder
  of `migration.signoff` whom an administrator assigned to the role; the list is written only by the
  administrator/operator provisioning path (runtime role: SELECT only, so no API caller can assign
  itself); an admin-facing assignment command is an open item. `recordSignOff` refuses a role the
  signer is not assigned (`409 reviewer_role_not_assigned`) and the sign-off trigger refuses it again
  (42501). Red 1/1 failing; green 8/8; tenant-isolation lists the new table.
- M-6 opening entry once (`20261128520000_opening_entry_once.sql`): unique index on one
  `opening_equity` line per opening item (only an opening entry touches equity, so one equity line is
  one entry; an allocation of opening credit touches the credit side) and a BEFORE INSERT trigger
  constraining the equity side (negative for a balance, positive for a credit, never an open claim).
  Tests: two concurrent forged postings of one fresh item, exactly one commits (the other 23505 at
  insert, previously 23514 only at commit); an entry of two equity lines is refused (previously
  committed). The M5 repost test now sees 23505. Red 2/2 failing; green 10/10.
- M-7 excluded money (`20261128530000_migration_exclusion_acknowledgement.sql`): every excluded
  `ledger_balances`/`unapplied_credits` row with a non-zero amount is a blocking `excluded_balance`
  exception (`acknowledge_exclusion`). Decision: the acknowledgement is part of the financial
  reviewer's approval (`acknowledgedExclusions`, optional in `SignOffRecord`, recorded as
  `migration_signoffs.acknowledged_exclusions` on the append-only, digest-bound sign-off; only a
  financial approval may carry it), rather than a new operation. Approval refuses
  `unacknowledged_exclusion`; cutover (domain and the DB guard) accepts an `excluded_balance`
  exception only when the approved financial sign-off of that digest names it. Catalog regenerated.
  Red 1/1 failing; green 11/11.
- M-8 CSV hygiene: staged values stay raw; `csvExportCell`/`csvExportRow` (exported from the
  migration module) neutralise formula-leading values (`=`, `+`, `-`, `@`, tab, CR) with a leading
  apostrophe and quote separators for any downstream CSV export (no CSV export exists yet; consumers
  must use it, recommended-pending-approval). Intake refuses a NUL character (`422 nul_character`)
  before anything is read or staged, and the already-staged digest path returns the prior package
  only to the same profile and authorisation reference (`409 staged_under_other_authorisation`);
  authorization and the profile checks already run before that path. Red 4/4 failing; green.
- M-9 opening balances round-trip. Decision: carry the opening chain inside the B export rather
  than a separate M document, because the chain exists only for B's opening journal lines (their
  `opening_item_id` foreign key), B's import already validates every foreign key and currency of its
  tables and re-runs the journal check (which reads the opening items), and a new M export would
  need a new operation, route, MCP tool and authorization for four tables. `BILLING_EXPORT_TABLES`
  gains `migration_source_profiles`, `migration_packages`, `migration_staged_records` and
  `migration_opening_items`, exported only as the chain (every opening item, the staged record it
  repeats, its package with `raw - 'tables'`, its profile); review items, applied records, other
  staged rows, reports and sign-offs (the workspace) stay out. The five-way round trip now seeds a
  migrated opening balance and credit, imports S, I, C, E, B and re-exports identically. Red 1/1
  failing; green. A separate M export (with its own operation) remains an option if M grows.
- M-10 B seam (`20261128540000_opening_credit_allocation.sql`): the patient balance adds
  `opening_receivable` to patient responsibility and `opening_credit` to unapplied credit; statements
  state both opening accounts. `billing.payments.allocate` accepts an opening credit item reference in
  place of a payment: same invariants (active charge of the item's merge set, never more than the item
  holds or the charge owes, item patient then charges locked first), an `allocation` entry drawing on
  `opening_credit` that names its charge and no payment; `billing_check_entry` now permits that and
  refuses mixing it with payment credit or another item kind/patient/currency. The opening
  reconciliation counts only `openingBalance` entries, so a later allocation does not read as an
  import difference. The B1 structural test allows `migration_opening_items` as the seam table.
  Open item: reversing an opening-credit allocation is not wired (the reversal path copies payment
  dimensions only). Red 1/1 failing; green 14/14.

## M batch 2 (M1, M7-M10; synthetic only; M-S1..M-S3 blocked-on-discovery)

- M1 practice export contract (`20261129000000_practice_exports.sql`): `practice.export.create`
  composes the S17, I9, C18, E9 and B10 exports (B with the opening chain) as the same caller into
  one `cuspatlas-practice-export/1` package: manifest with per-document canonical digests, per-table
  counts, blob digests, terminology refs (synthetic provisional, unlicensed), tenant-free
  `exportRef`. Every table's count is checked against the live tenant before storing; a partial
  export is refused (`409 export_incomplete`, tables named). Bytes are stored privately
  (content-addressed object store); delivery is `practice.export.grant` (I1 grant tokens, at most
  300 s, bound to caller and export, token never stored) and `practice.export.download` (sensitive
  read). `practice.export.verify` re-checks stored bytes, the completeness validator and live drift
  (`verified`/`drifted`/`failed`, entity named). `validatePracticeExport` (domain) refuses
  `unknown_version`, `empty_manifest`, `missing_entity`, `count_mismatch`, `digest_mismatch`,
  `tenant_mismatch`. Tenant-wide human administrators only (`admin.configure`), catalog owner `M`,
  sensitivity `phiBulk`. Round trip: the downloaded documents import into a fresh database and store
  through `importExports` + `importImagingBlobs` and re-export the same manifest. Format published in
  `docs/export-format.md`. Red 5/5 failing (exit 1); green 5/5.
- M7 historical archive packages (`20261129010000_migration_archive.sql`): `migration.archive.register`
  copies the M3 archive references of a package (historical appointments and procedures, archived
  future appointments) into a new read-only archive package version (per-entry digest over entity,
  source id, time precision, patient and the source row; package digest over the entries); nothing
  is written to live S/C/B tables (asserted). `migration.archive.verify` (human or worker) records
  `verified`, `partial` (unreadable entries enumerated) or `failed`. Reads: `migration.archive.references`
  (one visible patient, explicit empty list) and `migration.archive.read` (one entry for its linked
  patient only, else 404; damaged content `409 archive_entry_unreadable`, a failed package
  `409 archive_unavailable`), human-only, also need `patients.read`, sensitive-read logged. A
  re-registration is a new version; the prior one stays readable. Retention (recommended-pending-
  approval `archive-retention.pending-approval.1`, ten years from registration) and legal holds:
  `migration.archive.holds.record` (place, release once) and `migration.archive.retention.evaluate`
  (reasons `legal_hold`, `retention_period`); an I8 patient hold (`imaging_legal_holds`) on an entry's
  patient also holds the archive. A delete trigger refuses any deletion while held or retained, for
  every role that fires triggers; the runtime role has no DELETE grant. Disposal itself is not an
  operation (pending M-S2). Red 6/6 failing (exit 1); green 6/6.
- M8 downtime procedures and timed restore exercise: `docs/runbooks/downtime.md` (what staff do per
  module, what is recorded on reconnect, paper records reconciled back as reviewed entries through
  the ordinary operations with amendments/reversals, never silent overwrite; downtime-log
  operations planned, not built). `runRestoreDrill` (`packages/db/src/restore-drill.ts`): F8 logical
  backup plus object-store backup of the whole synthetic database, restore into a fresh isolated
  target, per-tenant reconciliation of every tenant table (count and content digest), the journal
  check on every restored entry, timing against `docs/deployment/recovery-objectives.json` (RPO 900 s,
  RTO 14400 s, recommended-pending-approval, M-D5/M-S3) with any gap named; a damaged backup is a
  failed drill (`incomplete_backup`), never a throw past the source. The restored stack verifies an
  M1 export taken before the backup and denies another tenant. Report written to
  `artifacts/restore-drill-report.json` and bound into the evidence manifest as control AS-06
  (`docs/assurance/controls.json`). Measured on the embedded cluster: backup about 1 s, RTO about
  4 s, 208 tenant tables reconciled. Drill finding fixed: the F8 restore of a tenant with migrated
  opening items failed (H2 M-2 bind trigger requires an apply run in the restoring transaction);
  `20261129020000_restore_opening_items.sql` honours a transaction-local restore flag only for a
  role that bypasses RLS (runtime role still refused, tested). Red 2/2 failing (exit 1); green 3/3.
- M9 operator ownership, backup verification, support and escalation
  (`20261129030000_operations_readiness.sql`): `operations.operatorProfiles.record` (tenant-wide
  human administrator) records a new versioned operator profile with placeholder names/contacts only
  (`placeholder:<slug>`; real contact data refused 400), hosting model, required responsibilities
  (`422 responsibility_missing`) and escalation paths (security incident must be always covered,
  `422 weak_escalation`); prior versions retained. `verifyBackup` (db) checks the manifest and every
  data-file digest, restores into an isolated sample database and drops it; `runBackupVerificationJob`
  (worker) records the result through `operations.backupVerifications.record` as the service
  principal; the server derives `verified` only with an isolated restore (`checksum_only`, `failed`
  otherwise; a job that cannot run records `failed`). `operations.readiness.assert` lists every unmet
  obligation (`missing_operator`, `weak_escalation`, `absent_verification`, `stale_verification`
  (older than 24 h, recommended-pending-approval), `failed_verification`, `checksum_only_verification`,
  `sla_not_demonstrated`); `operations.alerts.list` shows them as work items (practice manager queue,
  owed by the platform). Runbook `docs/runbooks/escalation.md`; AS-06 extended. Pending: wiring the
  job into the worker tick (needs the operator's backup location, M-S3). Red 8/8 failing (exit 1);
  green 8/8.
- M10 migration parity, negative matrix, export and release evidence
  (`tests/integration/migration-negative-matrix.test.ts`): the parity matrix is derived from the
  operation catalog (`operations.json`, owner `M`): every M operation must have its REST route
  (same path), its MCP tool registered on the server and a negative-matrix row; a missing tool or
  row fails (asserted with a synthetic gap). Negative matrix for the 15 batch 2 operations: revoked
  membership (403 on REST; MCP refused at the transport), cross-tenant (404 for every reference, or
  the caller tenant's own data with no alpha reference), downgraded (the op's own scope removed after
  the token was issued: 403 on REST and MCP), each with no change to the alpha practice-export,
  archive, operator, verification, audit or sensitive-read rows, and no caller tenant accepted (400).
  The M2-M6 operations keep their rows in the shared negative harness. `migration.export`
  (`cuspatlas-migration-export/1`, tenant-wide human administrator, sensitive-read logged): the
  workspace complement of B's opening chain (profiles, packages, staged records outside the chain,
  review items, runs, applied records with provenance, reviewer assignments, reports, sign-offs,
  archive packages/entries/holds, operator profiles, backup verifications); `importExports` gains the
  format (additive: FORMATS and IMPORT_ORDER entries); S, I, C, E, B and M re-import into a fresh
  database and S, C, E, B and M re-export identically. Test written after the export endpoint
  (deviation from test-first for that piece); first run 15/33 failing (MCP transport refusal not
  handled by the matrix), green 33/33.

## Workstream M handoff (2026-11-05)

Built and tested on synthetic data (embedded test cluster only; nothing deployed):
- M2-M6 (batch 1 and H2 hardening): source profiles, intake and staging, review queue, idempotent
  dry-run/apply, identity reconciliation through S6, opening balances and credits through B1,
  versioned reconciliation reports, two-reviewer sign-off, cutover readiness gate.
- M1 practice export (easy exit) with completeness validator, private grant-based delivery and a
  fresh-database round trip; format published in `docs/export-format.md`.
- M7 read-only historical archive packages, patient-scoped reads, verification, legal holds and
  retention with a database deletion guard.
- M8 downtime runbook and a timed, reconciled restore drill with a machine-readable report (AS-06).
- M9 operator profiles, backup verification job, readiness obligations and alert work items,
  escalation runbook (AS-06).
- M10 catalog-derived parity matrix, negative matrix for batch 2, migration workspace export with
  round trip.

Pending decisions (recommended values are recommended-pending-approval, never approved):
- M-D1 cutover scope, M-D2 historical financial detail (opening balances plus archive), M-D3
  archive access model (in-product read-only module, built), M-D4 write-freeze duration, M-D5
  recovery objectives (RPO 900 s, RTO 14400 s engineering targets), M-D6 hosting model, M-D7
  support tiers, M-D8 rollback after new work.
- Archive retention period (ten years from registration) and disposal procedure; downtime-log
  operations (`openDowntimeLog`/`recordManualEvent`/`reconcileManualEvents`) not built; wiring the
  backup verification job into the worker tick; reversing an opening-credit allocation (from M-10).
  The admin-facing reviewer assignment commands (from M-5) are built and tested in Closeout A6
  (`migration.reviewers.assign`/`.unassign`/`.list`, docs/execution/integration-progress.md).

Blocked on discovery: M-S1 (authorised incumbent export and rights: no real export has been
received), M-S2 (lawful archive arrangement for history that will not export), M-S3 (named
operator, hosting model and tested objectives). Every real-practice use of M waits on these.

Honest status: planned, configured and tested on synthetic data. Not approved, not deployed, not
compliant, not clinically validated; the drill timings describe the embedded test cluster only.
Not a production-ready PMS.
- Full-run fixes: `migration_archive_entries.patient_id` is a merge-excluded reference (an immutable
  archive entry keeps the patient it was registered for; open item: resolve a survivor's references
  through the merge chain), and the C18 import-order expectation names the migration export.
