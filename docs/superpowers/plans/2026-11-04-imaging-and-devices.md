# Imaging and Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a future execution plan, not authorization to start.

**Goal:** Store dental images and documents in private object storage with provenance and integrity, match acquisitions to the correct patient with a correctable audit trail, keep mounts and annotations as separate versioned objects, define an honest DICOM boundary, and acquire images through a qualified device bridge instead of assuming a browser can reach a sensor.

**Architecture:** Object storage holds bytes; PostgreSQL holds identity, provenance, association, retention and audit. Originals, derived images and annotations are separate records so an annotation never mutates the source. Acquisition enters through one ingress contract with two proposed producers: an operator upload in the browser application and a paired local device bridge on the practice network. DICOM is treated as a container format behind a bounded parser port, not as an implicit capability claim.

**Tech Stack:** Inherits the platform foundation: supported Node LTS, TypeScript, Fastify, PostgreSQL/Supabase, JSON Schema/OpenAPI, Vitest and SQL integration tests. Object storage is reached through an S3-compatible adapter so a managed backend and a self-hosted backend share one boundary. The bridge is a separately reviewed native component; no bridge code is written in this plan.

**Spec:** [Product design](../specs/2026-11-03-dental-pms-design.md), [capability matrix](../../CAPABILITIES.md), [API contract](../../API-AND-MCP.md), [security gates](../../SECURITY-AND-READINESS.md), [observed imaging boundaries](../../WORKFLOW-RESEARCH-COVERAGE.md).

**Task numbering:** this plan's prefix is `I`. Implementation tasks are `I1`–`I9`, discovery spikes are `I-S1`–`I-S3`, and open decisions are `I-D1`–`I-D8`. A cross-workstream reference names the fully qualified task: `F` is [platform foundation](2026-11-03-platform-foundation.md), `S` is [patients and scheduling](2026-11-04-scheduling-and-patients.md), `C` is [clinical record](2026-11-04-clinical-record.md), `B` billing, `E` portal, `M` migration. Spikes have owners, sit in the dependency graph and can block a task. `Blocks` is derived from `Dependencies` and is never maintained as a second list.

## Practice-time acceptance requirements

Consume [PT-01–06 and UX-01–03](../../PRACTICE-TIME-AND-AUTOMATION.md) in the owning tasks: reuse authoritative data, expose current state/next owner, distinguish unavailable from empty, and automate eligible routine steps under explicit policy. Clinical and imaging tasks provide correctly linked evidence for CL-04; scheduling/engagement tasks coordinate cancellation recovery, recall and treatment follow-up with consent and race-safe booking. Preserve human clinical judgment and signatures. Add exception, retry, revocation and provenance cases before implementing these extensions; UI design stays deferred.

## Provider onboarding acceptance

Apply [CN-01–05](../../OPEN-PLATFORM-AND-ONBOARDING.md) to this workstream's provider adapters: guided protected credentials, sandbox/live distinction, required enrollment/verification, explicit capabilities/costs, health, rotation/revocation and recoverable failures. Test interrupted onboarding, failed verification, unsafe live test actions, duplicate callbacks and expired credentials. Provider connection does not establish clinical or production qualification. No CuspAtlas paid tier may gate this adapter; third-party contracts and costs remain explicit.

## Global Constraints

- The [platform foundation](2026-11-03-platform-foundation.md) is a prerequisite for this plan; this plan adds no platform guarantee of its own and does not restate the foundation's synthetic-data, provenance or tenancy rules. Tenant and actor are always derived from context.
- Negative testing is stated once for the whole plan: the shared harness `tests/integration/negative-harness.test.ts` attempts every command cross-tenant, with a revoked membership, with a downgraded role, and through MCP, and each task cites the harness instead of restating the case list.
- Synthetic images only, produced for testing. No patient radiographs, no clinic exports, no vendor sample libraries committed to Git.
- Private storage by default. No public bucket, no guessable object path, no long-lived signed URL in a log or referrer.
- No assumption about sensor access from a browser, about a vendor SDK's language or platform requirements, or about an acquisition system's export format. Each is blocked-on-discovery until the hardware matrix closes.
- The application never receives filesystem paths, shell access or raw device handles. The bridge exposes narrow, typed jobs.
- Image association to a patient is a recorded decision with an actor and time; correcting it appends history rather than overwriting it.
- Retention and deletion rules are configured per tenant and record class; no single universal deletion period is assumed.
- No diagnostic interpretation, measurement claim or rendering fidelity claim is made at pilot.
- This plan owns the image object, its storage, its digest, the patient association and the match decision. C references an image by `imageRef` only and defines no matching or `matchStatus` of its own.

## Research gate before executing this plan

[reference PMS analysis coverage](../../WORKFLOW-RESEARCH-COVERAGE.md) records only an Imaging Studio menu label and public vendor claims. Patient matching, mount and import behavior, annotation, and actual hardware compatibility are **unobserved**. The design already states that first-release imaging is import plus a validated acquisition-software bridge, and that direct sensor acquisition is a later milestone. Nothing in this plan may promote that boundary without a hardware matrix result.

Test evidence is synthetic. A vendor's public description of DICOM support is a vendor claim, not a conformance statement, and must not be converted into a parser requirement.

## Discovery spikes (resolve before the tasks they gate)

### I-S1: Pilot hardware, driver and acquisition-software matrix — blocked-on-discovery

Enumerate each device in a consenting practice: manufacturer, model, capture software and version, operating system, export format, whether a documented integration interface or a watched-folder export exists, whether the vendor requires a specific language runtime or redistribution agreement, licence and support terms, and what happens on capture failure. Blocks I6 and constrains I1, I2 and I5. Stop condition: a written matrix covering at least one practice's ordinary equipment, or the release is scoped to manual file import and declared as such.

### I-S2: DICOM conformance and library licensing — blocked-on-discovery

Establish whether the acquisition software can emit DICOM, which information entities and transfer syntaxes appear, whether images are single-frame or multi-frame, what patient identifiers the files carry, whether a network store or query capability is required at all, and whether a candidate parsing library's licence is compatible with the project's distribution. Blocks I5. Stop condition: recorded synthetic sample files with a written field inventory, or the plan keeps DICOM out of scope and stores proprietary exports as opaque originals.

### I-S3: Where acquisition runs — blocked-on-discovery

Decide whether first release acquires through the existing capture software plus a bridge export, through a bridge that drives a vendor interface, or through manual import with staff confirmation. Blocks I6. Stop condition: a decision record naming the supported path, the operator steps, and the fallback when it is unavailable.

## Implementation review focus

- A signed object URL issued before access revocation must stop working or be short enough that its remaining life is stated; I1 must prove revocation behavior rather than assume it.
- Same bytes uploaded for two different patients must not deduplicate into one association; I2 must keep dedupe scoped to a resolved patient.
- An interrupted upload must never appear as a complete study; I2 must separate staging from availability.
- Correcting a wrong-patient association must preserve both the incorrect and the corrected decision; I3 must not delete the prior link.
- An annotation must not alter the stored original; I4 must prove the source digest is unchanged after annotation and export.
- A revoked device or expired pairing must be denied at job execution, not only at enqueue; I6 must reauthorize.
- A deletion request during an open retention hold must be refused with a visible reason; I8 must not half-delete a study.

## Proposed file structure (create only during authorized execution)

`packages/domain/src/imaging/` owns study registration, association, mounts, annotations, retention and deletion. `packages/contracts/src/imaging/` owns schemas for image objects, provenance, match decisions, bridge jobs and deletion requests. `apps/api/src/routes/imaging/` holds thin REST transports that call only these commands and publish the same operation names to MCP; no route reaches storage or a table directly. `packages/adapters/object-store/` owns the S3-compatible port, a managed implementation and a local implementation for tests. `packages/adapters/dicom/` owns the bounded parser port and a synthetic implementation; no vendor library lands before I-S2 closes. `apps/worker/` hosts ingress finalization and deletion jobs. The bridge protocol schema lives in `packages/contracts/src/bridge/` and is reviewed independently of any bridge implementation. Migrations use `supabase migration new imaging_studies`, `imaging_objects`, `imaging_mounts`, `imaging_annotations`, `imaging_retention`. Tests live in `tests/integration/imaging-*.test.ts` with generated fixtures under `tests/fixtures/imaging/`. Viewer and measurement UI are out of scope.

## Shared interfaces

Proposed contract definitions to create during execution, not code already present:

- `Money` is not used for image bytes or storage in this plan; where a contract would carry a monetary value it uses the shared `Money` contract from [SHARED-CONTRACTS](../../SHARED-CONTRACTS.md#money) and never a scalar amount with a separate currency.
- Identifiers are opaque `<entity>Ref` strings throughout, and tenant is derived from context; no imaging record shape carries a tenant field.
- `ImageRef = { imageRef: string }` is the opaque handle this plan mints for a current association decision. It is the **only** image identifier C stores; `C15` records which encounter an `imageRef` was used in and nothing about the patient match.
- `ImageObject = { objectRef: string; patientRef?: string; stagingState: 'staged' | 'available' | 'quarantined' | 'failed'; contentType: string; byteLength: number; digestSha256: string; storageKey: string; capturedAt?: string; receivedAt: string }` — `patientRef` is absent until association is decided.
- `Provenance = { source: 'operatorUpload' | 'bridgeImport' | 'migrationArchive'; deviceRef?: string; captureSoftware?: string; operatorRef?: string; bridgeJobRef?: string; originalFilename?: string }` — recorded once, never rewritten.
- `StudyRef = { studyRef: string; patientRef: string; modalityLabel: string; acquiredOn?: string; objectRefs: string[] }`.
- `MatchDecision = { decisionRef: string; objectRef: string; patientRef: string; basis: 'operatorSelected' | 'metadataExact' | 'metadataAssisted'; confidence: 'confirmed' | 'unverified'; decidedBy: string; decidedAt: string; supersededBy?: string; reason?: string }`. The current decision mints the `imageRef` that C consumes.
- `Mount = { mountRef: string; studyRef: string; template: string; slots: { slot: number; objectRef: string }[]; version: number }`.
- `Annotation = { annotationRef: string; objectRef: string; kind: string; geometry: unknown; authorRef: string; createdAt: string; version: number }` — stored separately from the object and never burned into the original.
- `BridgeJob = { jobRef: string; deviceRef: string; kind: 'acquire' | 'import' | 'probe'; state: 'queued' | 'claimed' | 'transferring' | 'completed' | 'failed' | 'expired' | 'denied'; attempts: number; expiresAt: string; capabilityGrant: string }`.
- `DeletionRequest = { requestRef: string; objectRef: string; requestedBy: string; reason: string; state: 'pending' | 'blocked' | 'executed' | 'cancelled'; blockReason?: string }`.
- `Denial = { outcome: 'denied'; reasonCode: string; actorRef: string; detailRef?: string }` is returned by every command here that can legitimately refuse; a thrown error is reserved for faults.
- `ObjectStorePort` with `putStaged(stream, expectedDigest)`, `finalize(stagedKey)`, `signRead(objectKey, ttlSeconds)`, `deleteVerified(objectKey)`, and `head(objectKey)`; all methods tenant-scoped and audited on the sensitive paths.

### I1: Private object storage boundary with provenance and integrity

**Dependencies:** F2 and F4. **Status:** implementation.
**Files (proposed):** `packages/contracts/src/imaging/image-object.ts`, `apps/api/src/routes/imaging/objects.ts`, `packages/adapters/object-store/port.ts`, `packages/adapters/object-store/s3-compatible.ts`, `packages/adapters/object-store/local.ts`, `packages/domain/src/imaging/objects.ts`, migration via `supabase migration new imaging_objects`, `tests/integration/imaging-storage.test.ts`.
**Contract:** `registerObject(ctx, envelope: CommandEnvelope<{ stagingKey: string; digest: string; contentType: string; provenance: Provenance }>): Promise<CommandResult<ImageObject>>`; `signObjectRead(ctx, { objectRef: string; ttlSeconds: number }): Promise<{ url: string; expiresAt: string }>`; `readObjectMetadata(ctx, { objectRef: string }): Promise<ImageObject>`; `ObjectStorePort`.
**Refusals:** `tenant_mismatch`, `object_not_available`, `digest_mismatch`, `path_traversal`, `provenance_immutable`, `signed_url_expired`.

**Acceptance cases:** an object written for tenant A cannot be read, signed or described from tenant B, and the denial is indistinguishable from a missing object; a signed read URL expires and is rejected afterwards; a revoked actor cannot obtain a new signed read; an object whose stored digest does not match the registered digest is quarantined rather than served; a storage key containing path traversal or an unexpected prefix is refused; the application role cannot list a bucket directly; provenance is written once and a second write is refused.

**Failure and recovery:** a put that fails leaves a staged object that is never marked available and is reclaimed by a documented sweep; a successful put followed by a database failure leaves an orphan object that reconciliation detects and either registers or removes; a storage outage surfaces as a typed unavailable state and blocks no clinical read of unrelated data.

**Completion condition:** the suite shows cross-tenant read, sign, describe and delete all denied, an expired signature refused, and a digest mismatch quarantined with the stored bytes retained for investigation.

- [ ] Write the cross-tenant, expiry, revoke and digest-mismatch cases; confirm failure.
- [ ] Implement the port with a local backend for tests and an S3-compatible backend behind the same contract; no direct bucket access elsewhere.
- [ ] Run the suite twice: once with an actor revoked between sign and read, once with a digest mismatch.
- [ ] Record the storage boundary and the orphan-sweep policy in an ADR and commit.

### I2: Ingress pipeline with staging, gating and dedupe

**Dependencies:** I1; F6 for finalization. **Status:** implementation.
**Files (proposed):** `packages/domain/src/imaging/ingress.ts`, `packages/domain/src/imaging/gating.ts`, `apps/api/src/routes/imaging/ingress.ts`, `apps/worker/src/imaging-finalize.ts`, `tests/integration/imaging-ingress.test.ts`, `tests/fixtures/imaging/generate.ts`.
**Contract:** `beginIngress(ctx, envelope: CommandEnvelope<{ contentType: string; byteLength: number; declaredDigest: string; provenance: Provenance }>): Promise<CommandResult<{ uploadTarget: string; stagingToken: string }>>`; `completeIngress(ctx, envelope: CommandEnvelope<{ stagingToken: string; observedDigest: string }>): Promise<CommandResult<ImageObject>>` returning an `ImageObject` in `available` or `quarantined`; `listIngressFailures(ctx): Promise<ImageObject[]>`.
**Refusals:** `content_type_mismatch`, `oversize_object`, `digest_mismatch`, `duplicate_completion`, `tenant_mismatch`, `malware_gated`.

**Acceptance cases:** a declared content type that does not match the sniffed content is quarantined; an oversize object is refused at begin time and again at completion if the observed size differs; a completion with a mismatched digest does not produce an available object; two completions of the same staging token produce one object and one replay; identical bytes for the same resolved patient deduplicate to one object with two provenance records, while identical bytes for two different patients produce two objects; a completion referencing another tenant's staging token is denied; an object that fails malware gating is quarantined and never associated.

**Failure and recovery:** an interrupted upload leaves no available object and no study reference; a finalization job that crashes after marking available but before writing the outbox event is retried idempotently; a gating service outage holds objects in `staged` with a visible queue rather than passing them through.

**Completion condition:** after the suite, no path produces an `available` object without a verified digest, and the same bytes imported twice for one patient yield one object with two recorded provenances.

- [ ] Write the accept, quarantine, oversize, duplicate and cross-tenant cases; confirm failure.
- [ ] Implement staging tokens, gating order, digest verification and patient-scoped dedupe.
- [ ] Run the suite with a deliberately truncated upload and a deliberately mismatched digest.
- [ ] Commit the ingress contract before any bridge integration begins.

### I3: Patient matching, association correction and the imageRef

**Dependencies:** I2; S4 for `patientRef`. **Status:** implementation.
**Files (proposed):** `packages/domain/src/imaging/matching.ts`, `packages/domain/src/imaging/association.ts`, `packages/contracts/src/imaging/match-decision.ts`, `apps/api/src/routes/imaging/association.ts`, migration via `supabase migration new imaging_association`, `tests/integration/imaging-matching.test.ts`.
**Contract:** `proposeMatch(ctx, { objectRef: string }): Promise<MatchCandidate[]>` returning candidates with a stated basis and no automatic binding; `confirmAssociation(ctx, envelope: CommandEnvelope<{ objectRef: string; patientRef: string; basis: string }>): Promise<CommandResult<{ decisionRef: string; imageRef: string }>>`; `correctAssociation(ctx, envelope: CommandEnvelope<{ decisionRef: string; patientRef: string; reason: string }>): Promise<CommandResult<{ decisionRef: string }>>`; `listUnmatchedObjects(ctx): Promise<ImageObject[]>`.
**Refusals:** `candidate_not_confirmed`, `association_conflict`, `object_not_available`, `tenant_mismatch`, `missing_reason`, `study_amendment_required`.
**Produces for C:** the current `MatchDecision` and the `imageRef` minted from it. `C15` is the only consumer; it stores the `imageRef` and defines no match status or correction command.

**Acceptance cases:** metadata-only similarity proposes a candidate and never binds it; an exact metadata match still requires a recorded decision before the object becomes part of a patient's record; a shared household name or phone does not produce a match on its own; correcting an association appends a new decision that supersedes the earlier one and leaves the earlier decision readable; the object is never simultaneously associated with two patients as current; a correction to a tenant B patient is denied; an object in `quarantined` or `staged` state cannot be associated; an unmatched object appears in the operator worklist with its age; a current decision mints exactly one `imageRef` and a superseded decision's `imageRef` stops being current.

**Failure and recovery:** if metadata parsing fails, the object remains unmatched with a recorded parse limitation rather than a guessed patient; a concurrent confirmation and correction resolve to one current decision with the other returned as a conflict; a correction that would move an object out of a completed study requires the study to be amended explicitly.

**Completion condition:** the suite shows every available object resolving to exactly one current association decision and one current `imageRef`, and a corrected object retaining both decisions in order.

- [ ] Write the candidate, exact-match-still-requires-decision, correction and cross-tenant cases; confirm failure.
- [ ] Implement candidate proposal, decision recording, `imageRef` minting and worklist queries; no implicit binding anywhere.
- [ ] Run the suite including a concurrent confirm-and-correct pair.
- [ ] Commit; record in the ADR that `imageRef` is the handle C15 consumes.

### I4: Mounts, annotations and derived images as separate objects

**Dependencies:** I1 and I3. **Status:** implementation.
**Files (proposed):** `packages/domain/src/imaging/mounts.ts`, `packages/domain/src/imaging/annotations.ts`, `packages/domain/src/imaging/derived.ts`, `apps/api/src/routes/imaging/composition.ts`, migration via `supabase migration new imaging_mounts_annotations`, `tests/integration/imaging-mounts.test.ts`.
**Contract:** `createMount(ctx, envelope: CommandEnvelope<MountInput>): Promise<CommandResult<Mount>>`; `reviseMount(ctx, envelope: CommandEnvelope<{ mountRef: string; slots: MountSlot[] }>): Promise<CommandResult<Mount>>` returning a new version; `createAnnotation(ctx, envelope: CommandEnvelope<AnnotationInput>): Promise<CommandResult<Annotation>>`; `supersedeAnnotation(ctx, envelope: CommandEnvelope<{ annotationRef: string; reason: string }>): Promise<CommandResult<Annotation>>`; `createDerivedImage(ctx, envelope: CommandEnvelope<{ sourceObjectRef: string; transform: string }>): Promise<CommandResult<ImageObject>>`; `readStudyComposition(ctx, { studyRef: string }): Promise<StudyComposition>`.
**Refusals:** `invalid_slot`, `cross_tenant_object`, `mount_referenced_by_export`, `annotation_object_unavailable`, `source_digest_changed`.

**Acceptance cases:** revising a mount creates a new version and leaves the prior version readable; an annotation never changes the source object's digest; a derived image records its source object, transform description and author, and cannot be presented as an original; a slot referencing an object from another tenant is refused; a slot count or template identifier outside the configured set is refused; superseding an annotation preserves the earlier annotation; deleting a mount version that is referenced by an exported artifact is refused or converted to a soft state with a reason.

**Failure and recovery:** a partially written mount is refused as a whole; an annotation that arrives before its object is available is refused rather than queued indefinitely; a derived-image job failure leaves the source untouched and records a failed derivation.

**Completion condition:** a synthetic study with one original, one revised mount and two annotation versions reads back with the original digest unchanged and every revision addressable.

- [ ] Write the versioning, digest-invariance, cross-tenant and invalid-slot cases; confirm failure.
- [ ] Implement mount versioning, annotation supersession and derived-image provenance.
- [ ] Run the suite and verify the original object digest before and after every operation.
- [ ] Commit.

### I5: DICOM boundary

**Dependencies:** I2; I-S2. **Status:** blocked-on-discovery for format scope; parser port and opaque storage permitted now.
**Files (proposed):** `packages/adapters/dicom/port.ts`, `packages/adapters/dicom/synthetic.ts`, `packages/domain/src/imaging/dicom.ts`, `apps/api/src/routes/imaging/dicom.ts`, `tests/fixtures/imaging/generate-dicom.ts`, `tests/integration/imaging-dicom.test.ts`.
**Contract:** `inspectContainer(ctx, { objectRef: string }): Promise<{ supported: boolean; summary?: ContainerSummary; limitation?: string }>`; `registerContainerObject(ctx, envelope: CommandEnvelope<{ stagingToken: string }>): Promise<CommandResult<ImageObject>>` storing the original opaquely alongside any extracted summary. No network DICOM service in this task.
**Refusals:** `unsupported_container`, `parser_budget_exceeded`, `identifier_disagreement`, `external_reference_refused`, `summary_unverified`.

**Acceptance cases:** an unsupported container stores as an opaque original with an explicit unsupported state and no fabricated metadata; a container claiming patient identifiers that disagree with the association decision does not silently override it; a container with an absurd element length is refused by the parser budget rather than exhausting memory; a container referring to external file references does not cause a fetch; two containers with the same digest deduplicate under the I2 rule; a summary is labeled as parsed-not-verified in the record.

**Failure and recovery:** a parse failure never blocks storage of the original; a parser upgrade that changes a summary does not rewrite the historical summary but records a new parse with its version; a container that requires an unavailable transfer syntax is stored and flagged, not dropped.

**Completion condition:** the suite stores an unsupported container, a malformed container and a valid container, and in all three cases the original bytes are retrievable and the reported state is explicit.

- [ ] Write the unsupported, malformed, disagreement and budget cases; confirm failure.
- [ ] Implement the parser port with a synthetic implementation and strict resource budgets; store originals regardless of parse outcome.
- [ ] Run the suite and confirm no parse outcome alters the stored bytes.
- [ ] Commit; leave network DICOM services and real conformance out of scope under I-S2.

### I6: Device bridge pairing, signed jobs and capability allowlist

**Dependencies:** I1–I3; I-S1 and I-S3. **Status:** blocked-on-discovery for any real device integration; protocol design and synthetic bridge testing permitted.
**Files (proposed):** `packages/contracts/src/bridge/job.schema.json`, `packages/contracts/src/bridge/pairing.md`, `packages/domain/src/imaging/bridge.ts`, `packages/domain/src/imaging/devices.ts`, `apps/api/src/routes/imaging/devices.ts`, migration via `supabase migration new imaging_devices`, `tests/integration/imaging-bridge.test.ts`, `docs/adr/0004-bridge-boundary.md`.
**Contract:** `pairDevice(ctx, enrollmentToken: string): Promise<CommandResult<{ deviceRef: string; credentialRef: string }>>`; `revokeDevice(ctx, { deviceRef: string; reason: string }): Promise<CommandResult<{ deviceRef: string }>>`; `enqueueBridgeJob(ctx, envelope: CommandEnvelope<{ deviceRef: string; kind: 'acquire' | 'import' | 'probe'; scope: string }>): Promise<CommandResult<BridgeJob>>`; `claimJob(deviceCredential): Promise<BridgeJob | null>`; `reportJobResult(deviceCredential, { jobRef: string; state: string; artifactRef?: string }): Promise<CommandResult<BridgeJob>>`. Device credentials are distinct from staff and service credentials.
**Refusals:** `device_unpaired`, `device_revoked`, `capability_not_allowlisted`, `path_outside_import_root`, `replayed_result`, `tenant_mismatch`, `pairing_token_expired`.

**Acceptance cases:** an unpaired device cannot claim a job; a revoked device cannot claim or report, and revocation takes effect for a job already claimed; a job for a device in another tenant is invisible to that device; a job whose `kind` is outside the device's allowlisted capabilities is refused at enqueue; a job carrying an absolute path outside the configured import directory is refused; a replayed result for a completed job is recorded as a duplicate without creating a second object; a pairing token is single-use and expires; bridge credentials cannot call staff API routes, and staff sessions cannot claim bridge jobs.

**Failure and recovery:** a bridge that crashes while transferring leaves a job in `transferring` until expiry, then becomes reclaimable with a bounded attempt count; a duplicate result after expiry is refused and surfaced for operator review; a bridge reporting an unverifiable artifact is denied and the job fails visibly.

**Completion condition:** the suite shows only a paired, non-revoked, in-tenant device can claim and complete a job, and a replay produces no second object.

- [ ] Write the pairing, revocation, cross-tenant, capability and replay cases; confirm failure.
- [ ] Implement pairing, device credential issuance and revocation, job enqueue/claim/report, and the capability allowlist.
- [ ] Run the suite including revocation between claim and report.
- [ ] Record the bridge boundary in the ADR and commit; keep vendor specifics open under I-S1 and I-S3.

### I7: Offline device, bridge failure and recovery worklist

**Dependencies:** I2 and I6. **Status:** implementation for state and worklist; device-specific messaging blocked-on-discovery.
**Files (proposed):** `packages/domain/src/imaging/bridge-health.ts`, `packages/domain/src/imaging/offline.ts`, `apps/api/src/routes/imaging/worklist.ts`, `tests/integration/imaging-offline.test.ts`.
**Contract:** `recordDeviceHeartbeat(ctx, { deviceRef: string; at: string }): Promise<CommandResult<void>>`; `deriveDeviceAvailability(ctx, { deviceRef: string }): Promise<{ state: 'available' | 'stale' | 'offline'; asOf: string }>`; `enqueueOrDeferAcquisition(ctx, envelope: CommandEnvelope<AcquisitionRequest>): Promise<CommandResult<{ state: 'queued' | 'deferred'; jobRef?: string; deferReason?: string }>>`; `listAcquisitionWorklist(ctx, filter): Promise<WorklistItem[]>`; `resolveDeferredAcquisition(ctx, envelope: CommandEnvelope<{ deferRef: string; action: 'release' | 'cancel'; reason?: string }>): Promise<CommandResult<WorklistItem>>`.
**Refusals:** `device_offline`, `queue_bound_reached`, `unresolved_association`, `duplicate_release`, `missing_reason`.

**Acceptance cases:** an acquisition requested while a device is offline becomes a visible deferred item with a reason, not a silent failure or an indefinite spinner state; when the device returns, a deferred item can be released to a job exactly once; a queue with more deferred items than a configured bound refuses further requests with a typed reason rather than growing without limit; an operator cancellation of a deferred item is recorded with actor and reason; a device that reports stale heartbeat does not appear available; an acquisition for a patient whose association is unresolved cannot be completed and stays visible.

**Failure and recovery:** a bridge restart after reconnection does not duplicate previously completed jobs; a deferred item whose patient record changed is flagged for re-confirmation rather than captured against the new state silently; a device that never returns leaves the item resolvable by manual import.

**Completion condition:** an acquisition attempted with no reachable device appears in the worklist with a reason, and releasing it after reconnection produces exactly one job and one object.

- [ ] Write the offline, release-once, bounded-queue, stale-heartbeat and unresolved-association cases; confirm failure.
- [ ] Implement heartbeat-derived availability, deferred acquisition state and worklist queries.
- [ ] Run the suite with a device that disappears mid-transfer and returns.
- [ ] Commit; keep device-specific operator guidance open until I-S1 closes.

### I8: Retention, deletion and legal hold

**Dependencies:** I1–I4; F4; a jurisdiction decision. **Status:** implementation of the mechanism; policy values require a human decision.
**Files (proposed):** `packages/domain/src/imaging/retention.ts`, `packages/domain/src/imaging/deletion.ts`, `apps/api/src/routes/imaging/retention.ts`, migration via `supabase migration new imaging_retention`, `tests/integration/imaging-retention.test.ts`, `docs/runbooks/deletion.md`.
**Contract:** `setRetentionPolicy(ctx, { recordClass: string; minimumRetention: string; basis: string }): Promise<CommandResult<void>>`; `requestDeletion(ctx, envelope: CommandEnvelope<{ objectRef: string; reason: string }>): Promise<CommandResult<DeletionRequest>>`; `evaluateDeletion(ctx, { requestRef: string }): Promise<{ blocked: boolean; rule: string; earliestDate?: string }>`; `executeDeletion(ctx, envelope: CommandEnvelope<{ requestRef: string }>): Promise<CommandResult<DeletionRequest>>`; `placeLegalHold(ctx, { subjectRef: string; reason: string }): Promise<CommandResult<void>>`; `releaseLegalHold(ctx, { holdRef: string; reason: string }): Promise<CommandResult<void>>`.
**Refusals:** `legal_hold_active`, `minimum_retention_not_met`, `archive_owner_review`, `tenant_mismatch`, `deletion_incomplete`.

**Acceptance cases:** a deletion request under an active legal hold is refused with the hold as the stated reason; a deletion request before the minimum retention period is refused with the computed earliest date; an executable deletion removes bytes, marks the object record as deleted, retains the audit entry and provenance, and leaves the study reference visibly incomplete rather than silently shorter; derived images and thumbnails are deleted with the original; a deletion attempted across tenants is denied; a deletion of one object inside a mount leaves the mount version readable with an explicit missing-slot state; an object referenced by an exported archive is flagged for archive-owner review before deletion.

**Failure and recovery:** a deletion that removes bytes but fails to record completion is retried idempotently and reports the same outcome; a policy change never retroactively deletes already-retained objects without a new explicit request; a deletion executed during a restore drill is reconciled against the backup so the object does not reappear as available.

**Completion condition:** the suite shows a blocked request with a computed reason, an executed request with retained audit and provenance, and a restore that does not resurrect a completed deletion as available.

- [ ] Write the hold, minimum-retention, partial-study, cross-tenant and restore cases; confirm failure.
- [ ] Implement policy evaluation, deletion execution with tombstone and audit retention, and hold handling.
- [ ] Run the deletion suite, then the restore check, and confirm the deleted object is not available afterwards.
- [ ] Record that retention values remain an open decision and commit the mechanism only.

### I9: Imaging parity, negative matrix, export and release evidence

**Dependencies:** I1–I8, plus the spike records from I-S1–I-S3.

**Files (proposed):** `tests/integration/imaging-negative-matrix.test.ts`, `tests/integration/imaging-parity.test.ts`, `tests/scenarios/ordinary-imaging-day.test.ts`, `docs/api/openapi.yaml`, `docs/runbooks/imaging-recovery.md`.

**Consumes:** every operation this plan introduces. **Produces:** a parity matrix covering REST, MCP, bridge and worker paths, an export manifest for image objects and provenance, and a recovery runbook that does not claim diagnostic fidelity.

- [ ] Run the shared negative harness (`tests/integration/negative-harness.test.ts`, stated once in Global Constraints) over every command, asserting the same `Denial` reason code on REST, MCP and the bridge-credential path.
- [ ] Write the parity matrix: every imaging command through REST and MCP with identical allow, deny and conflict outcomes, including revoked device and expired pairing cases.
- [ ] Write the export check: image objects, provenance, match decisions, mounts, annotations and retention state export with stable identifiers and digests, and `imageRef` re-imports without identifier loss.
- [ ] Run the ordinary imaging day scenario: begin and complete an ingress, match and associate an object, mount it, annotate it, register a container, request a deletion and refuse it under a hold.
- [ ] Run the full suite and record every operation present in the matrix with its reason code; commit.

**Observable completion condition:** one test run reports a parity matrix with no operation missing, every cross-tenant and revoked-device path denied with the same reason code, and an export that re-imports `imageRef` values without loss.

## Open decisions

| Decision | Options | Recommended | What settles it |
|---|---|---|---|
| I-D1 Storage backend | Supabase Storage; S3-compatible managed; self-hosted object store | One S3-compatible abstraction with a managed implementation at pilot and a documented self-hosted option | Operator decision plus BAA scope and cost (see migration/operations plan) |
| I-D2 Acquisition path at pilot | Manual import; bridge export from existing capture software; bridge driving a vendor interface | Bridge export from existing capture software, with manual import as the documented fallback | I-S1 and I-S3 hardware matrix |
| I-D3 DICOM scope | Opaque storage only; opaque plus metadata summary; full network services | Opaque storage plus a bounded metadata summary; no network DICOM services at pilot | I-S2 conformance samples and library licensing |
| I-D4 Annotation storage | Burned into exported copy; stored separately and re-rendered | Stored separately, with generated export copies marked as derived | Clinical reviewer confirmation that separate storage matches charting expectations |
| I-D5 Retention defaults | One universal period; per record class; per jurisdiction | Per record class with jurisdiction configuration, no universal default shipped | Legal and clinical review per pilot jurisdiction |
| I-D6 Deletion authority | Any clinician; practice manager; dual approval | Dual approval for images, with a single-actor path only for objects never associated to a patient | Practice policy and legal review |
| I-D7 Bridge distribution | Unsigned installer; signed installer with update channel | Signed installer and signed updates with a revocation path | I-S1 vendor requirements and operator capability |
| I-D8 Unmatched image age bound | Auto-discard; indefinite; escalate after a configured age | Escalate to the operator worklist after a configured age; never auto-discard | Operator decision at pilot |

## Plan self-review and scope boundary

This plan covers storage boundaries, ingress gating, association and the `imageRef` handle, mounts and annotations, a bounded DICOM treatment, bridge protocol design and retention mechanics. It does not specify a device SDK, an acquisition sequence, a DICOM conformance profile or a retention period, because none has been verified. I5 and I6 remain blocked-on-discovery and cannot be reported as complete on a synthetic parser and a synthetic bridge.

No viewer, measurement tool, printing pipeline, diagnostic interpretation or direct sensor acquisition is designed here. Direct acquisition remains a separate milestone per the design, and UI design remains the last planning stage. Nothing in this document is implemented, tested or validated.

## Known deviations from docs/SHARED-CONTRACTS.md

- The `imageRef` handle is minted by I3 and consumed only by C15. This is a deliberate one-way contract: imaging owns storage, digest, patient association and matching, and no clinical table stores those fields. The earlier clinical-side `matchStatus` and `correctReferenceAssociation` were removed from C, not duplicated here.
- No `Money` field exists in this plan. The shared `Money` contract is cited so that any later monetary field (for example an export cost line) cannot arrive as a scalar pair.
- Typed command contracts and refusal sets were written for all nine tasks. They are proposed shapes, not a published OpenAPI contract until I1 and I9 land.
