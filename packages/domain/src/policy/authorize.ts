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
  // C9 progress-note templates (C-D4, recommended-pending-clinical-approval). Templates are practice
  // configuration (human admin only); reads need clinical.read.
  'clinical.noteTemplates.define': { scope: 'admin.configure', principals: ['human'] },
  'clinical.noteTemplates.revise': { scope: 'admin.configure', principals: ['human'] },
  'clinical.noteTemplates.retire': { scope: 'admin.configure', principals: ['human'] },
  'clinical.noteTemplates.read': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.noteTemplates.readVersion': { scope: 'clinical.read', principals: ['human', 'service'] },
  'clinical.noteTemplates.applicable': { scope: 'clinical.read', principals: ['human', 'service'] },
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
