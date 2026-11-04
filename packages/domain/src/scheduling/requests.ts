import {
  type ActorContext,
  type AppointmentRequestClose,
  type AppointmentRequestCreate,
  type AppointmentRequestListQuery,
  type AppointmentRequestPreferences,
  type AppointmentRequestRecord,
  type AppointmentRequestReopen,
  type AppointmentRequestReview,
  type AppointmentRequestSummary,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  type Page,
  type PreferredWindow,
  RefusalError,
  type RequestCommandData,
  type RequestState,
  type RequestTransition,
  SCHEDULING_PROPERTIES,
  type TenantTransaction,
  type UnbookedRequestReport,
  validateAppointmentRequestClose,
  validateAppointmentRequestCreate,
  validateAppointmentRequestListQuery,
  validateAppointmentRequestPreferences,
  validateAppointmentRequestReopen,
  validateAppointmentRequestReview,
  validateSchedulingEntityRef,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { assertPatientSchedulable } from '../patients/identity';
import { type AuthorizationDecision, assertLocation } from '../policy/authorize';
import { type AppointmentBase, assertVisibleLocation, limitOf } from './appointment-base';
import { checkEnvelope, failedAt, loadLocation, loadResource, notFound } from './resources';

export const REQUEST_RESOURCE = 'appointmentRequest';
const TERMINAL: ReadonlySet<RequestState> = new Set(['scheduled', 'declined', 'expired', 'withdrawn']);

export const requestConflict = (reason: string) => new RefusalError({ code: 'conflict', detail: { reason } });

export interface RequestRow extends Record<string, unknown> {
  id: string;
  subject_patient_id: string;
  location_id: string;
  location_ref: string;
  origin: 'staff' | 'portal';
  source_channel: string;
  appointment_type_code: string | null;
  provider_preference_id: string | null;
  preferred_windows: PreferredWindow[];
  flexibility: AppointmentRequestRecord['flexibility'];
  urgent: boolean;
  contact_consent: AppointmentRequestRecord['contactConsent'];
  note: string | null;
  state: RequestState;
  state_reason: string | null;
  appointment_id: string | null;
  closed_at: Date | null;
  version: number;
  created_at: Date;
}

const REQUEST_COLUMNS = `q.id, q.subject_patient_id, q.location_id, l.location_ref, q.origin, q.source_channel,
  q.appointment_type_code, q.provider_preference_id, q.preferred_windows, q.flexibility, q.urgent, q.contact_consent,
  q.note, q.state, q.state_reason, q.appointment_id, q.closed_at, q.version, q.created_at`;

/** Loads one request of the current tenant (RLS) that the caller's location policy may see. */
export async function loadRequest(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  requestRef: string,
  lock: '' | 'FOR UPDATE OF q' = '',
): Promise<RequestRow> {
  if (!validateSchedulingEntityRef(requestRef)) throw notFound();
  const { rows } = await tx.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM cuspatlas.appointment_requests q
     JOIN cuspatlas.scheduling_locations l ON l.id = q.location_id AND l.tenant_id = q.tenant_id
     WHERE q.id = $1 ${lock}`,
    [requestRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  assertVisibleLocation(decision, row.location_ref);
  return row;
}

const toSummary = (r: RequestRow): AppointmentRequestSummary => ({
  requestRef: r.id,
  patientRef: r.subject_patient_id,
  locationRef: r.location_ref,
  state: r.state,
  urgent: r.urgent,
  appointmentRef: r.appointment_id,
  version: r.version,
  createdAt: r.created_at.toISOString(),
});

function checkWindows(windows: readonly PreferredWindow[] | undefined): PreferredWindow[] {
  const out = (windows ?? []).map((w) => ({
    startsAt: new Date(w.startsAt).toISOString(),
    endsAt: new Date(w.endsAt).toISOString(),
  }));
  for (const w of out) {
    if (!(Date.parse(w.startsAt) < Date.parse(w.endsAt)))
      throw failedAt('/preferredWindows', 'intervalOrder');
  }
  return out;
}

async function checkProviderPreference(
  tx: TenantTransaction,
  ref: string | null | undefined,
  locationId: string,
): Promise<string | null> {
  if (ref === undefined || ref === null) return null;
  const r = await loadResource(tx, ref);
  if (r.kind !== 'provider') throw failedAt('/providerPreference', 'kindMismatch');
  if (r.location_id !== locationId) throw failedAt('/providerPreference', 'locationMismatch');
  return r.id;
}

/** Appends the transition row and the committed-change audit/outbox in the command transaction. */
export async function recordTransition(
  tx: TenantTransaction,
  operation: string,
  t: {
    requestId: string;
    from: RequestState | null;
    to: RequestState;
    reason: string | null;
    appointmentId: string | null;
    version: number;
  },
  changedFields: string[],
): Promise<void> {
  await tx.query(
    `INSERT INTO cuspatlas.appointment_request_transitions (tenant_id, request_id, from_state, to_state, reason_code,
       appointment_id, request_version, actor_id)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id())`,
    [t.requestId, t.from, t.to, t.reason, t.appointmentId, t.version],
  );
  await recordCommand(
    tx,
    { operation, resourceType: REQUEST_RESOURCE, resourceRef: t.requestId, resourceVersion: t.version },
    { changedFields },
  );
}

/**
 * Moves a request to `scheduled` with the booking reference on both records. The only path to
 * `scheduled`; called by close(scheduled), the link command and a booking made from a request.
 */
export async function linkRequestToBookingIn(
  tx: TenantTransaction,
  operation: string,
  request: RequestRow,
  appointment: { id: string; subject_patient_id: string; location_id: string; status: string },
  reasonCode: string,
): Promise<number> {
  if (TERMINAL.has(request.state)) throw requestConflict('request_closed');
  if (appointment.status !== 'booked') throw requestConflict('appointment_not_booked');
  if (appointment.subject_patient_id !== request.subject_patient_id)
    throw failedAt('/appointmentRef', 'patientMismatch');
  if (appointment.location_id !== request.location_id) throw failedAt('/appointmentRef', 'locationMismatch');
  const linked = await tx.query(
    `UPDATE cuspatlas.appointments SET request_id = $1, version = version + 1, updated_at = now()
     WHERE id = $2 AND request_id IS NULL`,
    [request.id, appointment.id],
  );
  if (linked.rowCount !== 1) throw requestConflict('appointment_already_linked');
  const { rows } = await tx.query<{ version: number }>(
    `UPDATE cuspatlas.appointment_requests SET state = 'scheduled', state_reason = $1, appointment_id = $2,
       closed_at = now(), version = version + 1, updated_at = now()
     WHERE id = $3 AND version = $4 RETURNING version`,
    [reasonCode, appointment.id, request.id, request.version],
  );
  const version = rows[0]?.version;
  if (version === undefined) throw new RefusalError({ code: 'stale_version' });
  await recordTransition(
    tx,
    operation,
    {
      requestId: request.id,
      from: request.state,
      to: 'scheduled',
      reason: reasonCode,
      appointmentId: appointment.id,
      version,
    },
    ['state', 'appointmentRef'],
  );
  return version;
}

export type LinkHook = (
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  request: RequestRow,
  appointmentRef: string,
  reasonCode: string,
  operation: string,
) => Promise<number>;

/** S8 request commands and queries. `origin` is set by the transport (staff routes: 'staff'). */
export function createRequestOperations(base: AppointmentBase, link: LinkHook) {
  const { deps, execute, cursors } = base;

  function versioned(row: RequestRow, expected: number): void {
    if (TERMINAL.has(row.state) && row.version !== expected) throw requestConflict('request_closed');
    if (row.version !== expected) {
      throw new RefusalError({ code: 'stale_version', detail: { currentVersion: row.version } });
    }
  }

  async function transition(
    ctx: ActorContext,
    operation: 'scheduling.requests.review' | 'scheduling.requests.close' | 'scheduling.requests.reopen',
    requestRef: string,
    envelope: CommandEnvelope<unknown>,
    validate: () => void,
    apply: (
      tx: TenantTransaction,
      row: RequestRow,
      decision: AuthorizationDecision,
    ) => Promise<{ state: RequestState; version: number }>,
  ): Promise<CommandResult<RequestCommandData>> {
    return base.guarded(ctx, operation, async () => {
      const decision = await base.authorize(ctx, operation);
      checkEnvelope(envelope, operation);
      validate();
      return deps.withTenantTransaction(ctx, async (tx) => {
        const row = await loadRequest(tx, decision, requestRef, 'FOR UPDATE OF q');
        return execute<RequestCommandData>(
          ctx,
          { ...envelope, payload: { requestRef, ...(envelope.payload as object) } },
          tx,
          async () => {
            const out = await apply(tx, row, decision);
            return { data: { requestRef: row.id, state: out.state }, version: out.version };
          },
        );
      });
    });
  }

  return {
    createRequest(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
      origin: 'staff' | 'portal' = 'staff',
    ): Promise<CommandResult<RequestCommandData>> {
      return base.guarded(ctx, 'scheduling.requests.create', async () => {
        const decision = await base.authorize(ctx, 'scheduling.requests.create');
        checkEnvelope(envelope, 'scheduling.requests.create');
        const p = envelope.payload;
        assertValid<AppointmentRequestCreate>(validateAppointmentRequestCreate, p, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, p.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, p.locationRef, 'share');
          return execute<RequestCommandData>(
            ctx,
            { ...envelope, payload: { ...p, origin } },
            tx,
            async () => {
              await assertPatientSchedulable(tx, p.patientRef);
              if (location.status !== 'active') throw failedAt('/locationRef', 'locationInactive');
              const windows = checkWindows(p.preferredWindows);
              if (windows.length === 0 && p.flexibility === undefined)
                throw failedAt('/', 'preferenceRequired');
              const provider = await checkProviderPreference(tx, p.providerPreference, location.id);
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.appointment_requests (tenant_id, subject_patient_id, location_id, origin, source_channel,
                 appointment_type_code, provider_preference_id, preferred_windows, flexibility, urgent, contact_consent,
                 note, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11,
                 cuspatlas.current_actor_id())
               RETURNING id`,
                [
                  p.patientRef,
                  location.id,
                  origin,
                  p.sourceChannel,
                  p.appointmentTypeCode ?? null,
                  provider,
                  JSON.stringify(windows),
                  p.flexibility ?? null,
                  p.urgent ?? false,
                  p.contactConsent,
                  p.note ?? null,
                ],
              );
              const id = rows[0]?.id;
              if (!id) throw new Error('insert returned no row');
              await recordTransition(
                tx,
                'scheduling.requests.create',
                { requestId: id, from: null, to: 'open', reason: null, appointmentId: null, version: 1 },
                ['patientRef', 'locationRef', 'sourceChannel', 'preferences', 'urgent', 'contactConsent'],
              );
              return { data: { requestRef: id, state: 'open' }, version: 1 };
            },
          );
        });
      });
    },

    updateRequestPreferences(
      ctx: ActorContext,
      requestRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<RequestCommandData>> {
      const op = 'scheduling.requests.updatePreferences';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<AppointmentRequestPreferences>(
          validateAppointmentRequestPreferences,
          p,
          SCHEDULING_PROPERTIES,
        );
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadRequest(tx, decision, requestRef, 'FOR UPDATE OF q');
          return execute<RequestCommandData>(
            ctx,
            { ...envelope, payload: { requestRef, ...p } },
            tx,
            async () => {
              versioned(row, p.expectedVersion);
              if (TERMINAL.has(row.state)) throw requestConflict('request_closed');
              const windows =
                p.preferredWindows === undefined ? row.preferred_windows : checkWindows(p.preferredWindows);
              const flexibility = p.flexibility === undefined ? row.flexibility : p.flexibility;
              if (windows.length === 0 && flexibility === null) throw failedAt('/', 'preferenceRequired');
              const provider =
                p.providerPreference === undefined
                  ? row.provider_preference_id
                  : await checkProviderPreference(tx, p.providerPreference, row.location_id);
              const { rows } = await tx.query<{ version: number }>(
                `UPDATE cuspatlas.appointment_requests SET provider_preference_id = $1, preferred_windows = $2::jsonb,
                 flexibility = $3, urgent = $4, contact_consent = $5, note = $6, version = version + 1, updated_at = now()
               WHERE id = $7 AND version = $8 RETURNING version`,
                [
                  provider,
                  JSON.stringify(windows),
                  flexibility,
                  p.urgent ?? row.urgent,
                  p.contactConsent ?? row.contact_consent,
                  p.note === undefined ? row.note : p.note,
                  row.id,
                  row.version,
                ],
              );
              const version = rows[0]?.version;
              if (version === undefined) throw new RefusalError({ code: 'stale_version' });
              const changed = Object.keys(p).filter((k) => k !== 'expectedVersion');
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: REQUEST_RESOURCE,
                  resourceRef: row.id,
                  resourceVersion: version,
                },
                { changedFields: changed.length > 0 ? changed : ['version'] },
              );
              return { data: { requestRef: row.id, state: row.state }, version };
            },
          );
        });
      });
    },

    reviewRequest(ctx: ActorContext, requestRef: string, envelope: CommandEnvelope<unknown>) {
      const p = envelope.payload as AppointmentRequestReview;
      return transition(
        ctx,
        'scheduling.requests.review',
        requestRef,
        envelope,
        () =>
          assertValid<AppointmentRequestReview>(validateAppointmentRequestReview, p, SCHEDULING_PROPERTIES),
        async (tx, row) => {
          versioned(row, p.expectedVersion);
          if (row.state !== 'open') throw requestConflict('request_not_open');
          return move(tx, 'scheduling.requests.review', row, 'in_review', null, {});
        },
      );
    },

    closeRequest(ctx: ActorContext, requestRef: string, envelope: CommandEnvelope<unknown>) {
      const p = envelope.payload as AppointmentRequestClose;
      return transition(
        ctx,
        'scheduling.requests.close',
        requestRef,
        envelope,
        () => assertValid<AppointmentRequestClose>(validateAppointmentRequestClose, p, SCHEDULING_PROPERTIES),
        async (tx, row, decision) => {
          versioned(row, p.expectedVersion);
          if (TERMINAL.has(row.state)) throw requestConflict('request_closed');
          if (p.state === 'scheduled') {
            if (p.appointmentRef === undefined) throw failedAt('/appointmentRef', 'required');
            const version = await link(
              tx,
              decision,
              row,
              p.appointmentRef,
              p.reasonCode,
              'scheduling.requests.close',
            );
            return { state: 'scheduled', version };
          }
          if (p.appointmentRef !== undefined) throw failedAt('/appointmentRef', 'onlyWhenScheduled');
          let expiry: string | null = null;
          if (p.state === 'expired') {
            const policy = await tx.query<{ ref: string | null }>(
              'SELECT request_expiry_policy_ref AS ref FROM cuspatlas.scheduling_policy_settings',
            );
            const configured = policy.rows[0]?.ref ?? null;
            if (configured === null) throw failedAt('/expiryPolicyRef', 'expiryPolicyNotConfigured');
            if (p.expiryPolicyRef === undefined) throw failedAt('/expiryPolicyRef', 'required');
            if (p.expiryPolicyRef !== configured) throw failedAt('/expiryPolicyRef', 'expiryPolicyMismatch');
            expiry = configured;
          } else if (p.expiryPolicyRef !== undefined) {
            throw failedAt('/expiryPolicyRef', 'onlyWhenExpired');
          }
          return move(tx, 'scheduling.requests.close', row, p.state, p.reasonCode, { closed: true, expiry });
        },
      );
    },

    reopenRequest(
      ctx: ActorContext,
      requestRef: string,
      envelope: CommandEnvelope<unknown>,
      bookingStillActive: (tx: TenantTransaction, appointmentId: string) => Promise<boolean>,
    ) {
      const p = envelope.payload as AppointmentRequestReopen;
      return transition(
        ctx,
        'scheduling.requests.reopen',
        requestRef,
        envelope,
        () =>
          assertValid<AppointmentRequestReopen>(validateAppointmentRequestReopen, p, SCHEDULING_PROPERTIES),
        async (tx, row) => {
          versioned(row, p.expectedVersion);
          if (!TERMINAL.has(row.state)) throw requestConflict('request_not_closed');
          // A scheduled request reopens only once its booking no longer stands (cancelled or
          // rescheduled); the link stays in the transition history.
          if (row.appointment_id !== null && (await bookingStillActive(tx, row.appointment_id))) {
            throw requestConflict('booking_still_active');
          }
          return move(tx, 'scheduling.requests.reopen', row, 'open', p.reasonCode, { reopen: true });
        },
      );
    },

    getRequest(ctx: ActorContext, requestRef: string): Promise<AppointmentRequestRecord> {
      return base.guarded(ctx, 'scheduling.requests.read', async () => {
        const decision = await base.authorize(ctx, 'scheduling.requests.read');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadRequest(tx, decision, requestRef);
          const t = await tx.query<{
            from_state: RequestState | null;
            to_state: RequestState;
            reason_code: string | null;
            appointment_id: string | null;
            occurred_at: Date;
            request_version: number;
          }>(
            `SELECT from_state, to_state, reason_code, appointment_id, occurred_at, request_version
             FROM cuspatlas.appointment_request_transitions WHERE request_id = $1 ORDER BY request_version LIMIT 100`,
            [row.id],
          );
          const transitions: RequestTransition[] = t.rows.map((x) => ({
            from: x.from_state,
            to: x.to_state,
            reasonCode: x.reason_code,
            appointmentRef: x.appointment_id,
            occurredAt: x.occurred_at.toISOString(),
            version: x.request_version,
          }));
          return {
            ...toSummary(row),
            origin: row.origin,
            sourceChannel: row.source_channel,
            appointmentTypeCode: row.appointment_type_code,
            providerPreference: row.provider_preference_id,
            preferredWindows: row.preferred_windows,
            flexibility: row.flexibility,
            contactConsent: row.contact_consent,
            note: row.note,
            stateReason: row.state_reason,
            closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
            transitions,
          };
        });
      });
    },

    listRequests(ctx: ActorContext, query: unknown): Promise<Page<AppointmentRequestSummary>> {
      return base.guarded(ctx, 'scheduling.requests.list', async () => {
        const decision = await base.authorize(ctx, 'scheduling.requests.list');
        assertValid<AppointmentRequestListQuery>(
          validateAppointmentRequestListQuery,
          query,
          SCHEDULING_PROPERTIES,
        );
        const scope = `requests:${query.state ?? ''}:${query.locationRef ?? ''}:${query.patientRef ?? ''}`;
        const limit = limitOf(query.limit);
        const after = query.cursor === undefined ? null : cursors.decode(ctx.tenantId, scope, query.cursor);
        return deps.withTenantTransaction(ctx, async (tx) => {
          // Default: the open worklist (open and in review); a state filter selects any one state.
          const { rows } = await tx.query<RequestRow>(
            `SELECT ${REQUEST_COLUMNS} FROM cuspatlas.appointment_requests q
             JOIN cuspatlas.scheduling_locations l ON l.id = q.location_id AND l.tenant_id = q.tenant_id
             WHERE ($1::uuid IS NULL OR q.id > $1::uuid)
               AND ($2::text[] IS NULL OR l.location_ref = ANY ($2::text[]))
               AND (($3::text IS NULL AND q.state IN ('open', 'in_review')) OR q.state = $3::text)
               AND ($4::text IS NULL OR l.location_ref = $4::text)
               AND ($5::uuid IS NULL OR q.subject_patient_id = $5::uuid)
             ORDER BY q.id LIMIT $6`,
            [
              after,
              decision.locationRefs,
              query.state ?? null,
              query.locationRef ?? null,
              query.patientRef ?? null,
              limit + 1,
            ],
          );
          const page = rows.slice(0, limit).map(toSummary);
          const last = page[page.length - 1];
          return {
            data: page,
            nextCursor:
              rows.length > limit && last ? cursors.encode(ctx.tenantId, scope, last.requestRef) : null,
          };
        });
      });
    },

    unbookedRequests(ctx: ActorContext): Promise<UnbookedRequestReport> {
      return base.guarded(ctx, 'scheduling.requests.unbookedReport', async () => {
        const decision = await base.authorize(ctx, 'scheduling.requests.unbookedReport');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const where = `q.state IN ('declined', 'expired', 'withdrawn') AND q.appointment_id IS NULL
            AND ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))`;
          const from = `FROM cuspatlas.appointment_requests q
            JOIN cuspatlas.scheduling_locations l ON l.id = q.location_id AND l.tenant_id = q.tenant_id`;
          const total = await tx.query<{ n: number; at: Date }>(
            `SELECT count(*)::int AS n, now() AS at ${from} WHERE ${where}`,
            [decision.locationRefs],
          );
          const list = await tx.query<{
            id: string;
            location_ref: string;
            state: 'declined' | 'expired' | 'withdrawn';
            state_reason: string | null;
            closed_at: Date;
          }>(
            `SELECT q.id, l.location_ref, q.state, q.state_reason, q.closed_at ${from} WHERE ${where}
             ORDER BY q.closed_at DESC, q.id LIMIT 100`,
            [decision.locationRefs],
          );
          const first = total.rows[0];
          return {
            checkedAt: (first?.at ?? new Date()).toISOString(),
            count: first?.n ?? 0,
            requests: list.rows.map((r) => ({
              requestRef: r.id,
              locationRef: r.location_ref,
              state: r.state,
              reasonCode: r.state_reason,
              closedAt: r.closed_at.toISOString(),
            })),
          };
        });
      });
    },
  };

  async function move(
    tx: TenantTransaction,
    operation: string,
    row: RequestRow,
    to: RequestState,
    reason: string | null,
    o: { closed?: boolean; expiry?: string | null; reopen?: boolean },
  ): Promise<{ state: RequestState; version: number }> {
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE cuspatlas.appointment_requests SET state = $1, state_reason = $2,
         closed_at = CASE WHEN $3::boolean THEN now() ELSE NULL END,
         expiry_policy_ref = $4, appointment_id = CASE WHEN $5::boolean THEN NULL ELSE appointment_id END,
         version = version + 1, updated_at = now()
       WHERE id = $6 AND version = $7 RETURNING version`,
      [to, reason, o.closed === true, o.expiry ?? null, o.reopen === true, row.id, row.version],
    );
    const version = rows[0]?.version;
    if (version === undefined) throw new RefusalError({ code: 'stale_version' });
    await recordTransition(
      tx,
      operation,
      { requestId: row.id, from: row.state, to, reason, appointmentId: null, version },
      ['state'],
    );
    return { state: to, version };
  }
}

export type RequestOperations = ReturnType<typeof createRequestOperations>;
