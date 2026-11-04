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
  // E1 portal principals (staff side). Enrollment, verification and revocation manage portal access
  // (`portal.manage`); reads need patients.read. Grants themselves are S5 relationships managed by
  // patients.relationships.add/revoke. No staff policy admits a `portal` principal.
  'portal.principals.enroll': { scope: 'portal.manage', principals: ['human', 'service'] },
  'portal.principals.verify': { scope: 'portal.manage', principals: ['human'] },
  'portal.principals.revoke': { scope: 'portal.manage', principals: ['human', 'service'] },
  'portal.principals.read': { scope: 'patients.read', principals: ['human', 'service'] },
  'portal.grants.list': { scope: 'patients.read', principals: ['human', 'service'] },
  // E6 consent, opt-out and the suppression decision (owned by E; S and B only consume it). Channel
  // policy and template approval are practice administration by a person (E-D6 pending).
  'communications.consents.record': { scope: 'communications.write', principals: ['human', 'service'] },
  'communications.consents.optOut': { scope: 'communications.write', principals: ['human', 'service'] },
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
  'messaging.threads.read': { scope: 'messaging.read', principals: ['human', 'service'] },
  'messaging.threads.worklist': { scope: 'messaging.read', principals: ['human', 'service'] },
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
