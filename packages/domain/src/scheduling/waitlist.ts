import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  type Conflict,
  type OfferOutcome,
  type OfferRespond,
  type RecoveryExecute,
  type RecoveryListQuery,
  RefusalError,
  SCHEDULING_PROPERTIES,
  type StandingPolicyGrant,
  type StandingPolicyRevoke,
  type TenantTransaction,
  validateOfferReconcile,
  validateOfferRespond,
  validateRecoveryExecute,
  validateRecoveryListQuery,
  validateSchedulingEntityRef,
  validateStandingPolicyGrant,
  validateStandingPolicyRevoke,
  validateWaitlistAdd,
  validateWaitlistListQuery,
  validateWaitlistOffer,
  validateWaitlistRemove,
  type WaitlistAdd,
  type WaitlistListQuery,
  type WaitlistOffer,
  type WaitlistRemove,
  type WaitlistState,
  type WorkItemListData,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { assertPatientSchedulable } from '../patients/identity';
import { type AuthorizationDecision, assertLocation } from '../policy/authorize';
import { AVAILABLE, workItem, workList } from '../work-items';
import { type AppointmentBase, assertVisibleLocation } from './appointment-base';
import {
  availabilityConflicts,
  convertHoldIn,
  createHoldIn,
  expireHolds,
  type HoldRow,
  insertBookingIn,
  loadHold,
  patientConflicts,
  prepareWindow,
  releaseHoldIn,
} from './booking';
import { recordNotificationIntent } from './notification-intent';
import { checkEnvelope, failedAt, type LocationRow, loadLocation, notFound } from './resources';
import { reopenEntryIn, WAITLIST_ENTRY_RESOURCE, WAITLIST_OFFER_RESOURCE } from './waitlist-offers';

/**
 * E portal authority for answering an offer (the seam S documented in respondToOffer): `authorize`
 * receives the offer's patient and throws E's typed refusal unless the acting portal principal holds
 * `scheduling` for that patient (and the patient is the one the portal route names).
 */
export interface PortalOfferAuthority {
  authorize(tx: TenantTransaction, patientRef: string): Promise<void>;
}

export const RECOVERY_RESOURCE = 'cancellationRecovery';
export const STANDING_POLICY_RESOURCE = 'standingPolicy';
const MINUTE = 60_000;
const MAX_POLICY_DAYS = 90;

const refused = (reason: string, replayable = true) =>
  new RefusalError({ code: 'conflict', reasonCode: 'booking_refused', replayable, detail: { reason } });

export interface WaitlistEntryRecord {
  readonly entryRef: string;
  readonly patientRef: string;
  readonly locationRef: string;
  readonly durationMinutes: number;
  readonly desiredFrom: string;
  readonly desiredUntil: string;
  readonly providerPreference: { readonly kind: 'provider'; readonly resourceRef: string } | null;
  readonly appointmentTypeCode: string | null;
  readonly priority: number;
  readonly requestedChannel: string;
  readonly expiresAt: string | null;
  readonly state: WaitlistState;
  readonly stateReason: string | null;
  readonly appointmentRef: string | null;
  readonly version: number;
  readonly createdAt: string;
}
export interface OfferCommandData {
  readonly offerRef: string;
  readonly holdRef: string;
  readonly entryRef: string;
  readonly recoveryRef: string | null;
  readonly expiresAt: string;
  readonly intentRef: string;
  readonly standingPolicyRef: string | null;
  readonly standingPolicyVersion: number | null;
}
export interface OfferRespondData {
  readonly offerRef: string;
  readonly entryRef: string;
  readonly outcome: OfferOutcome;
  readonly appointmentRef: string | null;
}
export interface OfferRecord {
  readonly offerRef: string;
  readonly entryRef: string;
  readonly holdRef: string;
  readonly recoveryRef: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly expiresAt: string;
  readonly outcome: OfferOutcome | null;
  readonly outcomeReason: string | null;
  readonly appointmentRef: string | null;
  readonly standingPolicyRef: string | null;
  readonly standingPolicyVersion: number | null;
  readonly version: number;
}
export interface RecoveryRecord {
  readonly recoveryRef: string;
  readonly appointmentRef: string;
  readonly locationRef: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly provider: { readonly kind: 'provider'; readonly resourceRef: string };
  readonly state: 'open' | 'filled' | 'closed';
  readonly version: number;
  readonly automation: {
    readonly mode: 'prepare_for_approval' | 'policy_authorized';
    readonly standingPolicyRef: string | null;
  };
  readonly candidates: {
    readonly entryRef: string;
    readonly patientRef: string;
    readonly rank: number;
    readonly priority: number;
    readonly consent: { readonly owner: 'E6'; readonly state: 'undecided' };
  }[];
  readonly excluded: { readonly entryRef: string; readonly reason: string }[];
  readonly offers: { readonly offerRef: string; readonly outcome: OfferOutcome | null }[];
}
export interface StandingPolicyRecord {
  readonly policyRef: string;
  readonly operation: 'scheduling.recovery.execute';
  readonly ownerRef: string;
  readonly granteeRef: string;
  readonly locationRefs: string[];
  readonly maxOffersPerRecovery: number;
  readonly expiresAt: string;
  readonly state: 'active' | 'revoked' | 'expired';
  readonly version: number;
  readonly createdAt: string;
}

interface EntryRow extends Record<string, unknown> {
  id: string;
  subject_patient_id: string;
  location_id: string;
  location_ref: string;
  appointment_type_code: string | null;
  duration_minutes: number;
  provider_preference_id: string | null;
  desired_from: Date;
  desired_until: Date;
  priority: number;
  requested_channel: string;
  expires_at: Date | null;
  expired: boolean;
  state: WaitlistState;
  state_reason: string | null;
  appointment_id: string | null;
  version: number;
  created_at: Date;
}
const ENTRY_COLUMNS = `e.id, e.subject_patient_id, e.location_id, l.location_ref, e.appointment_type_code, e.duration_minutes,
  e.provider_preference_id, e.desired_from, e.desired_until, e.priority, e.requested_channel, e.expires_at,
  coalesce(e.expires_at <= now(), false) AS expired, e.state, e.state_reason, e.appointment_id, e.version, e.created_at`;
const ENTRY_FROM = `FROM cuspatlas.waitlist_entries e
  JOIN cuspatlas.scheduling_locations l ON l.id = e.location_id AND l.tenant_id = e.tenant_id`;

async function loadEntry(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  entryRef: string,
  lock: '' | 'FOR UPDATE OF e' = '',
): Promise<EntryRow> {
  if (!validateSchedulingEntityRef(entryRef)) throw notFound();
  const { rows } = await tx.query<EntryRow>(`SELECT ${ENTRY_COLUMNS} ${ENTRY_FROM} WHERE e.id = $1 ${lock}`, [
    entryRef,
  ]);
  const row = rows[0];
  if (!row) throw notFound();
  assertVisibleLocation(decision, row.location_ref);
  return row;
}

const entryRecord = (e: EntryRow): WaitlistEntryRecord => ({
  entryRef: e.id,
  patientRef: e.subject_patient_id,
  locationRef: e.location_ref,
  durationMinutes: e.duration_minutes,
  desiredFrom: e.desired_from.toISOString(),
  desiredUntil: e.desired_until.toISOString(),
  providerPreference:
    e.provider_preference_id === null ? null : { kind: 'provider', resourceRef: e.provider_preference_id },
  appointmentTypeCode: e.appointment_type_code,
  priority: e.priority,
  requestedChannel: e.requested_channel,
  expiresAt: e.expires_at === null ? null : e.expires_at.toISOString(),
  state: e.state,
  stateReason: e.state_reason,
  appointmentRef: e.appointment_id,
  version: e.version,
  createdAt: e.created_at.toISOString(),
});

interface OfferRow extends Record<string, unknown> {
  id: string;
  entry_id: string;
  hold_id: string;
  recovery_id: string | null;
  location_ref: string;
  starts_at: Date;
  ends_at: Date;
  provider_id: string;
  operatory_id: string | null;
  no_operatory_reason: WaitlistOffer['noOperatoryReason'] | null;
  expires_at: Date;
  outcome: OfferOutcome | null;
  outcome_reason: string | null;
  appointment_id: string | null;
  standing_policy_id: string | null;
  standing_policy_version: number | null;
  version: number;
  /** The live offer's hold lapsed and no reconcile has recorded the expiry yet. */
  hold_expired: boolean;
}
async function loadOffer(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  offerRef: string,
  lock: '' | 'FOR UPDATE OF o' = '',
): Promise<OfferRow> {
  if (!validateSchedulingEntityRef(offerRef)) throw notFound();
  const { rows } = await tx.query<OfferRow>(
    `SELECT o.id, o.entry_id, o.hold_id, o.recovery_id, l.location_ref, o.starts_at, o.ends_at, o.provider_id,
       o.operatory_id, o.no_operatory_reason, o.expires_at, o.outcome, o.outcome_reason, o.appointment_id,
       o.standing_policy_id, o.standing_policy_version, o.version,
       (o.outcome IS NULL AND EXISTS (SELECT 1 FROM cuspatlas.scheduling_holds h WHERE h.id = o.hold_id
         AND h.tenant_id = o.tenant_id AND h.state = 'active' AND h.expires_at <= now())) AS hold_expired
     FROM cuspatlas.waitlist_offers o
     JOIN cuspatlas.scheduling_locations l ON l.id = o.location_id AND l.tenant_id = o.tenant_id
     WHERE o.id = $1 ${lock}`,
    [offerRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  assertVisibleLocation(decision, row.location_ref);
  return row;
}

interface RecoveryRow extends Record<string, unknown> {
  id: string;
  appointment_id: string;
  location_id: string;
  location_ref: string;
  starts_at: Date;
  ends_at: Date;
  provider_id: string;
  operatory_id: string | null;
  state: 'open' | 'filled' | 'closed';
  version: number;
}
async function loadRecovery(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  recoveryRef: string,
  lock: '' | 'FOR UPDATE OF r' = '',
): Promise<RecoveryRow> {
  if (!validateSchedulingEntityRef(recoveryRef)) throw notFound();
  const { rows } = await tx.query<RecoveryRow>(
    `SELECT r.id, r.appointment_id, r.location_id, l.location_ref, r.starts_at, r.ends_at, r.provider_id, r.operatory_id,
       r.state, r.version
     FROM cuspatlas.cancellation_recoveries r
     JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
     WHERE r.id = $1 ${lock}`,
    [recoveryRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  assertVisibleLocation(decision, row.location_ref);
  return row;
}

async function patientBookedIn(
  tx: TenantTransaction,
  patientId: string,
  s: number,
  e: number,
): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM cuspatlas.appointments WHERE subject_patient_id = $1 AND status = 'booked'
       AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)') LIMIT 1`,
    [patientId, new Date(s), new Date(e)],
  );
  return rows.length > 0;
}

/**
 * PT-02 hook of the cancel command: a cancelled booking that has not started opens a recovery record
 * for its freed window (one per appointment). Matching is computed when the recovery is read.
 */
export async function openRecoveryIn(tx: TenantTransaction, appointmentId: string): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.cancellation_recoveries (tenant_id, appointment_id, location_id, starts_at, ends_at,
       provider_id, operatory_id, created_by)
     SELECT a.tenant_id, a.id, a.location_id, a.starts_at, a.ends_at, a.provider_id, a.operatory_id,
       cuspatlas.current_actor_id()
     FROM cuspatlas.appointments a WHERE a.id = $1 AND a.starts_at > now()
     ON CONFLICT (tenant_id, appointment_id) DO NOTHING RETURNING id`,
    [appointmentId],
  );
  const id = rows[0]?.id;
  if (id) {
    await recordCommand(
      tx,
      {
        operation: 'scheduling.recovery.open',
        resourceType: RECOVERY_RESOURCE,
        resourceRef: id,
        resourceVersion: 1,
      },
      { changedFields: ['state', 'window'] },
    );
  }
}

/** Ranked, explained candidates for a freed window (consent is E6's and is referenced only). */
async function candidatesFor(tx: TenantTransaction, r: RecoveryRow) {
  const { rows } = await tx.query<
    EntryRow & { patient_status: string; merged: boolean; live_offer: boolean }
  >(
    `SELECT ${ENTRY_COLUMNS}, p.status AS patient_status, (p.merged_into IS NOT NULL) AS merged,
       EXISTS (SELECT 1 FROM cuspatlas.waitlist_offers o
         JOIN cuspatlas.scheduling_holds h ON h.id = o.hold_id AND h.tenant_id = o.tenant_id
         WHERE o.entry_id = e.id AND o.outcome IS NULL AND NOT (h.state = 'active' AND h.expires_at <= now())) AS live_offer
       ${ENTRY_FROM}
     JOIN cuspatlas.patients p ON p.id = e.subject_patient_id AND p.tenant_id = e.tenant_id
     WHERE e.location_id = $1 AND e.state IN ('active', 'offered')
     ORDER BY e.priority, e.created_at, e.id LIMIT 200`,
    [r.location_id],
  );
  const slotStart = r.starts_at.getTime();
  const slotMinutes = (r.ends_at.getTime() - slotStart) / MINUTE;
  const candidates: (RecoveryRecord['candidates'][number] & { row: EntryRow })[] = [];
  const excluded: { entryRef: string; reason: string }[] = [];
  for (const e of rows) {
    const end = slotStart + e.duration_minutes * MINUTE;
    let reason: string | null = null;
    // An offer whose hold lapsed is not live (lazy expiry); executing reaps it before offering.
    if (e.state === 'offered' && e.live_offer) reason = 'offer_pending';
    else if (e.expired) reason = 'entry_expired';
    else if (e.duration_minutes > slotMinutes) reason = 'duration_exceeds_slot';
    else if (slotStart < e.desired_from.getTime() || end > e.desired_until.getTime())
      reason = 'outside_desired_window';
    else if (e.provider_preference_id !== null && e.provider_preference_id !== r.provider_id)
      reason = 'provider_mismatch';
    else if (e.merged || e.patient_status !== 'active') reason = 'patient_not_schedulable';
    else if (await patientBookedIn(tx, e.subject_patient_id, slotStart, end))
      reason = 'patient_already_booked';
    if (reason !== null) excluded.push({ entryRef: e.id, reason });
    else {
      candidates.push({
        entryRef: e.id,
        patientRef: e.subject_patient_id,
        rank: candidates.length + 1,
        priority: e.priority,
        consent: { owner: 'E6', state: 'undecided' },
        row: e,
      });
    }
  }
  return { candidates: candidates.slice(0, 50), excluded: excluded.slice(0, 100) };
}

interface PolicyRow extends Record<string, unknown> {
  id: string;
  owner_principal_id: string;
  grantee_principal_id: string;
  location_refs: string[];
  max_offers_per_recovery: number;
  expires_at: Date;
  revoked_at: Date | null;
  expired: boolean;
  version: number;
  created_at: Date;
}
const POLICY_COLUMNS = `id, owner_principal_id, grantee_principal_id, location_refs, max_offers_per_recovery, expires_at,
  revoked_at, (expires_at <= now()) AS expired, version, created_at`;

/**
 * Lazy reconciliation (review hardening): records the expiry of live offers whose hold lapsed, for one
 * entry or one location, so an expired offer is never treated as live by a write path. The lock order is
 * hold, offer, entry (`expireHolds`), the same as the response command; callers run this before
 * locking the entry or the recovery.
 */
async function reapExpiredOffers(
  tx: TenantTransaction,
  scope: { entryId?: string; locationId?: string },
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT h.id FROM cuspatlas.waitlist_offers o
     JOIN cuspatlas.scheduling_holds h ON h.id = o.hold_id AND h.tenant_id = o.tenant_id
     WHERE o.outcome IS NULL AND h.state = 'active' AND h.expires_at <= now()
       AND ($1::uuid IS NULL OR o.entry_id = $1) AND ($2::uuid IS NULL OR o.location_id = $2)
     ORDER BY h.id LIMIT 200`,
    [scope.entryId ?? null, scope.locationId ?? null],
  );
  if (rows.length > 0)
    await expireHolds(
      tx,
      rows.map((r) => r.id),
    );
}

/** S15 waitlist and PT-02 cancellation recovery with its standing-policy gate. */
export function createWaitlistOperations(base: AppointmentBase) {
  const { deps, execute } = base;

  /**
   * One offer: a hold of the window (TTL from the location's offer policy), the offer record with
   * its outcome open, the entry moved to `offered` and a waitlist_offer intent with channel none,
   * all in one transaction. Never books.
   */
  async function offerIn(
    tx: TenantTransaction,
    operation: string,
    decision: AuthorizationDecision,
    entry: EntryRow,
    window: WaitlistOffer,
    o: {
      recoveryId: string | null;
      policy: PolicyRow | null;
      canReadBookings: boolean;
      canReadPatients: boolean;
    },
  ): Promise<{ data: OfferCommandData; version: number }> {
    if (entry.state === 'offered') throw refused('offer_pending');
    if (entry.state !== 'active') throw refused('entry_closed');
    if (entry.expired) throw refused('entry_expired');
    const policy = await tx.query<{ ttl: number }>(
      'SELECT offer_ttl_minutes AS ttl FROM cuspatlas.scheduling_offer_policies WHERE location_id = $1',
      [entry.location_id],
    );
    const ttl = policy.rows[0]?.ttl;
    // Configuration, not stored state: not replayed, so a policy added later is honoured on retry.
    if (ttl === undefined) throw refused('offer_policy_missing', false);
    const location: LocationRow = await loadLocation(tx, entry.location_ref, 'share');
    const prepared = await prepareWindow(tx, decision, location, { ...window, timeZone: location.time_zone });
    const minutes = (prepared.w.e - prepared.w.s) / MINUTE;
    if (minutes !== entry.duration_minutes) throw failedAt('/endsAt', 'durationMismatch');
    if (prepared.w.s < entry.desired_from.getTime() || prepared.w.e > entry.desired_until.getTime()) {
      throw failedAt('/startsAt', 'outsideDesiredWindow');
    }
    if (entry.provider_preference_id !== null && entry.provider_preference_id !== prepared.provider.id) {
      throw failedAt('/provider', 'providerMismatch');
    }
    const extra: Conflict[] = [
      ...(await patientConflicts(tx, entry.subject_patient_id, o.canReadPatients)),
      ...(await availabilityConflicts(tx, prepared.resources, prepared.w, location.time_zone)),
    ];
    if (await patientBookedIn(tx, entry.subject_patient_id, prepared.w.s, prepared.w.e)) {
      extra.push({
        kind: 'patient_unavailable',
        explanation: 'The patient is already booked in this window.',
        overrideable: false,
      });
    }
    const hold = await createHoldIn(
      tx,
      operation,
      location,
      prepared.resources,
      prepared.w,
      ttl,
      o.canReadBookings,
      extra,
    ).catch((err: unknown) => {
      // A slot conflict depends on other records' current state: never replayed from the key.
      if (err instanceof RefusalError && err.code === 'conflict')
        throw new RefusalError({
          code: 'conflict',
          reasonCode: 'booking_conflict',
          replayable: false,
          ...(err.detail ? { detail: err.detail } : {}),
        });
      throw err;
    });
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cuspatlas.waitlist_offers (tenant_id, entry_id, hold_id, recovery_id, location_id, starts_at, ends_at,
         provider_id, operatory_id, no_operatory_reason, expires_at, standing_policy_id, standing_policy_version,
         created_by)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         cuspatlas.current_actor_id())
       RETURNING id`,
      [
        entry.id,
        hold.id,
        o.recoveryId,
        location.id,
        new Date(prepared.w.s),
        new Date(prepared.w.e),
        prepared.provider.id,
        prepared.operatory?.id ?? null,
        prepared.noOperatoryReason,
        hold.expires_at,
        o.policy?.id ?? null,
        o.policy?.version ?? null,
      ],
    );
    const offerId = rows[0]?.id;
    if (!offerId) throw new Error('insert returned no row');
    await recordCommand(
      tx,
      { operation, resourceType: WAITLIST_OFFER_RESOURCE, resourceRef: offerId, resourceVersion: 1 },
      { changedFields: ['hold', 'window', ...(o.policy ? ['standingPolicy'] : [])] },
    );
    const moved = await tx.query<{ version: number }>(
      `UPDATE cuspatlas.waitlist_entries SET state = 'offered', version = version + 1, updated_at = now()
       WHERE id = $1 AND state = 'active' RETURNING version`,
      [entry.id],
    );
    const entryVersion = moved.rows[0]?.version;
    if (entryVersion === undefined) throw refused('offer_pending');
    await recordCommand(
      tx,
      {
        operation,
        resourceType: WAITLIST_ENTRY_RESOURCE,
        resourceRef: entry.id,
        resourceVersion: entryVersion,
      },
      { changedFields: ['state'] },
    );
    const intentRef = await recordNotificationIntent(tx, operation, {
      subjectKind: 'waitlist_offer',
      subjectId: offerId,
      locationId: location.id,
      purpose: 'waitlist_offer',
      dueAt: hold.expires_at,
    });
    return {
      data: {
        offerRef: offerId,
        holdRef: hold.id,
        entryRef: entry.id,
        recoveryRef: o.recoveryId,
        expiresAt: hold.expires_at.toISOString(),
        intentRef,
        standingPolicyRef: o.policy?.id ?? null,
        standingPolicyVersion: o.policy?.version ?? null,
      },
      version: 1,
    };
  }

  /** The live standing policy that authorizes `actor` here, rechecked inside the executing transaction. */
  async function livePolicyFor(tx: TenantTransaction, actorId: string, locationRef: string) {
    const { rows } = await tx.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM cuspatlas.scheduling_standing_policies
       WHERE operation = 'scheduling.recovery.execute' AND grantee_principal_id = $1 AND $2 = ANY (location_refs)
         AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at, id LIMIT 1 FOR SHARE`,
      [actorId, locationRef],
    );
    return rows[0] ?? null;
  }

  /** The live policy for a service principal, or the `standing_policy_required` refusal. */
  async function requireLivePolicy(tx: TenantTransaction, ctx: ActorContext, locationRef: string) {
    const policy = await livePolicyFor(tx, ctx.actorId, locationRef);
    if (policy === null) {
      throw new RefusalError({
        code: 'forbidden',
        reasonCode: 'scope_missing',
        detail: { reason: 'standing_policy_required' },
      });
    }
    return policy;
  }

  return {
    addToWaitlist(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'scheduling.waitlist.add';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as WaitlistAdd;
        assertValid<WaitlistAdd>(validateWaitlistAdd, p, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, p.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, p.locationRef);
          return execute<{ entryRef: string; state: WaitlistState }>(ctx, envelope, tx, async () => {
            if (!(Date.parse(p.desiredFrom) < Date.parse(p.desiredUntil)))
              throw failedAt('/desiredUntil', 'intervalOrder');
            await assertPatientSchedulable(tx, p.patientRef);
            let provider: string | null = null;
            if (p.providerPreference) {
              if (!validateSchedulingEntityRef(p.providerPreference.resourceRef)) throw notFound();
              const r = await tx.query<{ id: string; kind: string; location_id: string }>(
                'SELECT id, kind, location_id FROM cuspatlas.scheduling_resources WHERE id = $1',
                [p.providerPreference.resourceRef],
              );
              const row = r.rows[0];
              if (!row) throw notFound();
              if (row.kind !== 'provider') throw failedAt('/providerPreference', 'kindMismatch');
              if (row.location_id !== location.id) throw failedAt('/providerPreference', 'locationMismatch');
              provider = row.id;
            }
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.waitlist_entries (tenant_id, subject_patient_id, location_id, appointment_type_code,
                 duration_minutes, provider_preference_id, desired_from, desired_until, priority, requested_channel,
                 expires_at, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, cuspatlas.current_actor_id())
               RETURNING id`,
              [
                p.patientRef,
                location.id,
                p.appointmentTypeCode ?? null,
                p.durationMinutes,
                provider,
                new Date(p.desiredFrom),
                new Date(p.desiredUntil),
                p.priority ?? 3,
                p.requestedChannel ?? 'none',
                p.expiresAt === undefined ? null : new Date(p.expiresAt),
              ],
            );
            const id = rows[0]?.id;
            if (!id) throw new Error('insert returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: WAITLIST_ENTRY_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['patientRef', 'window', 'state'] },
            );
            return { data: { entryRef: id, state: 'active' }, version: 1 };
          });
        });
      });
    },

    removeFromWaitlist(ctx: ActorContext, entryRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'scheduling.waitlist.remove';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as WaitlistRemove;
        assertValid<WaitlistRemove>(validateWaitlistRemove, p, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (validateSchedulingEntityRef(entryRef)) await reapExpiredOffers(tx, { entryId: entryRef });
          const e = await loadEntry(tx, decision, entryRef, 'FOR UPDATE OF e');
          return execute<{ entryRef: string; state: WaitlistState }>(
            ctx,
            { ...envelope, payload: { entryRef, ...p } },
            tx,
            async () => {
              if (e.version !== p.expectedVersion)
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: e.version } });
              if (e.state === 'offered') throw refused('offer_pending');
              if (e.state !== 'active') throw refused('entry_closed');
              await tx.query(
                `UPDATE cuspatlas.waitlist_entries SET state = 'removed', state_reason = $1, version = version + 1,
                   updated_at = now() WHERE id = $2`,
                [p.reasonCode, e.id],
              );
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: WAITLIST_ENTRY_RESOURCE,
                  resourceRef: e.id,
                  resourceVersion: e.version + 1,
                },
                { changedFields: ['state'] },
              );
              return { data: { entryRef: e.id, state: 'removed' }, version: e.version + 1 };
            },
          );
        });
      });
    },

    listWaitlist(ctx: ActorContext, query: unknown): Promise<WaitlistEntryRecord[]> {
      const op = 'scheduling.waitlist.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        const q = query as WaitlistListQuery;
        assertValid<WaitlistListQuery>(validateWaitlistListQuery, q, SCHEDULING_PROPERTIES);
        if (q.locationRef !== undefined) assertLocation(decision.locationRefs, q.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<EntryRow>(
            `SELECT ${ENTRY_COLUMNS} ${ENTRY_FROM}
             WHERE ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[])) AND ($2::text IS NULL OR l.location_ref = $2)
               AND ($3::text IS NULL OR e.state = $3)
             ORDER BY e.priority, e.created_at, e.id LIMIT 100`,
            [decision.locationRefs, q.locationRef ?? null, q.state ?? null],
          );
          return rows.map(entryRecord);
        });
      });
    },

    offerSlot(ctx: ActorContext, entryRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'scheduling.waitlist.offer';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as WaitlistOffer;
        assertValid<WaitlistOffer>(validateWaitlistOffer, p, SCHEDULING_PROPERTIES);
        const canReadBookings = await base.can(ctx, 'scheduling.appointments.read');
        const canReadPatients = await base.can(ctx, 'patients.read');
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (validateSchedulingEntityRef(entryRef)) await reapExpiredOffers(tx, { entryId: entryRef });
          const e = await loadEntry(tx, decision, entryRef, 'FOR UPDATE OF e');
          // S-D6: a direct offer by a service principal needs the same live standing policy as
          // recovery execution (rechecked here, FOR SHARE), limited per entry, and records its version.
          const policy =
            ctx.principal === 'service' ? await requireLivePolicy(tx, ctx, e.location_ref) : null;
          return execute<OfferCommandData>(
            ctx,
            { ...envelope, payload: { entryRef, ...p } },
            tx,
            async () => {
              if (policy !== null) {
                const used = await tx.query<{ n: number }>(
                  `SELECT count(*)::int AS n FROM cuspatlas.waitlist_offers
                 WHERE entry_id = $1 AND recovery_id IS NULL AND standing_policy_id = $2`,
                  [e.id, policy.id],
                );
                if ((used.rows[0]?.n ?? 0) >= policy.max_offers_per_recovery)
                  throw refused('standing_policy_limit');
              }
              return offerIn(tx, op, decision, e, p, {
                recoveryId: null,
                policy,
                canReadBookings,
                canReadPatients,
              });
            },
          );
        });
      });
    },

    readOffer(ctx: ActorContext, offerRef: string): Promise<OfferRecord> {
      const op = 'scheduling.waitlist.offers.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const o = await loadOffer(tx, decision, offerRef);
          return {
            offerRef: o.id,
            entryRef: o.entry_id,
            holdRef: o.hold_id,
            recoveryRef: o.recovery_id,
            startsAt: o.starts_at.toISOString(),
            endsAt: o.ends_at.toISOString(),
            expiresAt: o.expires_at.toISOString(),
            outcome: o.hold_expired ? 'expired' : o.outcome,
            outcomeReason: o.hold_expired ? 'hold_expired' : o.outcome_reason,
            appointmentRef: o.appointment_id,
            standingPolicyRef: o.standing_policy_id,
            standingPolicyVersion: o.standing_policy_version,
            version: o.version,
          };
        });
      });
    },

    respondToOffer(
      ctx: ActorContext,
      offerRef: string,
      envelope: CommandEnvelope<unknown>,
      portal?: PortalOfferAuthority,
    ): Promise<CommandResult<OfferRespondData>> {
      const op = 'scheduling.waitlist.respond';
      return base.recorded(ctx, op, async () => {
        // E seam: a portal principal answers only through E's portal authority (S5 relationship
        // scopes, rechecked in this transaction before the executor, so a replay is reauthorized), and
        // a staff call can never carry that authority. The portal sees every location of the tenant
        // (its confinement is the patient, enforced by the authority).
        if ((ctx.principal === 'portal') !== (portal !== undefined)) {
          throw new RefusalError({ code: 'forbidden', reasonCode: 'principal_kind_denied' });
        }
        const decision: AuthorizationDecision = portal
          ? { action: op, locationRefs: null }
          : await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as OfferRespond;
        assertValid<OfferRespond>(validateOfferRespond, p, SCHEDULING_PROPERTIES);
        // S-D6: an offer books only on explicit acceptance, by a person: staff (human) or the patient
        // or a guardian holding `scheduling` through the E portal. A service principal never accepts,
        // and only staff withdraw an offer.
        if (p.outcome === 'accepted' && ctx.principal !== 'human' && ctx.principal !== 'portal') {
          throw new RefusalError({ code: 'forbidden', reasonCode: 'principal_kind_denied' });
        }
        if (p.outcome === 'withdrawn' && ctx.principal === 'portal') {
          throw new RefusalError({ code: 'forbidden', reasonCode: 'principal_kind_denied' });
        }
        const canReadBookings = await base.can(ctx, 'scheduling.appointments.read');
        const canReadPatients = await base.can(ctx, 'patients.read');
        return deps.withTenantTransaction(ctx, async (tx) => {
          // One lock order everywhere: recovery, hold, offer, entry (expireHolds takes hold, offer, entry).
          // The bindings read here are immutable, so they are safe to read before the locks.
          const peek = await loadOffer(tx, decision, offerRef);
          if (peek.recovery_id !== null)
            await loadRecovery(tx, decision, peek.recovery_id, 'FOR UPDATE OF r');
          const hold: HoldRow = await loadHold(tx, decision, peek.hold_id, 'FOR UPDATE OF h');
          const o = await loadOffer(tx, decision, offerRef, 'FOR UPDATE OF o');
          const entry = await loadEntry(tx, decision, o.entry_id, 'FOR UPDATE OF e');
          if (portal) await portal.authorize(tx, entry.subject_patient_id);
          return execute<OfferRespondData>(
            ctx,
            { ...envelope, payload: { offerRef, ...p } },
            tx,
            async () => {
              if (o.version !== p.expectedVersion)
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: o.version } });
              if (o.outcome !== null) throw refused('offer_closed');
              let appointmentId: string | null = null;
              if (p.outcome === 'accepted') {
                // An offer that expired in flight is refused (the expiry path records it); the next step is
                // a new offer or a direct booking, never a booking from an expired hold.
                if (hold.state !== 'active' || hold.expired) throw refused('offer_expired', false);
                const location = await loadLocation(tx, o.location_ref, 'share');
                const prepared = await prepareWindow(tx, decision, location, {
                  startsAt: o.starts_at.toISOString(),
                  endsAt: o.ends_at.toISOString(),
                  timeZone: location.time_zone,
                  provider: { kind: 'provider', resourceRef: o.provider_id },
                  operatory:
                    o.operatory_id === null ? null : { kind: 'operatory', resourceRef: o.operatory_id },
                  ...(o.no_operatory_reason ? { noOperatoryReason: o.no_operatory_reason } : {}),
                });
                await tx.query(
                  `UPDATE cuspatlas.scheduling_occupancy SET released_at = now()
                 WHERE source_kind = 'hold' AND source_id = $1 AND released_at IS NULL`,
                  [hold.id],
                );
                appointmentId = await insertBookingIn(tx, op, {
                  location,
                  prepared,
                  patientRef: entry.subject_patient_id,
                  timeZone: location.time_zone,
                  appointmentTypeCode: entry.appointment_type_code,
                  requestId: null,
                  holdId: hold.id,
                  rescheduledFrom: null,
                  ignoreSources: [hold.id],
                  canReadBookings,
                  canReadPatients,
                  override: undefined,
                  canOverride: false,
                  extraConflicts: [],
                });
                await convertHoldIn(tx, hold.id, hold.version, appointmentId);
                await tx.query(
                  `UPDATE cuspatlas.waitlist_entries SET state = 'booked', appointment_id = $1, version = version + 1,
                   updated_at = now() WHERE id = $2`,
                  [appointmentId, entry.id],
                );
                await recordCommand(
                  tx,
                  {
                    operation: op,
                    resourceType: WAITLIST_ENTRY_RESOURCE,
                    resourceRef: entry.id,
                    resourceVersion: entry.version + 1,
                  },
                  { changedFields: ['state', 'appointmentRef'] },
                );
                if (o.recovery_id !== null) {
                  const rec = await tx.query<{ version: number }>(
                    `UPDATE cuspatlas.cancellation_recoveries SET state = 'filled', filled_appointment_id = $1,
                     version = version + 1, updated_at = now() WHERE id = $2 AND state = 'open' RETURNING version`,
                    [appointmentId, o.recovery_id],
                  );
                  const rv = rec.rows[0]?.version;
                  if (rv !== undefined) {
                    await recordCommand(
                      tx,
                      {
                        operation: op,
                        resourceType: RECOVERY_RESOURCE,
                        resourceRef: o.recovery_id,
                        resourceVersion: rv,
                      },
                      { changedFields: ['state'] },
                    );
                  }
                }
              } else {
                if (hold.state === 'active') {
                  await releaseHoldIn(
                    tx,
                    op,
                    hold.id,
                    hold.version,
                    p.outcome === 'declined' ? 'offer_declined' : 'offer_withdrawn',
                  );
                }
                await reopenEntryIn(tx, op, entry.id);
              }
              const { rows } = await tx.query<{ version: number }>(
                `UPDATE cuspatlas.waitlist_offers SET outcome = $1, outcome_reason = $2, appointment_id = $3,
                 decided_by = cuspatlas.current_actor_id(), decided_at = now(), version = version + 1, updated_at = now()
               WHERE id = $4 RETURNING version`,
                [p.outcome, p.reasonCode ?? null, appointmentId, o.id],
              );
              const version = rows[0]?.version ?? o.version + 1;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: WAITLIST_OFFER_RESOURCE,
                  resourceRef: o.id,
                  resourceVersion: version,
                },
                { changedFields: ['outcome', ...(appointmentId ? ['appointmentRef'] : [])] },
              );
              return {
                data: {
                  offerRef: o.id,
                  entryRef: entry.id,
                  outcome: p.outcome,
                  appointmentRef: appointmentId,
                },
                version,
              };
            },
          );
        });
      });
    },

    reconcileOffers(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'scheduling.waitlist.reconcileOffers';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateOfferReconcile, envelope.payload, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute<{ expired: number }>(ctx, envelope, tx, async () => {
            const due = await tx.query<{ id: string }>(
              `SELECT h.id FROM cuspatlas.waitlist_offers o
               JOIN cuspatlas.scheduling_holds h ON h.id = o.hold_id AND h.tenant_id = o.tenant_id
               JOIN cuspatlas.scheduling_locations l ON l.id = o.location_id AND l.tenant_id = o.tenant_id
               WHERE o.outcome IS NULL AND h.state = 'active' AND h.expires_at <= now()
                 AND ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))
               ORDER BY h.id LIMIT 500`,
              [decision.locationRefs],
            );
            const expired = await expireHolds(
              tx,
              due.rows.map((r) => r.id),
            );
            return { data: { expired }, version: 1 };
          }),
        );
      });
    },

    listRecoveries(ctx: ActorContext, query: unknown): Promise<WorkItemListData> {
      const op = 'scheduling.recovery.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        const q = query as RecoveryListQuery;
        assertValid<RecoveryListQuery>(validateRecoveryListQuery, q, SCHEDULING_PROPERTIES);
        if (q.locationRef !== undefined) assertLocation(decision.locationRefs, q.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<RecoveryRow & { live_offers: number }>(
            `SELECT r.id, r.appointment_id, r.location_id, l.location_ref, r.starts_at, r.ends_at, r.provider_id,
               r.operatory_id, r.state, r.version,
               (SELECT count(*)::int FROM cuspatlas.waitlist_offers o
                 JOIN cuspatlas.scheduling_holds h ON h.id = o.hold_id AND h.tenant_id = o.tenant_id
                WHERE o.recovery_id = r.id AND o.outcome IS NULL AND NOT (h.state = 'active' AND h.expires_at <= now()))
                 AS live_offers
             FROM cuspatlas.cancellation_recoveries r
             JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
             WHERE r.state = 'open' AND r.starts_at > now()
               AND ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[])) AND ($2::text IS NULL OR l.location_ref = $2)
             ORDER BY r.starts_at, r.id LIMIT 500`,
            [decision.locationRefs, q.locationRef ?? null],
          );
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          return workList(
            now,
            AVAILABLE,
            rows.map((r) =>
              workItem({
                workItemRef: r.id,
                kind: 'cancellation_recovery',
                reasonCode: r.live_offers > 0 ? 'offer_awaiting_answer' : 'slot_freed_by_cancellation',
                explanation:
                  r.live_offers > 0
                    ? 'The freed slot is held for a waitlisted patient; record their answer before the offer expires.'
                    : 'A booking was cancelled and its slot is free. Review the waitlist candidates and offer the slot.',
                evidenceRefs: [
                  { kind: 'appointment', ref: r.appointment_id },
                  { kind: 'cancellationRecovery', ref: r.id },
                ],
                owner: { queue: 'scheduling', principalRef: null },
                nextActionOwedBy: r.live_offers > 0 ? 'patient' : 'practice',
                dueAt: r.starts_at.toISOString(),
                priority: r.starts_at.getTime() - now.getTime() < 2 * 86_400_000 ? 'soon' : 'routine',
                priorityRationale: 'slot_start_proximity',
                suggestedNextAction: r.live_offers > 0 ? 'await_offer_answer' : 'review_waitlist_candidates',
                blockingDependencies: ['E6'],
              }),
            ),
          );
        });
      });
    },

    readRecovery(ctx: ActorContext, recoveryRef: string): Promise<RecoveryRecord> {
      const op = 'scheduling.recovery.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const r = await loadRecovery(tx, decision, recoveryRef);
          const { candidates, excluded } =
            r.state === 'open' ? await candidatesFor(tx, r) : { candidates: [], excluded: [] };
          const policy = await tx.query<{ id: string }>(
            `SELECT id FROM cuspatlas.scheduling_standing_policies
             WHERE operation = 'scheduling.recovery.execute' AND $1 = ANY (location_refs) AND revoked_at IS NULL
               AND expires_at > now() ORDER BY created_at, id LIMIT 1`,
            [r.location_ref],
          );
          const offers = await tx.query<{ id: string; outcome: OfferOutcome | null }>(
            `SELECT o.id, CASE WHEN o.outcome IS NULL AND h.state = 'active' AND h.expires_at <= now() THEN 'expired'
                ELSE o.outcome END AS outcome
             FROM cuspatlas.waitlist_offers o
             JOIN cuspatlas.scheduling_holds h ON h.id = o.hold_id AND h.tenant_id = o.tenant_id
             WHERE o.recovery_id = $1 ORDER BY o.created_at, o.id LIMIT 20`,
            [r.id],
          );
          const policyRef = policy.rows[0]?.id ?? null;
          return {
            recoveryRef: r.id,
            appointmentRef: r.appointment_id,
            locationRef: r.location_ref,
            startsAt: r.starts_at.toISOString(),
            endsAt: r.ends_at.toISOString(),
            provider: { kind: 'provider', resourceRef: r.provider_id },
            state: r.state,
            version: r.version,
            automation: {
              mode: policyRef === null ? 'prepare_for_approval' : 'policy_authorized',
              standingPolicyRef: policyRef,
            },
            candidates: candidates.map(({ row: _row, ...c }) => c),
            excluded,
            offers: offers.rows.map((o) => ({ offerRef: o.id, outcome: o.outcome })),
          };
        });
      });
    },

    executeRecovery(
      ctx: ActorContext,
      recoveryRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<OfferCommandData>> {
      const op = 'scheduling.recovery.execute';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as RecoveryExecute;
        assertValid<RecoveryExecute>(validateRecoveryExecute, p, SCHEDULING_PROPERTIES);
        const canReadBookings = await base.can(ctx, 'scheduling.appointments.read');
        const canReadPatients = await base.can(ctx, 'patients.read');
        return deps.withTenantTransaction(ctx, async (tx) => {
          // Expired offers of this location are reaped before the recovery is locked (lock order).
          const peek = await loadRecovery(tx, decision, recoveryRef);
          await reapExpiredOffers(tx, { locationId: peek.location_id });
          const r = await loadRecovery(tx, decision, recoveryRef, 'FOR UPDATE OF r');
          // Automation authority (PT-02): a person executing is the approval of the prepared offer; a
          // service principal needs a live standing policy naming it, this operation and this location,
          // rechecked here (FOR SHARE serializes with revocation) and recorded on the offer.
          const policy =
            ctx.principal === 'service' ? await requireLivePolicy(tx, ctx, r.location_ref) : null;
          return execute<OfferCommandData>(
            ctx,
            { ...envelope, payload: { recoveryRef, ...p } },
            tx,
            async () => {
              if (r.version !== p.expectedVersion)
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: r.version } });
              if (r.state !== 'open' || r.starts_at.getTime() <= Date.now()) throw refused('recovery_closed');
              if (policy !== null) {
                const used = await tx.query<{ n: number }>(
                  `SELECT count(*)::int AS n FROM cuspatlas.waitlist_offers WHERE recovery_id = $1 AND standing_policy_id = $2`,
                  [r.id, policy.id],
                );
                if ((used.rows[0]?.n ?? 0) >= policy.max_offers_per_recovery)
                  throw refused('standing_policy_limit');
              }
              const { candidates, excluded } = await candidatesFor(tx, r);
              const chosen =
                p.entryRef === undefined ? candidates[0] : candidates.find((c) => c.entryRef === p.entryRef);
              if (!chosen) {
                if (p.entryRef !== undefined && !excluded.some((e) => e.entryRef === p.entryRef))
                  throw notFound();
                throw refused(
                  p.entryRef === undefined ? 'no_eligible_candidate' : 'candidate_not_eligible',
                  false,
                );
              }
              const entry = await loadEntry(tx, decision, chosen.entryRef, 'FOR UPDATE OF e');
              const end = r.starts_at.getTime() + entry.duration_minutes * MINUTE;
              const made = await offerIn(
                tx,
                op,
                decision,
                entry,
                {
                  startsAt: r.starts_at.toISOString(),
                  endsAt: new Date(end).toISOString(),
                  provider: { kind: 'provider', resourceRef: r.provider_id },
                  operatory:
                    r.operatory_id === null ? null : { kind: 'operatory', resourceRef: r.operatory_id },
                  ...(r.operatory_id === null ? { noOperatoryReason: 'not_yet_assigned' as const } : {}),
                },
                { recoveryId: r.id, policy, canReadBookings, canReadPatients },
              );
              await tx.query(
                'UPDATE cuspatlas.cancellation_recoveries SET version = version + 1, updated_at = now() WHERE id = $1',
                [r.id],
              );
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: RECOVERY_RESOURCE,
                  resourceRef: r.id,
                  resourceVersion: r.version + 1,
                },
                { changedFields: ['offers'] },
              );
              return made;
            },
          );
        });
      });
    },

    grantStandingPolicy(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'scheduling.standingPolicies.grant';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as StandingPolicyGrant;
        assertValid<StandingPolicyGrant>(validateStandingPolicyGrant, p, SCHEDULING_PROPERTIES);
        for (const l of p.locationRefs) assertLocation(decision.locationRefs, l);
        // The grantee must be a service principal with a live membership in this tenant. Anything else
        // (a person, another tenant's principal, an unknown or revoked one) is one indistinguishable 422.
        const grantee = validateSchedulingEntityRef(p.granteeRef)
          ? await deps.memberships?.load(p.granteeRef, ctx.tenantId)
          : null;
        return deps.withTenantTransaction(ctx, async (tx) => {
          for (const l of p.locationRefs) await loadLocation(tx, l);
          return execute<{ policyRef: string; state: 'active' | 'revoked' }>(ctx, envelope, tx, async () => {
            if (!grantee?.active || grantee.principal !== 'service')
              throw failedAt('/granteeRef', 'notServicePrincipal');
            const expires = Date.parse(p.expiresAt);
            if (expires <= Date.now()) throw failedAt('/expiresAt', 'inThePast');
            if (expires > Date.now() + MAX_POLICY_DAYS * 86_400_000)
              throw failedAt('/expiresAt', 'beyondReviewLimit');
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.scheduling_standing_policies (tenant_id, operation, owner_principal_id,
                 grantee_principal_id, location_refs, max_offers_per_recovery, expires_at)
               VALUES (cuspatlas.current_tenant_id(), $1, cuspatlas.current_actor_id(), $2, $3::text[], $4, $5)
               RETURNING id`,
              [
                p.operation,
                p.granteeRef,
                [...p.locationRefs].sort(),
                p.maxOffersPerRecovery,
                new Date(p.expiresAt),
              ],
            );
            const id = rows[0]?.id;
            if (!id) throw new Error('insert returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: STANDING_POLICY_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['operation', 'grantee', 'scope', 'limits', 'expiresAt'] },
            );
            return { data: { policyRef: id, state: 'active' }, version: 1 };
          });
        });
      });
    },

    revokeStandingPolicy(ctx: ActorContext, policyRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'scheduling.standingPolicies.revoke';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as StandingPolicyRevoke;
        assertValid<StandingPolicyRevoke>(validateStandingPolicyRevoke, p, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (!validateSchedulingEntityRef(policyRef)) throw notFound();
          const { rows } = await tx.query<PolicyRow>(
            `SELECT ${POLICY_COLUMNS} FROM cuspatlas.scheduling_standing_policies WHERE id = $1 FOR UPDATE`,
            [policyRef],
          );
          const pol = rows[0];
          if (!pol) throw notFound();
          return execute<{ policyRef: string; state: 'active' | 'revoked' }>(
            ctx,
            { ...envelope, payload: { policyRef, ...p } },
            tx,
            async () => {
              if (pol.version !== p.expectedVersion)
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: pol.version } });
              if (pol.revoked_at !== null) throw refused('policy_already_revoked');
              await tx.query(
                `UPDATE cuspatlas.scheduling_standing_policies SET revoked_at = now(), revoked_by = cuspatlas.current_actor_id(),
                   revoke_reason = $1, version = version + 1, updated_at = now() WHERE id = $2`,
                [p.reasonCode, pol.id],
              );
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: STANDING_POLICY_RESOURCE,
                  resourceRef: pol.id,
                  resourceVersion: pol.version + 1,
                },
                { changedFields: ['revoked'] },
              );
              return { data: { policyRef: pol.id, state: 'revoked' }, version: pol.version + 1 };
            },
          );
        });
      });
    },

    listStandingPolicies(ctx: ActorContext): Promise<StandingPolicyRecord[]> {
      const op = 'scheduling.standingPolicies.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<PolicyRow>(
            `SELECT ${POLICY_COLUMNS} FROM cuspatlas.scheduling_standing_policies ORDER BY created_at, id LIMIT 100`,
          );
          return rows.map((r) => ({
            policyRef: r.id,
            operation: 'scheduling.recovery.execute' as const,
            ownerRef: r.owner_principal_id,
            granteeRef: r.grantee_principal_id,
            locationRefs: r.location_refs,
            maxOffersPerRecovery: r.max_offers_per_recovery,
            expiresAt: r.expires_at.toISOString(),
            state: r.revoked_at !== null ? 'revoked' : r.expired ? 'expired' : 'active',
            version: r.version,
            createdAt: r.created_at.toISOString(),
          }));
        });
      });
    },
  };
}

export type WaitlistOperations = ReturnType<typeof createWaitlistOperations>;
