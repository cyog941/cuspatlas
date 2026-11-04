# Billing and RCM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a future execution plan, not authorization to start.

**Goal:** Build an append-only financial journal with explicit reversal, allocation and undistributed-funds handling, payment plans with first-class failure states, audited statement generation, eligibility provenance, a claim lifecycle that separates submission from adjudication, and remittance reconciliation, for a US general-dentistry practice.

**Architecture:** PostgreSQL is the financial authority. A journal of balanced entries records charges, patient money, insurer money, adjustments, transfers, refunds and write-offs; nothing posted is edited, and every correction is a reversal plus a replacement. Domain commands live in `packages/domain/src/billing` and `packages/domain/src/rcm`. Payment processors, eligibility sources and claims partners sit behind narrow adapter ports, implemented first against synthetic providers. Statements and claim submissions are audited commands with durable state, not renders of current data.

**Tech Stack:** Inherits the platform foundation: supported Node LTS, TypeScript, Fastify, PostgreSQL/Supabase, JSON Schema/OpenAPI, Vitest and SQL integration tests. All money uses the shared `Money` contract; no floating-point value appears in any financial path. Pin versions and lockfiles in the foundation plan; this plan adds no runtime dependency of its own.

**Spec:** [Product design](../specs/2026-11-03-dental-pms-design.md), [capability matrix](../../CAPABILITIES.md), [API contract](../../API-AND-MCP.md), [security gates](../../SECURITY-AND-READINESS.md), [observed payment-plan and statement surfaces](../../TAB32-DOMAIN-MODEL.md).

**Task numbering:** this plan's prefix is `B`. Implementation tasks are `B1`–`B10`, discovery spikes are `B-S1`–`B-S4`, and open decisions are `B-D1`–`B-D8`. A cross-workstream reference names the fully qualified task: `F` is [platform foundation](2026-11-03-platform-foundation.md), `S` is [patients and scheduling](2026-11-04-scheduling-and-patients.md), `C` is [clinical record](2026-11-04-clinical-record.md), `I` imaging, `E` portal, `M` migration. Spikes have owners, sit in the dependency graph and can block a task. `Blocks` is derived from `Dependencies` and is never maintained as a second list.

## Global Constraints

- The [platform foundation](2026-11-03-platform-foundation.md) is a prerequisite for this plan; this plan adds no platform guarantee of its own and does not restate the foundation's synthetic-data, provenance or export rules.
- Tenant and actor are derived from authenticated context; no financial record shape carries a tenant field.
- Negative testing is stated once for the whole plan: the shared harness `tests/integration/negative-harness.test.ts` attempts every command cross-tenant, with a revoked membership, with a downgraded role, and through MCP, and each task cites the harness instead of restating the case list.
- Synthetic data and fake provider adapters only. No real money movement, no live payer submission, no production card data.
- Payment, clearinghouse, eligibility and payer behaviour is **blocked-on-discovery** until a contracted sandbox exists. No task may assume a transaction guide, denial vocabulary, remittance layout, adjudication timeline or fee arrangement.
- Posted financial history is immutable to application roles. Corrections are reversals that cite the entry being reversed, followed by a replacement entry.
- Money is the shared contract type from [SHARED-CONTRACTS](../../SHARED-CONTRACTS.md#money) — `Money = { currency: string; minor: integer }` — and is never redefined here. Mixed-currency arithmetic is a typed refusal, never a silent coercion.
- Report and export access is authorised separately from patient-read access, including ledger, receivables, payment distribution, undistributed funds and open claims.
- No CDT or other licensed code set is bundled, and no real fee schedule is reproduced. Fixtures use clearly synthetic placeholder codes until terminology rights are resolved.
- Patient identity, appointment attendance, procedure completion, claim status and payment allocation remain separate facts. No financial state may be inferred from a scheduling state.
- The estimate aggregate belongs to C12. This plan consumes an estimate by `estimateRef` and defines no estimate creation or acceptance command.

## Research gate before executing this plan

[Tab32 analysis coverage](../../TAB32-ANALYSIS-COVERAGE.md) records payment-plan worklists as observed and statement columns as observed; plan creation, authorization, failed installments, retries, allocation, claim submission, rejection, correction, ERA and secondary-claim lifecycles are **unobserved**. The claims surface exposes a denial-code endpoint and separate appeal navigation, but no vocabulary, transition rule or adjudication timing has been verified.

Treat the observed worklists as vocabulary input only. The plan status set, card-expiry handling and auto-pay semantics are our proposed model, derived from the visible columns, not a description of the incumbent's behaviour. Readiness requires a contracted sandbox, a synthetic end-to-end claim, and signed review by a billing reviewer before any of these states are presented as validated.

## Discovery spikes (resolve before the tasks they gate)

### B-S1: Payment processor qualification — blocked-on-discovery

Confirm, from a contract and a sandbox rather than documentation marketing: tokenization and whether card data ever reaches our systems; authorization, capture, void, partial and full refund semantics; retry and duplicate-charge protection; the shape and reliability of success, decline and timeout signals; receipt and settlement reporting; webhook signing; BAA scope, subprocessor list, region and cost model. Blocks B2, B3, B7 and B9. Stop condition: a written capability summary with recorded sandbox evidence, or an explicit decision to launch with patient money recorded as `unapplied` and collected outside the product.

### B-S2: Claims and clearinghouse partner qualification — blocked-on-discovery

Confirm the attachment format version, submission acknowledgement path, rejection and denial code sources with version identity, status inquiry or webhook availability, remittance delivery mechanism, secondary-claim adjudication rules, correction and replacement claim handling, sandbox access, contractual obligations and per-transaction costs. Blocks B6, B7 and B8. Stop condition: a sandbox exchange covering one accepted, one rejected and one corrected claim, or the release is declared a limited trial without claims.

### B-S3: Eligibility source qualification — blocked-on-discovery

Confirm whether real-time eligibility is available, for which payers, with what request and response fields, what staleness window the response implies, how benefit carve-outs and frequency limits are represented, and what the agreement permits us to retain. Blocks B5. Stop condition: recorded sandbox responses plus a written statement of permitted retention, or eligibility is recorded as staff-entered only and labeled as unverified.

### B-S4: Fee schedule and terminology rights — blocked-on-discovery

Determine whether a procedure code set can be distributed with the software or must be licensed per practice, and who owns fee schedule configuration. Blocks B9 and the coverage-to-estimate provenance surface in B5. Stop condition: a written licensing position reviewed before any dataset is committed, or synthetic placeholder codes remain permanently confined to fixtures.

## Implementation review focus

- A reversal that does not exactly net its original leaves a residual balance that no screen explains; B1 must prove the pair cancels and both remain readable.
- Two concurrent allocations against the same payment must not both succeed when only one payment's worth of funds exists; B2 must serialize and refuse the second.
- A payment provider timeout is an unknown result, not a failure; B3 and B7 must record an attempt pending reconciliation rather than retrying a charge.
- Re-ingesting the same remittance file must change nothing; B7 must deduplicate on a control identity, not on row similarity.
- A statement generated before a later payment must be readable as stale without being silently restated; B4 must preserve the snapshot it was generated from.
- A claim rejection must remain actionable and separately visible from acceptance; B6 must not collapse adjudication into one status field.
- A forged tenant or guarantor reference in a payment, allocation, statement or claim payload must return the same `Denial` shape as a missing record; B2, B4, B6 and B9 must prove this.
- A clinical estimate referenced by `estimateRef` must resolve through C12; this plan must never construct one. B10 must prove the read-only direction against C12.

## Proposed file structure (create only during authorized execution)

`packages/contracts/src/money.ts` implements the shared money type, currency validation and structured rounding helpers without redefining the type. `packages/domain/src/billing/` owns journal posting, reversal, allocation, undistributed funds, statements, payment plans and fee schedules. `packages/domain/src/rcm/` owns coverage, eligibility records, claim preparation and lifecycle, appeals, remittance ingestion and secondary claims. `apps/api/src/routes/billing/` and `apps/api/src/routes/rcm/` hold thin REST transports that call only these commands and publish the same operation names to MCP; no route reaches a table directly. `packages/adapters/payments/`, `packages/adapters/claims/` and `packages/adapters/eligibility/` hold the port definitions plus a synthetic implementation; no real vendor client lands before its spike closes. `packages/db/src/billing/` holds transaction adapters. Migrations use `supabase migration new billing_journal`, `billing_allocations`, `billing_statements`, `billing_plans`, `rcm_claims`, `rcm_remittance`. Tests live in `tests/integration/billing-*.test.ts` and `tests/integration/rcm-*.test.ts` with fixtures under `tests/fixtures/billing/`. UI, PDF rendering and provider SDK clients are out of scope here.

## Shared interfaces

Proposed contract definitions to create during execution, not code already present:

- `Money` is the shared contract type and is not redefined in this plan; `packages/contracts/src/money.ts` implements `addMoney`, `subtractMoney`, `negateMoney` and `allocateRemainder` over it. A mixed-currency operation returns `Denial` with `reasonCode: 'currency_mismatch'`.
- Identifiers are opaque `<entity>Ref` strings. A guaranteed patient identifier is `patientRef` (from `S4`); a guaranteed financial party is `guarantorRef` (from `S5`). Tenant is never a field.
- `Denial = { outcome: 'denied'; reasonCode: string; actorRef: string; detailRef?: string }`. Any command in this plan that can legitimately refuse returns `Denial`; a thrown error is reserved for faults.
- `JournalEntry = { entryRef: string; patientRef: string; kind: 'charge' | 'patientPayment' | 'insurerPayment' | 'adjustment' | 'refund' | 'writeOff' | 'transfer' | 'openingBalance'; amount: Money; serviceDate: string; postedAt: string; sourceRef?: string; reversesEntryRef?: string }`.
- `Allocation = { allocationRef: string; paymentEntryRef: string; chargeEntryRef: string; amount: Money; allocatedAt: string; reversedByAllocationRef?: string }`.
- `UnappliedFunds = { patientRef: string; amount: Money; ageBasis: string }`, derived and never stored as a mutable balance field.
- `postJournalEntry(ctx, envelope, entry): Promise<CommandResult<{ entryRef: string }>>` and `reverseJournalEntry(ctx, envelope, { entryRef, reason }): Promise<CommandResult<{ entryRef: string }>>`.
- `allocatePayment(ctx, envelope, { paymentEntryRef, allocations }): Promise<CommandResult<{ allocationRefs: string[] }>>` — all-or-nothing per command.
- `StatementRecord = { statementRef: string; guarantorRef: string; cutoffAt: string; snapshotDigest: string; balance: Money; state: 'generated' | 'reissued' | 'voided' }`; staleness is derived from the snapshot and never stored; delivery and print are separate events.
- `PaymentPlanView = { planRef: string; guarantorRef: string; contractTotal: Money; installment: Money; balance: Money; nextDueOn: string; authorizationState: 'unsigned' | 'authorized' | 'revoked'; autoPayState: 'active' | 'paused' | 'failed'; cardExpiryState: 'current' | 'expiring' | 'expired' | 'absent' }`.
- `ClaimView = { claimRef: string; version: number; state: 'prepared' | 'submitted' | 'acknowledged' | 'accepted' | 'rejected' | 'paid' | 'closed'; appealRef?: string; partnerRef?: string }` — appeal is a separate object, not a state value.
- `EstimateView = { estimateRef: string; planVersionRef: string; coverageRefs: readonly string[]; feeScheduleRef?: string; coverageStatus: 'entered' | 'unknown' | 'stale'; amount?: Money }` — a read-only projection of C12's aggregate; this plan never writes an estimate.
- Adapter ports: `PaymentProviderPort`, `ClaimsPartnerPort`, `EligibilityPort`, `RemittanceSourcePort`, each accepting a stable idempotency key and returning `{ outcome: 'confirmed' | 'declined' | 'unknown'; receiptId?: string; detail?: unknown }` with no PHI in the detail. A success followed by a local commit failure is the foundation's reconcilable-attempt case (`F5`–`F6`): the attempt is recorded once and reconciled by provider reference, never re-charged.
- `ReconciliationItem = { itemRef: string; kind: 'unknownOutcome' | 'unmatchedRemittance' | 'failedAutoPay' | 'expiredCard' | 'staleStatement'; subjectRef: string; openedAt: string; state: 'open' | 'resolved' | 'writtenOff' }`.

### B1: Money type and append-only journal invariants

**Dependencies:** F1–F5. **Status:** implementation.
**Files (proposed):** `packages/contracts/src/money.ts`, `packages/domain/src/billing/journal.ts`, `apps/api/src/routes/billing/journal.ts`, migration via `supabase migration new billing_journal`, `tests/integration/billing-journal.test.ts`, `docs/adr/0008-money.md`.
**Contract:** `postJournalEntry(ctx, envelope: CommandEnvelope<JournalEntryInput>): Promise<CommandResult<{ entryRef: string }>>`; `reverseJournalEntry(ctx, envelope: CommandEnvelope<{ entryRef: string; reason: string }>): Promise<CommandResult<{ entryRef: string }>>`; `readPatientBalance(ctx, { patientRef, currency }): Promise<{ balance: Money; asOf: string }>`.
**Refusals:** `unbalanced_entry`, `currency_mismatch`, `already_reversed`, `entry_not_found`, `tenant_mismatch`, `stale_version`.

**Acceptance cases:** a balanced charge posts and reads back with exact minor units; an unbalanced or malformed entry is refused with a typed reason; a currency mismatch between entry and tenant configuration is refused; a reversal exactly cancels its original and both remain readable; a reversal of an already-reversed entry is refused; a cross-tenant charge reference is denied with the same shape as a missing record; two concurrent reversals of one entry produce one reversal and one conflict; the application role cannot update or delete a posted entry; `readPatientBalance` never constructs an estimate and reads no clinical table.

**Failure and recovery:** a failure inside the posting transaction leaves no entry, no audit row and no outbox event; a crash after commit but before the caller acknowledges yields a recoverable recorded result through the idempotency layer; a reversal whose original cannot be read fails closed rather than posting an unlinked correction.

**Completion condition:** the integration suite shows a charge, a partial payment and a partial refund reconciling to an exact remaining balance, while direct update and delete attempts by the runtime role are denied.

- [ ] Write the acceptance and failure cases above as synthetic tests against a tenant-scoped fixture; run `pnpm test:integration -- billing-journal` and confirm they fail.
- [ ] Implement the money helpers over the shared type, entry validation, reversal linkage, and append-only grants; no balance column, no mutation path.
- [ ] Re-run the suite under the restricted runtime role and confirm every deny case fails closed.
- [ ] Record the currency and rounding decision in the ADR and commit.

### B2: Payments, allocations and undistributed funds

**Dependencies:** B1; B-S1 for the provider-facing parts only. **Status:** allocation implementation; provider execution blocked-on-discovery.
**Files (proposed):** `packages/domain/src/billing/allocations.ts`, `packages/domain/src/billing/unapplied.ts`, `apps/api/src/routes/billing/payments.ts`, migration via `supabase migration new billing_allocations`, `packages/adapters/payments/port.ts`, `packages/adapters/payments/synthetic.ts`, `tests/integration/billing-allocations.test.ts`.
**Contract:** `allocatePayment(ctx, envelope: CommandEnvelope<{ paymentEntryRef: string; allocations: readonly { chargeEntryRef: string; amount: Money }[] }>): Promise<CommandResult<{ allocationRefs: string[] }>>`; `moveUnappliedFunds(ctx, envelope: CommandEnvelope<{ fromPatientRef: string; toPatientRef: string; amount: Money; reason: string }>): Promise<CommandResult<{ transferEntryRef: string }>>`; `listUnappliedFunds(ctx, filter: UnappliedFilter): Promise<UnappliedFunds[]>`; `recordPaymentIntent(ctx, envelope: CommandEnvelope<PaymentIntentInput>): Promise<CommandResult<{ attemptRef: string; outcome: 'confirmed' | 'declined' | 'unknown' }>>`.
**Refusals:** `insufficient_funds`, `currency_mismatch`, `tenant_mismatch`, `reason_required`, `allocation_reversal_required`, `refund_exceeds_funds`.

**Acceptance cases:** an allocation exceeding the payment's available funds is refused; allocations across two charges in one command commit together or not at all; a payment with all funds allocated leaves no undistributed balance; undistributed funds appear as a first-class query result with age basis, not as a silent remainder; allocating a tenant A payment to a tenant B charge is denied; moving funds between two patients requires an explicit reason and is audited; a refund larger than collected-and-unapplied funds is refused; a duplicate provider receipt does not create a second payment entry.

**Failure and recovery:** a provider call that times out is recorded as `unknown` with a reconciliation item, never retried automatically and never posted as collected; a reversal of a payment with existing allocations requires the allocations to be reversed first and refuses otherwise.

**Completion condition:** a synthetic charge plus payment plus partial refund reconciles to zero undistributed funds, and a query distinguishes allocated from undistributed money per patient and currency.

- [ ] Write the cases above, including the forged-tenant and concurrent-allocation cases, and confirm failure.
- [ ] Implement allocation commands, undistributed derivation, and the synthetic payment adapter with `confirmed`/`declined`/`unknown` outcomes.
- [ ] Run the suite with two concurrent allocation attempts against one payment; expect exactly one committed allocation set.
- [ ] Add the reconciliation-item path for unknown outcomes and commit.

### B3: Payment plans with expired-card and failed-auto-pay worklists

**Dependencies:** B1–B2; B-S1 for real card state. **Status:** plan lifecycle implementation; card and auto-pay execution blocked-on-discovery.
**Files (proposed):** `packages/domain/src/billing/payment-plans.ts`, `packages/domain/src/billing/plan-worklists.ts`, `apps/api/src/routes/billing/payment-plans.ts`, migration via `supabase migration new billing_plans`, `tests/integration/billing-payment-plans.test.ts`.
**Contract:** `createPaymentPlan(ctx, envelope: CommandEnvelope<PaymentPlanInput>): Promise<CommandResult<PaymentPlanView>>`; `authorizePlan(ctx, envelope: CommandEnvelope<{ planRef: string; authorizationRef: string }>): Promise<CommandResult<PaymentPlanView>>`; `voidPlan(ctx, envelope: CommandEnvelope<{ planRef: string; reason: string }>): Promise<CommandResult<PaymentPlanView>>`; `recordInstallmentAttempt(ctx, envelope: CommandEnvelope<{ planRef: string; periodRef: string; outcome: 'paid' | 'declined' | 'unknown' }>): Promise<CommandResult<{ attemptRef: string }>>`; `listPlanWorklist(ctx, { kind }): Promise<PaymentPlanView[]>` where kind covers missing signature, expired card, failed auto-pay, overdue, and closed.
**Refusals:** `unsigned_authorization`, `tenant_mismatch`, `plan_voided`, `attempt_in_flight`, `duplicate_period`.

**Acceptance cases:** a plan cannot move to authorized without a recorded authorization fact; an installment due date in the past marks overdraft on the plan without editing the contract total; a failed auto-pay attempt creates exactly one open reconciliation item and a visible worklist row; an expired card moves `cardExpiryState` to expired and enters the expired-card worklist without voiding the plan; updating a card expiry requires a new authorization record; a voided plan retains its history and any collected money stays in the journal; two concurrent auto-pay runs for the same installment produce one attempt; a cross-tenant plan read or mutation is denied.

**Failure and recovery:** a plan whose installment charge outcome is unknown stays in a blocked auto-pay state with a reconciliation item rather than advancing the schedule; a void requested while an attempt is in flight completes only after the attempt resolves or is marked unknown; a plan with a partially collected installment records partial application rather than rounding to paid.

**Completion condition:** the worklist queries return exactly the synthetic plans in missing-signature, expired-card and failed-auto-pay states, and a repeated scheduler run adds no second attempt for the same installment period.

- [ ] Write the lifecycle and worklist cases, including the duplicate-run and cross-tenant cases, and confirm failure.
- [ ] Implement plan creation, authorization facts, attempt recording, and derived worklist queries; no stored computed balance.
- [ ] Run the scheduler twice in the same test and confirm one attempt per installment period.
- [ ] Run the suite and commit.

### B4: Audited statement generation with balance snapshot and staleness

**Dependencies:** B1–B2; F4 for audit and outbox; E6 for any delivery decision. **Status:** implementation.
**Files (proposed):** `packages/domain/src/billing/statements.ts`, `apps/api/src/routes/billing/statements.ts`, migration via `supabase migration new billing_statements`, `tests/integration/billing-statements.test.ts`, `docs/api/openapi.yaml` additions.
**Contract:** `generateStatement(ctx, envelope: CommandEnvelope<{ guarantorRef: string; cutoffAt: string; basis: string }>): Promise<CommandResult<StatementRecord>>`; `recordStatementDelivery(ctx, envelope: CommandEnvelope<{ statementRef: string; channel: string; outcome: 'delivered' | 'failed' | 'unknown'; suppressionDecisionRef?: string }>): Promise<CommandResult<{ deliveryRef: string }>>`; `deriveStatementFreshness(record: StatementRecord, currentBalance: Money): 'fresh' | 'stale'`.
**Refusals:** `tenant_mismatch`, `stale_statement`, `unknown_delivery_outcome`, `garantor_unresolved`.

**Acceptance cases:** generation writes one audited command with a snapshot digest and a cutoff basis, and the statement row is never updated afterwards; regenerating for the same guarantor and cutoff with the same idempotency key replays the same record; regenerating for a new cutoff produces a new record that supersedes the earlier one without altering it; a payment posted after generation makes the earlier record derive as stale; a statement addressed to a guarantor in another tenant is denied; a zero-balance or credit-balance guarantor is handled by an explicit rule rather than producing a negative statement silently; print and delivery are separate events, and a delivery failure does not void the statement; a delivery that messages a patient cites E6's suppression decision and its `SuppressionReason` vocabulary, and never evaluates consent here.

**Failure and recovery:** a generation that fails mid-way leaves no statement row and no audit claim of generation; a delivery attempt with an unknown provider outcome creates a reconciliation item and does not resend; a stale statement cannot be delivered through the ordinary path without an explicit reissue, and the reissue names the superseded record.

**Completion condition:** statement records retain the snapshot they were generated from, staleness is derived rather than stored, and no statement row shows a post-generation update.

- [ ] Write the generation, idempotency, staleness and delivery cases; confirm failure.
- [ ] Implement generation as an audited command with snapshot capture and separate delivery events.
- [ ] Run the suite including the late-payment staleness case and the cross-tenant case.
- [ ] Publish the statement contract in OpenAPI and commit.

### B5: Coverage, eligibility records and coverage provenance

**Dependencies:** S4; S5 for `guarantorRef`; B1 for coverage amounts; B-S3. **Status:** record model implementation; live eligibility blocked-on-discovery. C12 consumes this contract by coverage reference; the reverse estimate read is B10's, so the two tasks do not block each other.
**Files (proposed):** `packages/domain/src/rcm/coverage.ts`, `packages/domain/src/rcm/eligibility.ts`, `apps/api/src/routes/rcm/coverage.ts`, migration via `supabase migration new rcm_coverage_eligibility`, `packages/adapters/eligibility/port.ts`, `packages/adapters/eligibility/synthetic.ts`, `tests/integration/rcm-eligibility.test.ts`.
**Contract:** `recordCoverage(ctx, envelope: CommandEnvelope<CoverageInput>): Promise<CommandResult<{ coverageRef: string }>>`; `resolveActiveCoverage(ctx, { patientRef: string; serviceDate: string }): Promise<CoverageSummary[]>` returning ordered primary/secondary with effective dates; `recordEligibility(ctx, envelope: CommandEnvelope<EligibilityInput>): Promise<CommandResult<{ eligibilityRef: string; state: 'verified' | 'unverified' | 'unknown' }>>`; `assessEligibilityFreshness(record, serviceDate): 'current' | 'stale' | 'unknown'`.
**Refusals:** `overlapping_coverage`, `tenant_mismatch`, `stale_eligibility`, `unparsed_response`.

**Acceptance cases:** coverage is effective-dated and a service date outside the effective range does not resolve; overlapping coverage for the same payer and rank is refused unless an explicit override with reason is recorded; an eligibility record carries source, capture time and a staleness window and derives as stale after it; a stale record is surfaced and never silently treated as current; a coverage record exposes the exact coverage, fee schedule version and eligibility record it carries, and a later change does not rewrite an earlier record; a subscriber who is not the patient is modeled as a separate relationship; a cross-tenant subscriber or patient reference is denied; this plan creates no estimate and offers no acceptance command.

**Failure and recovery:** an eligibility request that times out records `unknown` rather than `ineligible`; a response that cannot be mapped to the expected fields is stored as raw evidence with an explicit unparsed state rather than partially interpreted; an estimate referencing no eligibility record is reported as unverified, never silently promoted.

**Completion condition:** every coverage record resolves to one named fee schedule version and one eligibility record, and a stale record is shown as stale in the same query that returns it.

- [ ] Write the coverage, freshness, provenance and cross-tenant cases; confirm failure.
- [ ] Implement coverage resolution and eligibility recording with provenance.
- [ ] Run the suite and confirm an expired record never reports as current.
- [ ] Commit the coverage and eligibility contracts; record that this plan defines no estimate command.

### B6: Claim lifecycle, denial codes and appeals

**Dependencies:** B2 and B5; C14 for the rendered-procedure facts a claim is prepared from; B-S2 and B-S4. **Status:** blocked-on-discovery beyond claim preparation and internal state.
**Files (proposed):** `packages/domain/src/rcm/claims.ts`, `packages/domain/src/rcm/appeals.ts`, `apps/api/src/routes/rcm/claims.ts`, `packages/adapters/claims/port.ts`, `packages/adapters/claims/synthetic.ts`, migration via `supabase migration new rcm_claims`, `tests/integration/rcm-claims.test.ts`.
**Contract:** `prepareClaim(ctx, envelope: CommandEnvelope<{ patientRef: string; renderedProcedureRefs: readonly string[] }>): Promise<CommandResult<ClaimView>>`; `validateClaim(ctx, { claimRef: string; version: number }): Promise<{ valid: true } | Denial>`; `submitClaim(ctx, envelope: CommandEnvelope<{ claimRef: string; version: number }>): Promise<CommandResult<{ partnerRef: string }>>`; `recordAcknowledgement`, `recordAdjudication`; `openAppeal(ctx, envelope: CommandEnvelope<{ claimRef: string; basis: string }>): Promise<CommandResult<{ appealRef: string }>>`; `reassignClaim(ctx, envelope: CommandEnvelope<{ claimRef: string; assigneeRef: string; reason: string }>): Promise<CommandResult<ClaimView>>`.
**Refusals:** `missing_completion_fact`, `missing_rendering_provider`, `stale_version`, `unvalidated_claim`, `duplicate_appeal`, `cross_tenant`, `partner_unavailable`.

**Acceptance cases:** a claim can be prepared only from procedures with a completion fact and a rendering provider; submission requires the validated version and an authorized partner, and a stale version conflicts; the same submission idempotency key returns the same partner reference rather than a second claim; acknowledgement, acceptance and rejection are separate recorded facts and a rejection keeps the claim actionable; a denial is stored with its source vocabulary identity and version, never as free text only; an appeal is a separate object linked to the claim, not a status mutation, and a second appeal on the same basis is refused; reassignment retains the prior assignment history and cannot orphan unassigned work; a submitted claim body cannot be edited, only replaced by a new version; a cross-tenant claim read, submit or appeal is denied.

**Failure and recovery:** a partner error after acceptance is recorded as `unknown` and reconciled by partner reference; a submission rejected for a transport reason is retried with the same key, not a new one; a claim whose procedure completion is later amended requires a replacement claim with an explicit link, not a silent resubmission; a partner outage leaves claims queued in a visible state and blocks nothing else.

**Completion condition:** a synthetic claim traverses prepared, submitted, acknowledged, rejected and appealed with each transition recorded and auditable, and no earlier claim version is overwritten.

- [ ] Write the lifecycle, duplicate-submission, denial-vocabulary and cross-tenant cases; confirm failure.
- [ ] Implement preparation, validation, submission through the synthetic partner, adjudication facts and appeals as linked objects.
- [ ] Run the suite including the unknown-outcome reconciliation case.
- [ ] Record the partner contract as blocked-on-discovery in the ADR and commit.

### B7: Remittance ingestion and reconciliation

**Dependencies:** B1, B2 and B6; B-S2. **Status:** blocked-on-discovery for real remittance layout; staging implementation permitted against synthetic files.
**Files (proposed):** `packages/domain/src/rcm/remittance.ts`, `apps/api/src/routes/rcm/remittance.ts`, `packages/adapters/claims/remittance-source.ts`, migration via `supabase migration new rcm_remittance`, `tests/fixtures/billing/remittance/`, `tests/integration/rcm-remittance.test.ts`.
**Contract:** `stageRemittance(ctx, envelope: CommandEnvelope<{ fileRef: string }>): Promise<CommandResult<{ stagedRef: string; digest: string; controlIdentity: string; complete: boolean }>>`; `postRemittance(ctx, envelope: CommandEnvelope<{ stagedRef: string }>): Promise<CommandResult<{ postedRefs: string[]; exceptions: ReconciliationItem[] }>>`; `listUnmatchedRemittance(ctx): Promise<ReconciliationItem[]>`.
**Refusals:** `duplicate_control_identity`, `partial_parse`, `currency_mismatch`, `cross_tenant`, `unmatched_line`, `already_posted`.

**Acceptance cases:** re-ingesting the same control identity is refused as a duplicate and posts nothing; a remittance line matching a charge posts an insurer payment and any adjustment as balanced entries; a line that cannot be matched to one charge creates a reconciliation item instead of guessing a patient; a partially parsed file stages in an incomplete state and posts nothing; a corrected remittance reverses the earlier postings with linkage rather than editing them; a remittance referencing a tenant A claim cannot post against tenant B; a remittance whose currency differs from the claim is refused.

**Failure and recovery:** a parse failure preserves the staged artifact and the diagnostic without partial posting; a posting failure midway rolls back the whole remittance transaction and leaves the staged artifact available for a careful retry; a duplicate control identity arriving after a correction is treated as an explicit supersede event, not an automatic second posting.

**Completion condition:** one synthetic remittance yields either fully balanced postings or an explicit exception list, and a second ingestion of the same file leaves totals unchanged.

- [ ] Write the duplicate, unmatched, partial-parse, supersede and cross-tenant cases; confirm failure.
- [ ] Implement staging with digest and control identity, then all-or-nothing posting with reconciliation items.
- [ ] Run the suite twice against the same fixture file and confirm identical totals.
- [ ] Commit; keep the real layout mapping behind the unclosed spike.

### B8: Secondary claims and coordination of benefits

**Dependencies:** B5, B6 and B7; B-S2. **Status:** blocked-on-discovery.
**Files (proposed):** `packages/domain/src/rcm/secondary.ts`, `apps/api/src/routes/rcm/secondary.ts`, `tests/integration/rcm-secondary.test.ts`.
**Contract:** `prepareSecondaryClaim(ctx, envelope: CommandEnvelope<{ primaryClaimRef: string }>): Promise<CommandResult<ClaimView>>`; `validateSecondaryEligibility(ctx, { claimRef: string }): Promise<{ valid: true } | Denial>`.
**Refusals:** `primary_pending`, `primary_reversed`, `double_payment`, `cross_tenant`, `missing_adjudication`.

**Acceptance cases:** a secondary claim cannot be prepared without a primary adjudication fact; the secondary claim cannot claim an amount the primary already paid; swapping primary and secondary coverage produces a new claim pair with retained history rather than mutating either; a secondary submission is refused while the primary is pending, and a worklist item records why; a cross-tenant primary reference is denied; a secondary claim whose primary was later reversed is flagged for review rather than resubmitted silently.

**Failure and recovery:** if the primary adjudication arrives after the secondary was queued, the secondary is held with a visible dependency state; if the secondary partner returns an unknown outcome, the claim is reconciled by partner reference.

**Completion condition:** every synthetic secondary claim carries an explicit reference to the primary adjudication it depends on, and a pending primary blocks preparation with a visible reason.

- [ ] Write the dependency, double-payment, swap and cross-tenant cases; confirm failure.
- [ ] Implement secondary preparation with adjudication linkage and the pending-primary dependency state.
- [ ] Run the suite and confirm no path creates a secondary claim without a primary reference.
- [ ] Commit; keep partner-specific rules behind the unclosed spike.

### B9: Fee schedules, adjustments and report-scope authorisation

**Dependencies:** B1–B8; B-S4. **Status:** implementation for fee schedules and report scope; code content blocked-on-discovery.
**Files (proposed):** `packages/domain/src/billing/fee-schedules.ts`, `packages/domain/src/billing/reports.ts`, `apps/api/src/routes/billing/fee-schedules.ts`, `apps/api/src/routes/billing/reports.ts`, migration via `supabase migration new billing_fee_schedules`, `tests/integration/billing-fee-schedules.test.ts`, `tests/integration/billing-report-scope.test.ts`.
**Contract:** `publishFeeSchedule(ctx, envelope: CommandEnvelope<FeeScheduleInput>): Promise<CommandResult<{ feeScheduleRef: string }>>` with effective dating; `resolveFee(procedureCodeRef, serviceDate, locationRef): Promise<{ fee: Money; feeScheduleRef: string }>`; `postAdjustment(ctx, envelope: CommandEnvelope<{ entryRef: string; amount: Money; reasonCode: string }>): Promise<CommandResult<{ adjustmentRef: string }>>`; report queries guarded by explicit scopes: `ledger.read`, `receivables.read`, `paymentDistribution.read`, `undistributedFunds.read`, `openClaims.read`.
**Refusals:** `scope_missing`, `effective_date_gap`, `reason_not_configured`, `tenant_mismatch`, `reconciliation_discrepancy`.

**Acceptance cases:** a fee schedule change never alters an already posted charge; a charge records the schedule version it used; an adjustment requires a reason from the configured set and is reversible; a role holding patient-read but not `receivables.read` is denied the receivables report, and the denial shape is identical whether or not records exist; a user denied `undistributedFunds.read` cannot infer totals through a filter or count; report access by a service account without the scope is denied; a cross-tenant report request is denied; distribution totals reconcile to journal and provider totals or the report states the difference explicitly.

**Failure and recovery:** publishing a schedule with a gap in effective dates is refused rather than leaving an undefined fee; a report that cannot reconcile to provider totals returns an explicit discrepancy state instead of a truncated number; a mid-day schedule correction creates a new version without retroactive repricing.

**Completion condition:** the report suites show each sensitive report denied to a role lacking its own scope, and every posted charge resolves to exactly one fee schedule version.

- [ ] Write the effective-dating, adjustment, report-scope and cross-tenant cases; confirm failure.
- [ ] Implement fee schedule versioning, adjustment posting with reasons, and scope-guarded report queries.
- [ ] Run the reconciliation check against a synthetic journal and confirm agreement or explicit discrepancy.
- [ ] Commit, leaving the code-set question open under B-S4.

### B10: Billing parity, negative matrix, export and release evidence

**Dependencies:** B1–B9, C12 for the estimate read, plus the spike records from B-S1–B-S4.

**Files (proposed):** `tests/integration/billing-negative-matrix.test.ts`, `tests/integration/billing-parity.test.ts`, `tests/scenarios/ordinary-financial-day.test.ts`, `docs/api/openapi.yaml`, `docs/runbooks/reconciliation-exceptions.md`.

**Consumes:** every operation this plan introduces. **Produces:** a parity matrix covering REST, MCP and worker paths, an export manifest for financial records, and a reconciliation-exception runbook.

- [ ] Run the shared negative harness (`tests/integration/negative-harness.test.ts`, stated once in Global Constraints) over every command, asserting the same `Denial` reason code on REST, MCP and the worker path.
- [ ] Write the parity matrix: every financial and RCM command through REST and MCP with identical allow, deny and conflict outcomes, including the report-scope denials.
- [ ] Write the estimate-provenance check: an estimate read by `estimateRef` from C12 resolves every coverage and fee-schedule reference through B5, and this plan writes nothing to the estimate.
- [ ] Write the export check: journal entries, allocations, undistributed funds, statements, plans, coverage, eligibility, claims, appeals and remittance artifacts export with stable identifiers and digests and verify on re-import.
- [ ] Run the ordinary financial day scenario: post a charge, accept a payment, allocate partially, generate and stale a statement, run a payment plan, prepare and submit a claim, adjudicate, ingest a remittance, and produce a report.
- [ ] Run the full suite and record every operation present in the matrix with its reason code; commit.

**Observable completion condition:** one test run reports a parity matrix with no operation missing, every sensitive report denied to a role outside its scope, a stale estimate/statement surfaced as stale rather than restated, and an export that re-imports without identifier loss.

## Open decisions

| Decision | Options | Recommended | What settles it |
|---|---|---|---|
| B-D1 Card data handling | Store card data; store provider tokens only | Provider tokens only, no card data in our systems | Provider contract and PCI obligations reviewed (B-S1) |
| B-D2 Draft vs posted adjustments | Auto-post contractual adjustments; require review | Post insurer contractual adjustments from remittance, require review for patient-facing adjustments | Billing reviewer sign-off |
| B-D3 Rounding of a residual minor unit | Assign to largest line; fixed order; refuse | Deterministic largest-remainder with a documented tie-break, recorded on the allocation | Billing reviewer sign-off; recorded in ADR 0008 |
| B-D4 Undistributed funds policy | Hold indefinitely; age and escalate; refund | Hold with age basis and an escalation worklist; refund only by explicit command | Practice financial policy |
| B-D5 Statement delivery | Portal only; printed in practice; mail vendor | Portal plus recorded manual print at pilot; no mail vendor before a qualified partner exists | Operator decision at pilot |
| B-D6 Historical financial detail | Import as posted transactions; opening balances plus archive | Opening balances plus an integrity-checked read-only archive, never fabricated postings | Design review already recommends this; confirms at migration sign-off |
| B-D7 Claim correction model | Edit and resubmit; replace with a new version | Replace with a linked new version; never edit a submitted claim | Clearinghouse rules (B-S2) |
| B-D8 Report discrepancy tolerance | Zero tolerance; explicit threshold | Zero tolerance with an explicit discrepancy state; no threshold without evidence | Billing reviewer and pilot reconciliation baseline |

## Plan self-review and scope boundary

This plan covers financial accounting, patient billing mechanics, eligibility recording, claim lifecycle and remittance handling. It does not specify a payer contract, a clearinghouse transaction guide, a denial vocabulary, a fee schedule dataset or an adjudication timeline, because none has been verified. B6, B7 and B8 are explicitly blocked-on-discovery and cannot be represented as complete on synthetic adapters alone.

No UI layout, PDF rendering, printing pipeline, provider SDK client, collection-agency workflow or analytics surface is designed here. Those belong to later plans and to UI design, which remains the last planning stage. Nothing in this document is implemented, tested or validated.

## Known deviations from docs/SHARED-CONTRACTS.md

- The estimate aggregate moved to C12. This plan defines no estimate creation or acceptance command; the read-only `readEstimate(estimateRef)` provenance check lives in B10 so that B5 and C12 do not depend on each other.
- `guarantorRef` is produced by S5; B4 and B3 consume it. This plan previously used an unproduced guarantor identifier and no longer does.
- Report scopes `ledger.read`, `receivables.read`, `paymentDistribution.read`, `undistributedFunds.read` and `openClaims.read` are already listed in the shared registry; no new scope was added. If B10 needs an export-specific scope it must be registered in `docs/SHARED-CONTRACTS.md` first.
- The typed command contracts and refusal sets were written against the current proposal. They are not a published OpenAPI contract until B1 and B9 land.
