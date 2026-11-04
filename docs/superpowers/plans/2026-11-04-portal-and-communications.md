# Portal and Communications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a future execution plan, not authorization to start.

**Goal:** Give patients and their guardians a narrowly scoped portal, let portal intake and appointment requests feed the same domain objects staff use, and deliver reminders, recall and messages only where consent and channel state permit, with delivery receipts that can be reconciled.

**Architecture:** The portal is a separate transport with its own principal model, not a reduced staff role. Every portal query and command passes the same application policy layer as staff requests, but resolves authority from the relationship model owned by S rather than from membership. Appointment requests are one aggregate regardless of origin. Outbound messages are durable records produced by a worker from an approved template, with consent, opt-out, quiet-hour and channel state checked at execution time; this plan owns that decision.

**Tech Stack:** Inherits the platform foundation: supported Node LTS, TypeScript, Fastify, PostgreSQL/Supabase, JSON Schema/OpenAPI, Vitest and SQL integration tests. Messaging and telephony providers sit behind adapter ports with synthetic implementations; no provider SDK client lands before its spike closes. No PHI appears in a channel notification payload.

**Spec:** [Product design](../specs/2026-11-03-dental-pms-design.md), [capability matrix](../../CAPABILITIES.md), [API contract](../../API-AND-MCP.md), [security gates](../../SECURITY-AND-READINESS.md), [observed request and notification surfaces](../../TAB32-STATUS-VOCABULARIES.md).

**Task numbering:** this plan's prefix is `E`. Implementation tasks are `E1`–`E9`, discovery spikes are `E-S1`–`E-S3`, and open decisions are `E-D1`–`E-D8`. A cross-workstream reference names the fully qualified task: `F` is [platform foundation](2026-11-03-platform-foundation.md), `S` is [patients and scheduling](2026-11-04-scheduling-and-patients.md), `C` is [clinical record](2026-11-04-clinical-record.md), `B` billing, `I` imaging, `M` migration. Spikes have owners, sit in the dependency graph and can block a task. `Blocks` is derived from `Dependencies` and is never maintained as a second list.

## Practice-time acceptance requirements

Consume [PT-01–06 and UX-01–03](../../PRACTICE-TIME-AND-AUTOMATION.md) in the owning tasks: reuse authoritative data, expose current state/next owner, distinguish unavailable from empty, and automate eligible routine steps under explicit policy. Clinical and imaging tasks provide correctly linked evidence for CL-04; scheduling/engagement tasks coordinate cancellation recovery, recall and treatment follow-up with consent and race-safe booking. Preserve human clinical judgment and signatures. Add exception, retry, revocation and provenance cases before implementing these extensions; UI design stays deferred.

## Provider onboarding acceptance

Apply [CN-01–05](../../OPEN-PLATFORM-AND-ONBOARDING.md) to this workstream's provider adapters: guided protected credentials, sandbox/live distinction, required enrollment/verification, explicit capabilities/costs, health, rotation/revocation and recoverable failures. Test interrupted onboarding, failed verification, unsafe live test actions, duplicate callbacks and expired credentials. Provider connection does not establish clinical or production qualification. No CuspAtlas paid tier may gate this adapter; third-party contracts and costs remain explicit.

## Global Constraints

- The [platform foundation](2026-11-03-platform-foundation.md) is a prerequisite for this plan; this plan adds no platform guarantee of its own and does not restate the foundation's synthetic-data, provenance or tenancy rules. Tenant and actor are always derived from context.
- This plan consumes S's contracts and does not redefine them: patient identity is `S4`, the guardian/guarantor/proxy relationship model and its scopes are `S5`, the appointment request aggregate is `S8`, booking is `S10`, and recall policy and due computation are `S16`.
- Negative testing is stated once for the whole plan: the shared harness `tests/integration/negative-harness.test.ts` attempts every command cross-tenant, with a revoked membership, with a downgraded role, and through MCP, and each task cites the harness instead of restating the case list.
- Synthetic patients, synthetic contact details and fake providers only. No real messages, no real phone numbers, no live provider credentials in tests.
- Portal access derives from an explicit relationship grant recorded by S5. It is never inferred from a shared phone number, a shared email address, a family membership or a surname match, and this plan adds no second grant model and no second expiry mechanism.
- Consent, opt-out and the suppression decision are owned here. Consent and opt-out are recorded facts with source, channel, version and time; an opt-out is authoritative until a later recorded change, and it applies before any message is sent. S and B consume this decision and never evaluate consent themselves.
- The suppression reason vocabulary is defined once, in Shared interfaces, as `SuppressionReason`. Every plan that consumes a suppression decision cites that one list.
- Notification payloads carry no clinical content by default. A message that must be read is read in the portal, not in an SMS body.
- Quiet hours, per-channel rate bounds and template approval are enforced at execution, not only at scheduling.
- SMS sender registration, telephony number provisioning and provider delivery semantics are **blocked-on-discovery**. No task assumes them.

## Research gate before executing this plan

[Tab32 analysis coverage](../../TAB32-ANALYSIS-COVERAGE.md) records appointment requests as a surface separate from appointments and a checkout-triggered survey configuration, and [RESEARCH](../../RESEARCH.md) records that the observed new-appointment form had an email/text notification control checked by default. Those observations establish that notification choice must be explicit; they do not establish consent behavior, opt-out handling, delivery semantics or portal scope.

The design and capability matrix already require that a booking does not send an unexpected message and that opt-out and quiet-hour policy are enforced. Treat those as our requirements. Any statement about how the incumbent enforces them remains unverified.

## Discovery spikes (resolve before the tasks they gate)

### E-S1: Messaging channel qualification — blocked-on-discovery

For email and for SMS separately, confirm delivery-receipt semantics and their reliability, bounce and failure classes, opt-out mechanisms and mandated handling, sender registration or campaign registration obligations in the US, quiet-hour constraints, per-message cost, retention of message content by the provider, webhook signing and replay protection, and BAA scope. Blocks E5, E6 and E7. Stop condition: a written capability summary with sandbox evidence, or the release ships portal messaging only and declares reminders unavailable.

### E-S2: Telephony provider qualification — blocked-on-discovery

Confirm number provisioning and portability, hours-based routing, voicemail handling, whether a voicemail can create a task, call recording availability and the consent rules that apply, retention, cost, and BAA scope. Blocks E8. Stop condition: a written capability summary, or telephony remains an external practice system with only a recorded reference number in our data.

### E-S3: Portal identity proofing level — blocked-on-discovery

Decide the assurance level required to grant portal access: invitation to a verified contact on file, email possession plus a second factor, or an external identity verification step. Consider guardian and minor cases, household shared devices, and what recovery looks like when a contact is wrong. Blocks E1. Stop condition: a decision record approved by the security owner and a practice representative, with the recovery path written down.

## Implementation review focus

- A shared household phone or email must never establish access to more than one patient; E1 must prove it.
- A proxy grant revoked between page load and a command must fail at the command; E1 must recheck at execution through S5.
- A portal session must not reach any staff route, and a staff session must not act as a proxy; E1 must prove both directions.
- A duplicate intake submission must not create two form records; E4 must be idempotent on the submission identity.
- A reminder for an appointment cancelled after enqueue must be suppressed before send; E6 must recheck state.
- A delivery receipt arriving twice must not double-count or trigger a second send; E7 must deduplicate.
- An opt-out recorded after a message was queued must stop that message; E6 and E7 must check consent at send time, not only at queue time.

## Proposed file structure (create only during authorized execution)

`packages/domain/src/portal/` owns principals, grant projections and portal-facing commands. `packages/domain/src/communications/` owns templates, consent, suppression, outbound messages, delivery receipts and reminders. `packages/domain/src/recall/` owns enrollment and the delivery cohort, not policy. `packages/domain/src/intake/` owns form definitions, submissions and consent capture. `packages/contracts/src/portal/` and `packages/contracts/src/communications/` own the schemas. `apps/api/src/routes/portal/`, `apps/api/src/routes/communications/` and `apps/api/src/routes/intake/` are thin REST transports that call only these commands and publish the same operation names to MCP; no route reaches a table directly. `packages/adapters/messaging/` and `packages/adapters/telephony/` hold ports plus synthetic implementations. `apps/worker/` hosts the outbound sender and reminder evaluator. Migrations use `supabase migration new portal_grants`, `portal_projections`, `intake_forms`, `communications_consent`, `communications_outbound`, `communications_receipts`, `recall_enrollment`. Tests live in `tests/integration/portal-*.test.ts` and `tests/integration/comms-*.test.ts`. Portal UI, email templates as design artifacts and telephony IVR flows are out of scope.

## Shared interfaces

Proposed contract definitions to create during execution, not code already present:

- `Money` is not used for message content in this plan; where a contract would carry a monetary value (for example a per-message cost report) it uses the shared `Money` contract from [SHARED-CONTRACTS](../../SHARED-CONTRACTS.md#money) and never a scalar amount with a separate currency.
- Identifiers are opaque `<entity>Ref` strings throughout, and tenant is derived from context; no record shape carries a tenant field.
- `RelationshipScope = 'demographics' | 'scheduling' | 'clinical_read' | 'financial' | 'consent'` is exactly the scope set S5 owns. This plan adds no scope name and no scope taxonomy of its own.
- `PortalPrincipal = { principalRef: string; kind: 'patient' | 'guardian' | 'guarantor' | 'dependent' | 'proxy'; patientRef: string; grantRef?: string; authenticatedAt: string; assuranceLevel: string }` — no staff roles, no tenant-wide scopes.
- `PortalGrant` is a **projection** of S5's relationship record, not a parallel model: `{ grantRef: string; relationshipRef: string; patientRef: string; granteeContactRef: string; kind: 'guardian' | 'guarantor' | 'dependent' | 'proxy'; scope: readonly RelationshipScope[]; effectiveFrom: string; effectiveUntil?: string; revokedAt?: string; projectedAt: string }`. It has no `tenantId` and no expiry field of its own: `effectiveUntil` is read from the relationship, and revocation is S5's `revokeRelationship`. The former portal scope taxonomy (`appointments`, `balances`, `documents`, `messages`, `forms`) is deleted; view names remain view names and map to the relationship scopes below.
- Portal view to relationship scope: `appointments` needs `scheduling`; `balances` needs `financial`; `documents` needs `clinical_read`; `messages` needs `consent`; `forms` needs `demographics` and `consent`. A view whose required scope is absent from the projection is denied.
- `PortalProjection<T> = { fields: Record<string, unknown>; redacted: readonly string[]; generatedAt: string }` — an explicit allowlist, never a filtered row.
- `AppointmentRequest` — owned by S8; portal commands call the same `createAppointmentRequest` handler with `origin: 'portal' | 'staff'`.
- `FormSubmission = { submissionRef: string; formVersion: string; patientRef: string; submittedBy: string; idempotencyKey: string; answers: unknown; consentRefs: string[] }`.
- `ConsentRecord = { consentRef: string; patientRef: string; channel: 'portal' | 'email' | 'sms' | 'voice'; purpose: 'reminders' | 'recall' | 'messaging' | 'treatment'; state: 'granted' | 'denied' | 'optedOut'; source: string; recordedAt: string; version: string }`.
- `SuppressionDecision = { decisionRef: string; subjectRef: string; purpose: string; channel: string; outcome: 'allowed' | 'suppressed'; reason?: SuppressionReason; decidedAt: string }`.
- `SuppressionReason = 'no_consent' | 'opt_out' | 'quiet_hours' | 'missing_contact' | 'policy_off' | 'appointment_cancelled' | 'appointment_missing' | 'template_withdrawn' | 'recall_not_due' | 'grant_expired'`. This is the **single** reason vocabulary. S14 and B4 cite it by name and must not define their own.
- `OutboundMessage = { messageRef: string; patientRef: string; channel: string; templateRef: string; templateVersion: string; state: 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'suppressed' | 'unknown'; suppressionReason?: SuppressionReason; contentRef: string }` — content stored once, never edited after send.
- `DeliveryReceipt = { receiptRef: string; messageRef: string; providerEventId: string; state: string; occurredAt: string; dedupeKey: string }`.
- `MessageThread = { threadRef: string; patientRef: string; participants: readonly string[]; state: 'open' | 'closed'; retentionClass: string }`.
- `MessagingPort` and `TelephonyPort` with `send(request, idempotencyKey)` returning `{ outcome: 'accepted' | 'rejected' | 'unknown'; providerRef?: string }`, and receipt normalization that never returns message bodies.
- `Denial = { outcome: 'denied'; reasonCode: string; actorRef: string; detailRef?: string }` is returned by every command here that can legitimately refuse; a thrown error is reserved for faults.

### E1: Portal principals and the grant projection

**Dependencies:** F1–F2; S5; E-S3. **Status:** projection and principal resolution implementation; assurance level blocked-on-discovery.
**Files (proposed):** `packages/domain/src/portal/grants.ts`, `packages/domain/src/portal/principal.ts`, `apps/api/src/routes/portal/auth.ts`, migration via `supabase migration new portal_grants`, `tests/integration/portal-grants.test.ts`.
**Contract:** `inviteGrantee(ctx, envelope: CommandEnvelope<{ patientRef: string; granteeContactRef: string; kind: 'guardian' | 'guarantor' | 'dependent' | 'proxy'; scope: readonly RelationshipScope[]; effectiveUntil?: string }>): Promise<CommandResult<PortalGrant>>` delegating to S5's `addRelationship`; `resolvePortalPrincipal(session): Promise<PortalPrincipal | Denial>`; `listGrantsForPatient(ctx, { patientRef: string }): Promise<PortalGrant[]>` projecting S5 state; `revokeGrant(ctx, envelope: CommandEnvelope<{ grantRef: string; reason: string }>): Promise<CommandResult<PortalGrant>>` delegating to S5's `revokeRelationship`. There is no portal expiry job.
**Refusals:** `shared_contact_ambiguous`, `contact_unverified`, `grant_expired`, `grant_revoked`, `tenant_mismatch`, `staff_route_forbidden`, `scope_not_in_relationship`.

**Acceptance cases:** a grant is scoped to exactly one patient and cannot be widened by a request parameter; a shared household phone or email that matches two patients produces no grant and an explicit ambiguity state; a guardian grant expires on the relationship's configured event and, after expiry, denies access without deleting the patient record or the relationship history; revocation takes effect for an existing session at the next command; a grant created for a tenant B patient cannot be resolved by a tenant A session; a portal principal cannot call a staff route and a staff session cannot act as a portal principal; a grant whose grantee contact is unverified remains pending and grants nothing; two grants for the same patient and grantee do not multiply access; this plan has no command that extends an expiry, because expiry belongs to S5.

**Failure and recovery:** an invitation that is never accepted leaves a pending relationship that expires without granting access; a contact change on the patient record does not silently retarget an existing grant, it flags the projection for review; a revocation during an in-flight portal command fails that command and records the denial.

**Completion condition:** the suite shows guardian expiry, revocation, shared-contact ambiguity and both cross-transport directions denied, with the patient record intact and every portal grant resolving to exactly one S5 relationship.

- [ ] Write the expiry, revocation, ambiguity, cross-tenant and cross-transport cases; confirm failure.
- [ ] Implement the projection, principal resolution and typed denials; no implicit grant creation anywhere.
- [ ] Run the suite with a session that outlives its grant.
- [ ] Record the pending assurance decision and commit the projection.

### E2: Scoped portal views

**Dependencies:** E1; B4 for statement and balance read models; C15 for document links. **Status:** implementation for the projection mechanism; field sets for balances and documents depend on B4 and C15 landing.
**Files (proposed):** `packages/contracts/src/portal/projections.ts`, `packages/domain/src/portal/projections/`, `apps/api/src/routes/portal/views.ts`, `tests/integration/portal-views.test.ts`.
**Contract:** `readPortalView(ctx, { view: 'appointments' | 'balances' | 'documents' | 'messages' | 'forms' }): Promise<PortalProjection<...> | Denial>`; `describePortalView(view): Promise<{ fields: readonly string[]; redactions: readonly string[]; requiredScope: readonly RelationshipScope[] }>`.
**Refusals:** `scope_missing`, `view_unavailable`, `tenant_mismatch`, `grant_revoked`, `read_authorization_expired`.

**Acceptance cases:** a view returns only its allowlisted fields and reports what it redacted; a grant scoped without `financial` is denied the balances view even when the patient has a balance; internal identifiers, staff notes, audit metadata, other family members and billing detail beyond the allowlist never appear in a portal response; a portal response for a patient in another tenant is indistinguishable from a missing record; a revoked grant denies the view at read time; a view over an empty record set does not leak existence through differing error shapes; a document view returns a short-lived read authorization rather than a durable URL; every view resolves its requirement through `RelationshipScope` and never through a portal-local scope name.

**Failure and recovery:** a downstream read model that is unavailable returns an explicit unavailable state rather than a partial view that looks complete; a projection whose allowlist changed between deploy and request returns the version it used; a read authorization issued before revocation is bounded and its remaining validity is stated.

**Completion condition:** the suite enumerates each view's response keys and shows no key outside the declared allowlist for any role, relationship scope or record state.

- [ ] Write the allowlist, redaction, scope-denial and cross-tenant cases; confirm failure.
- [ ] Implement projection definitions with an explicit allowlist and a redaction report.
- [ ] Run the suite and assert the response key set, not only selected values.
- [ ] Commit each view only as its owning contract lands.

### E3: Portal appointment requests into the shared request aggregate

**Dependencies:** E1; S8 and S10 for the request aggregate and booking. **Status:** implementation against the shared aggregate. An acknowledgement is enqueued through E6 as an outbox consumer; E3 does not call E6 synchronously and is not blocked on it.
**Files (proposed):** `packages/domain/src/portal/appointment-requests.ts`, `apps/api/src/routes/portal/requests.ts`, `tests/integration/portal-requests.test.ts`.
**Contract:** `submitPortalRequest(ctx, envelope: CommandEnvelope<PortalRequestInput>): Promise<CommandResult<{ requestRef: string }>>` delegating to S8's `createAppointmentRequest` with `origin: 'portal'`; `listPortalRequests(ctx): Promise<AppointmentRequestSummary[]>` returning only the requesting patient's requests and a bounded state set.
**Refusals:** `cross_patient_request`, `forbidden_field`, `request_window_closed`, `aggregate_unavailable`, `tenant_mismatch`.

**Acceptance cases:** a portal submission creates one request in the same aggregate staff read, with the same identity, state machine and audit; duplicate submission with the same idempotency key returns the same request; a request never becomes an appointment until staff save one, and the portal shows it as pending rather than booked; a portal principal cannot supply a tenant, location or provider value outside the allowed set; requesting for a patient other than the principal's patient is denied; a request submitted during a closure or outside configured request windows is refused with a stated reason; a cancelled appointment does not retroactively alter the request history.

**Failure and recovery:** if the scheduling aggregate is unavailable, the portal returns a typed unavailable state and does not store a shadow request; a request accepted but whose acknowledgement message fails remains pending and visible to staff; a duplicate submission after a timeout returns the original request rather than a second one.

**Completion condition:** a portal-originated request is visible in the staff request list with the same identifier, and no portal path can create an appointment directly.

- [ ] Write the shared-aggregate, idempotency, forbidden-field and cross-patient cases; confirm failure.
- [ ] Implement the portal command as a thin delegation to the existing request handler; no parallel request table.
- [ ] Run the suite including a duplicate submission after an induced timeout.
- [ ] Commit; confirm the audit record names the portal origin.

### E4: Intake forms and consent capture

**Dependencies:** E1–E2; C8 for history content; a clinical reviewer for form content. **Status:** implementation of the mechanism; form content requires clinical sign-off.
**Files (proposed):** `packages/domain/src/intake/forms.ts`, `packages/domain/src/intake/submissions.ts`, `apps/api/src/routes/intake/forms.ts`, migration via `supabase migration new intake_forms`, `tests/integration/portal-intake.test.ts`.
**Contract:** `publishFormVersion(ctx, envelope: CommandEnvelope<FormVersionInput>): Promise<CommandResult<{ formVersionRef: string }>>`; `startSubmission(ctx, { formVersionRef: string }): Promise<CommandResult<{ submissionRef: string }>>`; `submitForm(ctx, envelope: CommandEnvelope<FormSubmissionInput>): Promise<CommandResult<FormSubmission>>` idempotent on `idempotencyKey`; `listSubmissionsForPatient(ctx, { patientRef: string }): Promise<FormSubmission[]>`; consent capture writes `ConsentRecord` entries linked to the submission.
**Refusals:** `missing_required_answer`, `unknown_field`, `form_version_expired`, `cross_patient_submission`, `consent_grant_expired`, `tenant_mismatch`.

**Acceptance cases:** a submission is bound to a form version and a later form revision does not alter it; re-submitting the same idempotency key returns the same submission; a submission with a missing required answer is refused with field-level detail that contains no other patient data; a guardian submitting for a minor records which relationship grant was used; a submission for another patient is denied; a consent captured in a submission is recorded once and appears in the patient's consent state; an expired form version refuses new submissions but preserves existing ones; a submission containing an unexpected extra field is refused rather than stored.

**Failure and recovery:** a submission accepted but whose clinical write target is unavailable remains a stored submission with a pending-application state rather than being lost; a partially completed submission is not visible to staff as a completed form; a retry after a network failure returns the stored result.

**Completion condition:** the suite shows one submission per idempotency key, form-version binding intact after a revision, and consent state reflecting exactly the submissions recorded.

- [ ] Write the version-binding, idempotency, consent, cross-patient and extra-field cases; confirm failure.
- [ ] Implement form versioning, submission storage and consent linkage; no free-form history write bypassing C8.
- [ ] Run the suite including a revision between two submissions.
- [ ] Commit; leave form content to clinical review.

### E5: Secure messaging with retention and access audit

**Dependencies:** E1–E2; E-S1 for delivery. **Status:** thread and retention implementation; channel delivery blocked-on-discovery.
**Files (proposed):** `packages/domain/src/communications/threads.ts`, `packages/domain/src/communications/retention.ts`, `apps/api/src/routes/portal/messages.ts`, `apps/api/src/routes/communications/threads.ts`, migration via `supabase migration new communications_threads`, `tests/integration/portal-messaging.test.ts`.
**Contract:** `openThread(ctx, envelope: CommandEnvelope<{ patientRef: string; participantRefs: readonly string[] }>): Promise<CommandResult<MessageThread>>`; `postMessage(ctx, envelope: CommandEnvelope<{ threadRef: string; bodyRef: string }>): Promise<CommandResult<{ messageRef: string }>>`; `closeThread(ctx, envelope: CommandEnvelope<{ threadRef: string; reason: string }>): Promise<CommandResult<MessageThread>>`; `readThread(ctx, { threadRef: string; cursor?: string }): Promise<ThreadPage>`; `listThreadsForStaff(ctx, filter): Promise<MessageThread[]>`; `evaluateThreadRetention(ctx, { threadRef: string }): Promise<{ eligible: boolean; heldReason?: string }>`.
**Refusals:** `message_immutable`, `participant_not_authorized`, `scope_missing`, `retention_hold`, `tenant_mismatch`, `thread_closed`.

**Acceptance cases:** a message is immutable after send and an edit attempt is refused with a typed reason; a portal participant can read only threads for their patient; a staff member without a messaging scope cannot read a thread even with patient access; an attachment reference is authorized separately from the message body; a thread under retention cannot be deleted by a participant; closing a thread prevents new participant messages but not staff replies; a message body never appears in an ordinary log or an audit payload; a cross-tenant thread reference is denied indistinguishably from a missing thread.

**Failure and recovery:** a posted message whose notification failed is still delivered in the portal and marked as unnotified; a retention job that cannot complete leaves the thread intact and reports a failure rather than partially deleting; a restored backup that reintroduces a deleted thread is detected by the retention check.

**Completion condition:** the suite shows messages immutable after send, unauthorized reads denied at both transport levels, and a retention evaluation that names eligible and held threads without deleting either.

- [ ] Write the immutability, scope, retention, logging and cross-tenant cases; confirm failure.
- [ ] Implement threads, posting, retention evaluation and staff read with a messaging scope.
- [ ] Run the suite and check that no message body appears in emitted log fixtures.
- [ ] Commit; keep delivery behind the unclosed channel spike.

### E6: Consent, suppression and recall enrollment

**Dependencies:** E1, E3 and E5; S16 for due items; E-S1. **Status:** enrollment and suppression implementation; channel delivery blocked-on-discovery. This task owns consent, opt-out and the suppression decision. Recall policy and due computation remain S16's.
**Files (proposed):** `packages/domain/src/communications/consent.ts`, `packages/domain/src/communications/suppression.ts`, `packages/domain/src/communications/reminders.ts`, `packages/domain/src/recall/enrollment.ts`, `packages/domain/src/recall/cohort.ts`, migration via `supabase migration new communications_reminders_recall`, `tests/integration/comms-reminders.test.ts`.
**Contract:** `recordConsent(ctx, envelope: CommandEnvelope<ConsentInput>): Promise<CommandResult<ConsentRecord>>`; `recordOptOut(ctx, envelope: CommandEnvelope<{ patientRef: string; channel: string; source: string }>): Promise<CommandResult<ConsentRecord>>`; `decideSuppression(ctx, { subjectRef: string; purpose: string; channel: string; at: string }): Promise<SuppressionDecision>` — the single decision S14 and B4 consume; `enrollReminderPlan(ctx, envelope: CommandEnvelope<ReminderPlanInput>): Promise<CommandResult<{ enrollmentRef: string }>>`; `enrollRecallCohort(ctx, envelope: CommandEnvelope<{ dueItemRefs: readonly string[] }>): Promise<CommandResult<{ enrolled: number; skipped: readonly { ref: string; reason: SuppressionReason }[] }>>`; `evaluateDueOutreach(ctx, { asOf: string }): Promise<OutreachCandidate[]>`; `assertSendable(ctx, candidate: OutreachCandidate): Promise<SuppressionDecision>` used by E7.
**Refusals:** `no_consent`, `opt_out`, `quiet_hours`, `missing_contact`, `policy_off`, `recall_not_due`, `grant_expired`, `tenant_mismatch`.

**Acceptance cases:** no reminder candidate is produced without a granted consent for that channel and purpose; an opt-out recorded one minute before send suppresses the message even though it was queued earlier; quiet hours suppress a candidate with a stated reason rather than sending early; a cancelled or rescheduled appointment after enqueue suppresses the stale reminder and, where the rule allows, creates a new candidate for the new time; recall enrollment sends nothing by itself; the recall cohort contains only patients S16 marks due, and an already-booked exclusion is S16's policy reported with its reason rather than a portal rule; recall candidates already booked are shown with S16's exclusion reason; a duplicate appointment completion does not create two recall enrollments; a patient in another tenant never appears in a cohort; a guardian consent does not authorize outreach to the patient after the relationship expires.

**Failure and recovery:** a consent read failure blocks the send and creates a visible item rather than defaulting to allow; a template that was withdrawn between queue and send suppresses and reports `template_withdrawn`; a reminder whose appointment no longer exists is suppressed with `appointment_missing`, not sent with missing details.

**Completion condition:** the suite shows every suppressed candidate carrying one of the enumerated `SuppressionReason` values, an opt-out recorded after queueing prevents the send, and no recall candidate exists without S16's due item.

- [ ] Write the consent, opt-out, quiet-hour, stale-appointment, duplicate-enrollment and cross-tenant cases; confirm failure.
- [ ] Implement consent records, opt-out precedence, the suppression decision and recall enrollment from S16 due items.
- [ ] Run the suite with consent changed between evaluation and send.
- [ ] Commit; keep channel-specific rules behind the unclosed spike.

### E7: Delivery receipts, retries and unknown outcomes

**Dependencies:** E5 and E6; E-S1. **Status:** blocked-on-discovery for provider semantics; receipt handling implementation permitted against a synthetic provider.
**Files (proposed):** `packages/domain/src/communications/delivery.ts`, `apps/api/src/routes/communications/receipts.ts`, `packages/adapters/messaging/port.ts`, `packages/adapters/messaging/synthetic.ts`, `apps/worker/src/outbound-sender.ts`, migration via `supabase migration new communications_receipts`, `tests/integration/comms-delivery.test.ts`.
**Contract:** `dispatchOutbound(ctx, { messageRef: string }): Promise<{ outcome: 'accepted' | 'rejected' | 'unknown'; providerRef?: string }>` after `E6.assertSendable` returns `allowed`; `recordReceipt(ctx, receipt: DeliveryReceipt): Promise<CommandResult<{ deduplicated: boolean }>>` deduplicated on `dedupeKey`; `listUnresolvedDeliveries(ctx): Promise<OutboundMessage[]>`.
**Refusals:** `suppressed_message`, `receipt_duplicate`, `unknown_outcome`, `tenant_mismatch`, `message_withdrawn`.

**Acceptance cases:** a repeated provider receipt with the same dedupe key updates nothing and creates no second event; a message whose provider outcome is unknown enters an unresolved list and is not sent again automatically; a rejected send records the reason class without storing provider-internal payloads; a message accepted but never receipted is reconciled by provider reference or escalated; two workers sending the same queued message produce one provider acceptance; a suppressed message is never dispatched; a receipt for a message in another tenant is refused; a receipt that arrives after a message was withdrawn updates state without resurrecting content.

**Failure and recovery:** a worker crash after provider acceptance but before recording leaves an unknown outcome that reconciliation resolves rather than resends; a receipt endpoint outage leaves messages in `sent` with a stated uncertainty; a provider duplicate after a retry is recognized by the stable idempotency key.

**Completion condition:** the suite shows exactly one provider acceptance per outbound message under duplicate dispatch, and unknown outcomes visible in one reconciliation list with no automatic resend.

- [ ] Write the duplicate-receipt, duplicate-dispatch, unknown-outcome, suppression and cross-tenant cases; confirm failure.
- [ ] Implement dispatch, receipt dedupe and unresolved-delivery reconciliation with the synthetic provider.
- [ ] Run the suite with two concurrent workers and a replayed receipt.
- [ ] Commit; record the provider semantics as blocked-on-discovery.

### E8: Telephony configuration and call references

**Dependencies:** E-S2; E1 and E5 for any surfaced call reference. **Status:** blocked-on-discovery.
**Files (proposed):** `packages/domain/src/communications/telephony.ts`, `apps/api/src/routes/communications/telephony.ts`, `packages/adapters/telephony/port.ts`, migration via `supabase migration new communications_telephony`, `tests/integration/comms-telephony.test.ts`.
**Contract:** `describeTelephonyConfig(ctx): Promise<{ numbers: readonly string[]; hours: BusinessHours; routing: RoutingRule[]; recordingState: 'off' | 'configured' }>`; `recordCallReference(ctx, envelope: CommandEnvelope<CallReferenceInput>): Promise<CommandResult<{ callRef: string }>>` linking a call to a patient and optionally a task; `resolveCallHandling(ctx, { at: string }): Promise<{ rule: RoutingRule; sourceVersion: string }>`.
**Refusals:** `recording_without_consent`, `tenant_mismatch`, `ambiguous_caller`, `routing_invalid`, `provider_unavailable`.

**Acceptance cases:** a call reference cannot be attached to a patient in another tenant; recording is off unless explicitly configured, and a recording request without recorded consent is refused; a call reference stores metadata only, never a recording payload, unless a recording capability is separately configured; number and hours changes are versioned so a historical reference resolves to the rule in force at the time; a member of staff without a communications scope cannot read call metadata; an ambiguous caller match produces a candidate list rather than an automatic link.

**Failure and recovery:** a provider outage leaves call references unable to be created, which is surfaced as an unavailable capability rather than a fabricated record; a number change does not orphan historical references; a misconfigured routing rule is detected by validation before publication.

**Completion condition:** the suite shows recording refused without consent, cross-tenant linkage denied, and a historical call reference resolving to its versioned handling rule.

- [ ] Write the consent, cross-tenant, versioning and ambiguity cases; confirm failure.
- [ ] Implement configuration versioning and call-reference recording behind the port; no recording storage.
- [ ] Run the suite and confirm no path creates a recording.
- [ ] Commit and keep the provider decision open under E-S2.

### E9: Portal and communications parity, negative matrix, export and release evidence

**Dependencies:** E1–E8, plus the spike records from E-S1–E-S3.

**Files (proposed):** `tests/integration/portal-negative-matrix.test.ts`, `tests/integration/comms-parity.test.ts`, `tests/scenarios/ordinary-portal-day.test.ts`, `docs/api/openapi.yaml`, `docs/runbooks/consent-and-suppression.md`.

**Consumes:** every operation this plan introduces. **Produces:** a parity matrix covering REST, MCP and worker paths, an export manifest for portal, consent, messaging and recall-enrollment records, and a consent/suppression runbook.

- [ ] Run the shared negative harness (`tests/integration/negative-harness.test.ts`, stated once in Global Constraints) over every command, asserting the same `Denial` reason code on REST, MCP and the worker path.
- [ ] Write the parity matrix: portal and staff transports produce identical denials for the same operation, and a portal principal can never reach a staff route.
- [ ] Write the export check: principals, grant projections, submissions, consent records, threads, outbound messages, receipts and recall enrollments export with stable identifiers and digests, and re-import verifies.
- [ ] Run the ordinary portal day scenario: invite a grantee, request an appointment, submit an intake form, open a thread, record an opt-out, evaluate a due reminder, suppress it, then deliver and receipt one message.
- [ ] Run the full suite and record every operation present in the matrix with its `SuppressionReason` or denial code; commit.

**Observable completion condition:** one test run reports a parity matrix with no operation missing, every suppression carrying a reason from the single vocabulary, and an export that re-imports without identifier loss.

## Open decisions

| Decision | Options | Recommended | What settles it |
|---|---|---|---|
| E-D1 Channels at pilot | Portal only; portal plus email; portal, email and SMS | Portal plus email; SMS only after sender registration and consent behavior are verified | Channel qualification (E-S1) and practice preference |
| E-D2 Portal assurance level | Invitation to contact on file; email plus second factor; external identity verification | Invitation plus a second factor, with an explicit recovery path | Security owner and practice representative (E-S3) |
| E-D3 Guardian expiry rule | Fixed age; per-patient configured event; manual review | Per-patient configured event owned by S5, with a review task, so a delayed change is visible | Legal review per jurisdiction |
| E-D4 Portal balance visibility | Hidden; summary only; full statement access | Summary with a link to audited statements, no payment page until the payment partner is qualified | Billing reviewer and practice decision |
| E-D5 Message retention | Fixed period; per record class; indefinite with legal hold | Per record class with legal hold, no universal period | Legal review |
| E-D6 Template approval | Any staff member; practice manager; clinical review for clinical content | Practice manager approves administrative templates; clinical review for anything clinical | Practice policy |
| E-D7 Reminder timing defaults | Fixed national defaults; per-practice configuration | Per-practice configuration with explicit quiet hours and no shipped default send window | Pilot practice input |
| E-D8 Outbound content in notifications | Full message content; notice only | Notice only, with content read in the portal | Security review and channel constraints |

## Plan self-review and scope boundary

This plan covers portal authority as a projection of S's relationship model, scoped views, shared appointment requests, intake, messaging retention, consent, suppression, recall enrollment and delivery reconciliation. It does not specify a messaging provider's receipt semantics, an SMS registration path, a telephony contract or the assurance level required to grant portal access, because none has been verified. E8 is blocked-on-discovery, and E5 to E7 cannot be closed on a synthetic provider alone.

No portal screen design, email template design, IVR flow or marketing automation is included. Those belong to UI design and later plans, and UI design remains the last planning stage. Nothing in this document is implemented, tested or validated.

## Known deviations from docs/SHARED-CONTRACTS.md

- `PortalGrant` is now a projection of S5's relationship record. The former portal scope taxonomy and `expiresAt` field were deleted rather than mapped, and `expireGuardianGrants` is gone; expiry is evaluated against the relationship by S5 at command time.
- The relationship scope names (`demographics`, `scheduling`, `clinical_read`, `financial`, `consent`) are owned by S5 and are not yet listed in the shared scope registry. This plan did not mint replacements; registering them belongs to the owner of `docs/SHARED-CONTRACTS.md`.
- The suppression reason vocabulary is defined once here and cited by S14 and B4. Any future reason must be added here first, not invented at a consumer.
- Typed command contracts and refusal sets were written for all nine tasks. They are proposed shapes, not a published OpenAPI contract until E1 and E9 land.
