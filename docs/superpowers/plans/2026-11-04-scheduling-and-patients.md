# Patients and Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a future execution plan, not authorization to start.

**Goal:** Add patient identity, guardian relationships and an accountable scheduling surface in which a request, a booking, attendance and a notification decision are separate persisted facts, and a booking refusal is an inspectable conflict result rather than a silent failure.

**Architecture:** Two domain modules over the platform service. `patients` owns identity, relationship grants and duplicate resolution. `scheduling` owns resources, requests, availability, holds, bookings, attendance, recurrence, waitlist and recall. Booking authority is the database constraint set plus domain validation, so concurrent attempts cannot both succeed by trusting a rendered grid. Notification delivery is an outbox consumer; the booking transaction records only the decision and the intent.

**Tech Stack:** The foundation stack only: supported Node LTS, TypeScript, Fastify, PostgreSQL/Supabase, JSON Schema/OpenAPI, Vitest with SQL integration tests. This plan introduces no additional runtime, queue vendor or messaging vendor.

**Spec:** [Product design](../specs/2026-11-03-dental-pms-design.md), [capability matrix](../../CAPABILITIES.md), [API and MCP contract](../../API-AND-MCP.md), [status vocabularies](../../REFERENCE-STATE-VOCABULARIES.md), [domain-model observations](../../REFERENCE-DOMAIN-OBSERVATIONS.md).

**Depends on:** [platform foundation](2026-11-03-platform-foundation.md) Tasks 1-8, especially transactional policy (2), versioned contracts (3), atomic audit and outbox (4), idempotency (5) and the durable worker with fresh authorization (6).

**Task numbering:** this plan's prefix is `S`. Implementation tasks are `S1`–`S17`, discovery spikes are `S-S1`–`S-S3`, and open decisions are `S-D1`–`S-D8`. A cross-workstream reference names the fully qualified task: `F` is [platform foundation](2026-11-03-platform-foundation.md), `C` is [clinical record](2026-11-04-clinical-record.md), `B` billing, `I` imaging, `E` portal and communications, `M` migration. Spikes have owners, sit in the dependency graph and can block a task. `Blocks` is derived from `Dependencies` and is never maintained as a second list.

## Practice-time acceptance requirements

Consume [PT-01–06 and UX-01–03](../../PRACTICE-TIME-AND-AUTOMATION.md) in the owning tasks: reuse authoritative data, expose current state/next owner, distinguish unavailable from empty, and automate eligible routine steps under explicit policy. Clinical and imaging tasks provide correctly linked evidence for CL-04; scheduling/engagement tasks coordinate cancellation recovery, recall and treatment follow-up with consent and race-safe booking. Preserve human clinical judgment and signatures. Add exception, retry, revocation and provenance cases before implementing these extensions; UI design stays deferred.

## Global Constraints

- This is a reviewed proposal. Nothing here is implemented, tested, validated or authorized.
- US general dentistry first. No locale-specific payer, legal or clinical rule is fixed in this plan.
- Synthetic patients, staff, providers, locations and resources only, in fixtures, examples, logs and issue text.
- No vendor contract, messaging agreement, clearinghouse relationship or clinical rule is asserted. Unverified behaviour is marked blocked-on-discovery with a named owner and a probe.
- Patient identity, appointment request, booking, attendance, clinical completion and billing are separate facts. An attendance command writes no clinical or financial state; a booking command implies no treatment.
- No pseudo-resource. A resource never represents an appointment state, and an appointment may carry no operatory with a typed exception reason.
- Tenant and actor are derived from authenticated context; no record shape in this plan carries a tenant field.
- Negative testing is stated once for the whole plan: the shared harness `tests/integration/negative-harness.test.ts` attempts every command cross-tenant, with a revoked membership, with a downgraded role and through MCP, and each task cites the harness instead of restating the same list.
- Instants are stored with an explicit IANA zone for display; durations are integer minutes. Money is out of scope in this workstream, but where a field would carry money it uses the shared `Money` contract and never a scalar amount with a separate currency.
- No UI layout, component or interaction design is included.

## Evidence gate before executing this plan

Consult [Tab32 analysis coverage](../../WORKFLOW-RESEARCH-COVERAGE.md). Appointment entry was inspected as an empty form; saved conflict behaviour, transition guards, recurrence exceptions, rescheduling history, waitlist semantics and recall rules were not tested. The observed status vocabulary mixes lifecycle, physical presence, clinical completion, financial completion and exception into one field, which is why this plan splits them. Pseudo-operatories with state-like labels demonstrate a model that required every appointment to occupy a room; this plan removes that requirement instead of reproducing the workaround.

Observed labels are prompts, not semantics. Before implementation, the spikes in Tasks 1-3 must replace each inferred rule with a recorded decision or an explicit unknown. Transaction behaviour is verified in a sandbox or synthetic environment only; no production appointment is created, moved or cancelled to test behaviour.

## Open decisions (human required)

- **S-D1 Recurrence cap.** Question: the maximum occurrences a single booking request may create, and what happens at the limit. Recommended option: 26 occurrences per request, a documented hard ceiling of 52 in configuration, and an explicit "continue series" action that creates the next block rather than silently extending. The limit is published in the contract and named in the refusal reason code. Blocks S13.
- **S-D2 Merge reversibility.** Question: whether a patient merge can be undone, by whom, and for how long. Recommended option: merge is reversible while no new clinical or financial fact references the survivor after the merge; after that, reversal requires an elevated role plus a reconciliation review. Both paths audited. Blocks S6.
- **S-D3 Duplicate candidate presentation.** Question: which agreeing fields produce a candidate. Recommended option: candidate scoring for staff review with reasons shown, never automatic merge; shared phone, address or household membership never merge on their own. Blocks S6.
- **S-D4 Guardian and proxy terms.** Question: default authority duration and scope for guardians and portal proxies, and the age at which guardian authority ends. Recommended option: configurable per tenant with a jurisdiction review before release, guardian authority until the configured age of majority, proxy grants time-boxed and explicitly renewed. Blocks S5.
- **S-D5 First-release messaging channels.** Question: whether SMS, email, voice or portal messaging is in the first replacement release. Recommended option: implement intent recording only, with no verified channel, until S-S2 qualifies a provider with terms and delivery receipts; add channels behind `E`'s same contract. Blocks delivery in E7, not intent recording in S14.
- **S-D6 Waitlist offer semantics.** Question: whether an offer holds the slot and for how long. Recommended option: an offer creates a short-lived hold with an expiry, and no offer ever books without an explicit staff or patient acceptance command. Blocks S15.
- **S-D7 Recall basis.** Question: what makes a patient due for recall and whether already-booked patients are excluded by default. Recommended option: interval configured per practice and per recall category, exclusion rule explicit and default on, due list states the policy version and freshness. Blocks S16.
- **S-D8 Patient scope within a tenant.** Question: whether a patient belongs to the tenant or to a location. Recommended option: tenant-wide patient identity with location-level access policy for scheduling, clinical and financial workflows. Blocks S4.

## Implementation review focus

- Two concurrent bookings for one constrained resource: S10 must yield one `booked` and one `conflict` result, with no partial rows and no second audit success.
- Cancellation or rollback after a notification intent: S14 must record no send, and E7 must reconcile an attempt that already reached a provider rather than resending it.
- Merge of overlapping duplicate sets: S6 must preserve both source identifiers, refuse cross-tenant sources and never rewrite signed clinical content.
- Guardian grant expired or revoked between session issue and command: S5 must deny using fresh authorization.
- Recurrence one over the cap: S13 must return a denial naming the limit and write nothing, rather than truncating a series.

## Proposed file structure (create only during authorized execution)

`packages/domain/src/patients/` holds identity, relationships and duplicate resolution. `packages/domain/src/scheduling/` holds resources, requests, availability, booking, attendance, recurrence, waitlist and recall. `packages/contracts/src/` holds JSON Schema and generated types. `apps/api/src/routes/` holds thin transports. `apps/worker/src/` holds no notification delivery handler; E7 owns outbound delivery. `supabase/migrations/` holds schema, constraints, grants and RLS. `tests/integration/` proves isolation and invariants; `tests/scenarios/` holds the synthetic day. No UI package, no native project and no vendor SDK is added here.

## Shared interfaces

Proposed definitions to create during authorized execution, extending the foundation contracts:

- `Money` is not redefined here. It comes from [the shared contract](../../SHARED-CONTRACTS.md#money) as `Money = { currency: string; minor: integer }`; this plan introduces no scalar `amountMinor`/`currency` pair and performs no rounding of its own.
- Identifiers are opaque `<entity>Ref` strings throughout, and tenant is derived from context rather than stored on a shape. `ResourceRef` is the only composite reference, and its inner identifier is itself a ref.
- `ResourceRef = { kind: 'provider' | 'operatory' | 'equipment' | 'staff'; resourceRef: string }`.
- `BookingWindow = { startsAt: string; endsAt: string; timeZone: string }` with instants in UTC and duration derived, never a floating local time.
- `BookingResult = { outcome: 'booked' | 'held' | 'conflict' | 'denied'; appointmentRef?: string; holdRef?: string; conflicts: readonly Conflict[]; denial?: Denial }`. `conflict` and `denied` are typed domain refusals, not successful operations; map them using SHARED-CONTRACTS transport rules. A conflict carries a non-empty conflict list; a denial carries the policy reason code and the actor. Typed policy exceptions are normalized at the command boundary; unexpected faults remain faults. Refusal details are filtered to the caller's authorized visibility. `BookingOutcome` and `ConflictResult` do not exist.
- `Denial = { outcome: 'denied'; reasonCode: string; actorRef: string; detailRef?: string }` is the attempt/refusal/reason shape used by every command in this plan that can legitimately refuse, so a refusal is recorded and auditable rather than thrown.
- `Conflict = { kind: 'resource_overlap' | 'provider_assignment' | 'outside_availability' | 'insufficient_duration' | 'patient_unavailable' | 'patient_inactive' | 'policy_override_required'; resourceRef?: ResourceRef; existingRef?: string; explanation: string; overrideable: boolean }`.
- `AppointmentRequestRecord` and `AppointmentRecord` are distinct aggregates with distinct states; a request holds no resource and blocks nothing.
- `AttendanceTransition = { appointmentRef: string; kind: 'confirmed_manual' | 'confirmed_automated' | 'arrived' | 'arrived_curbside' | 'waiting' | 'in_care' | 'late' | 'left_without_treatment' | 'no_show' | 'cancelled' | 'rescheduled'; occurredAt: string; reasonCode?: string; note?: string }`; clinical completion and billing are not attendance kinds.
- `NotificationIntent = { intentRef: string; subjectRef: string; purpose: 'reminder' | 'waitlist_offer' | 'recall'; channel: 'none' | 'sms' | 'email' | 'voice' | 'portal'; suppressionDecisionRef?: string; policyRef: string; templateRef?: string }`. Consent, opt-out and the suppression decision belong to `E`; this plan records the intent and cites the decision by reference, and never re-derives a reason.
- `PatientSummary` is the minimum projection used by search and lists; it never carries clinical or financial detail.

### S-S1 (discovery spike): Patient identity, matching and merge workflow

Dependencies: none technical. Blocks S4, S5 and S6.

Files (proposed): `docs/adr/0003-patient-identity.md`, a reviewer sign-off note referenced from the ADR.

Consumes: the capability row for patient identity and the family/consent row. Produces: a decision record covering matching fields, candidate presentation, merge field precedence, required confirmation, roles permitted to merge, reversibility per S-D2, unmerge window, and the retention expectation for merged records.

- [ ] Prepare the question list and two synthetic duplicate pairs that exercise each answer, including a shared household phone and a same-name different-birth-date pair.
- [ ] Walk the permitted environment read-only with reception and practice-management reviewers; record no production record content.
- [ ] Write the decision record; mark each item decided, recommended-pending-approval, or blocked with an owner.
- [ ] Attach reviewer sign-off; commit and link the record from S4, S5 and S6.

**Observable completion condition:** a committed decision record names the matching fields, the merge confirmation steps, the roles, the reversibility rule and every unresolved item, and S4, S5 and S6 cite it.

### S-S2 (discovery spike): Notification channel and reminder qualification

Dependencies: none technical. Blocks S14; delivery in E7 is blocked on this spike through S14. Status: blocked-on-discovery until a provider is verified.

Files (proposed): `docs/integrations/notifications-qualification.md`.

Consumes: the communications capability row. Produces: a per-channel qualification note stating, for each of SMS, email, voice and portal, whether consent capture, opt-out, quiet hours, delivery receipts, templating, cost model, data-processing terms and a test environment are verified, unavailable or unknown, each with an owner.

- [ ] Enumerate channels and the minimum contract each must expose to satisfy E7's delivery, suppression and reconciliation requirements.
- [ ] Record access requirements, sandbox availability, contractual terms and delivery-receipt semantics per channel; do not sign, purchase or configure anything.
- [ ] Record the fallback: S14 must operate with `channel: 'none'` and E6 must expose a staff-visible worklist when no channel is verified.
- [ ] Commit the note with explicit unknown rows rather than assumed values.

**Observable completion condition:** every channel row carries a verified, unavailable or unknown status with an owner, and S14 can be executed without selecting a vendor.

### S-S3 (discovery spike): Recurrence, waitlist and recall policy validation

Dependencies: none technical. Blocks S9, S13, S15 and S16.

Files (proposed): `docs/adr/0009-scheduling-policy.md`.

Consumes: the observed recurrence label, scheduler tool inventory and the recall capability row. Produces: recorded answers for the recurrence cap and continuation behaviour (S-D1), waitlist offer and expiry semantics (S-D6), recall interval basis and exclusion rules (S-D7), and the documented rule for month-end and daylight-saving occurrences. Whether a due patient may be contacted is not decided here; it is E's suppression decision.

- [ ] Draft the policy questions with the recommended option and the consequence of each alternative.
- [ ] Obtain clinical and practice-management decisions; record who decided and what remains undecided.
- [ ] Write the occurrence rule for short months and clock changes as an explicit statement, not an implementation detail.
- [ ] Commit; mark any undecided item as blocking for the task it gates.

**Observable completion condition:** every policy item is recorded as decided, recommended-pending-approval or blocking, with the deciding role named.

### S4: Patient identity core

Dependencies: F2–F5; S-S1; S-D8 for scope. Blocks S5, S6, S8 and S16.

Files (proposed): `packages/domain/src/patients/identity.ts`, `packages/contracts/src/patient.schema.json`, `apps/api/src/routes/patients.ts`, migration via `supabase migration new patient_identity`, `tests/integration/patient-identity.test.ts`.

Consumes: `authorize`, `withTenantTransaction`, `executeOnce`, `recordCommand`. Produces: `createPatient`, `updatePatientDemographics`, `setPatientStatus`, `readPatient`, `searchPatients`; `PatientSummary`; scopes `patients.read` and `patients.write`.

Contract (proposed):

- `createPatient(ctx, envelope: CommandEnvelope<PatientInput>): Promise<CommandResult<PatientSummary>>`; a refusal is `Denial` with a reason code, never a thrown error.
- `updatePatientDemographics(ctx, envelope: CommandEnvelope<PatientDemographicsInput>): Promise<CommandResult<PatientSummary>>` requires `expectedVersion`; a stale version returns a typed conflict with reconciliation guidance.
- `setPatientStatus(ctx, envelope, { status: 'active' | 'inactive' | 'deceased', effectiveAt, reasonCode })` is an effective-dated state change, not a delete, and returns `CommandResult<PatientSummary>`.
- `searchPatients(ctx, query: PatientQuery): Promise<PatientSummaryPage>` accepts bounded filters, returns `PatientSummary` only, is cursor-paginated, and is audited as a sensitive read; it returns an empty page rather than a denial-shaped error for a foreign tenant.
- Identity fields: legal and preferred name, pronouns, birth date with an explicit precision, language, contact preferences per channel, typed identifiers with issuer, address, and provenance for each field group. Contact values are stored but never emitted in logs, errors, events or audit payloads.

Acceptance cases:

1. Creating a patient with the minimum required fields returns a version and commits identity, audit and outbox atomically.
2. Re-submitting the same idempotency key returns the same patient and one audit success, not two patients.
3. Two patients sharing a household phone remain separate records after creation and after search; neither search nor creation proposes a merge.
4. A deceased or inactive patient is readable but cannot be used for a new request or booking; the refusal names the patient state.
5. A read or update attempted by another tenant is denied, and the error does not reveal whether the record exists.
6. A required field group with unknown value is stored as explicitly unknown, never as an empty string that reads as "none".

Failure and recovery cases:

1. A partial write during creation rolls back identity, audit and outbox together.
2. A concurrent update with the same `expectedVersion` yields one commit and one typed conflict.
3. An unsupported birth-date precision or an unparseable IANA zone is rejected before any write.
4. A patient whose contact block is absent is created successfully and is later reported as not contactable, not as contactable by default.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing integration tests; record the expected typed error codes.
- [ ] Implement schema, migration, grants, RLS and handlers; no route reaches the tables directly.
- [ ] Run `pnpm test:integration -- patient-identity` under the restricted runtime role; expect every case to pass.
- [ ] Commit with the case list and the audit evidence reference in the task log.

**Observable completion condition:** a synthetic patient can be created, read, updated and searched with exactly one audit success per command, an explicit unknown where data is absent, and a denied cross-tenant attempt for every command.

### S5: Guardian, guarantor and proxy relationships

Dependencies: S4; F2, F4–F5; S-S1; S-D4. Blocks S6 and C13. This task owns the relationship model, the scope names and the policy hook; E1 projects them and defines no parallel grant model or expiry rule.

Files (proposed): `packages/domain/src/patients/relationships.ts`, `packages/domain/src/policy/patient-access.ts`, `packages/contracts/src/patient-relationship.schema.json`, migration via `supabase migration new patient_relationships`, `tests/integration/patient-relationships.test.ts`.

Consumes: `authorize`, `executeOnce`, `recordCommand`. Produces: `addRelationship`, `revokeRelationship`, `listRelationships`, `resolvePatientAccess(ctx, patientRef)`; relationship kinds `guardian`, `guarantor`, `dependent`, `proxy`.

Contract (proposed):

- `resolvePatientAccess(ctx, patientRef): Promise<PatientAccess>` returns the effective relationship, its scope, its expiry and the reason, computed at command time from current state.
- A relationship row records subject, counterparty, kind, scope, effective window, evidence reference and status; revocation sets an end instant and never deletes the row.
- Scope is explicit and this plan owns the names: `demographics`, `scheduling`, `clinical_read`, `financial`, `consent`. These are relationship scopes, a namespace distinct from the staff action scopes in the shared registry; E1's `PortalGrant` is a projection that carries exactly these five names and introduces no second taxonomy and no second expiry rule. Staff roles do not inherit relationship scopes, and relationships grant no staff capability.

Acceptance cases:

1. A guardian relationship for a synthetic minor permits scoped demographic and scheduling access and denies note signing.
2. A relationship past its expiry denies access while the patient record and the relationship history remain intact.
3. A relationship revoked before a command denies that command even though the caller's session was issued earlier.
4. An adult patient revoking a proxy produces a denial on both the REST and MCP surfaces for the same operation.
5. A relationship naming a patient from another tenant is refused at creation, and no partial row is written.
6. Two active guardians for one minor are allowed; an attempt to create a second exclusive guarantor where the model requires one returns a typed conflict.

Failure and recovery cases:

1. Expiry boundary evaluated with a server clock, not the client clock; a caller cannot extend its own window.
2. Revocation racing an open command fails closed at the next authorization check; the command already committed is retained and audited, not rewritten.
3. A relationship whose counterparty is later merged is relinked by S6 and the history shows both relationships.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests, including one REST/MCP pair.
- [ ] Implement the relationship model, the access resolver and the migration with grants and RLS.
- [ ] Run `pnpm test:integration -- patient-relationships`; expect every allow and deny case to pass.
- [ ] Commit; record E1 as the consumer of this model, and note the relationship scope registration in the deviations section rather than minting new names silently.

**Observable completion condition:** one synthetic minor with an active guardian and one expired proxy demonstrates permitted demographic reads, denied signing, denied expired access and denied revoked access on both transports, with each decision audited.

### S6: Duplicate candidate review, merge and unmerge

Dependencies: S-S1, S4 and S5; F4–F5; S-D2 and S-D3. Blocks S8 and M4. This plan owns merge and unmerge; M4 consumes these commands and defines no second confirmation command.

Files (proposed): `packages/domain/src/patients/duplicates.ts`, `packages/contracts/src/patient-merge.schema.json`, migration via `supabase migration new patient_merge`, `tests/integration/patient-merge.test.ts`.

Consumes: `executeOnce`, `recordCommand`, `resolvePatientAccess`. Produces: `findDuplicateCandidates`, `mergePatients`, `unmergePatients`, `listMergeHistory`.

Contract (proposed):

- `findDuplicateCandidates(ctx, patientRef): Promise<DuplicateCandidate[]>` returns scored candidates with the contributing reasons and no automatic action.
- `mergePatients(ctx, envelope, { survivorRef, mergedRef, confirmation }): Promise<CommandResult<MergeResult>>` requires an explicit confirmation token issued by the server for that specific pair, a permitted role, and a stated reason; a refusal returns `Denial` with the reason code, and a concurrent overlapping merge returns a typed conflict.
- `unmergePatients(ctx, envelope, { mergeRef, reason }): Promise<CommandResult<MergeResult>>` is the only reversal path; it is never exposed as a second confirmation command in another plan.
- Merge re-points requests, bookings, relationships and clinical record references to the survivor, writes a permanent merge link with both source identifiers, and records audit plus outbox. It never edits the content or authorship of a signed clinical record; only the patient reference changes, and that change is audited.
- Unmerge is permitted only under the S-D2 rule; it appends a reversal link and never deletes the merge link.

Acceptance cases:

1. A candidate list for two patients sharing a phone shows reasons and performs no write and no outbox event.
2. A merge moves the enumerated record classes, leaves one survivor, and the merged record is readable only through its merge history.
3. Every moved record appears in the merge result with its prior owner; the count in the result equals the count the history reports afterwards.
4. A merge without a valid confirmation token, or by a role without the merge scope, is refused with a typed denial.
5. A cross-tenant merge is refused, and the error does not confirm the second patient's existence.
6. Unmerge inside the permitted window restores the prior links; outside it, the request is refused with an explicit code rather than a generic error.
7. A signed note touched by a merge still verifies against its original content digest after the merge.

Failure and recovery cases:

1. A merge that fails partway rolls back every re-point, the merge link, audit and outbox together.
2. Two concurrent merges over overlapping patients produce one committed merge and one typed conflict; no record is re-pointed twice.
3. A merge referencing a record class that cannot be re-pointed under policy fails before any write and lists the blocking references.
4. A merge of an already-merged patient requires resolving the prior merge first.

Steps:

- [ ] Write cases 1-7 and the failure cases as failing tests, including the digest verification after merge.
- [ ] Implement candidate scoring, the confirmation token, merge and unmerge with the migration and constraints.
- [ ] Run `pnpm test:integration -- patient-merge`; expect all cases to pass.
- [ ] Commit; record the record classes that merge does not cover as an explicit limitation.

**Observable completion condition:** overlapping synthetic duplicates merge and unmerge in one scenario where every moved record is enumerated, no signed content digest changes, and the cross-tenant and concurrent attempts are refused.

### S7: Resource, operatory and time-block model

Dependencies: F2–F4. Blocks S8, S9 and S10.

Files (proposed): `packages/domain/src/scheduling/resources.ts`, `packages/contracts/src/resource.schema.json`, `apps/api/src/routes/resources.ts`, migration via `supabase migration new scheduling_resources`, `tests/integration/resources.test.ts`.

Consumes: `authorize`, `recordCommand`. Produces: `defineResource`, `setResourceAvailability`, `createTimeBlock`, `deactivateResource`, `listResources`; `ResourceRef`; the reserved exception vocabulary.

Contract (proposed):

- Resource kinds are `provider`, `operatory`, `equipment` and `staff`. A resource has a kind, a location, an optional display label, an effective-dated availability set and a status.
- Availability is effective-dated and IANA-zoned per location; a new version supersedes by effective date and never rewrites the prior version.
- An appointment carries zero or one operatory reference. A booking with no operatory is valid and carries a typed exception reason from configuration; nothing about the absence of a room is encoded as a resource.
- Validation refuses a resource whose label matches the reserved appointment-state vocabulary, so a state cannot be reintroduced as a room. A data-quality query lists any existing resource that resembles a state label.
- A time block occupies resources for a window with a reason and no patient; blocking time without a resource is allowed.

Acceptance cases:

1. A provider and an operatory are defined with effective-dated hours; a later hours version applies from its date and the earlier version remains readable.
2. Defining a resource whose label matches the reserved state vocabulary is refused with a typed validation error naming the conflict.
3. A time block with a reason and no patient is created and is visible to availability search as unavailable time.
4. A booking-side contract test records that an appointment with no operatory and a typed exception reason is accepted by the model.
5. A resource from another tenant cannot be read or referenced; a booking that names another tenant's operatory is refused.
6. Deactivating a resource with future bookings is refused, with the future bookings enumerated; the alternative is to end its availability at a date.

Failure and recovery cases:

1. Overlapping availability versions for one resource are rejected rather than merged.
2. Changing a location's zone while it has future bookings is refused or requires an explicit recorded migration; it never silently shifts existing appointments.
3. A deactivated resource retains its history and remains readable in past appointments.
4. A time block that overlaps an existing booking is refused with the affected booking references.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement resources, effective-dated availability, time blocks, reserved-label validation and the data-quality query.
- [ ] Run `pnpm test:integration -- resources`; expect all cases to pass, including the cross-tenant refusals.
- [ ] Commit with the data-quality query output recorded for the synthetic fixture.

**Observable completion condition:** the data-quality query reports zero state-labelled resources, and an appointment can exist with no operatory and a typed reason while a time block and an availability version coexist without overlap.

### S8: Appointment request as a separate fact

Dependencies: S4, S6 and S7; F4–F5. Blocks S10 and S15. This task owns the request aggregate and its staff-facing commands; E3 calls the same command with `origin: 'portal'` and defines no second request table.

Files (proposed): `packages/domain/src/scheduling/requests.ts`, `packages/contracts/src/appointment-request.schema.json`, `apps/api/src/routes/appointment-requests.ts`, migration via `supabase migration new appointment_requests`, `tests/integration/appointment-requests.test.ts`.

Consumes: `executeOnce`, `recordCommand`, `authorize`. Produces: `createAppointmentRequest`, `updateRequestPreferences`, `listOpenRequests`, `closeRequest`, `linkRequestToBooking`.

Contract (proposed):

- A request records patient, preferred windows or a stated flexibility, appointment type, provider preference, location, source channel, requester identity, contact-consent state, an urgency flag and a free-text note.
- Request states: `open`, `in_review`, `scheduled`, `declined`, `expired`, `withdrawn`. A request in any non-terminal state holds no resource and blocks no slot.
- Urgency is a boolean flag on the request, never a state.
- `closeRequest` requires a reason code; closing as `scheduled` requires the booking reference and fails without it.
- `linkRequestToBooking` is the only path from request to scheduled, and it records both references.

Acceptance cases:

1. A request is created and no appointment exists; a query for appointments returns none for that patient.
2. Re-submitting the same request with the same key returns the same request; a second distinct request for the same patient is allowed and stays independent.
3. A request for an inactive or deceased patient is refused with a typed error naming the patient state.
4. A request naming another tenant's patient or location is refused without revealing existence.
5. Closing a request as scheduled without a booking reference is refused; with one, both records show the link and the audit shows the transition.
6. A request in `expired` state requires an expiry policy reference; without a configured policy the request does not expire.

Failure and recovery cases:

1. A request created for a patient who is merged before review is re-pointed by the merge and remains open.
2. A request for a deactivated location is refused; the error names the location state.
3. Two staff closing the same request concurrently produce one transition and one conflict.
4. A booking is cancelled after the request was linked; the request returns to `open` only through an explicit command with a reason, never automatically.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement the request aggregate, states, guards, linking and the migration.
- [ ] Run `pnpm test:integration -- appointment-requests`; expect all cases to pass.
- [ ] Commit with a query that lists requests that reached a terminal state without a booking.

**Observable completion condition:** a synthetic request remains open and resource-free until a booking exists, then shows one link on both records, and a report lists requests that never became bookings.

### S9: Availability search

Dependencies: S7; S-S3 for policy inputs. Blocks S10.

Files (proposed): `packages/domain/src/scheduling/availability.ts`, `packages/contracts/src/availability.schema.json`, `apps/api/src/routes/availability.ts`, `tests/integration/availability.test.ts`.

Consumes: `authorize`, the resource and time-block model. Produces: `searchAvailability(ctx, query)` returning candidate windows with the applied constraints and an explicit coverage statement.

Contract (proposed):

- Query: location, appointment type and duration, optional provider and operatory requirements, date range, display zone, and an optional buffer.
- Each result names the resources it would occupy and the constraints applied.
- The response states what was not considered, for example credential or equipment eligibility not modelled yet.
- Search is read-only: no hold, no booking and no outbox event. A result is advisory and S10 rechecks before committing.

Acceptance cases:

1. Returned windows are free for the full duration plus buffer for every required resource.
2. Effective-dated hours, holidays, time blocks, and a window crossing a daylight-saving change produce the correct real duration and correct local display.
3. Search writes no hold, no appointment and no outbox event; the audit records a read.
4. A search naming another tenant's resource is refused; results never include another tenant's resource identifiers.
5. Zero duration, a duration over the configured maximum, or an unparseable zone is rejected.
6. A range beyond the configured horizon is refused or paginated, never silently truncated.

Failure and recovery cases:

1. Availability computed while a concurrent booking commits may be stale; the response marks itself advisory and the booking rechecks.
2. A resource deactivated during the search range is absent from results with an explicit coverage note, not a silently shorter list.
3. A location with no availability configured returns an explicit "no availability configured" outcome rather than an empty list that reads as fully booked.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests, including the no-side-effect assertion.
- [ ] Implement the query handlers and the coverage statement; no write path is added.
- [ ] Run `pnpm test:integration -- availability`; expect all cases to pass.
- [ ] Commit with the recorded DST case output.

**Observable completion condition:** for one synthetic day, availability results, a subsequent booking and the conflict recheck agree, and no search produces a persisted side effect.

### S10: Booking, holds and the inspectable conflict result

Dependencies: S7–S9; F2, F4–F5. Blocks S11, S13, S14, S15, S16 and S17.

Files (proposed): `packages/domain/src/scheduling/booking.ts`, `packages/domain/src/scheduling/conflicts.ts`, `packages/contracts/src/booking.schema.json`, `apps/api/src/routes/appointments.ts`, migration via `supabase migration new appointment_booking`, `tests/integration/booking-conflicts.test.ts`.

Consumes: `authorize`, `executeOnce`, `recordCommand`, `withTenantTransaction`. Produces: `bookAppointment`, `holdSlot`, `releaseHold`, `rescheduleAppointment`, `cancelAppointment`; `BookingResult`, `Conflict`, `Denial`.

Contract (proposed):

- `bookAppointment(ctx, envelope: CommandEnvelope<BookingInput>): Promise<CommandResult<BookingResult>>` returns `booked` with the appointment reference, `held` with a hold reference, `conflict` with a non-empty conflict list, or `denied` with a reason code and actor. Only booked and held are successful operations; conflict and denied use the shared refusal transport and durable attempt-audit paths; a conflict or a denial writes no appointment, no occupancy and no success audit, but both are recorded and auditable.
- `holdSlot`, `releaseHold`, `rescheduleAppointment` and `cancelAppointment` use the same attempt/refusal shape and never throw for a refusal.
- Conflict kinds are enumerated in Shared interfaces. Each names the blocking resource or the existing record and states whether an authorized override is possible.
- Occupancy is enforced by a database constraint per reserved resource and time range, including holds, plus domain validation for the remaining rules. A constraint violation maps to a conflict result, never an unhandled error.
- `holdSlot` creates a time-limited occupancy that converts to a booking or expires; an expired hold releases its range without staff action.
- An authorized override requires an override code, a reason, an identified actor, an audit record and a policy that names which conflict kinds are overrideable. Resource overlap is not overrideable.
- Reschedule preserves the original appointment, its version and a link to the new booking; the old occupancy is released in the same transaction.
- Cancellation records a reason code and a notification intent reference; it does not delete the appointment.

Acceptance cases:

1. Two concurrent identical booking attempts for one provider and operatory yield exactly one `booked` and one `conflict` whose list names the constraint, with no second appointment row.
2. A conflicting booking returns before any write: no appointment, no occupancy, no outbox event, and exactly one audited denial.
3. A booking naming another tenant's patient, provider or operatory returns `denied` with a reason code, and the result does not disclose the foreign record.
4. An override of a soft conflict with a valid code and reason succeeds and is audited; an override of a resource overlap is refused.
5. A hold blocks a conflicting booking and, after expiry, the same slot can be booked without staff intervention.
6. Rescheduling preserves the original appointment, records the link, and a stale `expectedVersion` returns a typed conflict with guidance.
7. Cancelling an appointment that never had a notification intent records an intent with `channel: 'none'` and cites E's suppression decision reference instead of inventing a local reason.

Failure and recovery cases:

1. A crash after commit and before the response returns the recorded booking on retry with the same key.
2. A deadlock between two contenders is retried within a bounded budget, then returns a conflict; it never produces a partial booking.
3. Two overlapping holds for one range are refused; a hold that outlives its TTL is released by a reconciliation path, not by a manual edit.
4. A booking referencing a resource deactivated between search and commit returns a conflict naming the resource state.

Steps:

- [ ] Write cases 1-7 and the failure cases as failing tests, including a controlled-concurrency harness.
- [ ] Implement the booking, hold, reschedule and cancel handlers, the occupancy constraints and conflict mapping.
- [ ] Run `pnpm test:integration -- booking-conflicts` repeatedly with controlled concurrency; expect one committed booking per contended slot.
- [ ] Commit with the concurrency run recorded and the conflict payload captured as an example.

**Observable completion condition:** under repeated concurrent attempts on one slot, exactly one booking commits and every other attempt returns a conflict result that names the blocking resource, with an audit trail for both outcomes.

### S11: Attendance, arrival and exception states

Dependencies: S10; F4–F5. Blocks S12, S14 and S17, and the daily-worklist query.

Files (proposed): `packages/domain/src/scheduling/attendance.ts`, `packages/contracts/src/attendance.schema.json`, `apps/api/src/routes/attendance.ts`, migration via `supabase migration new appointment_attendance`, `tests/integration/attendance.test.ts`.

Consumes: `executeOnce`, `recordCommand`, `authorize`. Produces: `recordAttendance`, `listAttendance`, `getVisitStatus`; the transition guards and the extended reason vocabulary.

Contract (proposed):

- Attendance is an append-only sequence of transitions with actor, instant, source and reason; the current state is derived, never a mutable column that overwrites history.
- Confirmation records its origin as `manual` or `automated`, kept distinct so reminder effectiveness can be measured.
- Arrival kinds include a curbside variant; presence kinds include waiting and in-chair. Clinical completion is not an attendance kind: encounter closure with disposition is C5, and rendered procedures are C14, a separate fact again. Billing is not an attendance kind and belongs to B1.
- Exception outcomes are `late`, `no_show`, `left_without_treatment`, `cancelled`, `rescheduled`. Each requires a configured reason code and allows an optional note.
- `getVisitStatus` returns the separate facts it can see (attendance, clinical completion reference, billing reference) as distinct fields, never as one status.

Acceptance cases:

1. A synthetic visit progresses booked, confirmation by automation, arrival, in-chair and left-without-treatment; every transition is retrievable with actor and instant, and no prior transition changes.
2. Confirmation by automation and by a person are distinguishable in a query that counts them separately.
3. A no-show without a configured reason code is refused; with a code and a note it is recorded and the note is not searchable as a clinical note.
4. Attempting to record clinical completion through the attendance command is refused; the completion belongs to C5.
5. Attempting to record a financial fact through the attendance command is refused.
6. A transition attempted across tenants, or by a role without the attendance scope, is denied and audited.
7. Arrival recorded with a server instant and a separate client-claimed instant retains both without one overwriting the other.

Failure and recovery cases:

1. An out-of-order transition, such as leaving before arrival, is refused with a typed code and changes nothing.
2. Repeating the same transition with the same key returns the recorded transition once.
3. A correction after the fact requires an explicit amendment transition with a reason; an overwrite command does not exist.
4. An appointment cancelled and then reinstated returns to attendance at its prior state only through an explicit recorded command.

Steps:

- [ ] Write cases 1-7 and the failure cases as failing tests.
- [ ] Implement the transition table, guards, reason vocabulary and the derived status query.
- [ ] Run `pnpm test:integration -- attendance`; expect all cases to pass.
- [ ] Commit with the derived-status output showing the separated facts.

**Observable completion condition:** one synthetic appointment shows separated attendance, clinical-completion reference and billing reference, with an append-only transition history and refused out-of-order and cross-workstream writes.

### S12: Appointment clinical context

Dependencies: S10–S11; C8, C10, C13 and C16 for the bound producers. Status: container behaviour is implementable now; producer-bound cases are cross-workstream cases that gate the visit-workspace claim.

Files (proposed): `packages/domain/src/scheduling/visit-context.ts`, `packages/contracts/src/visit-context.schema.json`, `apps/api/src/routes/visit-context.ts`, `tests/integration/visit-context.test.ts`, `tests/integration/visit-context-clinical.test.ts`.

Consumes: the appointment, the patient access resolver, and the clinical producers named above. Produces: `getVisitContext`, `pinMedicalHistorySnapshot`, `assignForm`, `linkLabSlip`, `listVisitContextItems`.

Contract (proposed):

- `getVisitContext(ctx, appointmentRef)` returns references only: patient identity projection, attendance state, the pinned medical-history version with provenance and instant, assigned forms, note drafts, lab-slip references and the treatment-plan items proposed for the visit. It copies no clinical content into a scheduling table.
- The medical-history snapshot is a version pin, not an editable copy; a change made in the visit calls C8's command and produces a new version, leaving the pin intact for audit.
- Form assignment is idempotent per form and appointment; unassigning is an explicit command with a reason.
- A lab-slip reference binds a lab case to the visit; a case already bound elsewhere requires an explicit relink command with a reason and audit.
- The context never substitutes an empty list for unavailable data: an absent producer returns an explicit `unavailable` status with the reason.

Acceptance cases:

1. Opening a context returns a pinned history version, and a later history change does not alter the pin; the pin names the version it captured.
2. Assigning the same form twice returns the recorded assignment once.
3. Linking a lab case bound to another appointment is refused unless the relink command is used, which preserves both references in history.
4. A visit context requested for an appointment in another tenant is denied; a lab case from another tenant cannot be linked.
5. With a producer module not yet deployed, the context returns `unavailable` for that item with a reason, not an empty success.
6. The context for a cancelled appointment is readable and marked, and no new assignment is permitted.

Failure and recovery cases:

1. A producer record voided after linking leaves a dangling reference that resolves to an explicit voided status, never a silent omission.
2. A failed link rolls back its assignment, audit and outbox together.
3. A cancelled appointment with pending forms retains them for review rather than deleting the assignment.

Steps:

- [ ] Write the container cases as failing tests now; write the producer-bound cases with the clinical plan and mark them deferred until C8, C10, C13 and C16 exist.
- [ ] Implement the container, pinning, assignment and link commands with the migration.
- [ ] Run `pnpm test:integration -- visit-context`; expect the container cases to pass and the deferred cases to be reported as skipped with a reason.
- [ ] Commit; keep the workspace claim explicitly open until the deferred cases pass.

**Observable completion condition:** one synthetic appointment returns a visit context in which the pinned medical-history version resolves to a real C8 reference with provenance, every other item is either a resolvable reference or an explicit unavailable status carrying a reason, and no item counts toward completion merely by being unavailable; no clinical content is copied into a scheduling table. The visit-workspace claim stays open until the deferred producer-bound cases for C10, C13 and C16 pass.

### S13: Recurrence series with a deliberate cap

Dependencies: S10; S-S3; S-D1. Blocks S17.

Files (proposed): `packages/domain/src/scheduling/recurrence.ts`, `packages/contracts/src/recurrence.schema.json`, migration via `supabase migration new appointment_recurrence`, `tests/integration/recurrence.test.ts`.

Consumes: `bookAppointment`, the occupancy constraints, `executeOnce`. Produces: `planSeries`, `createSeries`, `extendSeries`, `endSeries`, `listSeriesOccurrences`; a typed limit error.

Contract (proposed):

- A series has a pattern, an occurrence count, a configured limit, a starting point and a state. The limit is a published configuration constant returned in the error and documented in the contract; it is never discovered at runtime.
- Occurrences are materialized appointments, each independently versioned, so one occurrence can be edited, rescheduled or cancelled without touching the others.
- `planSeries(ctx, request): Promise<CommandResult<SeriesPlan>>` is a read-only preview returning per-occurrence conflicts. `createSeries(ctx, envelope): Promise<CommandResult<SeriesResult>>` is atomic: it either creates every occurrence or returns a `Denial` carrying the complete conflict list and writes nothing. A documented flag may create only the conflict-free occurrences, and the result then enumerates every skipped occurrence with its reason.
- `extendSeries` is the explicit continuation path at the limit; it never happens silently.
- Short-month and daylight-saving behaviour follows the rule recorded in S-S3 and is asserted in tests.

Acceptance cases:

1. A request for exactly the configured limit creates every occurrence; a request one over the limit returns a denial naming the limit and creates nothing.
2. Each occurrence is independently editable: changing one leaves the others unchanged, and cancelling one records a series exception naming that occurrence.
3. `planSeries` returns a conflict for every blocked occurrence and writes nothing.
4. A series whose later occurrences conflict is refused atomically by default; with the documented skip flag, the created and skipped sets are both enumerated and reconcile to the requested count.
5. A monthly occurrence on a short month follows the recorded rule and the test asserts the chosen date explicitly.
6. Idempotent re-submission returns the same occurrence set without duplicates.
7. A cross-tenant series is refused, and occurrences never reference a foreign resource.

Failure and recovery cases:

1. A series creation that fails at the last occurrence rolls back all occurrences and their audit rows.
2. Changing the configured limit never truncates an existing series; it affects new requests only, and the test asserts the existing series is untouched.
3. A series whose provider is deactivated requires `endSeries` and explicit reassignment of future occurrences; ending is not a deletion.
4. Two concurrent creations of the same series with different keys produce one series and one full-set conflict, not interleaved occurrences.

Steps:

- [ ] Write cases 1-7 and the failure cases as failing tests.
- [ ] Implement series planning, atomic creation, the limit denial and occurrence materialization.
- [ ] Run `pnpm test:integration -- recurrence`; expect all cases to pass.
- [ ] Commit with the limit constant, the short-month rule and the DST case output recorded.

**Observable completion condition:** a series at the configured limit exists with every occurrence individually addressable, and a request one over the limit is refused with the stated limit and zero rows written.

### S14: Notification intent separated from the booking transaction

Dependencies: S10–S11; F6; E6 for the suppression decision; S-S2; S-D5. Blocks S15 and S17. Status: intent recording is implementable now; delivery belongs to E7 and is blocked-on-discovery until S-S2 verifies a channel.

Files (proposed): `packages/domain/src/scheduling/notification-intent.ts`, `packages/contracts/src/notification.schema.json`, migration via `supabase migration new notification_intents`, `tests/integration/notification-separation.test.ts`.

Consumes: `recordCommand`, the outbox, and E6's `decideSuppression(subjectRef, purpose, channel, at)` returning a `SuppressionDecision`. Produces: `recordNotificationIntent`, `readIntentDecision`, `listPendingIntents`; this plan ships no delivery handler.

Contract (proposed):

- The booking transaction records a `NotificationIntent` with a stable delivery key and the `suppressionDecisionRef` E6 returned. No network call and no consent evaluation occurs inside the scheduling transaction.
- Consent, opt-out, quiet hours, missing contact data, template withdrawal and practice configuration are E6's decision, expressed in the single `SuppressionReason` vocabulary defined in E's plan. This plan records the reference and that reason; it never re-derives a reason and never reads a consent table.
- Delivery is E7's outbox consumer with fresh authorization, deduplication, a bounded retry budget and a dead-letter state.
- An intent committed without a decision reference is recorded `undecided` and listed for reconciliation, never sent.
- Suppression is a recorded outcome, not a failure, and appears in the appointment's notification history as E's decision.

Acceptance cases:

1. Booking with a suppressed decision commits and enqueues no outbound message; the appointment shows one recorded decision reference and E's reason.
2. Booking with an allowed decision commits one intent; E7's fake provider yields exactly one delivery, and a retry after a simulated timeout yields no second delivery.
3. An opt-out recorded by E between intent and delivery blocks delivery at execution; S stores the decision reference and no consent copy.
4. Missing contact data or quiet hours produce E's specific reason, and the appointment history distinguishes the two by citing E's vocabulary.
5. S never evaluates consent: a test asserts that no consent or opt-out table is read inside the scheduling transaction, and that a cross-tenant intent cannot be recorded.
6. Cancelling the appointment records a cancellation intent; E suppresses future intents derived from it while an already delivered message is retained as history.

Failure and recovery cases:

1. A booking rollback leaves no intent and no decision reference.
2. A decision unavailable at commit time leaves the intent `undecided` with a worklist entry, never a send.
3. A withdrawn template is suppressed at E's execution point and reported there; S records only the template reference.
4. A worker crash after provider acceptance is E7's reconciliation case; S does not retry and holds no delivery state.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests, using a fake E suppression resolver only.
- [ ] Implement intent recording, decision-reference storage and the null-channel path.
- [ ] Run `pnpm test:integration -- notification-separation`; expect all cases to pass.
- [ ] Commit; record that real delivery remains E7's claim and stays blocked until S-S2 records a verified channel.

**Observable completion condition:** with no verified channel a booking produces zero sends and one recorded intent carrying an E-owned decision reference, and a test proves S reads no consent state.

### S15: Waitlist

Dependencies: S8 and S10; S14; S-S3; S-D6. Blocks S17.

Files (proposed): `packages/domain/src/scheduling/waitlist.ts`, `packages/contracts/src/waitlist.schema.json`, `apps/api/src/routes/waitlist.ts`, `tests/integration/waitlist.test.ts`.

Consumes: `holdSlot`, `releaseHold`, `executeOnce`. Produces: `addToWaitlist`, `removeFromWaitlist`, `offerSlot`, `recordOfferOutcome`, `listWaitlist`.

Contract (proposed):

- A waitlist entry records patient, desired window or flexibility, appointment type, priority, location, requested channel, and an optional expiry. It creates no appointment and no occupancy.
- An offer creates a hold for one entry and a defined expiry; it is a record with an outcome (`accepted`, `declined`, `expired`, `withdrawn`), and it never books automatically.
- Only one live offer may exist per held slot; a second offer for the same range is refused with a conflict result.
- Expiry releases the hold and records the outcome without staff action.
- Offer delivery is a notification decision, never an inline send.

Acceptance cases:

1. Adding an entry leaves the schedule unchanged; a query for appointments and holds returns none.
2. An offer creates a hold with an expiry; a second offer for the same range is refused, and the conflict names the existing hold.
3. Expiry releases the slot; a booking after expiry succeeds without manual cleanup.
4. An entry for a patient already booked in the offered window is refused with a typed conflict.
5. Cross-tenant entries and offers are refused; offers never hold a foreign resource.
6. Accepting an offer without the explicit acceptance command is impossible; the record shows `expired` rather than a silent booking.

Failure and recovery cases:

1. A crash between offer creation and hold creation leaves neither; the offer and hold commit together.
2. An offer expiring while acceptance is in flight yields a typed conflict with next-step guidance, not a double booking.
3. A merged patient relinks to the survivor and the entry remains with its history.
4. A waitlist entry for a clinic with no configured offer policy cannot be offered until policy exists.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement entries, offers, holds, expiry and outcomes with the migration.
- [ ] Run `pnpm test:integration -- waitlist`; expect all cases to pass.
- [ ] Commit with the expiry reconciliation output recorded.

**Observable completion condition:** one slot is offered to one waitlisted synthetic patient, held, declined or expired, released, and re-offered to a second entry with no double booking at any point.

### S16: Recall policy and due worklists

Dependencies: S4 and S10; S-S3; S-D7; C14 for a completion-based basis. Blocks S17. This task owns recall policy and due computation; E6 owns enrollment and delivery and defines no second policy.

Files (proposed): `packages/domain/src/scheduling/recall.ts`, `packages/contracts/src/recall.schema.json`, `apps/api/src/routes/recall.ts`, migration via `supabase migration new recall_policy`, `tests/integration/recall.test.ts`.

Consumes: the completed-procedure event contract from C14 and appointment state. Produces: `defineRecallPolicy`, `computeRecallDue`, `createRecallContactTask`, `listDueWorklist`; policy and due computation only.

Contract (proposed):

- A recall policy names a recall category, an interval, the qualifying event basis and an already-booked exclusion rule. Policies are versioned; a computation records the policy version it used.
- A recall policy does not authorize contact. Whether a due patient may be contacted is E6's suppression decision at delivery, and this plan evaluates no consent.
- The due list returns, per patient, the last qualifying event, the due date, the reason, and an explicit exclusion reason where excluded.
- A patient with no qualifying event appears in a separate "no baseline" group rather than being omitted or treated as overdue.
- Computing the due list is read-only: no appointment, no intent, no task. Creating a contact task is a separate audited command, and sending is E7's delivery decision.
- Enrollment in an outreach plan is E6's command. `listDueWorklist` returns due items for E to enroll; it never enrolls or sends.
- The response states its as-of instant and freshness basis.

Acceptance cases:

1. The due list includes an eligible patient past the interval and, with the exclusion rule on, excludes a patient with a future booking while reporting the exclusion where the rule is off.
2. A patient with no qualifying event appears in the no-baseline group and is not counted as overdue.
3. Computing twice for the same as-of instant and policy version returns identical rows.
4. Producing the list creates no appointment, no intent and no task; creating a task requires the explicit command and is audited.
5. A location-restricted user cannot enumerate another location's due list; a cross-tenant request is denied.
6. A deceased or inactive patient is excluded with the patient state named as the reason.

Failure and recovery cases:

1. A policy change after a list was produced yields a different list on recomputation; the earlier result keeps its recorded policy version.
2. A stale projection is labelled with its age rather than presented as current.
3. A recall task created for a patient who books before outreach is not silently removed; the task records the resolution with a reason.
4. Duplicate task creation for the same patient and policy version is idempotent or reported as a conflict.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement policies, computation, exclusions and task creation.
- [ ] Run `pnpm test:integration -- recall`; expect all cases to pass.
- [ ] Commit with the determinism check and the policy version output recorded.

**Observable completion condition:** one synthetic day's due list is reproducible from stored states, states its policy version and freshness, separates no-baseline patients, and produces no outreach by itself.

### S17: Workstream parity, negative matrix and release evidence

Dependencies: S4–S16, plus the spike records from S-S1–S-S3.

Files (proposed): `tests/integration/scheduling-negative-matrix.test.ts`, `tests/integration/scheduling-parity.test.ts`, `tests/scenarios/ordinary-day-scheduling.test.ts`, `docs/api/openapi.yaml`, `docs/runbooks/downtime-scheduling.md`.

Consumes: every operation this plan introduces. Produces: a parity matrix covering REST, MCP and worker paths, an export manifest for this plan's records, and a downtime procedure for schedule and contact continuity.

- [ ] Run the shared negative harness (`tests/integration/negative-harness.test.ts`, stated once in Global Constraints) across every command this plan introduces; each attempt must produce the same `Denial` reason code on REST, MCP and the worker path.
- [ ] Write the export check: patients, relationships, requests, bookings, attendance history, series, waitlist entries and recall policies export with stable identifiers and verify on re-import.
- [ ] Write the downtime scenario: read-only schedule and contact continuity with manual numbering and a documented reconciliation step, without inventing a second write path.
- [ ] Run the ordinary-day scenario: configure resources, create a request, book, arrive, leave without treatment, reschedule, offer a waitlist slot, produce a recall list and export.
- [ ] Run the full suite and record every operation present in the matrix with its policy outcome; commit.

**Observable completion condition:** one test run reports a parity matrix with no operation missing, an export that re-imports without identifier loss, and an ordinary synthetic day that completes with no direct table access outside the domain layer.

## Plan self-review and scope boundary

This plan covers patient identity, relationships, duplicate resolution and scheduling up to attendance, recurrence, notification intent, waitlist and recall policy. It does not specify clinical charting, perio, treatment, notes, consent content, imaging bytes, lab exchange channels, billing, claims, statements, portal intake or the device bridge; those belong to C, B, I, E and M. It deliberately leaves notification delivery, recall clinical intervals, payer-dependent eligibility and any lab or referral exchange unverified and marked blocked rather than assumed.

Every task is a proposal. No capability becomes implemented until its acceptance cases run under the restricted runtime role and its named reviewer signs the record the task depends on.

## Known deviations from docs/SHARED-CONTRACTS.md

- The five relationship scope names this plan owns (`demographics`, `scheduling`, `clinical_read`, `financial`, `consent`) are not yet listed in the shared scope registry. They are a relationship-scope namespace rather than staff action scopes, and this correction pass did not mint replacements; registering them, or mapping them onto the registry, needs the owner of `docs/SHARED-CONTRACTS.md`.
- `Blocks` is now derived from `Dependencies` for every task in this plan. S17 has an empty `Blocks` by construction, and the spike entries block only through the task-level dependencies they are named in.
- The booking refusal shape is applied to the commands in this plan. Contracts for commands in B, I, E and M were brought to the same shape in their own plans; this plan does not restate them.
