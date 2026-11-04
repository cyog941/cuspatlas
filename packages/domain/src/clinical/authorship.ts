import {
  type ActorContext,
  type AuthorContextData,
  assertValid,
  CLINICAL_PROPERTIES,
  type ClinicalAuthor,
  type ClinicalAuthorDefine,
  type ClinicalAuthorProfile,
  type ClinicalRole,
  type CommandEnvelope,
  type CommandResult,
  RefusalError,
  type TenantTransaction,
  validateClinicalAuthorDefine,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { type ClinicalBase, checkEnvelope, conflict, notFound } from './base';

export const AUTHOR_PROFILE_RESOURCE = 'clinicalAuthorProfile';

interface ProfileRow extends Record<string, unknown> {
  actor_id: string;
  role: ClinicalRole;
  credential_ref: string | null;
  active: boolean;
  version: number;
}

const toProfile = (r: ProfileRow): ClinicalAuthorProfile => ({
  actorRef: r.actor_id,
  role: r.role,
  credentialRef: r.credential_ref,
  active: r.active,
  version: r.version,
});

async function loadProfile(tx: TenantTransaction, actorId: string, lock = ''): Promise<ProfileRow | null> {
  const { rows } = await tx.query<ProfileRow>(
    `SELECT actor_id, role, credential_ref, active, version FROM cuspatlas.clinical_author_profiles
     WHERE actor_id = $1 ${lock}`,
    [actorId],
  );
  return rows[0] ?? null;
}

const unresolved = (
  reason: 'clinical_author_service_principal' | 'clinical_author_missing' | 'clinical_author_inactive',
) => new RefusalError({ code: 'forbidden', reasonCode: 'clinical_author_unresolved', detail: { reason } });

/**
 * Authorship rule (C5): every clinical mutation records the authenticated human and the clinical
 * role configured for them at that instant. A service principal, a member without a profile, or an
 * inactive profile is refused (403) and leaves a security attempt; the role is never inferred from a
 * scope, a provider assignment or a procedure. The profile row is read FOR SHARE so a concurrent
 * deactivation serializes with the mutation that relies on it.
 */
export async function resolveClinicalAuthor(tx: TenantTransaction): Promise<ClinicalAuthor> {
  if (tx.ctx.principal !== 'human') throw unresolved('clinical_author_service_principal');
  const p = await loadProfile(tx, tx.ctx.actorId, 'FOR SHARE');
  if (!p) throw unresolved('clinical_author_missing');
  if (!p.active) throw unresolved('clinical_author_inactive');
  return { actorRef: p.actor_id, role: p.role, credentialRef: p.credential_ref };
}

/** Rebuilds a ClinicalAuthor from the snapshot columns of a stored row. */
export const authorOf = (
  actorRef: string,
  role: ClinicalRole,
  credentialRef: string | null,
): ClinicalAuthor => ({
  actorRef,
  role,
  credentialRef,
});

const isPgError = (err: unknown, code: string) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;

export function createAuthorshipOperations(base: ClinicalBase) {
  const { deps, execute } = base;
  return {
    /** Practice configuration (admin.configure, human): who is a clinical author, in which role. */
    defineClinicalAuthor(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ClinicalAuthorProfile>> {
      const op = 'clinical.authors.define';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ClinicalAuthorDefine>(validateClinicalAuthorDefine, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const r = await execute<{ ref: string }>(ctx, envelope, tx, async () => {
            const existing = await loadProfile(tx, p.actorRef, 'FOR UPDATE');
            if (p.expectedVersion === undefined) {
              if (existing) throw conflict('author_profile_exists');
              try {
                await tx.query(
                  `INSERT INTO cuspatlas.clinical_author_profiles (tenant_id, actor_id, role, credential_ref, active,
                     defined_by, updated_by)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id(),
                     cuspatlas.current_actor_id())`,
                  [p.actorRef, p.role, p.credentialRef ?? null, p.active ?? true],
                );
              } catch (err) {
                // Not a member of this tenant (or of any): indistinguishable from a missing record.
                if (isPgError(err, '23503')) throw notFound();
                throw err;
              }
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: AUTHOR_PROFILE_RESOURCE,
                  resourceRef: p.actorRef,
                  resourceVersion: 1,
                },
                { changedFields: ['role', 'credentialRef', 'active'] },
              );
              return { data: { ref: p.actorRef }, version: 1 };
            }
            if (!existing) throw notFound();
            if (existing.version !== p.expectedVersion) {
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: existing.version } });
            }
            const { rows } = await tx.query<{ version: number }>(
              `UPDATE cuspatlas.clinical_author_profiles SET role = $2, credential_ref = $3, active = $4,
                 version = version + 1, updated_by = cuspatlas.current_actor_id(), updated_at = now()
               WHERE actor_id = $1 RETURNING version`,
              [p.actorRef, p.role, p.credentialRef ?? null, p.active ?? true],
            );
            const version = rows[0]?.version;
            if (version === undefined) throw new Error('update returned no row');
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: AUTHOR_PROFILE_RESOURCE,
                resourceRef: p.actorRef,
                resourceVersion: version,
              },
              { changedFields: ['role', 'credentialRef', 'active'] },
            );
            return { data: { ref: p.actorRef }, version };
          });
          const row = await loadProfile(tx, r.data.ref);
          if (!row) throw notFound();
          return { ...r, data: toProfile(row) };
        });
      });
    },

    /**
     * The caller's own clinical author context. "Not resolvable" is an explicit answer with its
     * reason, never an empty success that reads as permission.
     */
    getAuthorContext(ctx: ActorContext): Promise<AuthorContextData> {
      const op = 'clinical.authors.context';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (ctx.principal !== 'human')
            return { resolvable: false, author: null, reason: 'service_principal' };
          const p = await loadProfile(tx, ctx.actorId);
          if (!p) return { resolvable: false, author: null, reason: 'no_profile' };
          const author = authorOf(p.actor_id, p.role, p.credential_ref);
          return p.active
            ? { resolvable: true, author, reason: null }
            : { resolvable: false, author: null, reason: 'profile_inactive' };
        });
      });
    },
  };
}
