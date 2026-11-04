import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  PATIENT_PROPERTIES,
  type Patient,
  type PatientCreate,
  type PatientDemographicsUpdate,
  type PatientReadQuery,
  type PatientSearch,
  type PatientStatusChange,
  type PatientSummary,
  type PatientSummaryPage,
  RefusalError,
  type TenantTransaction,
  validatePatientCreate,
  validatePatientDemographicsUpdate,
  validatePatientIdempotencyKey,
  validatePatientReadQuery,
  validatePatientRef,
  validatePatientSearch,
  validatePatientStatusChange,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { assertLocation } from '../policy/authorize';
import { requireRelationshipScope } from '../policy/patient-access';
import {
  applyUpdate,
  checkIdentityInput,
  conflict,
  groupsIn,
  identityParams,
  invalid,
  likePrefix,
  normalizeText,
  notFound,
  PATIENT_COLUMNS,
  PATIENT_WRITE_COLUMNS,
  type PatientRow,
  phoneKey,
  recordFromCreate,
  recordOf,
  toPatient,
  toSummary,
} from './model';
import type { PatientServiceContext } from './service-context';

export const PATIENT_RESOURCE = 'patient';
const DEFAULT_LIMIT = 25;
/** Allowed clock skew for an effective instant stated by the caller. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

type Ack = { readonly ref: string; readonly summary?: PatientSummary };

export function checkEnvelope(envelope: CommandEnvelope<unknown>, operation: string): void {
  if (envelope.operation !== operation) throw new RefusalError({ code: 'invalid_request' });
  assertValid(validatePatientIdempotencyKey, envelope.idempotencyKey, PATIENT_PROPERTIES);
}

/** Reads one live patient row inside a tenant transaction. Malformed refs are hidden like missing ones. */
export async function loadPatient(
  tx: TenantTransaction,
  patientRef: string,
  lock: '' | 'FOR UPDATE' | 'FOR SHARE' = '',
): Promise<PatientRow> {
  if (!validatePatientRef(patientRef)) throw notFound();
  const { rows } = await tx.query<PatientRow>(
    `SELECT ${PATIENT_COLUMNS} FROM cuspatlas.patients WHERE id = $1 ${lock}`,
    [patientRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * Guard for consumers that create requests or bookings (S8, S10): the patient must exist in the
 * current tenant, must not be merged, and must be active. The refusal names the state.
 */
export async function assertPatientSchedulable(tx: TenantTransaction, patientRef: string): Promise<void> {
  const row = await loadPatient(tx, patientRef, 'FOR SHARE');
  if (row.merged_into !== null) throw conflict('patient_merged');
  if (row.status === 'deceased') throw conflict('patient_deceased');
  if (row.status === 'inactive') throw conflict('patient_inactive');
}

function assertNotMerged(row: PatientRow): void {
  if (row.merged_into !== null) throw conflict('patient_merged');
}

const SET_IDENTITY = PATIENT_WRITE_COLUMNS.map((c, i) => `${c} = $${i + 1}${cast(c)}`).join(', ');
function cast(column: string): string {
  if (
    [
      'legal_name',
      'preferred_name',
      'pronouns',
      'language',
      'contact',
      'address',
      'identifiers',
      'provenance',
    ].includes(column)
  ) {
    return '::jsonb';
  }
  if (column === 'birth_date') return '::date';
  if (column === 'match_keys') return '::text[]';
  return '';
}

/** Patient identity commands and queries (S4). REST, MCP and workers call these; none takes a tenant. */
export function createIdentityCommands(s: PatientServiceContext) {
  const { deps, execute, cursors, guarded } = s;

  async function summaryOf(
    tx: TenantTransaction,
    result: CommandResult<Ack>,
  ): Promise<CommandResult<PatientSummary>> {
    // A replay re-reads the projection; the idempotency row stores the reference only.
    const summary = result.data.summary ?? toSummary(await loadPatient(tx, result.data.ref));
    return { ...result, data: summary };
  }

  return {
    createPatient(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PatientSummary>> {
      return guarded(ctx, 'patients.create', async () => {
        const decision = await deps.authorize(ctx, 'patients.create', { tenantId: ctx.tenantId, id: 'new' });
        checkEnvelope(envelope, 'patients.create');
        const payload = envelope.payload;
        assertValid<PatientCreate>(validatePatientCreate, payload, PATIENT_PROPERTIES);
        // Identity is tenant-wide (S-D8); a restricted member may only name its own locations.
        assertLocation(decision.locationRefs, payload.homeLocationRef ?? null);
        checkIdentityInput(payload);
        const record = recordFromCreate(payload);
        return deps.withTenantTransaction(ctx, async (tx) =>
          summaryOf(
            tx,
            await execute<Ack>(ctx, envelope, tx, async () => {
              const params = identityParams(record, s.keyer(tx.ctx.tenantId));
              const { rows } = await tx.query<PatientRow>(
                `INSERT INTO cuspatlas.patients (tenant_id, ${PATIENT_WRITE_COLUMNS.join(', ')}, status,
                   status_effective_at, created_by)
                 VALUES (cuspatlas.current_tenant_id(), ${PATIENT_WRITE_COLUMNS.map((c, i) => `$${i + 1}${cast(c)}`).join(', ')},
                   'active', now(), cuspatlas.current_actor_id())
                 RETURNING ${PATIENT_COLUMNS}`,
                params,
              );
              const row = rows[0];
              if (!row) throw new Error('insert returned no row');
              await tx.query(
                `INSERT INTO cuspatlas.patient_status_history (tenant_id, patient_id, status, effective_at,
                   reason_code, patient_version, recorded_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, 'active', $2, 'registered', 1, cuspatlas.current_actor_id())`,
                [row.id, row.status_effective_at],
              );
              await recordCommand(
                tx,
                {
                  operation: 'patients.create',
                  resourceType: PATIENT_RESOURCE,
                  resourceRef: row.id,
                  resourceVersion: 1,
                },
                { changedFields: [...groupsIn(payload), 'status'] },
              );
              return { data: { ref: row.id, summary: toSummary(row) }, version: row.version };
            }),
          ),
        );
      });
    },

    updatePatientDemographics(
      ctx: ActorContext,
      patientRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PatientSummary>> {
      return guarded(ctx, 'patients.updateDemographics', async () => {
        const decision = await deps.authorize(ctx, 'patients.updateDemographics', {
          tenantId: ctx.tenantId,
          id: patientRef,
        });
        checkEnvelope(envelope, 'patients.updateDemographics');
        const payload = envelope.payload;
        assertValid<PatientDemographicsUpdate>(
          validatePatientDemographicsUpdate,
          payload,
          PATIENT_PROPERTIES,
        );
        if (!validatePatientRef(patientRef)) throw notFound();
        if (payload.homeLocationRef !== undefined)
          assertLocation(decision.locationRefs, payload.homeLocationRef);
        const groups = [
          ...groupsIn(payload),
          ...(payload.timeZone === undefined ? [] : ['timeZone']),
          ...(payload.homeLocationRef === undefined ? [] : ['homeLocationRef']),
        ];
        if (groups.length === 0) throw invalid('no_field_group');
        checkIdentityInput(payload);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const current = await loadPatient(tx, patientRef, 'FOR UPDATE');
          // S5: acting for a related person is authorization, rechecked fresh before the executor so a
          // replay after revocation is denied too.
          if (payload.requestedBy !== undefined) {
            await requireRelationshipScope(tx, patientRef, payload.requestedBy, 'demographics');
          }
          return summaryOf(
            tx,
            await execute<Ack>(
              ctx,
              { ...envelope, expectedVersion: payload.expectedVersion, payload: { patientRef, ...payload } },
              tx,
              async () => {
                if (current.version !== payload.expectedVersion) {
                  throw new RefusalError({
                    code: 'stale_version',
                    detail: { currentVersion: current.version },
                  });
                }
                assertNotMerged(current);
                const next = applyUpdate(
                  recordOf(current),
                  payload,
                  payload.requestedBy === undefined ? 'staff_entry' : 'guardian_reported',
                );
                const params = identityParams(next, s.keyer(tx.ctx.tenantId));
                const n = PATIENT_WRITE_COLUMNS.length;
                const { rows } = await tx.query<PatientRow>(
                  `UPDATE cuspatlas.patients SET ${SET_IDENTITY}, version = version + 1, updated_at = now()
                   WHERE id = $${n + 1} AND version = $${n + 2} RETURNING ${PATIENT_COLUMNS}`,
                  [...params, patientRef, payload.expectedVersion],
                );
                const row = rows[0];
                if (!row) throw new RefusalError({ code: 'stale_version' });
                await recordCommand(
                  tx,
                  {
                    operation: 'patients.updateDemographics',
                    resourceType: PATIENT_RESOURCE,
                    resourceRef: row.id,
                    resourceVersion: row.version,
                  },
                  { changedFields: groups },
                );
                return { data: { ref: row.id, summary: toSummary(row) }, version: row.version };
              },
            ),
          );
        });
      });
    },

    setPatientStatus(
      ctx: ActorContext,
      patientRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PatientSummary>> {
      return guarded(ctx, 'patients.setStatus', async () => {
        await deps.authorize(ctx, 'patients.setStatus', { tenantId: ctx.tenantId, id: patientRef });
        checkEnvelope(envelope, 'patients.setStatus');
        const payload = envelope.payload;
        assertValid<PatientStatusChange>(validatePatientStatusChange, payload, PATIENT_PROPERTIES);
        if (!validatePatientRef(patientRef)) throw notFound();
        const effectiveAt = new Date(payload.effectiveAt);
        if (Number.isNaN(effectiveAt.getTime())) throw invalid('effective_at_invalid');
        if (effectiveAt.getTime() > Date.now() + FUTURE_SKEW_MS) throw invalid('effective_at_in_future');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const current = await loadPatient(tx, patientRef, 'FOR UPDATE');
          return summaryOf(
            tx,
            await execute<Ack>(
              ctx,
              { ...envelope, expectedVersion: payload.expectedVersion, payload: { patientRef, ...payload } },
              tx,
              async () => {
                if (current.version !== payload.expectedVersion) {
                  throw new RefusalError({
                    code: 'stale_version',
                    detail: { currentVersion: current.version },
                  });
                }
                assertNotMerged(current);
                if (current.status === payload.status) throw conflict('status_unchanged');
                // Leaving "deceased" is a correction of an error, never an ordinary transition.
                if (current.status === 'deceased' && payload.reasonCode !== 'entered_in_error') {
                  throw conflict('status_transition_denied');
                }
                const { rows } = await tx.query<PatientRow>(
                  `UPDATE cuspatlas.patients SET status = $1, status_effective_at = $2, version = version + 1,
                     updated_at = now()
                   WHERE id = $3 AND version = $4 RETURNING ${PATIENT_COLUMNS}`,
                  [payload.status, effectiveAt, patientRef, payload.expectedVersion],
                );
                const row = rows[0];
                if (!row) throw new RefusalError({ code: 'stale_version' });
                await tx.query(
                  `INSERT INTO cuspatlas.patient_status_history (tenant_id, patient_id, status, effective_at,
                     reason_code, patient_version, recorded_by)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id())`,
                  [row.id, payload.status, effectiveAt, payload.reasonCode, row.version],
                );
                await recordCommand(
                  tx,
                  {
                    operation: 'patients.setStatus',
                    resourceType: PATIENT_RESOURCE,
                    resourceRef: row.id,
                    resourceVersion: row.version,
                  },
                  { changedFields: ['status', 'statusEffectiveAt'] },
                );
                return { data: { ref: row.id, summary: toSummary(row) }, version: row.version };
              },
            ),
          );
        });
      });
    },

    readPatient(ctx: ActorContext, patientRef: string, query: unknown = {}): Promise<Patient> {
      return guarded(ctx, 'patients.read', async () => {
        await deps.authorize(ctx, 'patients.read', { tenantId: ctx.tenantId, id: patientRef });
        assertValid<PatientReadQuery>(validatePatientReadQuery, query, PATIENT_PROPERTIES);
        if (!validatePatientRef(patientRef)) throw notFound();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadPatient(tx, patientRef);
          // A merged record is reachable only through its merge history (S6).
          assertNotMerged(row);
          if (query.requestedBy !== undefined) {
            await requireRelationshipScope(tx, patientRef, query.requestedBy, 'demographics');
          }
          await recordSensitiveRead(tx, {
            operation: 'patients.read',
            resourceType: PATIENT_RESOURCE,
            resourceRefs: [row.id],
            queryFields: Object.keys(query as object),
          });
          return toPatient(row);
        });
      });
    },

    searchPatients(ctx: ActorContext, query: unknown): Promise<PatientSummaryPage> {
      return guarded(ctx, 'patients.search', async () => {
        await deps.authorize(ctx, 'patients.search', { tenantId: ctx.tenantId, id: 'search' });
        assertValid<PatientSearch>(validatePatientSearch, query, PATIENT_PROPERTIES);
        const limit = query.limit ?? DEFAULT_LIMIT;
        const after = query.cursor === undefined ? null : cursors.decode(ctx.tenantId, query.cursor);
        const name = query.name === undefined ? null : normalizeText(query.name);
        if (name !== null && name.length < 2) throw new RefusalError({ code: 'invalid_request' });
        const phone = query.phone === undefined ? null : phoneKey(query.phone, s.keyer(ctx.tenantId));
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<PatientRow>(
            `SELECT ${PATIENT_COLUMNS} FROM cuspatlas.patients
             WHERE merged_into IS NULL
               AND ($1::uuid IS NULL OR id > $1::uuid)
               AND ($2::text IS NULL OR search_family LIKE $2 ESCAPE '!' OR search_given LIKE $2 ESCAPE '!'
                 OR (search_given || ' ' || search_family) LIKE $2 ESCAPE '!'
                 OR (search_family || ' ' || search_given) LIKE $2 ESCAPE '!')
               AND ($3::date IS NULL OR (birth_date = $3::date AND birth_date_precision = 'day'))
               AND ($4::text IS NULL OR match_keys @> ARRAY[$4::text])
               AND ($5::text IS NULL OR status = $5)
             ORDER BY id LIMIT $6`,
            [
              after,
              name === null ? null : likePrefix(name),
              query.birthDate ?? null,
              phone,
              query.status ?? null,
              limit + 1,
            ],
          );
          const page = rows.slice(0, limit).map(toSummary);
          await recordSensitiveRead(tx, {
            operation: 'patients.search',
            resourceType: PATIENT_RESOURCE,
            resourceRefs: page.map((p) => p.patientRef),
            queryFields: (['name', 'birthDate', 'phone', 'status'] as const).filter(
              (k) => query[k] !== undefined,
            ),
          });
          const last = page[page.length - 1];
          return {
            data: page,
            nextCursor: rows.length > limit && last ? cursors.encode(ctx.tenantId, last.patientRef) : null,
          };
        });
      });
    },
  };
}
