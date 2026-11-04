import {
  type ActorContext,
  type Assignee,
  type AssignmentInput,
  type AssignmentRole,
  assertValid,
  CLINICAL_PROPERTIES,
  type ClinicalAuthor,
  type ClinicalRole,
  type CommandEnvelope,
  type CommandResult,
  type Encounter,
  type EncounterAppointmentStatus,
  type EncounterAssign,
  type EncounterAssignment,
  type EncounterClose,
  type EncounterFlag,
  type EncounterListQuery,
  type EncounterOpen,
  type EncounterOpenData,
  type EncounterPage,
  RefusalError,
  type TenantTransaction,
  validateEncounterAssign,
  validateEncounterClose,
  validateEncounterListQuery,
  validateEncounterOpen,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { type AuthorizationDecision, assertLocation } from '../policy/authorize';
import { authorOf, resolveClinicalAuthor } from './authorship';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, limitOf, notFound, UUID } from './base';

export const ENCOUNTER_RESOURCE = 'clinicalEncounter';
const MAX_ASSIGNMENTS = 200;

interface EncounterRow extends Record<string, unknown> {
  id: string;
  subject_patient_id: string;
  appointment_id: string | null;
  appointment_status_at_open: EncounterAppointmentStatus | null;
  location_id: string;
  location_ref: string;
  state: 'open' | 'closed';
  disposition_code: string | null;
  closed_by: string | null;
  closed_by_role: ClinicalRole | null;
  closed_by_credential_ref: string | null;
  closed_at: Date | null;
  opened_by: string;
  opened_by_role: ClinicalRole;
  opened_by_credential_ref: string | null;
  opened_at: Date;
  version: number;
}

const ENCOUNTER_COLUMNS = `e.id, e.subject_patient_id, e.appointment_id, e.appointment_status_at_open, e.location_id,
  l.location_ref, e.state, e.disposition_code, e.closed_by, e.closed_by_role, e.closed_by_credential_ref, e.closed_at,
  e.opened_by, e.opened_by_role, e.opened_by_credential_ref, e.opened_at, e.version`;

/**
 * Loads one encounter inside the caller's transaction. A malformed, missing, other-tenant (RLS) or
 * other-location encounter is the same 404, so a reference never confirms existence.
 */
export async function loadEncounter(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  encounterRef: string,
  lock: '' | 'FOR UPDATE OF e' | 'FOR SHARE OF e' = '',
): Promise<EncounterRow> {
  if (!UUID.test(encounterRef)) throw notFound();
  const { rows } = await tx.query<EncounterRow>(
    `SELECT ${ENCOUNTER_COLUMNS} FROM cuspatlas.clinical_encounters e
     JOIN cuspatlas.scheduling_locations l ON l.id = e.location_id AND l.tenant_id = e.tenant_id
     WHERE e.id = $1 ${lock}`,
    [encounterRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  if (decision.locationRefs !== null && !decision.locationRefs.includes(row.location_ref)) throw notFound();
  return row;
}

/**
 * Seam for every clinical entry command (C6-C15 and C8): the encounter must be visible, belong to
 * the patient the entry names, and still be open. A closed encounter refuses new entries with 409
 * `encounter_closed`, naming the encounter and, when the caller supplies one, the supported
 * alternative operation. The row is read FOR SHARE so a concurrent close serializes with the entry.
 */
export async function requireOpenEncounter(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  encounterRef: string,
  opts: { readonly patientId?: string; readonly alternative?: string } = {},
): Promise<EncounterRow> {
  const row = await loadEncounter(tx, decision, encounterRef, 'FOR SHARE OF e');
  if (opts.patientId !== undefined && row.subject_patient_id !== opts.patientId) {
    throw failedAt('/encounterRef', 'encounterPatientMismatch');
  }
  if (row.state === 'closed') {
    throw conflict('encounter_closed', {
      blockingRefs: [{ kind: ENCOUNTER_RESOURCE, ref: row.id }],
      ...(opts.alternative === undefined ? {} : { alternative: opts.alternative }),
    });
  }
  return row;
}

interface PatientRow extends Record<string, unknown> {
  id: string;
  merged_into: string | null;
}

/**
 * The patient a clinical record names, locked FOR SHARE (a concurrent merge, which locks both
 * patients FOR UPDATE, serializes with it). Hidden and missing are one 404. Patient identity is
 * tenant-wide (S-D8), so there is no location filter here.
 */
export async function loadClinicalPatient(
  tx: TenantTransaction,
  patientRef: string,
  lock: 'FOR SHARE' | '' = 'FOR SHARE',
): Promise<PatientRow> {
  if (!UUID.test(patientRef)) throw notFound();
  const { rows } = await tx.query<PatientRow>(
    `SELECT id, merged_into FROM cuspatlas.patients WHERE id = $1 ${lock}`,
    [patientRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** A merged-away identity takes no new clinical facts; the survivor is named. */
export function assertNotMerged(p: PatientRow): void {
  if (p.merged_into !== null) {
    throw conflict('patient_merged', { blockingRefs: [{ kind: 'patient', ref: p.merged_into }] });
  }
}

interface AssignmentRow extends Record<string, unknown> {
  sequence: number;
  role: AssignmentRole;
  resource_id: string | null;
  resource_kind: 'provider' | 'staff' | null;
  assigned_by: string;
  assigned_by_role: ClinicalRole;
  assigned_by_credential_ref: string | null;
  assigned_at: Date;
}

async function loadAssignments(tx: TenantTransaction, encounterId: string): Promise<AssignmentRow[]> {
  const { rows } = await tx.query<AssignmentRow>(
    `SELECT a.sequence, a.role, a.resource_id, r.kind AS resource_kind, a.assigned_by, a.assigned_by_role,
       a.assigned_by_credential_ref, a.assigned_at
     FROM cuspatlas.clinical_encounter_assignments a
     LEFT JOIN cuspatlas.scheduling_resources r ON r.id = a.resource_id AND r.tenant_id = a.tenant_id
     WHERE a.encounter_id = $1 ORDER BY a.sequence`,
    [encounterId],
  );
  return rows;
}

const toAssignment = (a: AssignmentRow): EncounterAssignment => ({
  sequence: a.sequence,
  role: a.role,
  assignee:
    a.resource_id === null || a.resource_kind === null
      ? null
      : { kind: a.resource_kind, resourceRef: a.resource_id },
  assignedBy: authorOf(a.assigned_by, a.assigned_by_role, a.assigned_by_credential_ref),
  assignedAt: a.assigned_at.toISOString(),
});

/** The latest assignment of each role that is currently assigned (an unassignment clears it). */
function current(history: readonly AssignmentRow[]): AssignmentRow[] {
  const latest = new Map<AssignmentRole, AssignmentRow>();
  for (const a of history) latest.set(a.role, a);
  return [...latest.values()].filter((a) => a.resource_id !== null).sort((x, y) => x.sequence - y.sequence);
}

async function project(tx: TenantTransaction, row: EncounterRow): Promise<Encounter> {
  const history = await loadAssignments(tx, row.id);
  let appointment: Encounter['appointment'] = null;
  const flags: EncounterFlag[] = [];
  if (row.appointment_id !== null && row.appointment_status_at_open !== null) {
    const { rows } = await tx.query<{ status: EncounterAppointmentStatus; rescheduled_to_id: string | null }>(
      'SELECT status, rescheduled_to_id FROM cuspatlas.appointments WHERE id = $1',
      [row.appointment_id],
    );
    const a = rows[0];
    if (!a) throw new Error('encounter appointment is missing');
    appointment = {
      appointmentRef: row.appointment_id,
      statusAtOpen: row.appointment_status_at_open,
      currentStatus: a.status,
      rescheduledToRef: a.rescheduled_to_id,
    };
    if (row.appointment_status_at_open === 'cancelled') flags.push('appointment_cancelled_at_open');
    if (row.appointment_status_at_open === 'rescheduled') flags.push('appointment_rescheduled_at_open');
    if (a.status !== row.appointment_status_at_open) flags.push('appointment_changed_since_open');
  }
  return {
    encounterRef: row.id,
    patientRef: row.subject_patient_id,
    locationRef: row.location_ref,
    appointment,
    flags,
    state: row.state,
    assignments: current(history).map(toAssignment),
    assignmentHistory: history.map(toAssignment),
    openedBy: authorOf(row.opened_by, row.opened_by_role, row.opened_by_credential_ref),
    openedAt: row.opened_at.toISOString(),
    closure:
      row.state === 'closed' && row.closed_by && row.closed_by_role && row.disposition_code && row.closed_at
        ? {
            dispositionCode: row.disposition_code,
            closedBy: authorOf(row.closed_by, row.closed_by_role, row.closed_by_credential_ref),
            closedAt: row.closed_at.toISOString(),
          }
        : null,
    version: row.version,
  };
}

const PROVIDER_ROLES: ReadonlySet<AssignmentRole> = new Set([
  'treating_provider',
  'secondary_provider',
  'supervising_provider',
  'completing_provider',
]);

/**
 * An assignee is a scheduling resource of the right kind (provider for the provider roles, staff for
 * the staff role), active, at the encounter location. Another tenant's resource is a 404.
 */
async function checkAssignee(
  tx: TenantTransaction,
  role: AssignmentRole,
  assignee: Assignee,
  locationId: string,
  pointer: string,
): Promise<void> {
  const want = PROVIDER_ROLES.has(role) ? 'provider' : 'staff';
  if (assignee.kind !== want) throw failedAt(`${pointer}/kind`, 'kindDoesNotMatchRole');
  if (!UUID.test(assignee.resourceRef)) throw notFound();
  const { rows } = await tx.query<{ kind: string; location_id: string; status: string }>(
    'SELECT kind, location_id, status FROM cuspatlas.scheduling_resources WHERE id = $1',
    [assignee.resourceRef],
  );
  const r = rows[0];
  if (!r) throw notFound();
  if (r.kind !== assignee.kind) throw failedAt(`${pointer}/kind`, 'kindMismatch');
  if (r.location_id !== locationId) throw failedAt(pointer, 'assigneeLocationMismatch');
  if (r.status !== 'active') throw failedAt(pointer, 'assigneeInactive');
}

async function appendAssignment(
  tx: TenantTransaction,
  row: { id: string; location_id: string },
  sequence: number,
  role: AssignmentRole,
  resourceId: string | null,
  author: ClinicalAuthor,
): Promise<void> {
  await tx.query(
    `INSERT INTO cuspatlas.clinical_encounter_assignments (tenant_id, encounter_id, location_id, sequence, role,
       resource_id, assigned_by, assigned_by_role, assigned_by_credential_ref)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id(), $6, $7)`,
    [row.id, row.location_id, sequence, role, resourceId, author.role, author.credentialRef],
  );
}

type Ack = { readonly ref: string; readonly outcome?: 'opened' | 'existing' };

/** C5 commands and reads. Encounter closure never completes a plan item, posts money or records attendance. */
export function createEncounterOperations(base: ClinicalBase) {
  const { deps, execute } = base;

  const reread = async (tx: TenantTransaction, decision: AuthorizationDecision, ref: string) =>
    project(tx, await loadEncounter(tx, decision, ref));

  return {
    openEncounter(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<EncounterOpenData>> {
      const op = 'clinical.encounters.open';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<EncounterOpen>(validateEncounterOpen, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, p.patientRef);
          let appointment: { id: string; status: EncounterAppointmentStatus } | null = null;
          let location: { id: string; location_ref: string };
          if (p.appointmentRef !== undefined) {
            if (!UUID.test(p.appointmentRef)) throw notFound();
            const { rows } = await tx.query<{
              id: string;
              subject_patient_id: string;
              status: EncounterAppointmentStatus;
              location_id: string;
              location_ref: string;
            }>(
              `SELECT a.id, a.subject_patient_id, a.status, a.location_id, l.location_ref
               FROM cuspatlas.appointments a
               JOIN cuspatlas.scheduling_locations l ON l.id = a.location_id AND l.tenant_id = a.tenant_id
               WHERE a.id = $1`,
              [p.appointmentRef],
            );
            const a = rows[0];
            // Another tenant's or another location's appointment is indistinguishable from a missing one.
            if (!a) throw notFound();
            if (decision.locationRefs !== null && !decision.locationRefs.includes(a.location_ref))
              throw notFound();
            if (a.subject_patient_id !== patient.id)
              throw failedAt('/appointmentRef', 'appointmentPatientMismatch');
            if (p.locationRef !== undefined && p.locationRef !== a.location_ref) {
              throw failedAt('/locationRef', 'appointmentLocationMismatch');
            }
            appointment = { id: a.id, status: a.status };
            location = { id: a.location_id, location_ref: a.location_ref };
          } else {
            if (p.locationRef === undefined) throw failedAt('/locationRef', 'required');
            // A location named in the body is the caller's statement: a restricted member gets 403.
            assertLocation(decision.locationRefs, p.locationRef);
            const { rows } = await tx.query<{ id: string; location_ref: string }>(
              'SELECT id, location_ref FROM cuspatlas.scheduling_locations WHERE location_ref = $1',
              [p.locationRef],
            );
            const l = rows[0];
            if (!l) throw notFound();
            location = l;
          }
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, envelope, tx, async () => {
            assertNotMerged(patient);
            const assignments: readonly AssignmentInput[] = p.assignments ?? [];
            if (new Set(assignments.map((a) => a.role)).size !== assignments.length) {
              throw failedAt('/assignments', 'duplicateRole');
            }
            for (const [i, a] of assignments.entries()) {
              await checkAssignee(tx, a.role, a.assignee, location.id, `/assignments/${i}/assignee`);
            }
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.clinical_encounters (tenant_id, subject_patient_id, appointment_id,
                 appointment_status_at_open, location_id, opened_by, opened_by_role, opened_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id(), $5, $6)
               ON CONFLICT (tenant_id, appointment_id) DO NOTHING RETURNING id`,
              [
                patient.id,
                appointment?.id ?? null,
                appointment?.status ?? null,
                location.id,
                author.role,
                author.credentialRef,
              ],
            );
            const created = rows[0];
            if (!created) {
              // One encounter per visit: return the existing one; nothing from this request is applied.
              const existing = await tx.query<{ id: string; version: number }>(
                'SELECT id, version FROM cuspatlas.clinical_encounters WHERE appointment_id = $1',
                [appointment?.id],
              );
              const e = existing.rows[0];
              if (!e) throw new RefusalError({ code: 'conflict', retryable: true });
              return { data: { ref: e.id, outcome: 'existing' }, version: e.version };
            }
            for (const [i, a] of assignments.entries()) {
              await appendAssignment(
                tx,
                { id: created.id, location_id: location.id },
                i + 1,
                a.role,
                a.assignee.resourceRef,
                author,
              );
            }
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: ENCOUNTER_RESOURCE,
                resourceRef: created.id,
                resourceVersion: 1,
              },
              {
                changedFields: [
                  'patientRef',
                  'locationRef',
                  ...(appointment ? ['appointmentRef'] : []),
                  ...(assignments.length > 0 ? ['assignments'] : []),
                ],
              },
            );
            return { data: { ref: created.id, outcome: 'opened' }, version: 1 };
          });
          return {
            ...r,
            data: { outcome: r.data.outcome ?? 'opened', encounter: await reread(tx, decision, r.data.ref) },
          };
        });
      });
    },

    assignEncounterRole(
      ctx: ActorContext,
      encounterRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Encounter>> {
      const op = 'clinical.encounters.assign';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<EncounterAssign>(validateEncounterAssign, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadEncounter(tx, decision, encounterRef, 'FOR UPDATE OF e');
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { encounterRef, ...p } },
            tx,
            async () => {
              if (row.state === 'closed') {
                throw conflict('encounter_closed', {
                  blockingRefs: [{ kind: ENCOUNTER_RESOURCE, ref: row.id }],
                });
              }
              if (row.version !== p.expectedVersion) {
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: row.version } });
              }
              const history = await loadAssignments(tx, row.id);
              if (history.length >= MAX_ASSIGNMENTS) throw failedAt('/', 'tooManyAssignments');
              const now = [...history].reverse().find((a) => a.role === p.role);
              const currentRef = now?.resource_id ?? null;
              if (p.assignee === null && currentRef === null) throw failedAt('/assignee', 'notAssigned');
              if (p.assignee !== null) {
                if (p.assignee.resourceRef === currentRef) throw failedAt('/assignee', 'unchanged');
                await checkAssignee(tx, p.role, p.assignee, row.location_id, '/assignee');
              }
              await appendAssignment(
                tx,
                row,
                history.length + 1,
                p.role,
                p.assignee?.resourceRef ?? null,
                author,
              );
              const { rows } = await tx.query<{ version: number }>(
                `UPDATE cuspatlas.clinical_encounters SET version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING version`,
                [row.id],
              );
              const version = rows[0]?.version;
              if (version === undefined) throw new Error('update returned no row');
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: ENCOUNTER_RESOURCE,
                  resourceRef: row.id,
                  resourceVersion: version,
                },
                { changedFields: ['assignments'] },
              );
              return { data: { ref: row.id }, version };
            },
          );
          return { ...r, data: await reread(tx, decision, r.data.ref) };
        });
      });
    },

    closeEncounter(
      ctx: ActorContext,
      encounterRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Encounter>> {
      const op = 'clinical.encounters.close';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<EncounterClose>(validateEncounterClose, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadEncounter(tx, decision, encounterRef, 'FOR UPDATE OF e');
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { encounterRef, ...p } },
            tx,
            async () => {
              if (row.state === 'closed') {
                throw conflict('encounter_closed', {
                  blockingRefs: [{ kind: ENCOUNTER_RESOURCE, ref: row.id }],
                });
              }
              if (row.version !== p.expectedVersion) {
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: row.version } });
              }
              const configured = await tx.query(
                'SELECT 1 FROM cuspatlas.clinical_encounter_dispositions WHERE disposition_code = $1',
                [p.dispositionCode],
              );
              if (configured.rowCount === 0) throw failedAt('/dispositionCode', 'notConfigured');
              const { rows } = await tx.query<{ version: number }>(
                `UPDATE cuspatlas.clinical_encounters SET state = 'closed', disposition_code = $2,
                 closed_by = cuspatlas.current_actor_id(), closed_by_role = $3, closed_by_credential_ref = $4,
                 closed_at = now(), version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING version`,
                [row.id, p.dispositionCode, author.role, author.credentialRef],
              );
              const version = rows[0]?.version;
              if (version === undefined) throw new Error('update returned no row');
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: ENCOUNTER_RESOURCE,
                  resourceRef: row.id,
                  resourceVersion: version,
                },
                { changedFields: ['state', 'dispositionCode', 'closedBy'] },
              );
              return { data: { ref: row.id }, version };
            },
          );
          return { ...r, data: await reread(tx, decision, r.data.ref) };
        });
      });
    },

    /** One encounter; a sensitive read (logged with the reference only). */
    readEncounter(ctx: ActorContext, encounterRef: string): Promise<Encounter> {
      const op = 'clinical.encounters.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const encounter = await project(tx, await loadEncounter(tx, decision, encounterRef));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: ENCOUNTER_RESOURCE,
            resourceRefs: [encounter.encounterRef],
            queryFields: [],
          });
          return encounter;
        });
      });
    },

    /** A patient's encounters (newest identifiers last, keyset pages), filtered to visible locations. */
    listEncounters(ctx: ActorContext, patientRef: string, query: unknown): Promise<EncounterPage> {
      const op = 'clinical.encounters.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid<EncounterListQuery>(validateEncounterListQuery, query, CLINICAL_PROPERTIES);
        const after = query.cursor === undefined ? null : base.cursors.decode(ctx.tenantId, query.cursor);
        const limit = limitOf(query.limit);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, patientRef, '');
          const { rows } = await tx.query<EncounterRow>(
            `SELECT ${ENCOUNTER_COLUMNS} FROM cuspatlas.clinical_encounters e
             JOIN cuspatlas.scheduling_locations l ON l.id = e.location_id AND l.tenant_id = e.tenant_id
             WHERE e.subject_patient_id = $1 AND ($2::uuid IS NULL OR e.id > $2)
               AND ($3::text[] IS NULL OR l.location_ref = ANY ($3::text[]))
             ORDER BY e.id LIMIT $4`,
            [patient.id, after, decision.locationRefs, limit + 1],
          );
          const page = rows.slice(0, limit);
          const data: Encounter[] = [];
          for (const row of page) data.push(await project(tx, row));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: ENCOUNTER_RESOURCE,
            resourceRefs: data.map((e) => e.encounterRef),
            queryFields: ['patientRef', ...(query.cursor === undefined ? [] : ['cursor'])],
          });
          const last = page.at(-1);
          return {
            data,
            nextCursor: rows.length > limit && last ? base.cursors.encode(ctx.tenantId, last.id) : null,
          };
        });
      });
    },
  };
}

export type EncounterOperations = ReturnType<typeof createEncounterOperations>;
