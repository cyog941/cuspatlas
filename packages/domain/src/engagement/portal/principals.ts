import { randomUUID } from 'node:crypto';
import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  ENGAGEMENT_PROPERTIES,
  PORTAL_PROOFING_LEVEL,
  type PortalEnroll,
  type PortalGrant,
  type PortalPrincipalRecord,
  type PortalRevoke,
  type PortalVerify,
  RefusalError,
  type TenantTransaction,
  validateEmptyQuery,
  validatePortalEnroll,
  validatePortalRevoke,
  validatePortalVerify,
} from '@cuspatlas/contracts';
import { executeOnce } from '../../commands/execute-once';
import { recordCommand } from '../../events/record-command';
import { createMatchKeyer, MATCH_KEY, phoneKey } from '../../patients/model';
import {
  loadPatientPolicy,
  RELATIONSHIP_SELECT,
  type RelationshipRow,
  relationshipView,
} from '../../policy/patient-access';
import { assertRef, checkEnvelope, conflict, type EngagementBase, failedAt, notFound } from '../common';

export const PORTAL_PRINCIPAL_RESOURCE = 'portalPrincipal';

interface PrincipalRow extends Record<string, unknown> {
  principal_id: string;
  person_patient_id: string;
  state: PortalPrincipalRecord['state'];
  proofing_level: string;
  contact_channel: 'email' | 'phone';
  verified_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  version: number;
  created_at: Date;
}
const PRINCIPAL_COLUMNS = `principal_id, person_patient_id, state, proofing_level, contact_channel, verified_at,
  revoked_at, revoke_reason, version, created_at`;

const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const record = (r: PrincipalRow): PortalPrincipalRecord => ({
  principalRef: r.principal_id,
  personRef: r.person_patient_id,
  state: r.state,
  proofingLevel: r.proofing_level,
  contactChannel: r.contact_channel,
  verifiedAt: iso(r.verified_at),
  revokedAt: iso(r.revoked_at),
  revokeReason: r.revoke_reason,
  version: r.version,
  createdAt: r.created_at.toISOString(),
});

/** S5 relationship rows projected as portal grants (grantRef = relationshipRef). */
export async function projectGrants(
  tx: TenantTransaction,
  where: 'subject' | 'counterparty',
  patientRef: string,
): Promise<PortalGrant[]> {
  const policy = await loadPatientPolicy(tx);
  const column = where === 'subject' ? 'r.subject_patient_id' : 'r.counterparty_patient_id';
  const { rows } = await tx.query<RelationshipRow>(
    `${RELATIONSHIP_SELECT} WHERE ${column} = $1 ORDER BY r.created_at, r.id LIMIT 100`,
    [patientRef],
  );
  return rows.map((row) => {
    const v = relationshipView(row, policy);
    return {
      grantRef: v.relationshipRef,
      relationshipRef: v.relationshipRef,
      patientRef: v.subjectRef,
      granteeRef: v.counterpartyRef,
      kind: v.kind,
      scope: v.scopes,
      effectiveFrom: v.effectiveFrom,
      effectiveUntil: v.effectiveEnd,
      revokedAt: v.revokedAt,
      status: v.status,
      statusReason: v.statusReason,
      projectedAt: row.evaluated_at.toISOString(),
    };
  });
}

/**
 * E1 staff commands: enroll, verify and revoke a portal principal, read it, and list the portal
 * grants (S5 projection) of a patient. Invitations and grant revocation are S5's own
 * `patients.relationships.add` / `.revoke`; this module adds no second grant command.
 */
export function createPortalPrincipalOperations(base: EngagementBase) {
  const { deps } = base;
  const execute = deps.execute ?? executeOnce;
  createMatchKeyer(deps.matchKeyPepper, '00000000-0000-4000-8000-000000000000');

  async function loadPrincipal(tx: TenantTransaction, ref: string, lock = false): Promise<PrincipalRow> {
    assertRef(ref);
    const { rows } = await tx.query<PrincipalRow>(
      `SELECT ${PRINCIPAL_COLUMNS} FROM cuspatlas.portal_principals WHERE principal_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [ref],
    );
    const row = rows[0];
    if (!row) throw notFound();
    return row;
  }

  async function transition(
    ctx: ActorContext,
    op: 'portal.principals.verify' | 'portal.principals.revoke',
    principalRef: string,
    envelope: CommandEnvelope<unknown>,
    apply: (tx: TenantTransaction, row: PrincipalRow) => Promise<{ state: string; version: number }>,
  ) {
    return base.guarded(ctx, op, async () => {
      await base.authorize(ctx, op);
      checkEnvelope(envelope, op);
      if (op === 'portal.principals.verify')
        assertValid<PortalVerify>(validatePortalVerify, envelope.payload, ENGAGEMENT_PROPERTIES);
      else assertValid<PortalRevoke>(validatePortalRevoke, envelope.payload, ENGAGEMENT_PROPERTIES);
      const p = envelope.payload as { expectedVersion: number };
      return deps.withTenantTransaction(ctx, async (tx) => {
        const row = await loadPrincipal(tx, principalRef, true);
        return execute<{ principalRef: string; state: string }>(
          ctx,
          { ...envelope, payload: { principalRef, ...(envelope.payload as object) } },
          tx,
          async () => {
            if (row.state === 'revoked') throw conflict('portal_principal_revoked');
            if (row.version !== p.expectedVersion) {
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: row.version } });
            }
            const out = await apply(tx, row);
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: PORTAL_PRINCIPAL_RESOURCE,
                resourceRef: row.principal_id,
                resourceVersion: out.version,
              },
              { changedFields: ['state'] },
            );
            return { data: { principalRef: row.principal_id, state: out.state }, version: out.version };
          },
        );
      });
    });
  }

  return {
    enrollPortalPrincipal(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ principalRef: string; state: string; proofingLevel: string }>> {
      const op = 'portal.principals.enroll';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid<PortalEnroll>(validatePortalEnroll, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload;
        const keyer = createMatchKeyer(deps.matchKeyPepper, ctx.tenantId);
        const key =
          p.contact.channel === 'phone'
            ? phoneKey(p.contact.value, keyer)
            : keyer.key(MATCH_KEY.email, p.contact.value.trim().toLowerCase());
        return deps.withTenantTransaction(ctx, async (tx) => {
          const person = await tx.query<{ merged_into: string | null; match_keys: string[] }>(
            'SELECT merged_into, match_keys FROM cuspatlas.patients WHERE id = $1 FOR SHARE',
            [p.personRef],
          );
          const row = person.rows[0];
          if (!row) throw notFound();
          // The contact value is part of the digest only: the idempotency row stores the payload digest.
          return execute<{ principalRef: string; state: string; proofingLevel: string }>(
            ctx,
            envelope,
            tx,
            async () => {
              if (row.merged_into !== null) throw conflict('patient_merged');
              if (!row.match_keys.includes(key)) throw failedAt('/contact', 'contactNotOnRecord');
              // A household contact shared with any other identity never establishes access.
              const shared = await tx.query(
                `SELECT 1 FROM cuspatlas.patients WHERE match_keys @> ARRAY[$1]::text[] AND id <> $2
                   AND merged_into IS NULL LIMIT 1`,
                [key, p.personRef],
              );
              if (shared.rowCount > 0) throw conflict('shared_contact_ambiguous');
              const live = await tx.query(
                `SELECT 1 FROM cuspatlas.portal_principals WHERE person_patient_id = $1 AND state <> 'revoked'`,
                [p.personRef],
              );
              if (live.rowCount > 0) throw conflict('portal_principal_exists');
              const id = randomUUID();
              await tx.query(
                `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'portal', $2)`,
                [id, `portal-${id}`],
              );
              try {
                await tx.query(
                  `INSERT INTO cuspatlas.portal_principals (principal_id, tenant_id, person_patient_id, state,
                     proofing_level, contact_channel, contact_key, enrolled_by)
                   VALUES ($1, cuspatlas.current_tenant_id(), $2, 'pending', $3, $4, $5, cuspatlas.current_actor_id())`,
                  [id, p.personRef, PORTAL_PROOFING_LEVEL, p.contact.channel, key],
                );
              } catch (err) {
                if ((err as { code?: unknown }).code === '23505') throw conflict('portal_principal_exists');
                throw err;
              }
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: PORTAL_PRINCIPAL_RESOURCE,
                  resourceRef: id,
                  resourceVersion: 1,
                },
                { changedFields: ['person', 'state', 'contactChannel'] },
              );
              return {
                data: { principalRef: id, state: 'pending', proofingLevel: PORTAL_PROOFING_LEVEL },
                version: 1,
              };
            },
          );
        });
      });
    },

    verifyPortalPrincipal(ctx: ActorContext, principalRef: string, envelope: CommandEnvelope<unknown>) {
      return transition(ctx, 'portal.principals.verify', principalRef, envelope, async (tx, row) => {
        if (row.state !== 'pending') throw conflict('portal_principal_not_pending');
        const { rows } = await tx.query<{ version: number }>(
          `UPDATE cuspatlas.portal_principals SET state = 'active', verification_method = 'synthetic_attested',
             verified_at = now(), verified_by = cuspatlas.current_actor_id(), version = version + 1, updated_at = now()
           WHERE principal_id = $1 AND version = $2 RETURNING version`,
          [row.principal_id, row.version],
        );
        const version = rows[0]?.version;
        if (version === undefined) throw new RefusalError({ code: 'stale_version' });
        return { state: 'active', version };
      });
    },

    revokePortalPrincipal(ctx: ActorContext, principalRef: string, envelope: CommandEnvelope<unknown>) {
      const reason = (envelope.payload as PortalRevoke | undefined)?.reasonCode;
      return transition(ctx, 'portal.principals.revoke', principalRef, envelope, async (tx, row) => {
        const { rows } = await tx.query<{ version: number }>(
          `UPDATE cuspatlas.portal_principals SET state = 'revoked', revoked_at = now(),
             revoked_by = cuspatlas.current_actor_id(), revoke_reason = $3, version = version + 1, updated_at = now()
           WHERE principal_id = $1 AND version = $2 RETURNING version`,
          [row.principal_id, row.version, reason],
        );
        const version = rows[0]?.version;
        if (version === undefined) throw new RefusalError({ code: 'stale_version' });
        return { state: 'revoked', version };
      });
    },

    readPortalPrincipal(ctx: ActorContext, principalRef: string): Promise<PortalPrincipalRecord> {
      const op = 'portal.principals.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => record(await loadPrincipal(tx, principalRef)));
      });
    },

    /** Staff view: the S5 relationships of one patient projected as portal grants. */
    listPortalGrants(
      ctx: ActorContext,
      patientRef: string,
      query: unknown,
    ): Promise<{ patientRef: string; grants: PortalGrant[]; principals: PortalPrincipalRecord[] }> {
      const op = 'portal.grants.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(patientRef);
          const exists = await tx.query('SELECT 1 FROM cuspatlas.patients WHERE id = $1', [patientRef]);
          if (exists.rowCount === 0) throw notFound();
          const grants = await projectGrants(tx, 'subject', patientRef);
          const people = [patientRef, ...grants.map((g) => g.granteeRef)];
          const principals = await tx.query<PrincipalRow>(
            `SELECT ${PRINCIPAL_COLUMNS} FROM cuspatlas.portal_principals WHERE person_patient_id = ANY ($1::uuid[])
             ORDER BY created_at, principal_id LIMIT 100`,
            [people],
          );
          return { patientRef, grants, principals: principals.rows.map(record) };
        });
      });
    },
  };
}
