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
  // I1 imaging objects (workstream I, synthetic; scope decisions pending approval). Metadata reads and
  // short-lived read grants need imaging.read; bytes are read only with a grant (REST only).
  'imaging.objects.read': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.objects.list': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.objects.grantRead': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.objects.content': { scope: 'imaging.read', principals: ['human', 'service'] },
  'imaging.objects.revokeGrant': { scope: 'imaging.read', principals: ['human', 'service'] },
  // Capability probe: revoking another principal's grant needs imaging.write.
  'imaging.grants.revokeAny': { scope: 'imaging.write', principals: ['human', 'service'] },
  'imaging.storage.reconcile': { scope: 'admin.configure', principals: ['human', 'service'] },
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
