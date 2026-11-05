# Migration and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a future execution plan, not authorization to start.

**Goal:** Move a practice from an incumbent into CuspAtlas under an authorised export, with counts and balances reconciled rather than assumed, an integrity-checked read-only archive for history that cannot be reconciled, an idempotent import with a dry run, and the operational scaffolding a self-hosted practice actually needs: downtime procedure, restore exercise, named operator ownership and an escalation path.

**Architecture:** Migration is a pipeline of staged artifacts, not a script that writes directly into live tables. A manifest describes what a source produced and what it claims; intake validates the claim; staging maps it into a proposed target shape; a dry run produces a reconciliation report with no durable domain effect; a live run applies the same staged plan idempotently. History that fails reconciliation does not get reinterpreted as new clinical or financial events; it stays in an archive with the same privacy and recovery boundary as the live system. Operations artifacts are versioned documents plus executable drills, not aspirations.

**Tech Stack:** Inherits the platform foundation: supported Node LTS, TypeScript, PostgreSQL/Supabase, JSON Schema/OpenAPI, Vitest and SQL integration tests, versioned export formats and checksums. Import runs are executed as durable jobs through the existing worker. No incumbent SDK, scraper or private endpoint client is written here.

**Spec:** [Product design](../specs/2026-11-03-dental-pms-design.md), [capability matrix](../../CAPABILITIES.md), [security gates](../../SECURITY-AND-READINESS.md), [delivery roadmap](../../ROADMAP.md), [research ledger](../../RESEARCH.md).

**Task numbering:** this plan's prefix is `M`. Implementation tasks are `M1`–`M10`, discovery spikes are `M-S1`–`M-S3`, and open decisions are `M-D1`–`M-D8`. A cross-workstream reference names the fully qualified task: `F` is [platform foundation](2026-11-03-platform-foundation.md), `S` is [patients and scheduling](2026-11-04-scheduling-and-patients.md), `C` is [clinical record](2026-11-04-clinical-record.md), `B` billing, `I` imaging, `E` portal. Spikes have owners, sit in the dependency graph and can block a task. `Blocks` is derived from `Dependencies` and is never maintained as a second list.

## Global Constraints

- The [platform foundation](2026-11-03-platform-foundation.md) is a prerequisite for this plan, including its restore smoke test. This plan extends recovery evidence; it does not substitute for it and does not restate the foundation's synthetic-data or tenancy rules. Tenant and actor are always derived from context.
- This plan maps into the target contracts owned by S4, S5, S6, C5, C12, C15, B1 and B5. It invents no parallel schema and defines no second merge or identity-confirmation command.
- Negative testing is stated once for the whole plan: the shared harness `tests/integration/negative-harness.test.ts` attempts every command cross-tenant, with a revoked membership, with a downgraded role, and through MCP, and each task cites the harness instead of restating the case list.
- No production export is used for development. Planning and tooling use synthetic source packages that imitate a plausible export shape and are clearly labeled as fabricated.
- Export is only taken under an authorisation the practice can evidence. No private endpoint scraping, no credential sharing, no copy of a vendor's data through an undocumented path.
- Never attribute an imported signature to a clinician in the new system. Imported notes and signed history are archive references, not newly signed records.
- Past financial events are not re-posted as new ledger entries. Opening balances and open items are recorded as explicit opening facts with provenance, using the shared `Money` contract.
- Every import run is idempotent and produces a reconciliation report; a partial import is never presented as complete.
- Recovery targets are proposed engineering acceptance targets, not an SLA. RPO and RTO claims require a timed drill result.
- Operator ownership is a named responsibility, not an assumption that a clinician administers infrastructure.

## Research gate before executing this plan

[reference PMS analysis coverage](../../WORKFLOW-RESEARCH-COVERAGE.md) records migration and export as **proposed requirements with no vendor-approved export sample**. The design commits to authorised exports or documented APIs whose rights and availability are verified, and explicitly rejects assuming private endpoint access.

No incumbent export has been obtained, sampled or characterised. The shape, completeness, cost and contractual permissibility of an export are unknown. Therefore M2 is blocked-on-discovery, and every downstream task that consumes a real export is gated. Synthetic packages validate our machinery only; they prove nothing about an incumbent's output.

## Discovery spikes (resolve before the tasks they gate)

### M-S1: Authorised export availability and rights — blocked-on-discovery

Determine what the incumbent will provide: which entities, which date range, which formats, whether attachments are included, whether history is included or only active records, whether an API is available under the practice's agreement, what it costs, how long it takes, and what the agreement says about using the output to populate another system. Blocks M2 and every downstream task that consumes a real export. Stop condition: a written authorisation plus one received synthetic-or-de-identified sample package, or migration is declared unavailable and the pilot does not cut over.

### M-S2: Lawful archive arrangement for history that will not export — blocked-on-discovery

If the export cannot deliver historical notes, images, claims or financial detail with acceptable fidelity, establish what lawful, continuing access the practice retains: read-only incumbent access for a defined period, a vendor-produced archive, or a negotiated data escrow. Blocks M7 and the cutover gate. Stop condition: a written arrangement naming duration, access method, responsible party, and what happens when it ends.

### M-S3: Recovery objective and operator model — blocked-on-discovery

Agree the RPO and RTO the pilot will be held to, whether hosting is managed or self-hosted for this practice, and who the named operator is. Blocks M8 and M9. Stop condition: a signed operating agreement naming the operator, the hosting model and the tested objectives.

## Migration usability and automation requirements

Apply [MG-01–05 and UX-01–03](../../PRACTICE-TIME-AND-AUTOMATION.md). M2 adds versioned reusable source mappings with explicit uncertainty and operator review of ambiguous fields. M3 provides resumable dry runs and staged idempotent application. M4/M5 route identity/financial ambiguity to actionable exceptions. M6 presents completeness, not-imported items and reconciliation results for proportionate staff sign-off. M7/M8 preserve usable historical access and controlled cutover/rollback. M1/M10 verify complete exit without proprietary keys.

Acceptance includes repeated import after interruption, source-schema drift, ambiguous patient, unmapped clinical semantics, incorrect opening balance, unavailable archive, and post-cutover rollback reconciliation. Measure practice/operator effort and downtime using synthetic rehearsals; no automatic mapping may fabricate clinical or financial meaning. Visual onboarding design is still deferred.

## Bring-your-own deployment and service handover

Apply [BY-01–05 and ON-01–04](../../OPEN-PLATFORM-AND-ONBOARDING.md). Extend M9 with versioned deployment templates, database preflight, separate setup/runtime authority, resumable migration and upgrade health checks. M8 must restore database plus objects and validate key custody. M1/M6/M10 must prove redacted configuration export, credential reauthorization, complete data transfer and continued practice-owned operation after support revocation. Record supported runtime/database/auth/storage combinations; arbitrary existing databases are not supported by default. Test interrupted setup, unrelated existing data, incorrect target, failed restore, support expiry and hosted-service handover. Onboarding visual design stays deferred.

## Implementation review focus

- Running an import twice must produce the same target state and no duplicates; M3 must prove it against every entity class, not just patients.
- A dry run must leave no durable domain rows; M3 must prove this by comparing table state before and after.
- A manifest that understates what the export contains must be detected by completeness checks rather than trusted; M1 must compare claims against observed artifacts.
- A source identifier reused across two source systems must resolve deterministically with provenance; M4 must not collapse two distinct patients.
- An opening balance must not be postable as a new charge; M5 must reject that path explicitly.
- A rollback after new post-cutover work must reconcile those events, not reset the database; M8 must state and test the reconciliation path.
- A restore that silently omits an entity class must fail the drill; M8 must be able to detect an incomplete backup.
- Support and escalation must name a responder for a security incident, not only a business-hours contact; M9 must record it.

## Proposed file structure (create only during authorized execution)

`packages/contracts/src/migration/` owns manifest, staged-entity, reconciliation-report and archive-package schemas, versioned from the first commit. `packages/domain/src/migration/` owns intake validation, staging, mapping, dry-run planning, application and reconciliation. `packages/domain/src/archive/` owns archive package registration, patient-linked references, integrity checks and access. `packages/domain/src/operations/` owns downtime logs, operator profiles and backup verification. `apps/api/src/routes/migration/` and `apps/api/src/routes/operations/` hold thin REST transports that call only these commands and publish the same operation names to MCP; no route reaches a table directly. `apps/worker/src/import-run.ts` executes durable import jobs. `docs/runbooks/` owns downtime, cutover, rollback, restore and escalation runbooks. `docs/deployment/` owns the operator bundle contract and hardware budget. `tests/integration/migration-*.test.ts` and `tests/integration/ops-*.test.ts` hold the suites; `tests/fixtures/migration/` holds generated synthetic packages. No vendor client, scraper or extraction tool is written here.

## Shared interfaces

Proposed contract definitions to create during execution, not code already present:

- `Money` is the shared contract type from [SHARED-CONTRACTS](../../SHARED-CONTRACTS.md#money), `{ currency: string; minor: integer }`, and is never redefined here. Every balance, difference and opening figure in this plan uses it; no scalar minor amount with a separate currency and no string amount appears.
- Identifiers are opaque `<entity>Ref` strings throughout, and tenant is derived from context; no record shape carries a tenant field.
- `Denial = { outcome: 'denied'; reasonCode: string; actorRef: string; detailRef?: string }` is returned by every command here that can legitimately refuse; a thrown error is reserved for faults.
- `MigrationManifest = { manifestVersion: string; sourceSystem: string; producedAt: string; authorisedBy: string; entities: { name: string; declaredCount: number; artifactDigest: string; dateRange?: { from: string; to: string }; fieldsPresent: string[] }[]; attachments: { declaredCount: number; totalBytes: number }; notes: string }`.
- `StagedEntity = { stagedRef: string; entity: string; sourceId: string; sourceSystem: string; payloadDigest: string; targetHint?: string; issue?: { code: string; detail: string } }`.
- `ImportRun = { runRef: string; mode: 'dryRun' | 'apply'; manifestDigest: string; state: 'staged' | 'planned' | 'applied' | 'failed' | 'abandoned'; startedAt: string; completedAt?: string }`.
- `ReconciliationReport = { runRef: string; counts: { entity: string; declared: number; staged: number; applied: number; excluded: number }[]; balanceComparison: { accountRef: string; sourceValue: Money; targetValue: Money; difference: Money }[]; attachmentResults: { declared: number; verified: number; failed: number }; exceptions: { code: string; subjectRef: string; requiredAction: string }[] }`.
- `ArchivePackage = { packageRef: string; sourceSystem: string; receivedAt: string; digestSha256: string; integrityState: 'verified' | 'partial' | 'failed'; entityCounts: Record<string, number>; accessModel: 'readOnlyLinked' | 'externalReference'; retentionClass: string }`.
- `DowntimeLog = { logRef: string; startedAt: string; endedAt?: string; manualEventSeries: string; reconciledAt?: string; unresolvedCount: number }`.
- `BackupVerification = { verificationRef: string; backupRef: string; verifiedAt: string; method: 'checksumOnly' | 'isolatedRestore'; result: 'passed' | 'failed'; entitiesChecked: string[]; gaps: string[] }`.
- `OperatorProfile = { operatorRef: string; namedPerson: string; role: 'itAdministrator' | 'contractedHosting' | 'managedService'; responsibilities: readonly string[]; escalationContactRef: string }` — no credentials stored in this record.
- Identity resolution consumes S6: `proposeIdentityResolution` returns candidates, and the operator applies them through S6's `mergePatients` / `unmergePatients` with S6's confirmation token. This plan defines no confirmation command of its own.

### M1: Export contract, manifest and completeness validation

**Dependencies:** F1–F5. **Status:** implementation.
**Files (proposed):** `packages/contracts/src/migration/manifest.schema.json`, `packages/domain/src/migration/manifest.ts`, `apps/api/src/routes/migration/manifests.ts`, `docs/export-format.md`, `tests/integration/migration-manifest.test.ts`.
**Contract:** `validateManifest(manifest: MigrationManifest): Promise<{ accepted: true; warnings: string[] } | Denial>`; `describeExportFormat(version: string): Promise<ExportFormatDescription>`; `compareManifestToArtifacts(ctx, { manifest: MigrationManifest; artifactRefs: readonly string[] }): Promise<{ entities: PerEntityComparison[]; missingEntities: string[]; missingFields: string[] }>`.
**Refusals:** `count_mismatch`, `digest_mismatch`, `missing_entity`, `unknown_version`, `tenant_mismatch`, `empty_manifest`.

**Acceptance cases:** a manifest with a declared count that differs from the observed artifact rows is refused with the specific entity named; an artifact whose digest does not match the manifest is refused; a required entity class absent from the manifest is reported as missing rather than treated as empty; a manifest claiming a field the artifacts do not contain is flagged; an unknown manifest version is refused rather than best-effort parsed; a manifest naming another tenant is refused on import; a manifest with zero entities is refused.

**Failure and recovery:** a truncated download fails the digest check rather than importing a partial package; a manifest that cannot be parsed preserves the raw bytes for diagnosis and applies nothing; an export format version bump requires a new schema version and does not reinterpret old packages.

**Completion condition:** the suite refuses every incomplete or inconsistent manifest with the failing entity named, and accepts exactly one well-formed synthetic manifest.

- [ ] Write the count-mismatch, digest-mismatch, missing-entity, version and cross-tenant cases; confirm failure.
- [ ] Implement manifest validation and artifact comparison against generated synthetic packages.
- [ ] Run the suite and confirm every refusal names an entity and a reason.
- [ ] Publish the export format document and commit.

### M2: Authorised source export intake and mapping

**Dependencies:** M1; M-S1 and M-S2. **Status:** blocked-on-discovery.
**Files (proposed):** `packages/domain/src/migration/intake.ts`, `packages/domain/src/migration/source-profile.ts`, `apps/api/src/routes/migration/intake.ts`, `tests/integration/migration-intake.test.ts`, `docs/migration/source-profile.md`.
**Contract:** `registerSourceProfile(profile: SourceProfile): Promise<CommandResult<{ profileRef: string; version: number }>>` describing entity names, identifier fields, timestamp precision and known gaps; `intakeExport(ctx, envelope: CommandEnvelope<{ artifactRef: string; manifest: MigrationManifest }>): Promise<CommandResult<ImportRun>>` returning an `ImportRun` in `staged` state; `describeUnmappedFields(ctx, { runRef: string }): Promise<UnmappedField[]>`.
**Refusals:** `missing_authorisation`, `unregistered_source`, `cross_practice`, `duplicate_intake`, `unreadable_package`, `stale_profile`.

**Acceptance cases:** an artifact registered without an authorisation reference is refused; an artifact from an unregistered source system is refused; an entity present in the artifact but absent from the source profile is staged as unmapped rather than dropped silently; a source identifier field that is empty in some rows is reported per row and does not collapse those rows together; a timestamp with unknown precision is recorded with the precision it had; a package whose authorisation names a different practice is refused; intake of the same package twice returns the same staged run rather than duplicating it.

**Failure and recovery:** an intake failure leaves the artifact and diagnostics in place with no staged entities; a partially readable package stages what is readable and reports the remainder as unread rather than inferring it; a source profile correction requires a new profile version and re-intake, not a mutation of the existing staged run.

**Completion condition:** a synthetic package stages with every entity either mapped or explicitly unmapped, and an unauthorised or cross-practice package is refused before staging.

- [ ] Write the authorisation, unmapped-entity, empty-identifier and duplicate-intake cases against synthetic packages; confirm failure.
- [ ] Implement source profiles and intake staging with per-row issue recording.
- [ ] Run the suite with a package containing an unknown entity and a missing identifier field.
- [ ] Record that real intake remains blocked on M-S1 and commit the mechanism only.

### M3: Idempotent import with dry run and staged application

**Dependencies:** M2; S4 for patient shape; C12 for estimate shape; B1 for financial shape; M-S1. **Status:** blocked-on-discovery for real sources; dry-run and idempotency implementation permitted against synthetic packages.
**Files (proposed):** `packages/domain/src/migration/plan.ts`, `packages/domain/src/migration/apply.ts`, `apps/api/src/routes/migration/runs.ts`, `apps/worker/src/import-run.ts`, `tests/integration/migration-import.test.ts`.
**Contract:** `planImport(ctx, { runRef: string }): Promise<CommandResult<{ report: ReconciliationReport; planDigest: string }>>` with a planned target per staged entity and no durable domain effect; `applyImport(ctx, envelope: CommandEnvelope<{ runRef: string; expectedPlanDigest: string }>): Promise<CommandResult<ReconciliationReport>>` applying exactly the planned operations; `abandonImport(ctx, envelope: CommandEnvelope<{ runRef: string; reason: string }>): Promise<CommandResult<ImportRun>>`.
**Refusals:** `plan_digest_changed`, `schema_version_mismatch`, `partially_applied`, `scope_missing`, `tenant_mismatch`, `validation_failed`.

**Acceptance cases:** a dry run leaves table state byte-identical before and after; an apply whose plan digest has changed since the dry run is refused; applying the same run twice produces no duplicates and reports the second application as a replay; an apply that fails partway leaves no partially imported patient visible as complete; an entity that fails validation is excluded with a code and the remainder still applies, and the run reports partial rather than successful; a service account without the migration scope cannot plan or apply; a cross-tenant plan digest cannot be applied.

**Failure and recovery:** a worker crash during apply resumes from the staged plan without reapplying completed entities; an apply against a tenant whose schema version differs from the plan is refused; a run abandoned after failure keeps its staging artifacts for a later corrected attempt.

**Completion condition:** two applies of one run produce identical target counts, a dry run changes nothing, and a mid-run failure leaves every affected patient either fully present or visibly excluded.

- [ ] Write the dry-run-no-effect, replay, partial-failure, stale-plan and cross-tenant cases; confirm failure.
- [ ] Implement planning, plan-digest pinning, staged application and per-entity exclusion reporting.
- [ ] Run the suite with a deliberately interrupted apply and a re-run of the same plan.
- [ ] Commit; keep real-source application behind M-S1.

### M4: Identity, duplicate and provenance reconciliation

**Dependencies:** M3; S6 for merge and unmerge. **Status:** implementation. This task proposes candidates and records provenance; the merge itself is S6's command, and this plan defines no second confirmation step.
**Files (proposed):** `packages/domain/src/migration/identity.ts`, `packages/domain/src/migration/provenance.ts`, `apps/api/src/routes/migration/identity.ts`, `tests/integration/migration-identity.test.ts`.
**Contract:** `proposeIdentityResolution(ctx, { runRef: string }): Promise<IdentityGroup[]>` returning groups with a stated basis and no automatic merge; `recordSourceProvenance(ctx, envelope: CommandEnvelope<{ entityRef: string; sourceSystem: string; sourceId: string; importedAt: string }>): Promise<CommandResult<{ provenanceRef: string }>>`; `applyIdentityResolution(ctx, envelope: CommandEnvelope<{ groupRef: string; survivorRef: string; mergedRef: string; confirmation: string; reason: string }>): Promise<CommandResult<MergeResult>>` delegating verbatim to S6's `mergePatients` with S6's confirmation token and permitted-role check.
**Refusals:** `automatic_merge_forbidden`, `ambiguous_identifiers`, `source_collision`, `cross_tenant`, `merge_scope_missing`, `confirmation_invalid`.

**Acceptance cases:** a shared household phone or address never merges two patients on its own; two source rows with the same name and different identifiers are proposed for review, not merged; a confirmed merge retains both source identifiers and the full prior history and can be reversed through S6's `unmergePatients`; a source identifier collision across two source systems resolves to two entities with distinct provenance rather than one; provenance is recorded per entity and not overwritten by a later import; a merge across tenants is denied; an identity decision by an actor without the merge scope is denied; this plan exposes no merge-confirmation command other than the delegation to S6.

**Failure and recovery:** an unmerged ambiguity leaves both records staged and visible in the exception list rather than defaulting to a merge; a reversal of a merge restores the prior references without losing the audit of the merge; a provenance write that fails prevents the entity from being marked applied.

**Completion condition:** every applied patient resolves to at least one recorded source identifier, the suite shows no automatic merge on demographic similarity alone, and every merge in the run resolves through S6's audited command.

- [ ] Write the shared-contact, collision, merge-reversal, provenance and cross-tenant cases; confirm failure.
- [ ] Implement candidate proposal, provenance recording and the delegation to S6's merge and unmerge.
- [ ] Run the suite including a reversal of a confirmed merge.
- [ ] Commit.

### M5: Opening balances, unapplied credit and open items

**Dependencies:** M3; B1 for the journal shape; B5 for claim references. **Status:** implementation of the mechanism; the practice's opening figures require financial sign-off.
**Files (proposed):** `packages/domain/src/migration/opening-balances.ts`, `packages/domain/src/migration/open-items.ts`, `apps/api/src/routes/migration/opening-balances.ts`, `tests/integration/migration-opening-balances.test.ts`.
**Contract:** `recordOpeningBalance(ctx, envelope: CommandEnvelope<{ patientRef: string; amount: Money; asOf: string; sourceRef: string }>): Promise<CommandResult<{ openingRef: string }>>`; `recordUnappliedCredit(ctx, envelope: CommandEnvelope<{ patientRef: string; amount: Money; ageBasis: string; sourceRef: string }>): Promise<CommandResult<{ creditRef: string }>>`; `recordOpenClaimReference(ctx, envelope: CommandEnvelope<{ claimRef: string; stateAtCutover: string; outstanding: Money }>): Promise<CommandResult<{ openClaimRef: string }>>`; `listOpeningReconciliation(ctx, { runRef: string }): Promise<OpeningReconciliation>`.
**Refusals:** `duplicate_opening`, `currency_mismatch`, `charge_path_forbidden`, `cross_tenant`, `approximate_date_required`, `totals_mismatch`.

**Acceptance cases:** an opening balance is recorded as an opening fact with a source reference and cannot be posted as a new charge; a duplicate opening balance for the same patient, currency and as-of date is refused; a currency not matching the tenant configuration is refused; an opening claim reference does not create a claim in a submittable state; unapplied credit retains its age basis from the source where the source provides one; an opening figure for a patient in another tenant is denied; the sum of opening balances and opening unapplied credit matches the reconciliation report or the difference is stated explicitly.

**Failure and recovery:** an opening figure whose source does not provide a reliable as-of date is recorded as approximate with a flag rather than given a fabricated date; a correction to an opening figure is a new superseding record, not an edit; a mismatch detected after cutover is escalated through the reconciliation report rather than silently adjusted.

**Completion condition:** opening figures reconcile to the source statement total for every synthetic patient, and no opening path can create a bookable charge or submittable claim.

- [ ] Write the no-charge-path, duplicate, currency, cross-tenant and total-reconciliation cases; confirm failure.
- [ ] Implement opening balance, unapplied credit and open claim reference records with provenance.
- [ ] Run the suite and compare the summed totals to the synthetic source statement.
- [ ] Commit; opening figures remain subject to financial sign-off.

### M6: Reconciliation report and staff sign-off gate

**Dependencies:** M1, M3, M4 and M5. **Status:** implementation.
**Files (proposed):** `packages/domain/src/migration/reconciliation.ts`, `packages/contracts/src/migration/report.schema.json`, `apps/api/src/routes/migration/reconciliation.ts`, `tests/integration/migration-reconciliation.test.ts`.
**Contract:** `buildReconciliationReport(ctx, { runRef: string }): Promise<CommandResult<ReconciliationReport>>`; `recordSignOff(ctx, envelope: CommandEnvelope<{ runRef: string; role: string; decision: 'approved' | 'rejected'; exceptions: readonly string[] }>): Promise<CommandResult<{ signOffRef: string }>>`; `listUnresolvedExceptions(ctx, { runRef: string }): Promise<ReconciliationException[]>`.
**Refusals:** `unresolved_exception`, `unexplained_difference`, `role_not_reviewer`, `stale_report_version`, `cross_tenant`, `sign_off_incomplete`.

**Acceptance cases:** the report includes per-entity declared, staged, applied and excluded counts and a per-account balance comparison rather than totals alone; an exception without a required action is refused at report build time; a sign-off by a role outside the configured reviewer set is denied; a cutover cannot be marked ready while any exception is unresolved or while any balance difference is unexplained; a re-run after a corrected package produces a new report that supersedes the prior one without deleting it; a sign-off on a stale report version is refused; a cross-tenant run identifier is denied.

**Failure and recovery:** a report that cannot complete because an artifact is unreadable states the gap rather than reporting zero differences; a sign-off interrupted between decision and record leaves no partial approval; a later discovered discrepancy reopens the gate rather than being noted informally.

**Completion condition:** the suite shows cutover readiness blocked until every exception carries an action and an accountable sign-off, with two distinct human roles recorded.

- [ ] Write the count, balance-difference, unresolved-exception, stale-version and cross-tenant cases; confirm failure.
- [ ] Implement report construction and the sign-off gate with role separation.
- [ ] Run the suite and confirm no path marks a run ready with an open exception.
- [ ] Commit.

### M7: Historical archive package, access and retention

**Dependencies:** M1; I3 for image references; C15 for the encounter link shape; M-S2. **Status:** blocked-on-discovery for the archive's source; package handling implementation permitted against a synthetic archive.
**Files (proposed):** `packages/domain/src/archive/packages.ts`, `packages/domain/src/archive/access.ts`, `packages/domain/src/archive/retention.ts`, `apps/api/src/routes/migration/archive.ts`, migration via `supabase migration new archive_packages`, `tests/integration/ops-archive.test.ts`.
**Contract:** `registerArchivePackage(ctx, envelope: CommandEnvelope<ArchiveManifestInput>): Promise<CommandResult<ArchivePackage>>`; `verifyArchiveIntegrity(ctx, { packageRef: string }): Promise<{ perEntity: EntityIntegrity[]; state: 'verified' | 'partial' | 'failed' }>`; `resolveArchiveReference(ctx, { patientRef: string }): Promise<ArchiveReference[]>` returning read-only references; `signArchiveRead(ctx, { referenceRef: string }): Promise<{ url: string; expiresAt: string }>`; `evaluateArchiveRetention(ctx, { packageRef: string }): Promise<{ eligible: boolean; holdReason?: string }>`.
**Refusals:** `digest_mismatch`, `cross_tenant`, `retention_required`, `package_partial`, `reference_not_linked`, `archive_unavailable`.

**Acceptance cases:** an archive package with a digest mismatch is registered as `failed` and is not served; a patient with no archive references resolves to an explicit empty state rather than an error that reveals nothing; an archive reference is readable only through a short-lived authorization and only for the linked patient; a cross-tenant archive reference is denied indistinguishably from a missing one; an archive package that is only partially readable is labeled partial and the unreadable portion is enumerated; archive content is never imported into live clinical or financial tables; a retention rule cannot delete an archive package that is the only remaining record for a retention-required period.

**Failure and recovery:** an unreadable archive removes nothing from live data and raises a visible gap; an archive host outage returns an unavailable state with the reference retained; a superseded archive package remains readable under its own identity rather than being overwritten.

**Completion condition:** the suite shows a verified package served read-only with patient linkage, a failed package not served, and a cross-tenant read denied.

- [ ] Write the integrity, partial, cross-tenant, short-lived-access and retention cases; confirm failure.
- [ ] Implement package registration, verification, patient linkage and scoped read authorization.
- [ ] Run the suite and confirm no archive path writes into live clinical or financial tables.
- [ ] Record that the real archive arrangement remains blocked on M-S2 and commit.

### M8: Practice downtime procedures and timed restore exercise

**Dependencies:** F8 restore smoke test; M1 and M6; M-S3. **Status:** implementation of runbooks and drills; the recovery objective requires a human decision.
**Files (proposed):** `docs/runbooks/downtime.md`, `docs/runbooks/cutover.md`, `docs/runbooks/rollback.md`, `docs/runbooks/restore.md`, `apps/api/src/routes/operations/downtime.ts`, `tests/integration/ops-downtime.test.ts`, `tests/integration/ops-restore.test.ts`.
**Contract:** `openDowntimeLog(ctx, envelope: CommandEnvelope<{ startedAt: string; reason: string }>): Promise<CommandResult<DowntimeLog>>`; `recordManualEvent(ctx, envelope: CommandEnvelope<{ logRef: string; event: ManualEvent }>): Promise<CommandResult<{ eventRef: string }>>` with a manual series identifier; `closeDowntimeLog(ctx, envelope: CommandEnvelope<{ logRef: string }>): Promise<CommandResult<DowntimeLog>>`; `reconcileManualEvents(ctx, { logRef: string }): Promise<{ reconciled: number; unresolved: number; duplicates: readonly string[] }>`; `runRestoreDrill(ctx, { backupRef: string; isolatedTargetRef: string }): Promise<{ result: BackupVerification; measuredRpo: string; measuredRto: string; gap?: string }>`.
**Refusals:** `duplicate_manual_event`, `unreconciled_events`, `incomplete_backup`, `post_cutover_writes`, `cross_tenant`, `drill_target_unavailable`.

**Acceptance cases:** a manual event recorded during downtime can be reconciled later exactly once, without creating a duplicate of the same event entered after recovery; a downtime log that is closed with unreconciled events reports the unresolved count rather than closing silently; a restore drill detects a deliberately incomplete backup by entity class and by count; a restore into an isolated target proves tenant counts, audit and outbox invariants, and denied cross-tenant access; a deleted image or a completed deletion does not reappear as available after restore; a restore performed over an environment with post-cutover writes is refused without an explicit reconciliation step; a rolled-back cutover requires post-cutover clinical and financial events to be captured and reconciled rather than discarded.

**Failure and recovery:** a drill that exceeds the target states the measured duration and the gap rather than rounding to pass; a restore that fails midway leaves the isolated target in a failed state without affecting the source; a downtime log opened by mistake is closed with a reason and no manual series is issued.

**Completion condition:** a timed drill restores a verified backup into an isolated environment and reports measured RPO and RTO against the agreed targets, with any gap named.

- [ ] Write the duplicate-manual-event, incomplete-backup, post-cutover-write, deletion-reappearance and drill-timing cases; confirm failure.
- [ ] Implement downtime logging, manual reconciliation and the restore drill harness.
- [ ] Run the drill against a deliberately incomplete backup and confirm detection.
- [ ] Record the measured result honestly, including any gap, and commit the runbooks.

### M9: Operator ownership, backup verification, support and escalation

**Dependencies:** M8; M-S3; F8 deployment record. **Status:** implementation of records and checks; the named operator and objectives require a human decision.
**Files (proposed):** `docs/deployment/operator-bundle.md`, `docs/deployment/hardware-budget.md`, `docs/runbooks/escalation.md`, `docs/runbooks/backup-verification.md`, `apps/api/src/routes/operations/operator.ts`, `packages/domain/src/operations/operator.ts`, `packages/domain/src/operations/backup-verification.ts`, `tests/integration/ops-operator.test.ts`.
**Contract:** `recordOperatorProfile(ctx, profile: OperatorProfile): Promise<CommandResult<{ operatorRef: string }>>`; `recordBackupVerification(ctx, verification: BackupVerification): Promise<CommandResult<{ verificationRef: string }>>`; `evaluateBackupVerificationFreshness(ctx, { at: string }): Promise<'verified' | 'stale' | 'absent'>`; `describeEscalationPath(ctx, { incidentClass: string }): Promise<{ responderClass: string; expectedFirstResponse: string }>`; `assertReleaseReadiness(ctx): Promise<{ ready: boolean; unmetObligations: readonly string[] }>`.
**Refusals:** `missing_operator`, `stale_verification`, `weak_escalation`, `sla_not_demonstrated`, `responsibility_missing`, `tenant_mismatch`.

**Acceptance cases:** a release readiness check fails when no named operator profile exists, when the last backup verification is stale or absent, or when an escalation path for a security incident is missing; a backup verification that checked only a checksum does not satisfy the isolated-restore requirement for release; an operator profile missing a responsibility is refused; an escalation entry naming only a business-hours contact fails the security-incident requirement; a support claim that implies an SLA the drill has not demonstrated is refused by the readiness check; a verification older than the configured interval reports stale rather than passed; a change of named operator is recorded as a new profile with the prior one retained.

**Failure and recovery:** a verification job that cannot run leaves the state as absent and blocks readiness rather than passing by default; an incident with no named responder escalates to the maintainer contact as a documented fallback; a rotated operator credential is recorded as an event without storing the credential.

**Completion condition:** the readiness check returns an explicit list of unmet operator obligations for a synthetic deployment with no operator, stale backup verification and no security escalation, and returns an empty list only when all three are satisfied.

- [ ] Write the missing-operator, stale-verification, weak-escalation and readiness cases; confirm failure.
- [ ] Implement operator profiles, backup verification records, escalation description and the readiness assertion.
- [ ] Run the suite against a deliberately under-provisioned synthetic deployment.
- [ ] Commit; the named operator, hosting model and objectives remain open decisions.

### M10: Migration parity, negative matrix, export and release evidence

**Dependencies:** M1–M9, plus the spike records from M-S1–M-S3.

**Files (proposed):** `tests/integration/migration-negative-matrix.test.ts`, `tests/integration/ops-parity.test.ts`, `tests/scenarios/ordinary-cutover-day.test.ts`, `docs/api/openapi.yaml`, `docs/runbooks/cutover-evidence.md`.

**Consumes:** every operation this plan introduces. **Produces:** a parity matrix covering REST, MCP and worker paths, an export manifest for migration and operations records, and a cutover evidence runbook.

- [ ] Run the shared negative harness (`tests/integration/negative-harness.test.ts`, stated once in Global Constraints) over every command, asserting the same `Denial` reason code on REST, MCP and the worker path.
- [ ] Write the parity matrix: every migration and operations command through REST and MCP with identical allow, deny and conflict outcomes, including reviewer-role and operator-role denials.
- [ ] Write the export check: runs, staged entities, provenance, opening facts, reports, sign-offs, archive packages, downtime logs, backup verifications and operator profiles export with stable identifiers and digests and verify on re-import.
- [ ] Run the ordinary cutover day scenario: validate a package, stage intake, dry run, apply, resolve identity through S6, record opening balances, build and sign the report, register an archive, run a restore drill and assert readiness.
- [ ] Run the full suite and record every operation present in the matrix with its reason code; commit.

**Observable completion condition:** one test run reports a parity matrix with no operation missing, cutover refused while any exception or readiness obligation is open, and an export that re-imports without identifier loss.

## Open decisions

| Decision | Options | Recommended | What settles it |
|---|---|---|---|
| M-D1 Cutover data scope | Active records only; active plus open items; full history | Active records, open items, opening balances and archive references; no fabricated historical postings | Design review already recommends this; confirms at financial sign-off |
| M-D2 Historical financial detail | Import as transactions; opening balances plus archive | Opening balances plus archive; never reinterpret past events as new ledger entries | Financial reviewer approval |
| M-D3 Archive access model | In-product read-only module; separate viewer; external reference only | In-product read-only module under the same privacy and recovery boundary | M-S2 arrangement and retention review |
| M-D4 Write freeze duration | Fixed window; per-practice agreement | Per-practice agreement with a documented rollback path and post-cutover reconciliation procedure | Practice and operator agreement |
| M-D5 Recovery objectives | Adopt the provisional targets; agree practice-specific targets | Adopt RPO 15 minutes and RTO 4 hours as engineering targets, then replace with demonstrated results | Timed drill under M-S3 |
| M-D6 Hosting model at pilot | Managed; self-hosted by practice; contracted hosting | Contracted hosting with a named operator for the first pilot; self-hosting documented but not claimed as supported until the drill set passes | Operator agreement (M-S3) |
| M-D7 Support tiers | Single free channel; paid tiers; maintainer-only security response | A published security-fix commitment for all users, plus an optional paid operational support tier | Maintainer capacity decision |
| M-D8 Rollback after new work | Database reset; reconcile into restored incumbent; forward-only | Reconcile post-cutover events into the restored incumbent under a pre-agreed runbook; never dual-write | Practice, operator and maintainer agreement |

## Plan self-review and scope boundary

This plan covers the export and import contract, completeness and balance reconciliation, provenance, an archive for unreconcilable history, downtime and restore drills, and operator readiness. It does not specify an incumbent's export format, a vendor's archive arrangement, a hosting provider, or a recovery result, because none has been verified. M2 and M7 are blocked-on-discovery, and no drill result exists yet, so no recovery claim may be made.

No extraction tool for a specific incumbent, no dual-write mechanism and no migration of real records is designed here. Migration of a live practice requires the release gates in the security and readiness document plus explicit cutover authorization. Nothing in this document is implemented, tested or validated.

## Known deviations from docs/SHARED-CONTRACTS.md

- Identity merge and unmerge are owned by S6. `confirmIdentityResolution` was removed from this plan; `applyIdentityResolution` delegates to S6's `mergePatients` with S6's confirmation token, and unmerge delegates to S6's `unmergePatients`. This plan adds no second confirmation mechanism.
- Opening balances, unapplied credit and outstanding claim figures now use the shared `Money` contract, and `balanceComparison` carries `Money` values rather than separate minor-unit and currency fields.
- The reconciliation report is a projection over the run and the target contracts, not a new financial authority. It reads B1 and B5 records and never posts them.
- Typed command contracts and refusal sets were written for all ten tasks. They are proposed shapes, not a published OpenAPI contract until M1 and M10 land.
