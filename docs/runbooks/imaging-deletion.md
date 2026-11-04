# Imaging deletion, legal hold and backup interaction (synthetic foundation)

Status: mechanism implemented and tested on synthetic data only (workstream I, I8). Retention values, deletion authority and hold practice need legal and clinical review per jurisdiction; every value here is **recommended-pending-approval**. Nothing in this runbook is approved, compliant or deployed.

## What a deletion does

1. `POST /v1/imaging/objects/{objectRef}/deletion-requests` (`imaging.delete`, a person) records a request only if the object could be deleted now. Otherwise it is refused 409 with the reason: `legal_hold_active` (the holds as `blockingRefs`), `retention_policy_missing` (no policy for the record class: no universal default ships), or `minimum_retention_not_met` (with `earliestAllowedAt`, computed from receipt plus the class's minimum retention).
2. `POST /v1/imaging/deletion-requests/{deletionRef}/execute` re-evaluates at execution time (a hold placed after the request still blocks; nothing is half-deleted). An image ever associated with a patient needs a second person (I-D6, `second_approver_required`); a never-associated object may be executed by its requester.
3. One transaction tombstones the object and its derived objects (`state = deleted`, `deleted_at`, `deletion_id`), revokes their read grants and records the execution (audit and outbox). The object row, its provenance, its association history and every audit row stay.
4. After the commit the service writes a tombstone marker per object in the object store (`tombstones/<tenant>/<objectRef>`), removes the bytes unless another live object in the tenant uses the same content-addressed blob (`retained_shared`), and records `bytes_state`. A crash between the commit and byte removal leaves `bytes_state = pending`; executing again (any key) or `imaging.storage.reconcile` finishes it and reports the same outcome.
5. Mount versions keep the slot and show it as `missing`; annotations stay as records.

A retention policy change never deletes anything by itself.

## Legal holds

`POST /v1/imaging/legal-holds` (`imaging.legalHold`, a person) on one object or on a patient. A patient hold covers every image ever associated with that patient, including identities merged into it. Holds override retention. Release is once, with a reason, and stays in history.

## Backups and restore drills

The logical database backup (`docs/runbooks/restore.md`) contains rows, not object bytes. Object bytes need their own backup at the storage layer (I-D1 decides the backend). The rules:

- Tombstone markers live in the object store and must be retained at least as long as the oldest database backup that could be restored.
- After any database restore, run `imaging.storage.reconcile` before serving images. It quarantines live rows whose bytes are missing or altered and turns any live row with a tombstone back into `deleted`, so a restored backup cannot resurrect a deleted image as available. It also completes pending byte removals and sweeps abandoned ingress.
- Restoring object-store bytes from an older storage backup can bring back deleted bytes; reconcile keeps the rows deleted, and the bytes are then orphans the maintenance listing (`listLocalStoreKeys`) finds for operator-reviewed removal.

Evidence: `tests/integration/imaging-restore-drill.test.ts` (I9): a real F8 logical backup plus a storage-layer backup of the synthetic store, a deletion and an upload after the backup, restore into a fresh synthetic database and an empty store with the live tombstones carried forward, reconcile before serving; the deleted image stays deleted, the kept image is served with its verified digest, the later upload is not resurrected. See [imaging-recovery.md](imaging-recovery.md).

## Not covered

No export archive registry exists yet (workstream M), so "an object referenced by an exported archive needs archive-owner review" has nothing to check; no jurisdiction-specific periods (for example minors) are encoded; no automatic retention-driven deletion exists.
