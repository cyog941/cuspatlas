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
