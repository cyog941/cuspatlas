import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  RefusalError,
  type ReviewerAssign,
  type ReviewerListQuery,
  type ReviewerRole,
  type ReviewerUnassign,
  type TenantTransaction,
  validateReviewerAssign,
  validateReviewerListQuery,
  validateReviewerUnassign,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import type { ActionName } from '../policy/authorize';
import { checkEnvelope, conflict, failed, isPgError, type MigrationBase, notFound, validate } from './base';

/**
 * Closeout A6 (H2 M-5 open item; synthetic only): the administrator-facing reviewer list. A tenant-wide
 * human administrator (admin.configure) assigns a live human member of the same tenant to a sign-off
 * role, never themself, and ends an assignment at its expected version with a reason code. An ended
 * assignment is kept (revoked at, by, why), so who could sign off when stays readable; the sign-off
 * check (`migration.signoffs.record` and its trigger) reads only live assignments. The database repeats
 * every rule (20261207020000).
 */
export const REVIEWER_RESOURCE = 'migrationReviewerAssignment';
export const REVIEWER_LIST_LIMIT = 500;

interface AssignmentRow extends Record<string, unknown> {
  id: string;
  principal_id: string;
  role: ReviewerRole;
  assigned_by: string;
  assigned_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  revocation_reason: string | null;
  version: number;
}
type AssignmentData = { assignmentRef: string; principalRef: string; role: ReviewerRole; state: string };

const COLUMNS = `id, principal_id, role, assigned_by, assigned_at, revoked_at, revoked_by, revocation_reason, version`;
const stale = (currentVersion: number) =>
  new RefusalError({ code: 'stale_version', detail: { currentVersion } });
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

async function loadAssignment(tx: TenantTransaction, ref: string): Promise<AssignmentRow> {
  const { rows } = await tx.query<AssignmentRow>(
    `SELECT ${COLUMNS} FROM cuspatlas.migration_reviewer_assignments WHERE id = $1 FOR UPDATE`,
    [ref],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

export function createReviewerOperations(base: MigrationBase) {
  const { deps, execute } = base;
  /** Assignments are tenant-wide configuration: a location-restricted administrator is refused. */
  const decideTenantWide = async (ctx: ActorContext, op: ActionName) => {
    const decision = await deps.authorize(ctx, op, { tenantId: ctx.tenantId, id: 'migration' });
    if (decision.locationRefs !== null)
      throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
  };

  return {
    assignReviewer(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<AssignmentData>> {
      const op = 'migration.reviewers.assign';
      return base.guarded(ctx, op, async () => {
        await decideTenantWide(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<ReviewerAssign>(validateReviewerAssign, p);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            if (p.principalRef === ctx.actorId) throw conflict('self_assignment_refused');
            // Re-checked server-side for the assignee: a live human member of this tenant.
            const { rows: ok } = await tx.query<{ ok: boolean }>(
              'SELECT cuspatlas.migration_reviewer_assignable($1::uuid) AS ok',
              [p.principalRef],
            );
            if (ok[0]?.ok !== true) throw failed('reviewer_not_eligible');
            const { rows: live } = await tx.query<{ id: string }>(
              `SELECT id FROM cuspatlas.migration_reviewer_assignments
               WHERE principal_id = $1 AND role = $2 AND revoked_at IS NULL`,
              [p.principalRef, p.role],
            );
            if (live[0])
              throw conflict('already_assigned', [{ kind: 'migrationReviewerAssignment', ref: live[0].id }]);
            let id: string | undefined;
            try {
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.migration_reviewer_assignments (tenant_id, principal_id, role, assigned_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id()) RETURNING id`,
                [p.principalRef, p.role],
              );
              id = rows[0]?.id;
            } catch (err) {
              if (isPgError(err, '23505')) throw conflict('already_assigned');
              if (isPgError(err, '42501')) throw failed('reviewer_not_eligible');
              throw err;
            }
            if (!id) throw new Error('reviewer assignment insert returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: REVIEWER_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['assignment'] },
            );
            return {
              data: { assignmentRef: id, principalRef: p.principalRef, role: p.role, state: 'active' },
              version: 1,
            };
          }),
        );
      });
    },

    /** Ends a live assignment once, at its expected version; the row is kept, never deleted. */
    unassignReviewer(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<AssignmentData>> {
      const op = 'migration.reviewers.unassign';
      return base.guarded(ctx, op, async () => {
        await decideTenantWide(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<ReviewerUnassign>(validateReviewerUnassign, p);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const row = await loadAssignment(tx, p.assignmentRef);
            if (row.revoked_at !== null) throw conflict('assignment_not_active');
            if (row.version !== p.expectedVersion) throw stale(row.version);
            await tx.query(
              `UPDATE cuspatlas.migration_reviewer_assignments SET revoked_at = now(),
                 revoked_by = cuspatlas.current_actor_id(), revocation_reason = $2, version = version + 1
               WHERE id = $1`,
              [row.id, p.reasonCode],
            );
            const version = row.version + 1;
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: REVIEWER_RESOURCE,
                resourceRef: row.id,
                resourceVersion: version,
              },
              { changedFields: ['revokedAt', 'revokedBy', 'revocationReason'] },
            );
            return {
              data: {
                assignmentRef: row.id,
                principalRef: row.principal_id,
                role: row.role,
                state: 'revoked',
              },
              version,
            };
          }),
        );
      });
    },

    /** The tenant's reviewer list, live and ended, oldest assignment first (at most 500). */
    listReviewers(ctx: ActorContext, query: unknown) {
      const op = 'migration.reviewers.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        const q = query ?? {};
        validate<ReviewerListQuery>(validateReviewerListQuery, q);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<AssignmentRow>(
            `SELECT ${COLUMNS} FROM cuspatlas.migration_reviewer_assignments
             WHERE ($1::text IS NULL OR role = $1) AND ($2::uuid IS NULL OR principal_id = $2::uuid)
               AND ($3::text IS NULL OR (revoked_at IS NULL) = ($3 = 'active'))
             ORDER BY assigned_at, id LIMIT $4`,
            [q.role ?? null, q.principalRef ?? null, q.state ?? null, REVIEWER_LIST_LIMIT],
          );
          return {
            data: rows.map((r) => ({
              assignmentRef: r.id,
              principalRef: r.principal_id,
              role: r.role,
              state: r.revoked_at === null ? 'active' : 'revoked',
              assignedByRef: r.assigned_by,
              assignedAt: r.assigned_at.toISOString(),
              revokedByRef: r.revoked_by,
              revokedAt: iso(r.revoked_at),
              revocationReason: r.revocation_reason,
              version: r.version,
            })),
          };
        });
      });
    },
  };
}
