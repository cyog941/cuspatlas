# Runbook: operator ownership, backup verification, support and escalation

Status: proposed and tested on synthetic data only. The named operator, the hosting model and the
recovery objectives are open decisions (M-S3, M-D5, M-D6, M-D7). Every name and contact below is a
placeholder; no real contact data is recorded until an operating agreement exists. Nothing here
describes a deployed service.

## Operator ownership record

The record is `operations.operatorProfiles.record` (REST `POST /v1/operations/operator-profiles`,
MCP `operations_operator_profiles_record`), a tenant-wide administrator's command. Each change is a
new version; earlier versions are retained. Names and contacts must be `placeholder:<slug>`.

| Responsibility (required) | Placeholder role | What it owns |
|---|---|---|
| `backup` | `placeholder:backup-owner` | Scheduled logical and object-store backups, retention of backup sets |
| `restore_drill` | `placeholder:restore-drill-owner` | The timed restore exercise (`downtime.md` section 6) and its report |
| `security_incident` | `placeholder:security-incident-owner` | Security incident response, always covered |
| `support` | `placeholder:support-owner` | Practice support requests |
| `escalation` | `placeholder:escalation-owner` | Routing an incident with no named responder |
| `credential_rotation` (optional) | `placeholder:credential-owner` | Rotation events (recorded as events; the credential is never stored) |

The command refuses a profile without every required responsibility (`422 responsibility_missing`)
and one whose security incident path is not covered at all hours (`422 weak_escalation`).

## Escalation paths

| Incident class | First responder | Coverage | Expected first response (placeholder) | Fallback |
|---|---|---|---|---|
| `security_incident` | operator | always | 60 minutes | maintainer security contact (published security-fix commitment, M-D7) |
| `outage` | operator | always | 30 minutes | escalation owner |
| `data_integrity` | operator | always | 60 minutes | maintainer |
| `support` | operator | business hours | 8 hours | escalation owner |

An incident with no named responder escalates to the maintainer contact as the documented fallback.
A support claim (for example a recovery time) that the restore drill has not demonstrated is reported
by readiness as `sla_not_demonstrated`; it is not advertised.

## Backup verification

- Job: `runBackupVerificationJob` (`apps/worker/src/backup-verification.ts`) with `verifyBackup`
  (`packages/db/src/backup-verify.ts`): verifies the latest backup's manifest and every data file
  digest, restores it into an isolated sample database, measures the restore and drops the sample.
- Result, derived by the server (`operations.backupVerifications.record`): `verified` only with both
  checks; `checksum_only` without a restore; `failed` otherwise. A job that cannot run records
  `failed` (never passes by default).
- Interval: at most 24 hours between verifications (`backupVerificationMaxAgeSeconds` in
  `docs/deployment/recovery-objectives.json`, recommended-pending-approval). Older is `stale`.
- Scheduling: `backupVerificationDue` is the schedule predicate. Wiring the job into the worker tick
  needs the operator's backup location and restore target (M-S3); pending.

## Readiness and alerts

`operations.readiness.assert` lists every unmet obligation: `missing_operator`, `weak_escalation`,
`absent_verification`, `stale_verification`, `failed_verification`, `checksum_only_verification`,
`sla_not_demonstrated`. Ready only when the list is empty. `operations.alerts.list` shows each unmet
obligation as a work item (practice manager queue, owed by the platform operator, with the evidence
reference and the next action). Release readiness evidence: control AS-06 in
`docs/assurance/controls.json`.

## When an alert fires

1. `failed_verification` or `stale_verification`: treat as an incident (`outage` class). Take a new
   backup, run the verification job, and do not start a cutover or a risky change until verified.
2. `checksum_only_verification`: run the isolated sample restore.
3. `missing_operator` or `weak_escalation`: the release gate stays closed; record a complete profile.
4. `sla_not_demonstrated`: withdraw the claim or run the timed drill on the agreed hosting.
