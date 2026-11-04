import {
  type ActorContext,
  type MembershipRecord,
  type MembershipSource,
  type PrincipalKind,
  RefusalError,
  type SecurityReasonCode,
} from '@cuspatlas/contracts';

interface ActionPolicy {
  /** Scope required in BOTH the live membership and the context; null = any active member. */
  readonly scope: string | null;
  readonly principals: readonly PrincipalKind[];
}

/** One policy table for every transport (REST, MCP, workers). Unknown actions are denied. */
export const ACTION_POLICIES = {
  'session.read': { scope: null, principals: ['human', 'service'] },
  'syntheticTasks.read': { scope: 'syntheticTasks.read', principals: ['human', 'service'] },
  'syntheticTasks.create': { scope: 'syntheticTasks.write', principals: ['human', 'service'] },
  'syntheticTasks.relabel': { scope: 'syntheticTasks.write', principals: ['human', 'service'] },
  'syntheticTasks.approve': { scope: 'syntheticTasks.approve', principals: ['human'] },
  // The outbox worker's own principal: leases and finalizes delivery state in one tenant (F Task 6).
  'outbox.deliver': { scope: 'outbox.deliver', principals: ['service'] },
  // F Task 7a proposals. Preparing and reading need only read: an agent may draft a change it could
  // never execute alone. Approval is human-only. Commit authorizes the executor for the proposal's own
  // operation (syntheticTasks.create / relabel), so there is no separate commit scope.
  'syntheticTasks.proposals.prepare': { scope: 'syntheticTasks.read', principals: ['human', 'service'] },
  'syntheticTasks.proposals.read': { scope: 'syntheticTasks.read', principals: ['human', 'service'] },
  'syntheticTasks.proposals.approve': { scope: 'syntheticTasks.approve', principals: ['human'] },
  // S4 patient identity (ADR 0003, recommended-pending-approval). Reads are sensitive-read audited.
  'patients.create': { scope: 'patients.write', principals: ['human', 'service'] },
  'patients.updateDemographics': { scope: 'patients.write', principals: ['human', 'service'] },
  'patients.setStatus': { scope: 'patients.write', principals: ['human', 'service'] },
  'patients.read': { scope: 'patients.read', principals: ['human', 'service'] },
  'patients.search': { scope: 'patients.read', principals: ['human', 'service'] },
  // S5 relationships. Staff manage them; relationship scopes themselves are evaluated by
  // policy/patient-access.ts and never grant a staff action.
  'patients.relationships.add': { scope: 'patients.write', principals: ['human', 'service'] },
  'patients.relationships.revoke': { scope: 'patients.write', principals: ['human', 'service'] },
  'patients.relationships.list': { scope: 'patients.read', principals: ['human', 'service'] },
  'patients.access.resolve': { scope: 'patients.read', principals: ['human', 'service'] },
  // S6 duplicate review and merge (ADR 0003 Q6, pending approval): human principals only. Candidate
  // review issues merge confirmation tokens, so it needs the merge scope too.
  'patients.duplicates.find': { scope: 'patients.merge', principals: ['human'] },
  'patients.merge': { scope: 'patients.merge', principals: ['human'] },
  'patients.unmerge': { scope: 'patients.merge', principals: ['human'] },
  // Elevated reversal (outside the window or after new clinical/financial facts): checked as an
  // additional capability of the unmerge caller, never as a separate operation.
  'patients.unmerge.reconcile': { scope: 'patients.mergeReconcile', principals: ['human'] },
  'patients.merges.list': { scope: 'patients.read', principals: ['human', 'service'] },
  // S7/S9 scheduling resources (resources track). Configuration of locations, resources and hours
  // is practice administration (`admin.configure`); blocking time is a scheduling act
  // (`scheduling.write`); every read and the availability search need `scheduling.read`.
  'scheduling.locations.define': { scope: 'admin.configure', principals: ['human', 'service'] },
  'scheduling.locations.changeTimeZone': { scope: 'admin.configure', principals: ['human', 'service'] },
  'scheduling.locations.list': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.resources.define': { scope: 'admin.configure', principals: ['human', 'service'] },
  'scheduling.resources.setAvailability': { scope: 'admin.configure', principals: ['human', 'service'] },
  'scheduling.resources.deactivate': { scope: 'admin.configure', principals: ['human', 'service'] },
  'scheduling.resources.list': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.resources.read': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.resources.dataQuality': { scope: 'admin.configure', principals: ['human', 'service'] },
  'scheduling.timeBlocks.create': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.availability.search': { scope: 'scheduling.read', principals: ['human', 'service'] },
  // S8 appointment requests: staff record and work requests (scheduling.write); reads need
  // scheduling.read. The portal (E3) will call the same create command with origin 'portal'.
  'scheduling.requests.create': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.requests.updatePreferences': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.requests.review': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.requests.close': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.requests.reopen': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.requests.read': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.requests.list': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.requests.unbookedReport': { scope: 'scheduling.read', principals: ['human', 'service'] },
  // S10 booking and holds. Reading a booking (and seeing a blocking booking named in a conflict)
  // needs scheduling.read; an override is an additional, human-only capability of the booking caller.
  'scheduling.appointments.book': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.appointments.reschedule': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.appointments.cancel': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.appointments.read': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.appointments.override': { scope: 'scheduling.override', principals: ['human'] },
  'scheduling.holds.create': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.holds.release': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.holds.reconcile': { scope: 'scheduling.write', principals: ['human', 'service'] },
  // S11 attendance: recording a transition is front-desk scheduling work (scheduling.write);
  // automated confirmation may come from a service principal with its provenance.
  'scheduling.attendance.record': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.attendance.list': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.attendance.visitStatus': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.worklist.daily': { scope: 'scheduling.read', principals: ['human', 'service'] },
  // B1 journal (ADR 0008, recommended-pending-billing-approval). Posting is billing.write (human or
  // service: C14 will post charges as a service). Every correction (reversal) is human-only
  // billing.correct. Reads need the registry's report scope ledger.read, never patients.read alone.
  'billing.charges.post': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.charges.read': { scope: 'ledger.read', principals: ['human', 'service'] },
  'billing.entries.read': { scope: 'ledger.read', principals: ['human', 'service'] },
  'billing.entries.reverse': { scope: 'billing.correct', principals: ['human'] },
  'billing.ledger.list': { scope: 'ledger.read', principals: ['human', 'service'] },
  'billing.balances.read': { scope: 'ledger.read', principals: ['human', 'service'] },
  // B2 payments and allocations. Recording, settling, reconciling and allocating are billing.write
  // (a deterministic rule may post them as a service). Refunds and transfers of funds between
  // patients are corrections: human-only billing.correct. Payment reads need paymentDistribution.read
  // and the undistributed-funds worklist undistributedFunds.read (registry report scopes).
  'billing.payments.record': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.payments.read': { scope: 'paymentDistribution.read', principals: ['human', 'service'] },
  'billing.payments.settle': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.payments.reconcile': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.payments.allocate': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.payments.refund': { scope: 'billing.correct', principals: ['human'] },
  'billing.funds.transfer': { scope: 'billing.correct', principals: ['human'] },
  'billing.responsibility.transfer': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.worklist.list': { scope: 'undistributedFunds.read', principals: ['human', 'service'] },
  // B3 payment plans. Creating, authorizing (recording the signed-agreement fact), amending, auto-pay
  // and collection are billing.write (a scheduler may collect as a service). Voiding or defaulting a
  // plan is a human-only billing.correct decision. Reads and the plan worklist need receivables.read.
  'billing.plans.create': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.plans.read': { scope: 'receivables.read', principals: ['human', 'service'] },
  'billing.plans.authorize': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.plans.amend': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.plans.autopay': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.plans.collect': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.plans.close': { scope: 'billing.correct', principals: ['human'] },
  'billing.plans.worklist': { scope: 'receivables.read', principals: ['human', 'service'] },
  // B4 statements. Generation is billing.write (a scheduled statement run may be a service); reading a
  // statement with its derived freshness needs receivables.read. Delivery is E7's.
  'billing.statements.generate': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.statements.read': { scope: 'receivables.read', principals: ['human', 'service'] },
  // B5 coverage and eligibility (registry scopes coverage.read / coverage.write). Front desk and billing
  // record coverage and eligibility; C (estimates) and S read coverage state, never compute it.
  'rcm.coverages.record': { scope: 'coverage.write', principals: ['human', 'service'] },
  'rcm.coverages.change': { scope: 'coverage.write', principals: ['human', 'service'] },
  'rcm.coverages.read': { scope: 'coverage.read', principals: ['human', 'service'] },
  'rcm.coverages.resolve': { scope: 'coverage.read', principals: ['human', 'service'] },
  'rcm.eligibility.record': { scope: 'coverage.write', principals: ['human', 'service'] },
  // B9 fee schedules (configuration: human billing.write), the fee read C12 estimates use, the C14 ->
  // B consumer (service only: the worker principal), adjustments (contractual by billing.write; a
  // courtesy or write-off decision is a human-only correction) and the receivables report.
  'billing.feeSchedules.publish': { scope: 'billing.write', principals: ['human'] },
  'billing.fees.resolve': { scope: 'ledger.read', principals: ['human', 'service'] },
  'billing.procedures.consume': { scope: 'billing.write', principals: ['service'] },
  'billing.adjustments.post': { scope: 'billing.write', principals: ['human'] },
  'billing.adjustments.decide': { scope: 'billing.correct', principals: ['human'] },
  'billing.reports.receivables': { scope: 'receivables.read', principals: ['human', 'service'] },
  // B6 claims (fake clearinghouse only): reads need openClaims.read; preparation, validation,
  // versions, submission and polling are billing.write (a qualified standing policy lets a service
  // submit); appeal review and standing policies are human-only billing.correct.
  'rcm.claims.prepare': { scope: 'billing.write', principals: ['human', 'service'] },
  'rcm.claims.validate': { scope: 'billing.write', principals: ['human', 'service'] },
  'rcm.claims.attach': { scope: 'billing.write', principals: ['human', 'service'] },
  'rcm.claims.replace': { scope: 'billing.write', principals: ['human'] },
  'rcm.claims.submit': { scope: 'billing.write', principals: ['human', 'service'] },
  'rcm.claims.poll': { scope: 'billing.write', principals: ['human', 'service'] },
  'rcm.claims.read': { scope: 'openClaims.read', principals: ['human', 'service'] },
  'rcm.claims.worklist': { scope: 'openClaims.read', principals: ['human', 'service'] },
  'rcm.appeals.draft': { scope: 'billing.write', principals: ['human'] },
  'rcm.appeals.review': { scope: 'billing.correct', principals: ['human'] },
  'rcm.submissionPolicies.create': { scope: 'billing.correct', principals: ['human'] },
  'rcm.submissionPolicies.revoke': { scope: 'billing.correct', principals: ['human'] },
  // B7 remittance: ingestion and settlement are billing.write (a service may ingest); reversal is a
  // human-only correction; reads need paymentDistribution.read.
  'rcm.remittances.ingest': { scope: 'billing.write', principals: ['human', 'service'] },
  'rcm.remittances.settle': { scope: 'billing.write', principals: ['human'] },
  'rcm.remittances.reverse': { scope: 'billing.correct', principals: ['human'] },
  'rcm.remittances.read': { scope: 'paymentDistribution.read', principals: ['human', 'service'] },
  // C5 encounters and clinical authorship (recommended-pending-clinical-approval). Clinical
  // mutations are human-only: a model or integration is never a clinical author. Every mutation
  // additionally needs a resolvable clinical author profile (clinical/authorship.ts). Reads are
  // sensitive-read audited and open to service principals holding clinical.read.
  'clinical.authors.define': { scope: 'admin.configure', principals: ['human'] },
  'clinical.authors.context': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.encounters.open': { scope: 'clinical.write', principals: ['human'] },
  'clinical.encounters.assign': { scope: 'clinical.write', principals: ['human'] },
  'clinical.encounters.close': { scope: 'clinical.write', principals: ['human'] },
  'clinical.encounters.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.encounters.list': { scope: 'clinical.read', principals: ['human', 'service'] },
  // C8 medical history, allergies and medications (recommended-pending-clinical-approval). Writes
  // are human clinical authors only; reads (history, a version, alerts) are sensitive reads.
  'clinical.history.recordChange': { scope: 'clinical.write', principals: ['human'] },
  'clinical.history.verifyItem': { scope: 'clinical.write', principals: ['human'] },
  'clinical.history.attestReview': { scope: 'clinical.write', principals: ['human'] },
  'clinical.history.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.history.readVersion': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.history.alerts': { scope: 'clinical.read', principals: ['human', 'service'] },
  // C6 chart (recommended-pending-clinical-approval): writes are human clinical authors only; the
  // chart read is a sensitive read.
  'clinical.chart.recordEntry': { scope: 'clinical.write', principals: ['human'] },
  'clinical.chart.correctEntry': { scope: 'clinical.write', principals: ['human'] },
  'clinical.chart.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  // C7 periodontal exams (recommended-pending-clinical-approval). Recording, correcting and deriving
  // are human clinical authors only; reads and comparison are sensitive reads.
  'clinical.perio.recordExam': { scope: 'clinical.write', principals: ['human'] },
  'clinical.perio.correctExam': { scope: 'clinical.write', principals: ['human'] },
  'clinical.perio.derive': { scope: 'clinical.write', principals: ['human'] },
  'clinical.perio.readExam': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.perio.listExams': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.perio.compare': { scope: 'clinical.read', principals: ['human', 'service'] },
  // C11 treatment plans (recommended-pending-clinical-approval). Every plan mutation, including item
  // state changes, is a human clinical author's; plan-version acceptance is C12's (seam only here).
  'clinical.treatmentPlans.create': { scope: 'clinical.write', principals: ['human'] },
  'clinical.treatmentPlans.addDetail': { scope: 'clinical.write', principals: ['human'] },
  'clinical.treatmentPlans.addItem': { scope: 'clinical.write', principals: ['human'] },
  'clinical.treatmentPlans.setItemState': { scope: 'clinical.write', principals: ['human'] },
  'clinical.treatmentPlans.setDetailState': { scope: 'clinical.write', principals: ['human'] },
  'clinical.treatmentPlans.supersede': { scope: 'clinical.write', principals: ['human'] },
  'clinical.treatmentPlans.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.treatmentPlans.list': { scope: 'clinical.read', principals: ['human', 'service'] },
  // C12 estimates and acceptance (C-D7 recommended-pending-approval). Generating, presenting and
  // accepting are human staff actions under clinical.write (no clinical author profile needed: an
  // estimate is not clinical authorship); creating an alternative plan is a clinical author's.
  'clinical.estimates.generate': { scope: 'clinical.write', principals: ['human'] },
  'clinical.estimates.present': { scope: 'clinical.write', principals: ['human'] },
  'clinical.estimates.accept': { scope: 'clinical.write', principals: ['human'] },
  'clinical.estimates.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.estimates.list': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.treatmentPlans.createAlternative': { scope: 'clinical.write', principals: ['human'] },
  'clinical.treatmentPlans.alternatives': { scope: 'clinical.read', principals: ['human', 'service'] },
  // C13 consent (C-D6 recommended-pending-approval). Capturing and withdrawing are human staff actions
  // under clinical.write; the signer's own authority is evaluated separately (S5, scope consent).
  // Registering a consent text version is practice configuration.
  'clinical.consents.capture': { scope: 'clinical.write', principals: ['human'] },
  'clinical.consents.withdraw': { scope: 'clinical.write', principals: ['human'] },
  'clinical.consents.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.consents.list': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.consentTemplates.register': { scope: 'admin.configure', principals: ['human'] },
  // C14 rendered procedures. Rendering and correcting are human clinical authorship (clinical.write and a
  // resolvable clinical author); reads are sensitive reads. No action posts money (B consumes events).
  'clinical.procedures.render': { scope: 'clinical.write', principals: ['human'] },
  'clinical.procedures.correct': { scope: 'clinical.write', principals: ['human'] },
  'clinical.procedures.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.procedures.list': { scope: 'clinical.read', principals: ['human', 'service'] },
  // C9 progress-note templates (C-D4, recommended-pending-clinical-approval). Templates are practice
  // configuration (human admin only); reads need clinical.read.
  'clinical.noteTemplates.define': { scope: 'admin.configure', principals: ['human'] },
  'clinical.noteTemplates.revise': { scope: 'admin.configure', principals: ['human'] },
  'clinical.noteTemplates.retire': { scope: 'admin.configure', principals: ['human'] },
  'clinical.noteTemplates.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.noteTemplates.readVersion': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.noteTemplates.applicable': { scope: 'clinical.read', principals: ['human', 'service'] },
  // C10 notes (C-D4, C-D5 recommended-pending-clinical-approval). Signing, amendment and co-signature
  // are human-only under clinical.sign; drafting and addenda need clinical.write; every write also
  // needs a resolvable clinical author. Amending another clinician's signed note is checked as an
  // additional capability of the amend caller (clinical.oversight), never as a separate operation.
  'clinical.notes.createDraft': { scope: 'clinical.write', principals: ['human'] },
  'clinical.notes.updateDraft': { scope: 'clinical.write', principals: ['human'] },
  'clinical.notes.sign': { scope: 'clinical.sign', principals: ['human'] },
  'clinical.notes.amend': { scope: 'clinical.sign', principals: ['human'] },
  'clinical.notes.amendOthers': { scope: 'clinical.oversight', principals: ['human'] },
  'clinical.notes.addendum': { scope: 'clinical.write', principals: ['human'] },
  'clinical.notes.cosign': { scope: 'clinical.sign', principals: ['human'] },
  'clinical.notes.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.notes.list': { scope: 'clinical.read', principals: ['human', 'service'] },
  // S12 visit context: a container of references to clinical producers. Reading it needs
  // scheduling.read; pinning, assigning and linking references are scheduling work (scheduling.write).
  // A clinical producer applies its own policy when it resolves a reference.
  'scheduling.visitContext.read': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.visitContext.items': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.visitContext.pinMedicalHistory': {
    scope: 'scheduling.write',
    principals: ['human', 'service'],
  },
  'scheduling.visitContext.assignForm': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.visitContext.unassignForm': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.visitContext.linkLabCase': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.visitContext.relinkLabCase': { scope: 'scheduling.write', principals: ['human', 'service'] },
  // S13 recurrence series (ADR 0009 S-D1 pending approval). Planning is a read.
  'scheduling.series.plan': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.series.read': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.series.create': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.series.extend': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.series.end': { scope: 'scheduling.write', principals: ['human', 'service'] },
  // S14 notification intents: recorded by the commands that cause them; staff read them and the
  // worklist of intents no channel will deliver. No send operation exists in scheduling.
  'scheduling.notifications.read': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.notifications.worklist': { scope: 'scheduling.read', principals: ['human', 'service'] },
  // S15 waitlist (ADR 0009 S-D6 pending): entries and offers are scheduling work; an offer never
  // books, acceptance is its own explicit command.
  'scheduling.waitlist.add': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.waitlist.remove': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.waitlist.list': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.waitlist.offer': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.waitlist.offers.read': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.waitlist.respond': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.waitlist.reconcileOffers': { scope: 'scheduling.write', principals: ['human', 'service'] },
  // PT-02 cancellation recovery. A service principal may execute only under a live standing policy
  // (checked in the domain at execution); granting and revoking a standing policy is practice
  // administration by a person.
  'scheduling.recovery.list': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.recovery.read': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.recovery.execute': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.standingPolicies.grant': { scope: 'admin.configure', principals: ['human'] },
  'scheduling.standingPolicies.revoke': { scope: 'admin.configure', principals: ['human'] },
  'scheduling.standingPolicies.list': { scope: 'scheduling.read', principals: ['human', 'service'] },
  // S16 recall (ADR 0009 S-D7 pending): defining a policy is practice configuration; the due list is a
  // read that produces no outreach; a contact task is an explicit scheduling command.
  'scheduling.recall.definePolicy': { scope: 'admin.configure', principals: ['human', 'service'] },
  'scheduling.recall.policies': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.recall.due': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.recall.createTask': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.recall.resolveTask': { scope: 'scheduling.write', principals: ['human', 'service'] },
  // PT-03 (S part): the follow-up worklist of recall tasks and unbooked or lost-booking requests.
  'scheduling.followUp.worklist': { scope: 'scheduling.read', principals: ['human', 'service'] },
  // S17 minimal scheduling export: a tenant-wide human administrator only (sensitive-read logged).
  'scheduling.export': { scope: 'admin.configure', principals: ['human'] },
} as const satisfies Record<string, ActionPolicy>;

/**
 * Version of the proposal policy (this table plus the proposal rules in commands/proposals.ts). It is
 * bound into every proposal and approval; a commit under a different version is refused
 * (`policy_changed`). Bump it whenever a rule that an approver relied on changes.
 */
export const PROPOSAL_POLICY_VERSION = 'synthetic-proposals.1';

/**
 * Pure check of a live membership record against an action's policy (used to recheck other
 * principals, such as a proposal's proposer and approver, from records loaded before a transaction).
 * Returns the reason it fails, or null.
 */
export function membershipAllows(
  m: MembershipRecord | null,
  kind: PrincipalKind,
  action: ActionName,
  locationId?: string | null,
): SecurityReasonCode | null {
  const policy: ActionPolicy = ACTION_POLICIES[action];
  if (!m?.active) return 'membership_inactive';
  if (m.principal !== kind || !policy.principals.includes(m.principal)) return 'principal_kind_denied';
  if (policy.scope !== null && !m.scopes.includes(policy.scope)) return 'scope_missing';
  if (
    locationId !== undefined &&
    locationId !== null &&
    m.locationRefs !== null &&
    !m.locationRefs.includes(locationId)
  ) {
    return 'location_denied';
  }
  return null;
}

export type ActionName = keyof typeof ACTION_POLICIES;

export interface ResourceRef {
  readonly tenantId: string;
  readonly id: string;
  /** Location of the resource when it has one; checked against the membership's locations. */
  readonly locationId?: string | null;
}

export interface AuthorizationDecision {
  readonly action: ActionName;
  /** Live location restriction of the membership (null = all), for query-level filtering. */
  readonly locationRefs: readonly string[] | null;
}

export type Authorize = (
  ctx: ActorContext,
  action: ActionName,
  resource: ResourceRef,
) => Promise<AuthorizationDecision>;

function deny(reasonCode: SecurityReasonCode): never {
  throw new RefusalError({ code: 'forbidden', reasonCode });
}

/**
 * Builds `authorize`. Every call reloads the membership (no cached authority), so revocation, role
 * downgrade and kind changes apply to tokens and queued work issued earlier.
 */
export function createAuthorize(memberships: MembershipSource): Authorize {
  return async function authorize(ctx, action, resource) {
    const policy: ActionPolicy | undefined = (ACTION_POLICIES as Record<string, ActionPolicy>)[action];
    if (!policy) deny('scope_missing');
    if (resource.tenantId !== ctx.tenantId) deny('tenant_mismatch');

    const m = await memberships.load(ctx.actorId, ctx.tenantId);
    if (!m?.active) deny('membership_inactive');
    if (m.principal !== ctx.principal || !policy.principals.includes(m.principal))
      deny('principal_kind_denied');
    if (policy.scope !== null && !(m.scopes.includes(policy.scope) && ctx.scopes.includes(policy.scope))) {
      deny('scope_missing');
    }
    if (resource.locationId !== undefined) assertLocation(m.locationRefs, resource.locationId);
    return { action, locationRefs: m.locationRefs };
  };
}

/**
 * Location rule, shared by `authorize` and by domain code that learns a resource location only after
 * reading it inside its transaction (it reuses the decision from the authorize call made before the
 * transaction, so no second pool connection is needed while the transaction holds one).
 * `null` location = tenant-wide resource, visible to every member of the tenant.
 */
export function assertLocation(allowed: readonly string[] | null, locationId: string | null): void {
  if (locationId !== null && allowed !== null && !allowed.includes(locationId)) deny('location_denied');
}
