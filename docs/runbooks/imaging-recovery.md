# Imaging recovery (synthetic foundation)

Status: procedure for synthetic environments only; recommended-pending-approval. It restores records and verified bytes. It makes **no claim of diagnostic fidelity, rendering, calibration or clinical suitability** of any restored image, and no device, scanner, DICOM library or managed object store is qualified (I-S1, I-S2, I-S3, I-D1 open).

## What is backed up

- Database: the F8 logical backup (`corepack pnpm run backup`, [restore.md](restore.md)) contains every schema table, imaging and bridge tables included (objects, provenance, association decisions and imageRefs, mounts, annotations, derivations, retention, holds, deletion requests, devices, device keys, pairings, nonces, bridge jobs, deferred acquisitions). Device private keys never exist server-side; pairing secrets are stored only as SHA-256.
- Object bytes: a storage-layer backup. For the synthetic local adapter, `backupObjectStore(root, dir)` copies the content-addressed bytes and the tombstone markers with a SHA-256 manifest (never staging or quarantine). The managed backend chosen under I-D1 replaces this with its own versioned backup.

## Restore order

1. Restore the database into a new synthetic database (`restoreBackup`; it refuses an existing target, a schema mismatch or a tampered dump).
2. Restore the object bytes into an empty store root (`restoreObjectStore`): every file is verified against the manifest and its content key before anything is written; carry the **live** store's tombstones forward (`tombstonesFrom`), because tombstones must outlive the oldest restorable database backup. Content named by a tombstone is not restored (reported as `skippedTombstoned`) unless the live store still holds identical bytes for a live object; the deleted image's bytes never come back.
3. Run `imaging.storage.reconcile` before serving any image. It turns a restored row with a tombstone back into `deleted` (or `quarantined` with `tombstoned_under_hold` when a hold now covers it), quarantines rows whose bytes are missing or altered, completes pending byte removals, sweeps abandoned ingress and sweeps bridge leases (expired claims requeued with backoff, staged-but-unreported jobs `outcome_unknown`).
4. Bridges: a restore returns each device to the state of the backup, which can be older than the live state. A key rotated after the backup comes back as the **old key, active again**, and a revocation made after the backup is lost. Run `findStaleRestoredDevices(restoredDb, liveDb)` (it lists `rotated_after_backup`, `revoked_after_backup`, `key_mismatch`) before serving any bridge route, and for every listed device revoke it again and pair it again (a rotation cannot be re-applied: the server never held the newer key, so re-rotation needs the device to authenticate with a key the restored database no longer knows). If the live database is unavailable, treat **every** restored device that way. Pairing codes issued before the backup are not trusted after it. Unknown-outcome jobs appear in the bridge worklist for a person to reconcile; they are never re-run automatically.
5. Check the worklists: ingress failures, unmatched images and the bridge worklist.

## Export and re-import (portability)

`GET /v1/imaging/export` (tenant-wide human administrator) returns the versioned imaging export (`cuspatlas-imaging-export/1`) with the blob manifest; `GET /v1/imaging/export/blobs` (REST only) pages the content-addressed bytes. `importImagingExport` and `importImagingBlobs` re-import into a synthetic database and store after the scheduling export (which carries the patients); every foreign key is validated and every blob digest verified. Storage keys never leave the service; the import re-derives them. Not exported: read grants, ingress sessions, bridge devices and jobs (a restored tenant pairs its devices again).

Evidence: `tests/integration/imaging-restore-drill.test.ts`, `tests/integration/imaging-export.test.ts`.
