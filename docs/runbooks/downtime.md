# Runbook: practice downtime and the timed restore exercise

Status: proposed procedure, tested only on the embedded synthetic cluster. Not clinically validated,
not an operating agreement, and not a claim about any production deployment (production deployment
is not authorized). Recovery objectives are recommended-pending-approval (M-D5; settled by M-S3).
Module detail: `downtime-scheduling.md` (S), `imaging-recovery.md` (I), `restore.md` (F8).

## 1. Before any downtime (daily preparation)

- The operator confirms the latest backup verification is fresh (`docs/runbooks/escalation.md`,
  backup verification section). A stale or absent verification is an incident, not a warning.
- The front desk prints or saves the next two days' schedule and the day sheet (S downtime runbook).
- Clinical staff keep the paper encounter form and the paper consent forms at each chair.
- The billing desk keeps the paper payment log (date, payer, method, amount in dollars and cents,
  receipt number from a pre-numbered book) and never re-keys card data on paper.

## 2. During downtime: what staff do

| Module | What staff do on paper | What they must not do |
|---|---|---|
| Scheduling (S) | Check patients in against the printed schedule; record arrivals, no-shows and walk-ins with the time | Promise a new booking as confirmed; it is a request until entered |
| Clinical (C) | Record findings, procedures performed, and notes on the paper encounter form, signed and timed | Treat a paper note as signed in the system; it is a source document |
| Imaging (I) | Keep acquiring on the device; the bridge buffers locally (I offline rules) | Copy images to personal devices or e-mail them |
| Billing (B) | Write receipts from the pre-numbered book; record method and amount | Post adjustments or refunds from memory later without the receipt |
| Communications (E) | Defer non-urgent outbound messages; urgent calls by phone with a call log | Send patient information from personal accounts |

Every paper record carries: the date, the time, the staff member's name and the downtime log
number written on the first page of the day.

## 3. Recording on reconnect

When the system is back, the downtime is recorded before any back-entry starts: start time, end
time, cause class, who declared it and the paper series used (receipt numbers, form numbers). This
is the anchor every reconciled entry refers to.

## 4. Reconciling paper records back into the system

Paper records enter the system as **reviewed entries**, never as silent overwrites:

1. Each paper item is entered through the ordinary operation for its fact (attendance, a procedure
   completion, a note, a payment), with the paper time as the occurrence time where the operation
   allows it and the downtime log number as the reference. The entry time stays the real entry time.
2. A second person reviews each back-entered batch against the paper (two-person rule for payments
   and clinical notes). Discrepancies are resolved by amendment or reversal; posted financial history
   and signed clinical history are never edited in place.
3. If the system already holds a conflicting fact entered after recovery (for example a payment
   keyed twice), the later duplicate is reversed with a reason; the paper record is not discarded.
4. The downtime is closed only when every paper item is either entered or explicitly marked not
   entered with a reason. Closing with unreconciled items reports the count; it never closes silently.

Planned, not yet built: a downtime log and manual-event reconciliation operation (plan M8
`openDowntimeLog` / `recordManualEvent` / `reconcileManualEvents`). Until then this section is the
procedure, carried out with the existing operations.

## 5. Restore (when downtime is a data loss event)

Follow `restore.md` (database) and `imaging-recovery.md` (object store, tombstones carried
forward). Then, before serving staff:

- verify a practice export taken before the incident against the restored tenant
  (`practice.export.verify`, M1): `verified` means every table count and document digest matches;
- re-run the journal check on every restored entry (the drill does this automatically);
- deny-test one cross-tenant read; and
- treat any business written after the restored backup as a downtime gap: reconcile it from paper
  through section 4, never by editing restored rows.

## 6. The timed restore exercise (M8 drill)

`tests/integration/ops-restore-drill.test.ts` runs `runRestoreDrill` (`packages/db/src/restore-drill.ts`):

1. logical backup of the whole synthetic database and an object-store backup;
2. restore into a fresh isolated database and empty store (tombstones carried forward);
3. reconciliation of every tenant table of the tenant (row count and content digest, source against
   target) and the database's own journal check on every restored entry;
4. a restored stack serves a verified practice export and denies another tenant;
5. elapsed time is measured against `docs/deployment/recovery-objectives.json` (RPO 900 s, RTO
   14400 s, recommended-pending-approval). A missed target is reported with the measured value and
   the gap; it is never rounded to pass;
6. a deliberately incomplete backup (a table file removed) is detected and reported as a failed
   drill with the source untouched.

The machine-readable report is written to `artifacts/restore-drill-report.json` and bound into the
evidence manifest under AS-06. A passing drill on the synthetic cluster says nothing about a
practice's hosting until M-S3 names the operator, the hosting model and the objectives.

Drill finding (fixed): restoring a tenant with migrated opening items failed because the H2 M-2
bind trigger required an apply run in the restoring transaction. The restore load now sets a
transaction-local flag honoured only for a role that bypasses RLS
(`20261129020000_restore_opening_items.sql`).
