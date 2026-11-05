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
