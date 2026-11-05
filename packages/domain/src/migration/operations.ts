import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  type TenantTransaction,
  validateBackupVerificationRecord,
  validateOperationsEmptyQuery,
  validateOperatorProfileRecord,
} from '@cuspatlas/contracts';
import { transactionNow } from '../clock';
import { recordCommand } from '../events/record-command';
import { checkEnvelope, failed, type MigrationBase, validate } from './base';

/**
 * M9 operator obligations (recommended-pending-approval; M-S3 names the operator, the hosting model
 * and the objectives). The objectives mirror docs/deployment/recovery-objectives.json.
 */
export const REQUIRED_RESPONSIBILITIES = [
  'backup',
  'restore_drill',
  'security_incident',
  'support',
  'escalation',
];
export const BACKUP_VERIFICATION_MAX_AGE_SECONDS = 86_400;
export const OBJECTIVES_STATUS = 'recommended-pending-approval';

type Obligation =
  | 'missing_operator'
  | 'weak_escalation'
  | 'absent_verification'
  | 'stale_verification'
  | 'failed_verification'
  | 'checksum_only_verification'
  | 'sla_not_demonstrated';

interface ProfileBody {
  responsibilities: { responsibility: string; roleName: string; contactRef: string }[];
  escalation: {
    incidentClass: string;
    responderClass: string;
    coverage: string;
    expectedFirstResponseMinutes: number;
  }[];
  supportClaim?: { rtoSeconds: number };
}

const weakEscalation = (b: ProfileBody) =>
  !b.escalation.some((e) => e.incidentClass === 'security_incident' && e.coverage === 'always');

const ACTIONS: Record<Obligation, string> = {
  missing_operator: 'Record an operator profile naming every required responsibility.',
  weak_escalation: 'Add an always-covered security incident escalation path.',
  absent_verification: 'Run the backup verification job (manifest digests and an isolated restore).',
  stale_verification: 'Run the backup verification job; the latest result is older than the interval.',
  failed_verification: 'Investigate the failed backup verification and take a new verified backup.',
  checksum_only_verification: 'Run an isolated sample restore; a checksum alone does not verify a backup.',
  sla_not_demonstrated: 'Withdraw the support claim or demonstrate it with a timed restore.',
};

async function evaluate(tx: TenantTransaction) {
  const unmet: Obligation[] = [];
  const evidence: Partial<Record<Obligation, { kind: string; ref: string }>> = {};
  const { rows: profiles } = await tx.query<{ id: string; body: ProfileBody }>(
    'SELECT id, body FROM cuspatlas.ops_operator_profiles ORDER BY profile_version DESC LIMIT 1',
  );
  const profile = profiles[0];
  if (!profile) unmet.push('missing_operator');
  else if (weakEscalation(profile.body)) {
    unmet.push('weak_escalation');
    evidence.weak_escalation = { kind: 'operatorProfile', ref: profile.id };
  }
  const { rows: checks } = await tx.query<{
    id: string;
    result: string;
    restore_seconds: string | null;
    stale: boolean;
  }>(
    `SELECT id, result, restore_seconds::text, checked_at < now() - make_interval(secs => $1) AS stale
     FROM cuspatlas.ops_backup_verifications ORDER BY checked_at DESC, id DESC LIMIT 1`,
    [BACKUP_VERIFICATION_MAX_AGE_SECONDS],
  );
  const latest = checks[0];
  const verification: Obligation | null = !latest
    ? 'absent_verification'
    : latest.stale
      ? 'stale_verification'
      : latest.result === 'failed'
        ? 'failed_verification'
        : latest.result === 'checksum_only'
          ? 'checksum_only_verification'
          : null;
  if (verification) {
    unmet.push(verification);
    if (latest) evidence[verification] = { kind: 'backupVerification', ref: latest.id };
  } else if (
    profile?.body.supportClaim &&
    latest &&
    Number(latest.restore_seconds ?? Number.POSITIVE_INFINITY) > profile.body.supportClaim.rtoSeconds
  ) {
    unmet.push('sla_not_demonstrated');
    evidence.sla_not_demonstrated = { kind: 'backupVerification', ref: latest.id };
  }
  const at = await transactionNow(tx);
  return { unmet, evidence, at };
}

export function createOperationsReadiness(base: MigrationBase) {
  const { deps, execute } = base;
  return {
    /** A new operator profile version; refused when a responsibility or the 24x7 security path is missing. */
    recordOperatorProfile(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ profileRef: string; profileVersion: number }>> {
      const op = 'operations.operatorProfiles.record';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<ProfileBody & { operatorRef: string; hostingModel: string }>(
          validateOperatorProfileRecord,
          p,
        );
        const named = new Set(p.responsibilities.map((r) => r.responsibility));
        if (!REQUIRED_RESPONSIBILITIES.every((r) => named.has(r))) throw failed('responsibility_missing');
        if (weakEscalation(p)) throw failed('weak_escalation');
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const body: ProfileBody = {
              responsibilities: p.responsibilities,
              escalation: p.escalation,
              ...(p.supportClaim ? { supportClaim: p.supportClaim } : {}),
            };
            const { rows } = await tx.query<{ id: string; profile_version: number }>(
              `INSERT INTO cuspatlas.ops_operator_profiles (tenant_id, profile_version, operator_ref, hosting_model,
                 body, recorded_by)
               SELECT cuspatlas.current_tenant_id(), coalesce(max(profile_version), 0) + 1, $1, $2, $3,
                 cuspatlas.current_actor_id()
               FROM cuspatlas.ops_operator_profiles
               RETURNING id, profile_version`,
              [p.operatorRef, p.hostingModel, JSON.stringify(body)],
            );
            const row = rows[0];
            if (!row) throw new Error('profile insert returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: 'operatorProfile', resourceRef: row.id, resourceVersion: 1 },
              { changedFields: ['profile'] },
            );
            return { data: { profileRef: row.id, profileVersion: row.profile_version }, version: 1 };
          }),
        );
      });
    },

    /** One backup verification; the result is derived here (verified only with an isolated restore). */
    recordBackupVerification(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ verificationRef: string; result: 'verified' | 'checksum_only' | 'failed' }>> {
      const op = 'operations.backupVerifications.record';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{
          backupDigest: string;
          manifestVerified: boolean;
          isolatedRestore: 'passed' | 'failed' | 'not_run';
          restoreSeconds?: number;
          failureCode?: string;
        }>(validateBackupVerificationRecord, p);
        const result =
          !p.manifestVerified || p.isolatedRestore === 'failed'
            ? ('failed' as const)
            : p.isolatedRestore === 'not_run'
              ? ('checksum_only' as const)
              : ('verified' as const);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.ops_backup_verifications (tenant_id, backup_digest, manifest_verified,
                 isolated_restore, restore_seconds, failure_code, result, recorded_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id())
               RETURNING id`,
              [
                p.backupDigest,
                p.manifestVerified,
                p.isolatedRestore,
                p.restoreSeconds ?? null,
                p.failureCode ?? null,
                result,
              ],
            );
            const id = rows[0]?.id as string;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'backupVerification', resourceRef: id, resourceVersion: 1 },
              { changedFields: ['result'] },
            );
            return { data: { verificationRef: id, result }, version: 1 };
          }),
        );
      });
    },

    /**
     * When the tenant's latest backup verification was recorded, and the database's now (the worker's
     * due check; not a catalog operation). Authorized as the recording action: only the recorder
     * schedules a verification.
     */
    lastBackupVerification(ctx: ActorContext): Promise<{ lastCheckedAt: Date | null; at: Date }> {
      const op = 'operations.backupVerifications.record';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{ last: Date | null; at: Date }>(
            'SELECT max(checked_at) AS last, now() AS at FROM cuspatlas.ops_backup_verifications',
          );
          return { lastCheckedAt: rows[0]?.last ?? null, at: rows[0]?.at ?? new Date() };
        });
      });
    },

    /** Every unmet operator obligation; ready only when none is unmet. */
    assertReadiness(ctx: ActorContext, query: unknown) {
      const op = 'operations.readiness.assert';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<Record<string, never>>(validateOperationsEmptyQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { unmet, at } = await evaluate(tx);
          return {
            data: {
              ready: unmet.length === 0,
              unmetObligations: unmet,
              evaluatedAt: at.toISOString(),
              objectivesStatus: OBJECTIVES_STATUS,
            },
          };
        });
      });
    },

    /** Operator alerts as work items: one per unmet obligation, owed by the platform operator. */
    listOperationsAlerts(ctx: ActorContext, query: unknown) {
      const op = 'operations.alerts.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<Record<string, never>>(validateOperationsEmptyQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { unmet, evidence, at } = await evaluate(tx);
          const items = unmet.map((o) => ({
            workItemRef: `operations:${o}`,
            kind: 'operations_alert',
            reasonCode: o,
            explanation: ACTIONS[o],
            evidenceRefs: evidence[o] ? [evidence[o]] : [],
            owner: { queue: 'practice_manager', principalRef: null },
            nextActionOwedBy: 'platform',
            dueAt: null,
            priority: o === 'sla_not_demonstrated' || o === 'checksum_only_verification' ? 'soon' : 'urgent',
            priorityRationale: 'operator_obligation',
            suggestedNextAction: ACTIONS[o],
            blockingDependencies: o === 'missing_operator' ? ['M-S3'] : [],
          }));
          return {
            data: { asOf: at.toISOString(), coverage: { status: 'available' }, count: items.length, items },
          };
        });
      });
    },
  };
}
