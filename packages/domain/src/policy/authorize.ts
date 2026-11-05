import {
  type ActorContext,
  type MembershipRecord,
  type MembershipSource,
  type PrincipalKind,
  RefusalError,
  type SecurityReasonCode,
} from '@cuspatlas/contracts';
import { recordListScope } from './list-scope';

interface ActionPolicy {
  /** Scope required in BOTH the live membership and the context; null = any active member. */
  readonly scope: string | null;
  readonly principals: readonly PrincipalKind[];
}

/** One policy table for every transport (REST, MCP, workers). Unknown actions are denied. */
export const ACTION_POLICIES = {
  'session.read': { scope: null, principals: ['human', 'service'] },
  // A20 / OR-02: state vocabularies (labels only, no tenant data) for any active staff member.
  'vocabularies.list': { scope: null, principals: ['human', 'service'] },
  'vocabularies.read': { scope: null, principals: ['human', 'service'] },
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
  'patients.relationships.add': { scope: 'patients.write', principals: ['human'] }, // A-D4
  'patients.relationships.revoke': { scope: 'patients.write', principals: ['human'] }, // A-D4
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
  'scheduling.locations.changeTimeZone': { scope: 'admin.configure', principals: ['human'] }, // A-D4
  'scheduling.locations.list': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.resources.define': { scope: 'admin.configure', principals: ['human'] }, // A-D4
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
  'billing.responsibility.transfer': { scope: 'billing.write', principals: ['human'] }, // A-D4
  'billing.worklist.list': { scope: 'undistributedFunds.read', principals: ['human', 'service'] },
  // B3 payment plans. Creating, authorizing (recording the signed-agreement fact), amending, auto-pay
  // and collection are billing.write (a scheduler may collect as a service). Voiding or defaulting a
  // plan is a human-only billing.correct decision. Reads and the plan worklist need receivables.read.
  'billing.plans.create': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.plans.read': { scope: 'receivables.read', principals: ['human', 'service'] },
  'billing.plans.authorize': { scope: 'billing.write', principals: ['human'] }, // A-D4
  'billing.plans.amend': { scope: 'billing.write', principals: ['human', 'service'] },
  'billing.plans.autopay': { scope: 'billing.write', principals: ['human'] }, // A-D4
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
  'rcm.claims.prepareSecondary': { scope: 'billing.write', principals: ['human', 'service'] },
  'rcm.claims.read': { scope: 'openClaims.read', principals: ['human', 'service'] },
  'rcm.claims.worklist': { scope: 'openClaims.read', principals: ['human', 'service'] },
  // B11 / OR-07: claim work queues (open claims) and headline measures (receivables; also rechecks queues).
  'rcm.claims.queues': { scope: 'openClaims.read', principals: ['human', 'service'] },
  'rcm.claims.measures': { scope: 'receivables.read', principals: ['human', 'service'] },
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
  // B7 review-line resolution (a second human approves adjustments and write-offs) and B8/CL policy data.
  'rcm.remittances.resolveLine': { scope: 'billing.write', principals: ['human'] },
  'rcm.remittances.decideResolution': { scope: 'billing.correct', principals: ['human'] },
  'rcm.workflowPolicies.publish': { scope: 'billing.correct', principals: ['human'] },
  // Closed-loop claims workflow (CL-01..CL-12): drives only the owning commands, which authorize again.
  'rcm.claims.packageAttachments': { scope: 'billing.write', principals: ['human', 'service'] },
  'rcm.workflows.start': { scope: 'billing.write', principals: ['human', 'service'] },
  'rcm.workflows.advance': { scope: 'billing.write', principals: ['human', 'service'] },
  'rcm.workflows.read': { scope: 'openClaims.read', principals: ['human', 'service'] },
  'rcm.workflows.close': { scope: 'billing.correct', principals: ['human'] },
  'rcm.workflows.fireTimer': { scope: 'billing.write', principals: ['service'] },
  'rcm.visits.prepare': { scope: 'coverage.read', principals: ['human', 'service'] },
  // B10 billing export: a tenant-wide human administrator only (sensitive-read logged), like S17.
  'billing.export': { scope: 'admin.configure', principals: ['human'] },
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
  // C15 encounter image links (C-D8 recommended): linking is human clinical authorship; reads are
  // sensitive reads. I owns the image itself; no action here registers an image or decides a match.
  'clinical.imageLinks.link': { scope: 'clinical.write', principals: ['human'] },
  'clinical.imageLinks.relink': { scope: 'clinical.write', principals: ['human'] },
  'clinical.imageLinks.unlink': { scope: 'clinical.write', principals: ['human'] },
  'clinical.imageLinks.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.imageLinks.list': { scope: 'clinical.read', principals: ['human', 'service'] },
  // C16 lab cases (C-D9 recommended): every case write is a human clinical author's; reads and the
  // worklist are sensitive reads. Export (the printable package, the only channel) is a person's.
  'clinical.labCases.create': { scope: 'clinical.write', principals: ['human'] },
  'clinical.labCases.setState': { scope: 'clinical.write', principals: ['human'] },
  'clinical.labCases.recordReturn': { scope: 'clinical.write', principals: ['human'] },
  'clinical.labCases.attach': { scope: 'clinical.write', principals: ['human'] },
  'clinical.labCases.remake': { scope: 'clinical.write', principals: ['human'] },
  'clinical.labCases.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.labCases.list': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.labCases.worklist': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.labCases.export': { scope: 'clinical.read', principals: ['human'] },
  // C17 referrals (C-D10 recommended): every referral write is a human clinical author's; reads and the
  // worklist are sensitive reads; the export (a disclosure under a share record) is a person's.
  'clinical.referrals.create': { scope: 'clinical.write', principals: ['human'] },
  'clinical.referrals.preparePackage': { scope: 'clinical.write', principals: ['human'] },
  'clinical.referrals.recordShare': { scope: 'clinical.write', principals: ['human'] },
  'clinical.referrals.markSent': { scope: 'clinical.write', principals: ['human'] },
  'clinical.referrals.recordTransmissionFailure': { scope: 'clinical.write', principals: ['human'] },
  'clinical.referrals.recordResponse': { scope: 'clinical.write', principals: ['human'] },
  'clinical.referrals.close': { scope: 'clinical.write', principals: ['human'] },
  'clinical.referrals.recall': { scope: 'clinical.write', principals: ['human'] },
  'clinical.referrals.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.referrals.list': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.referrals.worklist': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.referrals.export': { scope: 'clinical.read', principals: ['human'] },
  // C18 clinical export: a tenant-wide human administrator only (sensitive-read logged).
  'clinical.export': { scope: 'admin.configure', principals: ['human'] },
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
  // S20 (OR-05) staging list: capacity is practice configuration; staging and moving are scheduling acts.
  'scheduling.staging.list': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.staging.configure': { scope: 'admin.configure', principals: ['human', 'service'] },
  'scheduling.staging.add': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.staging.remove': { scope: 'scheduling.write', principals: ['human', 'service'] },
  'scheduling.staging.move': { scope: 'scheduling.write', principals: ['human', 'service'] },
  // S21 (OR-06) floor view, provider requests (people only) and self-set staff presence (people only).
  'scheduling.floor.read': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.floor.providerRequests': { scope: 'scheduling.read', principals: ['human', 'service'] },
  'scheduling.floor.requestProvider': { scope: 'scheduling.write', principals: ['human'] },
  'scheduling.floor.acknowledgeProviderRequest': { scope: 'scheduling.write', principals: ['human'] },
  'scheduling.floor.clearProviderRequest': { scope: 'scheduling.write', principals: ['human'] },
  'scheduling.presence.set': { scope: 'scheduling.write', principals: ['human'] },
  'scheduling.presence.list': { scope: 'scheduling.read', principals: ['human', 'service'] },
  // S22 (OR-11) reassigning an appointment's patient: a person's correction, never automated.
  'scheduling.appointments.reassignPatient': { scope: 'scheduling.write', principals: ['human'] },
  // S17 minimal scheduling export: a tenant-wide human administrator only (sensitive-read logged).
  'scheduling.export': { scope: 'admin.configure', principals: ['human'] },
  // E1 portal principals (staff side). Enrollment, verification and revocation manage portal access
  // (`portal.manage`); reads need patients.read. Grants themselves are S5 relationships managed by
  // patients.relationships.add/revoke. No staff policy admits a `portal` principal.
  'portal.principals.enroll': { scope: 'portal.manage', principals: ['human'] }, // A-D4
  'portal.principals.verify': { scope: 'portal.manage', principals: ['human'] },
  'portal.principals.revoke': { scope: 'portal.manage', principals: ['human'] }, // A-D4
  'portal.principals.read': { scope: 'patients.read', principals: ['human', 'service'] },
  'portal.grants.list': { scope: 'patients.read', principals: ['human', 'service'] },
  // E6 consent, opt-out and the suppression decision (owned by E; S and B only consume it). Channel
  // policy and template approval are practice administration by a person (E-D6 pending).
  'communications.consents.record': { scope: 'communications.write', principals: ['human'] }, // A-D4
  'communications.consents.optOut': { scope: 'communications.write', principals: ['human'] }, // A-D4
  'communications.consents.list': { scope: 'communications.read', principals: ['human', 'service'] },
  // Review hardening: a contact point is addressed only after a person attests its verification.
  'communications.contacts.verify': { scope: 'communications.write', principals: ['human'] },
  'communications.channelPolicies.define': { scope: 'admin.configure', principals: ['human'] },
  'communications.channelPolicies.list': { scope: 'communications.read', principals: ['human', 'service'] },
  'communications.templates.define': { scope: 'admin.configure', principals: ['human'] },
  'communications.templates.withdraw': { scope: 'admin.configure', principals: ['human'] },
  'communications.decisions.read': { scope: 'communications.read', principals: ['human', 'service'] },
  'communications.suppression.preview': { scope: 'communications.read', principals: ['human', 'service'] },
  'communications.recall.enroll': { scope: 'communications.write', principals: ['human', 'service'] },
  'communications.recall.enrollments': { scope: 'communications.read', principals: ['human', 'service'] },
  // E7 delivery: the messaging worker's own principal (service only), receipt ingestion by the
  // provider-integration principal (service only), and the staff delivery worklist and resolution.
  'communications.deliver': { scope: 'communications.deliver', principals: ['service'] },
  'communications.receipts.record': { scope: 'communications.receipts', principals: ['service'] },
  'communications.deliveries.worklist': { scope: 'communications.read', principals: ['human', 'service'] },
  'communications.deliveries.read': { scope: 'communications.read', principals: ['human', 'service'] },
  'communications.deliveries.resolve': { scope: 'communications.write', principals: ['human'] },
  // E4 intake forms. Form content is practice configuration (admin.configure, a person); submissions
  // and review items are patient data (patients.read / patients.write). A reviewed demographics change
  // is applied through S4's own update, which authorizes the reviewer again.
  'intake.forms.publish': { scope: 'admin.configure', principals: ['human'] },
  'intake.forms.retire': { scope: 'admin.configure', principals: ['human'] },
  'intake.forms.list': { scope: 'patients.read', principals: ['human', 'service'] },
  'intake.submissions.submit': { scope: 'patients.write', principals: ['human'] },
  'intake.submissions.list': { scope: 'patients.read', principals: ['human', 'service'] },
  'intake.submissions.read': { scope: 'patients.read', principals: ['human', 'service'] },
  'intake.reviews.worklist': { scope: 'patients.read', principals: ['human', 'service'] },
  'intake.reviews.read': { scope: 'patients.read', principals: ['human', 'service'] },
  'intake.reviews.resolve': { scope: 'patients.write', principals: ['human'] },
  // E5 secure messaging: its own scopes, so patient access alone never opens a thread. Writing is a
  // person's act; reads and the worklist are access-audited. Legal hold is administration.
  'messaging.threads.open': { scope: 'messaging.write', principals: ['human'] },
  'messaging.messages.post': { scope: 'messaging.write', principals: ['human'] },
  // Thread bodies are the most sensitive free text E holds: human staff only. A service principal
  // (an agent) is denied by default; a per-tenant policy that could enable it is a pending security
  // decision and is NOT implemented (review hardening, item 3).
  'messaging.threads.read': { scope: 'messaging.read', principals: ['human'] },
  'messaging.threads.worklist': { scope: 'messaging.read', principals: ['human', 'service'] },
  // E10 needs-reply queue: the list reads thread metadata only (no body); the policy is administration.
  'messaging.threads.list': { scope: 'messaging.read', principals: ['human', 'service'] },
  'messaging.replyPolicy.set': { scope: 'admin.configure', principals: ['human'] },
  'messaging.threads.close': { scope: 'messaging.write', principals: ['human'] },
  'messaging.threads.assign': { scope: 'messaging.write', principals: ['human'] },
  'messaging.threads.hold': { scope: 'admin.configure', principals: ['human'] },
  'messaging.retention.evaluate': { scope: 'messaging.read', principals: ['human', 'service'] },
  // E8 telephony (E-S2 blocked): configuration is administration; call events come only from the
  // telephony integration principal; linking a call to a patient is a person's confirmation.
  'telephony.config.define': { scope: 'admin.configure', principals: ['human'] },
  'telephony.config.read': { scope: 'communications.read', principals: ['human', 'service'] },
  'telephony.handling.resolve': { scope: 'communications.read', principals: ['human', 'service'] },
  'telephony.calls.record': { scope: 'telephony.events', principals: ['service'] },
  'telephony.calls.read': { scope: 'communications.read', principals: ['human', 'service'] },
  'telephony.calls.list': { scope: 'communications.read', principals: ['human', 'service'] },
  'telephony.calls.link': { scope: 'communications.write', principals: ['human'] },
  // E9 minimal engagement export: a tenant-wide human administrator only (sensitive-read logged).
  'communications.export': { scope: 'admin.configure', principals: ['human'] },
  // I1 imaging objects (workstream I, synthetic; scope decisions pending approval). Metadata reads and
  // short-lived read grants need imaging.read; bytes are read only with a grant (REST only).
  'imaging.objects.read': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.objects.list': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.objects.grantRead': { scope: 'imaging.read', principals: ['human'] }, // A-D4
  'imaging.objects.content': { scope: 'imaging.read', principals: ['human'] }, // A-D4
  'imaging.objects.revokeGrant': { scope: 'imaging.write', principals: ['human', 'service'] }, // A-S8
  // Capability probe: revoking another principal's grant needs imaging.write.
  'imaging.grants.revokeAny': { scope: 'imaging.write', principals: ['human', 'service'] },
  // A-D4: the admin reconcile is human only; the worker runs the same sweep as its own service-only command.
  'imaging.storage.reconcile': { scope: 'admin.configure', principals: ['human'] },
  'imaging.storage.sweep': { scope: 'admin.configure', principals: ['service'] },
  // I2 ingress: staging and completing an upload is imaging work (a bridge may be a service principal).
  'imaging.ingress.begin': { scope: 'imaging.write', principals: ['human', 'service'] },
  'imaging.ingress.upload': { scope: 'imaging.write', principals: ['human', 'service'] },
  'imaging.ingress.complete': { scope: 'imaging.write', principals: ['human', 'service'] },
  'imaging.ingress.read': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.ingress.failures': { scope: 'imaging.read', principals: ['human', 'service'] },
  // I3 patient association: reviewing candidates and recording or correcting a decision is a human
  // decision (imaging.associate); the history, the unmatched worklist and the imageRef read need
  // imaging.read (C15 and B attachment packages consume the imageRef read).
  'imaging.associations.candidates': { scope: 'imaging.associate', principals: ['human'] },
  'imaging.associations.confirm': { scope: 'imaging.associate', principals: ['human'] },
  'imaging.associations.correct': { scope: 'imaging.associate', principals: ['human'] },
  'imaging.associations.history': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.associations.unmatched': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.imageRefs.resolve': { scope: 'imaging.read', principals: ['human', 'service'] },
  // I4 mounts, annotations and derived images: separate records, never edits of an original.
  'imaging.mounts.create': { scope: 'imaging.write', principals: ['human', 'service'] },
  'imaging.mounts.revise': { scope: 'imaging.write', principals: ['human', 'service'] },
  'imaging.mounts.read': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.annotations.create': { scope: 'imaging.write', principals: ['human', 'service'] },
  'imaging.annotations.supersede': { scope: 'imaging.write', principals: ['human', 'service'] },
  'imaging.annotations.list': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.derived.create': { scope: 'imaging.write', principals: ['human', 'service'] },
  // I8 retention, deletion and legal hold (I-D5/I-D6 pending approval): policy values are practice
  // configuration by a person; holds and deletions are human decisions; evaluations are reads.
  'imaging.retention.setPolicy': { scope: 'admin.configure', principals: ['human'] },
  'imaging.retention.policies': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.legalHolds.place': { scope: 'imaging.legalHold', principals: ['human'] },
  'imaging.legalHolds.release': { scope: 'imaging.legalHold', principals: ['human'] },
  'imaging.legalHolds.list': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.deletions.request': { scope: 'imaging.delete', principals: ['human'] },
  'imaging.deletions.evaluate': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.deletions.execute': { scope: 'imaging.delete', principals: ['human'] },
  // I5 DICOM boundary: recognition and the pinned parsing refusal (I-S2 blocked); a metadata read.
  'imaging.containers.inspect': { scope: 'imaging.read', principals: ['human', 'service'] },
  // I6 device bridge (server side; I-S1/I-S3 blocked). Registering, pairing, allowlist edits and
  // revocation are human practice administration (admin.configure); jobs are imaging work.
  'imaging.devices.register': { scope: 'admin.configure', principals: ['human'] },
  'imaging.devices.issuePairingCode': { scope: 'admin.configure', principals: ['human'] },
  'imaging.devices.setCapabilities': { scope: 'admin.configure', principals: ['human'] },
  'imaging.devices.revoke': { scope: 'admin.configure', principals: ['human'] },
  'imaging.devices.list': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.devices.read': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.bridgeJobs.enqueue': { scope: 'imaging.write', principals: ['human', 'service'] },
  'imaging.bridgeJobs.read': { scope: 'imaging.read', principals: ['human', 'service'] },
  // Bridge-facing operations: device principals only, authorized by the live device row and its
  // allowlist inside the transaction (never by a staff membership; `authorize` never admits them).
  'imaging.bridge.pair': { scope: null, principals: ['device'] },
  'imaging.bridge.claim': { scope: null, principals: ['device'] },
  'imaging.bridge.content': { scope: null, principals: ['device'] },
  'imaging.bridge.result': { scope: null, principals: ['device'] },
  'imaging.bridge.heartbeat': { scope: null, principals: ['device'] },
  'imaging.bridge.rotateKey': { scope: null, principals: ['device'] },
  // I7 offline devices and recovery: requesting work is imaging work; releasing, cancelling and
  // reconciling are human decisions; the worklist is a read.
  'imaging.acquisitions.request': { scope: 'imaging.write', principals: ['human', 'service'] },
  'imaging.acquisitions.resolve': { scope: 'imaging.write', principals: ['human'] },
  'imaging.bridgeJobs.reconcile': { scope: 'imaging.write', principals: ['human'] },
  'imaging.bridge.worklist': { scope: 'imaging.read', principals: ['human', 'service'] },
  // I9 imaging export: a tenant-wide human administrator only (sensitive-read logged), like S17.
  'imaging.export': { scope: 'admin.configure', principals: ['human'] },
  'imaging.export.blobs': { scope: 'admin.configure', principals: ['human'] },
  // Workstream M migration (synthetic source packages only; M-S1 blocks real exports). Intake, review
  // and identity decisions are human business decisions; reads and planned application also admit a
  // service principal holding the scope (the import worker); sign-off and cutover are human-only.
  'migration.sourceProfiles.register': { scope: 'migration.write', principals: ['human'] },
  'migration.packages.intake': { scope: 'migration.write', principals: ['human'] },
  'migration.packages.read': { scope: 'migration.read', principals: ['human', 'service'] },
  'migration.reviewItems.list': { scope: 'migration.read', principals: ['human', 'service'] },
  'migration.reviewItems.resolve': { scope: 'migration.write', principals: ['human'] },
  'migration.imports.plan': { scope: 'migration.read', principals: ['human', 'service'] },
  'migration.imports.apply': { scope: 'migration.write', principals: ['human', 'service'] },
  // M4: the merge itself is S6's command (patients.merge, human) reached only by delegation.
  'migration.identity.merge': { scope: 'migration.write', principals: ['human'] },
  'migration.provenance.read': { scope: 'migration.read', principals: ['human', 'service'] },
  'migration.openingItems.list': { scope: 'migration.read', principals: ['human', 'service'] },
  // M6: building a report version is migration work; signing and the cutover gate are human-only.
  'migration.reports.build': { scope: 'migration.write', principals: ['human', 'service'] },
  'migration.reports.read': { scope: 'migration.read', principals: ['human', 'service'] },
  'migration.signoffs.record': { scope: 'migration.signoff', principals: ['human'] },
  'migration.cutover.advance': { scope: 'migration.signoff', principals: ['human'] },
  // M7 historical archive packages (M-S2 blocks the real arrangement): registration, verification and
  // holds are migration work by a person (verification also by the worker); reads are patient history
  // (human only, also need patients.read) and sensitive-read logged.
  'migration.archive.register': { scope: 'migration.write', principals: ['human'] },
  'migration.archive.verify': { scope: 'migration.write', principals: ['human', 'service'] },
  'migration.archive.references': { scope: 'migration.read', principals: ['human'] },
  'migration.archive.read': { scope: 'migration.read', principals: ['human'] },
  'migration.archive.holds.record': { scope: 'migration.write', principals: ['human'] },
  'migration.archive.retention.evaluate': { scope: 'migration.read', principals: ['human', 'service'] },
  // M9 operator ownership and readiness (M-S3 names the operator): the profile is an administrator's
  // record; the backup verification job (a service principal) records results; readiness and alerts
  // are reads of migration/operations state.
  'operations.operatorProfiles.record': { scope: 'admin.configure', principals: ['human'] },
  'operations.backupVerifications.record': { scope: 'migration.write', principals: ['human', 'service'] },
  'operations.readiness.assert': { scope: 'migration.read', principals: ['human', 'service'] },
  'operations.alerts.list': { scope: 'migration.read', principals: ['human', 'service'] },
  // M10 migration export (the audit workspace): a tenant-wide human administrator only, like B10.
  'migration.export': { scope: 'admin.configure', principals: ['human'] },
  // M1 practice export (easy exit, MG-03): the whole tenant leaves in one versioned package. A tenant-wide
  // human administrator only (elevated, audited, sensitive-read logged); delivery through a short-lived
  // grant bound to the caller; each composed S/I/C/E/B export re-authorizes the same caller.
  'practice.export.create': { scope: 'admin.configure', principals: ['human'] },
  'practice.export.grant': { scope: 'admin.configure', principals: ['human'] },
  'practice.export.download': { scope: 'admin.configure', principals: ['human'] },
  'practice.export.verify': { scope: 'admin.configure', principals: ['human'] },
  // Workstream A batch 2, A8 agent principals (synthetic; A-D9 open): the lifecycle is a human
  // administrator's act under the non-delegable agents.manage scope, so no agent can create, sponsor,
  // suspend or revoke an agent. One agent record is readable by an agent (its own grants, A23 seam);
  // the registry and the separate agent-audit stream are human reads.
  'agents.principals.create': { scope: 'agents.manage', principals: ['human'] },
  'agents.principals.suspend': { scope: 'agents.manage', principals: ['human'] },
  'agents.principals.resume': { scope: 'agents.manage', principals: ['human'] },
  'agents.principals.revoke': { scope: 'agents.manage', principals: ['human'] },
  'agents.credentials.rotate': { scope: 'agents.manage', principals: ['human'] },
  'agents.sponsors.change': { scope: 'agents.manage', principals: ['human'] },
  'agents.principals.read': { scope: 'agents.read', principals: ['human', 'service'] },
  'agents.principals.list': { scope: 'agents.read', principals: ['human'] },
  'agents.audit.list': { scope: 'agents.read', principals: ['human'] },
  // A9 consent and budgets (A-D3 open): consent is granted and revoked by a human holding
  // agents.manage; the registry is a human read; an agent may read its own budget usage.
  'agents.consents.record': { scope: 'agents.manage', principals: ['human'] },
  'agents.consents.revoke': { scope: 'agents.manage', principals: ['human'] },
  'agents.consents.list': { scope: 'agents.read', principals: ['human'] },
  'agents.budgets.read': { scope: 'agents.read', principals: ['human', 'service'] },
  // A10 generalized prepare/commit (A-D4 pending): anyone holding the proposed operation's own
  // authority (an agent included) may prepare; approval and commit are a human's act under the
  // non-delegable actions.approve; an agent reads only its own proposals.
  'actions.proposals.prepare': { scope: 'actions.prepare', principals: ['human', 'service'] },
  'actions.proposals.approve': { scope: 'actions.approve', principals: ['human'] },
  'actions.proposals.commit': { scope: 'actions.approve', principals: ['human'] },
  'actions.proposals.abandon': { scope: 'actions.prepare', principals: ['human', 'service'] },
  'actions.proposals.read': { scope: 'actions.read', principals: ['human', 'service'] },
  'actions.proposals.list': { scope: 'actions.read', principals: ['human', 'service'] },
  // A11 draft-only AI (A-D5/A-D6 pending; synthetic model only): a person or an agent may request a
  // draft from records it can already read; only a person (ai.review, non-delegable) accepts or
  // rejects one; switching use cases is practice configuration.
  'ai.drafts.create': { scope: 'ai.draft', principals: ['human', 'service'] },
  'ai.drafts.read': { scope: 'ai.read', principals: ['human', 'service'] },
  'ai.drafts.list': { scope: 'ai.read', principals: ['human', 'service'] },
  'ai.drafts.accept': { scope: 'ai.review', principals: ['human'] },
  'ai.drafts.reject': { scope: 'ai.review', principals: ['human'] },
  'ai.useCases.list': { scope: 'ai.read', principals: ['human', 'service'] },
  'ai.useCases.configure': { scope: 'admin.configure', principals: ['human'] },
  // A12 evaluation (A-S3 open): running the harness is practice configuration by a person; runs are
  // readable with ai.read.
  'ai.evaluations.run': { scope: 'admin.configure', principals: ['human'] },
  'ai.evaluations.list': { scope: 'ai.read', principals: ['human', 'service'] },
  // A13 prescribing envelope (no qualified partner): drafting and submission are a human
  // prescriber's acts; prescriptions.submit (controlled substances included) is non-delegable.
  'prescriptions.drafts.create': { scope: 'prescriptions.draft', principals: ['human'] },
  'prescriptions.submit': { scope: 'prescriptions.submit', principals: ['human'] },
  'prescriptions.cancel': { scope: 'prescriptions.draft', principals: ['human'] },
  // A14 webhooks (workstream A batch 4): subscription administration and replay are human only
  // (agents and services never register an endpoint or re-send an event); reads admit services; the
  // dispatch is the worker's own service principal under outbox.deliver.
  'webhooks.eventTypes.list': { scope: 'webhooks.read', principals: ['human', 'service'] },
  'webhooks.subscriptions.create': { scope: 'webhooks.manage', principals: ['human'] },
  'webhooks.subscriptions.list': { scope: 'webhooks.read', principals: ['human', 'service'] },
  'webhooks.subscriptions.rotateSecret': { scope: 'webhooks.manage', principals: ['human'] },
  'webhooks.subscriptions.revoke': { scope: 'webhooks.manage', principals: ['human'] },
  'webhooks.deliveries.list': { scope: 'webhooks.read', principals: ['human', 'service'] },
  'webhooks.deliveries.failures.list': { scope: 'webhooks.read', principals: ['human', 'service'] },
  'webhooks.deliveries.replay': { scope: 'webhooks.manage', principals: ['human'] },
  'webhooks.deliveries.dispatch': { scope: 'outbox.deliver', principals: ['service'] },
  // A15 export surface: the ordinary exports.create scope (no licence, plan or feature key); request,
  // grant and download are human only (agents and services never export); each composed module
  // export re-authorizes the caller for its own action. Request metadata reads admit services.
  'exports.create': { scope: 'exports.create', principals: ['human'] },
  'exports.list': { scope: 'exports.read', principals: ['human', 'service'] },
  'exports.read': { scope: 'exports.read', principals: ['human', 'service'] },
  'exports.grant': { scope: 'exports.create', principals: ['human'] },
  'exports.download': { scope: 'exports.create', principals: ['human'] },
} as const satisfies Record<string, ActionPolicy>;

/**
 * Version of the proposal policy (this table plus the proposal rules in commands/proposals.ts). It is
 * bound into every proposal and approval; a commit under a different version is refused
 * (`policy_changed`). Bump it whenever a rule that an approver relied on changes.
 */
export const PROPOSAL_POLICY_VERSION = 'synthetic-proposals.1';

/**
 * A10 / A-D4 (pending approval): operations an agent may only PREPARE (catalog `approval: proposal`).
 * They are human only (H1): a human keeps the direct path, a non-agent service is refused
 * (`principal_kind_denied`), and an agent calling one directly is refused (`proposal_required`) and must
 * go through actions.proposals.* with a distinct human approver (`proposerAllows`).
 */
export const PROPOSAL_REQUIRED_FOR_AGENTS: ReadonlySet<string> = new Set([
  'portal.principals.enroll',
  'communications.consents.record',
  'patients.relationships.add',
  'billing.plans.authorize',
]);

/**
 * A10: may this live membership PREPARE (and, at commit, still stand behind) a proposal for `action`?
 * The operation's own policy, except that an agent service principal also qualifies for an operation in
 * PROPOSAL_REQUIRED_FOR_AGENTS (a human-only operation an agent may only propose). Never used for the
 * direct path, where `authorize` refuses that agent with `proposal_required`.
 */
export function proposerAllows(
  m: MembershipRecord | null,
  kind: PrincipalKind,
  action: ActionName,
): SecurityReasonCode | null {
  if (
    m?.active &&
    m.agent &&
    kind === 'service' &&
    m.principal === kind &&
    PROPOSAL_REQUIRED_FOR_AGENTS.has(action)
  ) {
    const scope = ACTION_POLICIES[action].scope;
    return scope !== null && !m.scopes.includes(scope) ? 'scope_missing' : null;
  }
  return membershipAllows(m, kind, action);
}

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
    // A10: an agent reaching a propose-only (human-only) operation directly is told to propose it.
    if (m.agent && m.principal === ctx.principal && PROPOSAL_REQUIRED_FOR_AGENTS.has(action))
      deny('proposal_required');
    if (m.principal !== ctx.principal || !policy.principals.includes(m.principal))
      deny('principal_kind_denied');
    if (policy.scope !== null && !(m.scopes.includes(policy.scope) && ctx.scopes.includes(policy.scope))) {
      deny('scope_missing');
    }
    if (resource.locationId !== undefined) assertLocation(m.locationRefs, resource.locationId);
    recordListScope(m.locationRefs);
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
