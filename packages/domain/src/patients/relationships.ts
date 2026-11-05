import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  PATIENT_PROPERTIES,
  type PatientAccess,
  RefusalError,
  type Relationship,
  type RelationshipCreate,
  type RelationshipKind,
  type RelationshipRevoke,
  type RelationshipScope,
  type TenantTransaction,
  validatePatientAccessQuery,
  validatePatientRef,
  validateRelationshipCreate,
  validateRelationshipListQuery,
  validateRelationshipRef,
  validateRelationshipRevoke,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import {
  evaluatePatientAccess,
  loadPatientPolicy,
  majorityInstant,
  RELATIONSHIP_SELECT,
  type RelationshipRow,
  relationshipView,
} from '../policy/patient-access';
import { checkEnvelope, loadPatient } from './identity';
import { conflict, invalid, notFound } from './model';
import type { PatientServiceContext } from './service-context';

export const RELATIONSHIP_RESOURCE = 'patientRelationship';
const DAY_MS = 86_400_000;

/** Scopes each kind may carry (ADR 0003 Q12, pending approval). */
const ALLOWED_SCOPES: Record<RelationshipKind, readonly RelationshipScope[]> = {
  guardian: ['demographics', 'scheduling', 'clinical_read', 'financial', 'consent'],
  proxy: ['demographics', 'scheduling', 'clinical_read', 'financial', 'consent'],
  guarantor: ['financial'],
  dependent: [],
};

type Ack = { readonly ref: string; readonly view?: Relationship };

export async function loadRelationship(
  tx: TenantTransaction,
  relationshipRef: string,
  lock = false,
): Promise<RelationshipRow> {
  if (!validateRelationshipRef(relationshipRef)) throw notFound();
  const { rows } = await tx.query<RelationshipRow>(
    `${RELATIONSHIP_SELECT} WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`,
    [relationshipRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** Stateless rules for a new relationship (422 before any record is read), at the database clock `now`. */
function checkCreate(
  subjectRef: string,
  p: RelationshipCreate,
  now: number,
): { from: Date; until: Date | null } {
  if (p.counterpartyRef === subjectRef) throw invalid('self_relationship');
  if (!p.scopes.every((s) => ALLOWED_SCOPES[p.kind].includes(s))) throw invalid('scope_not_allowed_for_kind');
  if ((p.kind === 'guardian' || p.kind === 'proxy') && p.scopes.length === 0) throw invalid('scope_required');
  const from = p.effectiveFrom === undefined ? new Date(now) : new Date(p.effectiveFrom);
  const until = p.effectiveUntil === undefined ? null : new Date(p.effectiveUntil);
  if (Number.isNaN(from.getTime()) || (until !== null && Number.isNaN(until.getTime()))) {
    throw invalid('window_invalid');
  }
  if (p.kind === 'proxy' && until === null) throw invalid('proxy_requires_end');
  if (until !== null && until.getTime() <= now) throw invalid('window_already_ended');
  if (until !== null && until.getTime() <= from.getTime()) throw invalid('window_invalid');
  return { from, until };
}

/** Relationship commands and queries (S5). */
export function createRelationshipCommands(s: PatientServiceContext) {
  const { deps, execute, guarded } = s;

  async function viewOf(
    tx: TenantTransaction,
    result: CommandResult<Ack>,
  ): Promise<CommandResult<Relationship>> {
    const view =
      result.data.view ??
      relationshipView(await loadRelationship(tx, result.data.ref), await loadPatientPolicy(tx));
    return { ...result, data: view };
  }

  return {
    addRelationship(
      ctx: ActorContext,
      patientRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Relationship>> {
      return guarded(ctx, 'patients.relationships.add', async () => {
        await deps.authorize(ctx, 'patients.relationships.add', { tenantId: ctx.tenantId, id: patientRef });
        checkEnvelope(envelope, 'patients.relationships.add');
        const payload = envelope.payload;
        assertValid<RelationshipCreate>(validateRelationshipCreate, payload, PATIENT_PROPERTIES);
        if (!validatePatientRef(patientRef)) throw notFound();
        return deps.withTenantTransaction(ctx, async (tx) => {
          // The default start and the "already ended" check use the database clock that evaluates
          // the relationship (clock audit): an application instant ahead of it left a new grant pending.
          const window = checkCreate(patientRef, payload, await dbNow(tx));
          // Lock both patients in id order (FOR UPDATE): serializes exclusivity checks for the subject,
          // and an A->B add never deadlocks with a concurrent B->A add. Another tenant's (or a missing)
          // counterparty is hidden exactly like a missing one and nothing is written.
          const [first, second] = [patientRef, payload.counterpartyRef].sort();
          const locked = new Map<string, Awaited<ReturnType<typeof loadPatient>>>();
          for (const id of first === second ? [first as string] : [first as string, second as string]) {
            locked.set(id, await loadPatient(tx, id, 'FOR UPDATE'));
          }
          const subject = locked.get(patientRef) as Awaited<ReturnType<typeof loadPatient>>;
          const counterparty = locked.get(payload.counterpartyRef) as Awaited<ReturnType<typeof loadPatient>>;
          return viewOf(
            tx,
            await execute<Ack>(ctx, { ...envelope, payload: { patientRef, ...payload } }, tx, async () => {
              if (subject.merged_into !== null || counterparty.merged_into !== null)
                throw conflict('patient_merged');
              if (subject.status === 'deceased') throw conflict('patient_deceased');
              const policy = await loadPatientPolicy(tx);
              if (payload.kind === 'proxy' && window.until !== null) {
                if (window.until.getTime() - window.from.getTime() > policy.proxyMaxDays * DAY_MS) {
                  throw invalid('proxy_window_too_long');
                }
              }
              if (payload.kind === 'guardian') {
                const birth = subject.birth_date_text;
                const majority = majorityInstant(
                  birth,
                  subject.birth_date_precision,
                  policy.ageOfMajorityYears,
                );
                if (majority === null && window.until === null)
                  throw invalid('guardian_requires_birth_date_or_end');
                if (majority !== null && majority.getTime() <= (await dbNow(tx)))
                  throw invalid('subject_reached_majority');
              }
              const existing = await tx.query<{ id: string; kind: string; counterparty_patient_id: string }>(
                `SELECT id, kind, counterparty_patient_id FROM cuspatlas.patient_relationships
                 WHERE subject_patient_id = $1 AND revoked_at IS NULL AND (kind = 'guarantor' OR counterparty_patient_id = $2)`,
                [patientRef, payload.counterpartyRef],
              );
              const same = existing.rows.find(
                (r) => r.kind === payload.kind && r.counterparty_patient_id === payload.counterpartyRef,
              );
              if (same)
                throw conflict('relationship_exists', [{ kind: RELATIONSHIP_RESOURCE, ref: same.id }]);
              const guarantor = existing.rows.find((r) => r.kind === 'guarantor');
              if (payload.kind === 'guarantor' && guarantor) {
                throw conflict('exclusive_guarantor_exists', [
                  { kind: RELATIONSHIP_RESOURCE, ref: guarantor.id },
                ]);
              }
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.patient_relationships (tenant_id, subject_patient_id, counterparty_patient_id,
                   kind, scopes, effective_from, effective_until, evidence_ref, created_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4::text[], $5, $6, $7, cuspatlas.current_actor_id())
                 RETURNING id`,
                [
                  patientRef,
                  payload.counterpartyRef,
                  payload.kind,
                  [...payload.scopes],
                  window.from,
                  window.until,
                  payload.evidenceRef ?? null,
                ],
              );
              const id = rows[0]?.id;
              if (!id) throw new Error('insert returned no row');
              await recordCommand(
                tx,
                {
                  operation: 'patients.relationships.add',
                  resourceType: RELATIONSHIP_RESOURCE,
                  resourceRef: id,
                  resourceVersion: 1,
                },
                {
                  changedFields: [
                    'subjectRef',
                    'counterpartyRef',
                    'kind',
                    'scopes',
                    'effectiveFrom',
                    'effectiveUntil',
                  ],
                },
              );
              const view = relationshipView(await loadRelationship(tx, id), policy);
              return { data: { ref: id, view }, version: 1 };
            }),
          );
        });
      });
    },

    revokeRelationship(
      ctx: ActorContext,
      patientRef: string,
      relationshipRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Relationship>> {
      return guarded(ctx, 'patients.relationships.revoke', async () => {
        await deps.authorize(ctx, 'patients.relationships.revoke', {
          tenantId: ctx.tenantId,
          id: relationshipRef,
        });
        checkEnvelope(envelope, 'patients.relationships.revoke');
        const payload = envelope.payload;
        assertValid<RelationshipRevoke>(validateRelationshipRevoke, payload, PATIENT_PROPERTIES);
        if (!validatePatientRef(patientRef) || !validateRelationshipRef(relationshipRef)) throw notFound();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const current = await loadRelationship(tx, relationshipRef, true);
          if (current.subject_patient_id !== patientRef) throw notFound();
          return viewOf(
            tx,
            await execute<Ack>(
              ctx,
              {
                ...envelope,
                expectedVersion: payload.expectedVersion,
                payload: { patientRef, relationshipRef, ...payload },
              },
              tx,
              async () => {
                if (current.version !== payload.expectedVersion) {
                  throw new RefusalError({
                    code: 'stale_version',
                    detail: { currentVersion: current.version },
                  });
                }
                if (current.revoked_at !== null) throw conflict('relationship_already_revoked');
                // Revocation sets an end instant (now, server clock) and never deletes the row.
                const { rows } = await tx.query<{ version: number }>(
                  `UPDATE cuspatlas.patient_relationships SET revoked_at = now(), revoked_by = cuspatlas.current_actor_id(),
                     revoke_reason = $1, version = version + 1, updated_at = now()
                   WHERE id = $2 AND version = $3 RETURNING version`,
                  [payload.reasonCode, relationshipRef, payload.expectedVersion],
                );
                const version = rows[0]?.version;
                if (version === undefined) throw new RefusalError({ code: 'stale_version' });
                await recordCommand(
                  tx,
                  {
                    operation: 'patients.relationships.revoke',
                    resourceType: RELATIONSHIP_RESOURCE,
                    resourceRef: relationshipRef,
                    resourceVersion: version,
                  },
                  { changedFields: ['revokedAt', 'revokeReason'] },
                );
                const view = relationshipView(
                  await loadRelationship(tx, relationshipRef),
                  await loadPatientPolicy(tx),
                );
                return { data: { ref: relationshipRef, view }, version };
              },
            ),
          );
        });
      });
    },

    listRelationships(
      ctx: ActorContext,
      patientRef: string,
      query: unknown = {},
    ): Promise<{ data: Relationship[] }> {
      return guarded(ctx, 'patients.relationships.list', async () => {
        await deps.authorize(ctx, 'patients.relationships.list', { tenantId: ctx.tenantId, id: patientRef });
        assertValid<Record<string, never>>(validateRelationshipListQuery, query, PATIENT_PROPERTIES);
        if (!validatePatientRef(patientRef)) throw notFound();
        return deps.withTenantTransaction(ctx, async (tx) => {
          await loadPatient(tx, patientRef);
          const policy = await loadPatientPolicy(tx);
          // Both directions: relationships about this patient and those it holds towards others.
          const { rows } = await tx.query<RelationshipRow>(
            `${RELATIONSHIP_SELECT} WHERE r.subject_patient_id = $1 OR r.counterparty_patient_id = $1
             ORDER BY r.created_at, r.id LIMIT 100`,
            [patientRef],
          );
          const data = rows.map((r) => relationshipView(r, policy));
          await recordSensitiveRead(tx, {
            operation: 'patients.relationships.list',
            resourceType: RELATIONSHIP_RESOURCE,
            resourceRefs: data.map((d) => d.relationshipRef),
            queryFields: [],
          });
          return { data };
        });
      });
    },

    resolvePatientAccess(
      ctx: ActorContext,
      patientRef: string,
      query: unknown,
    ): Promise<{ data: PatientAccess }> {
      return guarded(ctx, 'patients.access.resolve', async () => {
        await deps.authorize(ctx, 'patients.access.resolve', { tenantId: ctx.tenantId, id: patientRef });
        assertValid<{ counterpartyRef: string }>(validatePatientAccessQuery, query, PATIENT_PROPERTIES);
        if (!validatePatientRef(patientRef)) throw notFound();
        return deps.withTenantTransaction(ctx, async (tx) => {
          await loadPatient(tx, patientRef);
          const data = await evaluatePatientAccess(tx, patientRef, query.counterpartyRef);
          await recordSensitiveRead(tx, {
            operation: 'patients.access.resolve',
            resourceType: RELATIONSHIP_RESOURCE,
            resourceRefs: data.relationships.map((r) => r.relationshipRef),
            queryFields: ['counterpartyRef'],
          });
          return { data };
        });
      });
    },
  };
}

/** The database clock at this statement (review hardening: one clock for age-of-majority checks). */
async function dbNow(tx: TenantTransaction): Promise<number> {
  const { rows } = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const now = rows[0]?.now;
  if (now === undefined) throw new Error('clock_timestamp() returned no row');
  return now.getTime();
}
