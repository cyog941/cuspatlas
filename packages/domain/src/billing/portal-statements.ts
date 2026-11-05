import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  moneyFromMinorText,
  type StatementAccount,
  type StatementReleaseData,
  type TenantTransaction,
  validateStatementPortalRelease,
  validateStatementReleaseRevoke,
} from '@cuspatlas/contracts';
import { canonicalJson, sha256Hex } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import {
  assertNotMerged,
  assertRef,
  type BillingBase,
  checkEnvelope,
  conflict,
  loadPatient,
  notFound,
  validate,
} from './base';

/**
 * Closeout C: B4 statements released to the portal (synthetic; recommended-pending-billing-approval).
 * A staff human explicitly releases one generated statement to the portal of the guarantor it was
 * generated for, and may revoke it once: the same E2 release fact the imaging side uses (item kind
 * `billing_statement`), audited through `recordCommand`, never deleted. The portal lists live
 * releases only and reads the stored snapshot (digest-verified) through E1 `requirePortalAccess`
 * with relationship scope `financial`; staff references (entries, charges, payments, the author)
 * never leave. A superseded statement can still be read once released (it is what the patient was
 * sent), but a new release of a superseded or tampered statement is refused.
 */
export const STATEMENT_RELEASE_RESOURCE = 'portalStatementRelease';
const LIST_LIMIT = 100;

interface ReleaseRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  item_id: string;
  revoked: boolean;
}

interface PortalStatementRow extends Record<string, unknown> {
  release_id: string;
  released_at: Date;
  statement_id: string;
  statement_version: number;
  cutoff_at: Date;
  currency: string;
  total: string;
  total_class: 'due' | 'zero' | 'credit';
  superseded: boolean;
  snapshot: { accounts: StatementAccount[] } & Record<string, unknown>;
  snapshot_digest: string;
}

const STATEMENT_SELECT = `SELECT r.id AS release_id, r.released_at, s.id AS statement_id, s.statement_version, s.cutoff_at, s.currency,
    s.snapshot_total_minor::text AS total, s.total_class, s.snapshot, s.snapshot_digest,
    EXISTS (SELECT 1 FROM cuspatlas.billing_statements n WHERE n.supersedes_id = s.id) AS superseded
  FROM cuspatlas.portal_document_releases r
  JOIN cuspatlas.billing_statements s ON s.id = r.item_id AND s.tenant_id = r.tenant_id
    AND s.guarantor_id = r.patient_id
  WHERE r.item_kind = 'billing_statement' AND r.revoked_at IS NULL AND r.patient_id = $1`;

const amounts = (row: PortalStatementRow) => {
  const total = BigInt(row.total);
  const m = (v: bigint) => moneyFromMinorText(row.currency, v.toString());
  return {
    total: m(total),
    amountDue: m(total > 0n ? total : 0n),
    creditBalance: m(total < 0n ? -total : 0n),
  };
};

/** The portal `statements` view: live statement releases of the patient (no staff identifiers). */
export async function portalStatementsView(tx: TenantTransaction, patientRef: string) {
  const { rows } = await tx.query<PortalStatementRow>(
    `${STATEMENT_SELECT} ORDER BY r.released_at DESC, r.id LIMIT ${LIST_LIMIT}`,
    [patientRef],
  );
  return {
    statements: rows.map((r) => ({
      releaseRef: r.release_id,
      statementVersion: r.statement_version,
      cutoffAt: r.cutoff_at.toISOString(),
      currency: r.currency,
      ...amounts(r),
      totalClass: r.total_class,
      superseded: r.superseded,
      releasedAt: r.released_at.toISOString(),
    })),
  };
}

/**
 * One released statement of the patient, projected for the portal from the stored snapshot. The
 * snapshot is checked against its recorded digest first (409 `statement_integrity_failed`); a
 * revoked, unknown or another patient's release is one 404. `statementRef` (the exact statement
 * version read; never sent to the portal) is returned for the caller's sensitive-read record only.
 */
export async function portalStatementRead(tx: TenantTransaction, patientRef: string, releaseRef: string) {
  assertRef(releaseRef);
  const { rows } = await tx.query<PortalStatementRow>(`${STATEMENT_SELECT} AND r.id = $2`, [
    patientRef,
    releaseRef,
  ]);
  const row = rows[0];
  if (!row) throw notFound();
  if (sha256Hex(canonicalJson(row.snapshot)) !== row.snapshot_digest)
    throw conflict('statement_integrity_failed');
  const statement = {
    releaseRef: row.release_id,
    statementVersion: row.statement_version,
    cutoffAt: row.cutoff_at.toISOString(),
    basis: 'posted_through_cutoff' as const,
    currency: row.currency,
    ...amounts(row),
    totalClass: row.total_class,
    superseded: row.superseded,
    releasedAt: row.released_at.toISOString(),
    integrity: 'verified' as const,
    accounts: row.snapshot.accounts.map((a) => ({
      accountPatientRef: a.accountPatientRef,
      total: a.total,
      lines: a.lines.map((l) => ({
        kind: l.kind,
        postedAt: l.postedAt,
        serviceDate: l.serviceDate,
        amount: l.amount,
      })),
    })),
  };
  return { statement, statementRef: row.statement_id };
}

export function createStatementReleaseOperations(base: BillingBase) {
  const { deps, execute } = base;
  return {
    /** Staff: release one generated statement to its guarantor's portal (human only, billing.write). */
    releaseStatementToPortal(
      ctx: ActorContext,
      statementRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<StatementReleaseData>> {
      const op = 'billing.statements.releaseToPortal';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertRef(statementRef);
        validate<Record<string, never>>(validateStatementPortalRelease, envelope.payload);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            guarantor_id: string;
            snapshot: Record<string, unknown>;
            snapshot_digest: string;
            superseded: boolean;
          }>(
            `SELECT s.id, s.guarantor_id, s.snapshot, s.snapshot_digest,
               EXISTS (SELECT 1 FROM cuspatlas.billing_statements n WHERE n.supersedes_id = s.id) AS superseded
             FROM cuspatlas.billing_statements s WHERE s.id = $1`,
            [statementRef],
          );
          const s = rows[0];
          if (!s) throw notFound();
          // Serializes with a concurrent release of the same statement and with a guarantor merge.
          const guarantor = await loadPatient(tx, s.guarantor_id, 'FOR SHARE');
          return execute<StatementReleaseData>(
            ctx,
            { ...envelope, payload: { statementRef: s.id } },
            tx,
            async () => {
              assertNotMerged(guarantor);
              if (sha256Hex(canonicalJson(s.snapshot)) !== s.snapshot_digest)
                throw conflict('statement_integrity_failed');
              if (s.superseded) throw conflict('statement_superseded');
              const { rows: live } = await tx.query(
                `SELECT 1 FROM cuspatlas.portal_document_releases
               WHERE item_kind = 'billing_statement' AND item_id = $1 AND revoked_at IS NULL FOR UPDATE`,
                [s.id],
              );
              if (live.length > 0) throw conflict('already_released');
              const { rows: ins } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.portal_document_releases (tenant_id, patient_id, item_kind, item_id, released_by)
               VALUES (cuspatlas.current_tenant_id(), $1, 'billing_statement', $2, cuspatlas.current_actor_id())
               RETURNING id`,
                [s.guarantor_id, s.id],
              );
              const id = ins[0]?.id as string;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: STATEMENT_RELEASE_RESOURCE,
                  resourceRef: id,
                  resourceVersion: 1,
                },
                { changedFields: ['statementRef', 'patientRef'] },
              );
              return {
                data: { releaseRef: id, statementRef: s.id, patientRef: s.guarantor_id, state: 'released' },
                version: 1,
              };
            },
          );
        });
      });
    },

    /** Staff: revoke a statement portal release once (human only, billing.write). Takes effect at once. */
    revokeStatementRelease(
      ctx: ActorContext,
      releaseRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<StatementReleaseData>> {
      const op = 'billing.statementReleases.revoke';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertRef(releaseRef);
        validate<Record<string, never>>(validateStatementReleaseRevoke, envelope.payload);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<ReleaseRow>(
            `SELECT id, patient_id, item_id, revoked_at IS NOT NULL AS revoked
             FROM cuspatlas.portal_document_releases
             WHERE id = $1 AND item_kind = 'billing_statement' FOR UPDATE`,
            [releaseRef],
          );
          const r = rows[0];
          if (!r) throw notFound();
          return execute<StatementReleaseData>(
            ctx,
            { ...envelope, payload: { releaseRef: r.id } },
            tx,
            async () => {
              if (r.revoked) throw conflict('release_already_revoked');
              await tx.query(
                `UPDATE cuspatlas.portal_document_releases SET revoked_at = now(),
                 revoked_by = cuspatlas.current_actor_id() WHERE id = $1`,
                [r.id],
              );
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: STATEMENT_RELEASE_RESOURCE,
                  resourceRef: r.id,
                  resourceVersion: 2,
                },
                { changedFields: ['revokedAt'] },
              );
              return {
                data: {
                  releaseRef: r.id,
                  statementRef: r.item_id,
                  patientRef: r.patient_id,
                  state: 'revoked',
                },
                version: 2,
              };
            },
          );
        });
      });
    },
  };
}
