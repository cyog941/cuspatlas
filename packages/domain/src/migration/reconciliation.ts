import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  moneyFromMinorText,
  type TenantTransaction,
  validateCutoverAdvance,
  validatePackageQuery,
  validateSignOffRecord,
} from '@cuspatlas/contracts';
import { canonicalJson, sha256Hex } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import {
  assertRef,
  checkEnvelope,
  conflict,
  loadPackage,
  MIGRATION_PACKAGE_RESOURCE,
  type MigrationBase,
  notFound,
  type PackageRow,
  validate,
} from './base';
import { openingReconciliation } from './opening';
import { type ApplyHooks, computePlan, loadApplied, planView } from './plan';

/**
 * M6: the reconciliation report and the staff sign-off gate. The report is a projection over the
 * staged rows, the plan, the applied records and the posted opening lines (never a financial
 * authority); its digest binds the package change sequence, so any later import change or decision
 * makes every earlier report and sign-off stale. Cutover readiness needs an approval of the current
 * report version by two distinct human reviewers (financial and operations roles) and no blocking
 * exception. Reports and sign-offs are append-only. Recommended-pending-approval.
 */
const ROLES = ['financialReviewer', 'operationsReviewer'] as const;

export interface ReportBody {
  readonly packageRef: string;
  readonly changeSeq: number;
  readonly counts: readonly {
    entity: string;
    declared: number;
    staged: number;
    applied: number;
    excluded: number;
    blocked: number;
  }[];
  readonly balanceComparison: readonly {
    accountRef: string;
    sourceValue: { currency: string; minor: number };
    targetValue: { currency: string; minor: number };
    difference: { currency: string; minor: number };
    explainedBy: { currency: string; minor: number };
  }[];
  readonly unappliedCredit: {
    source: { currency: string; minor: number };
    imported: { currency: string; minor: number };
  };
  readonly exceptionsByCategory: readonly { code: string; count: number }[];
  readonly blockingExceptions: readonly { code: string; subjectRef: string; requiredAction: string }[];
  readonly notImported: number;
}

async function computeReport(
  tx: TenantTransaction,
  pkg: PackageRow,
  hooks: ApplyHooks,
): Promise<{ body: ReportBody; digest: string }> {
  const currency = await hooks.currency(tx);
  const plan = await computePlan(tx, pkg, currency, hooks.financial);
  const applied = await loadApplied(tx, pkg.id);
  const view = planView(pkg, plan, applied);
  const { rows: raw } = await tx.query<{ entities: { name: string; declaredCount: number }[] }>(
    `SELECT raw->'manifest'->'entities' AS entities FROM cuspatlas.migration_packages WHERE id = $1`,
    [pkg.id],
  );
  const declared = new Map((raw[0]?.entities ?? []).map((e) => [e.name, e.declaredCount]));
  const opening = await openingReconciliation(tx, pkg);
  // A balance difference is explained when it equals the source money of rows that were excluded or
  // are still blocked for that guarantor (listed as not imported); anything else blocks cutover.
  const unexplainedSource = new Map<string, bigint>();
  for (const e of plan.entries) {
    if (e.kind === 'action' || !['ledger_balances'].includes(e.staged.entity)) continue;
    const raw2 = e.staged.payload.balance_minor ?? '';
    if (!/^[0-9]{1,15}$/.test(raw2) || e.staged.payload.currency !== currency) continue;
    const k = e.staged.payload.account_id || '(none)';
    unexplainedSource.set(k, (unexplainedSource.get(k) ?? 0n) + BigInt(raw2));
  }
  const m = (v: bigint) => moneyFromMinorText(currency, v.toString());
  const blocking: { code: string; subjectRef: string; requiredAction: string }[] = [];
  const balanceComparison = opening.byGuarantor.map((g) => {
    const explained = unexplainedSource.get(g.guarantorSourceId) ?? 0n;
    const diff = BigInt(g.balanceDifference.minor);
    if (diff !== explained || BigInt(g.creditDifference.minor) !== 0n)
      blocking.push({
        code: 'unexplained_difference',
        subjectRef: `guarantor:${g.guarantorSourceId}`,
        requiredAction: 'investigate_balance',
      });
    return {
      accountRef: `guarantor:${g.guarantorSourceId}`,
      sourceValue: g.sourceBalance,
      targetValue: g.importedBalance,
      difference: g.balanceDifference,
      explainedBy: m(explained),
    };
  });
  const { rows: open } = await tx.query<{ id: string; category: string }>(
    `SELECT id, category FROM cuspatlas.migration_review_items WHERE package_id = $1 AND state = 'open' ORDER BY id`,
    [pkg.id],
  );
  for (const i of open)
    blocking.push({
      code: `review_${i.category}`,
      subjectRef: `reviewItem:${i.id}`,
      requiredAction: 'resolve_review_item',
    });
  for (const e of plan.entries)
    if (e.kind === 'action' && !applied.has(e.staged.id))
      blocking.push({
        code: 'not_applied',
        subjectRef: `staged:${e.staged.id}`,
        requiredAction: 'apply_import',
      });
  for (const e of plan.entries)
    if (e.kind === 'blocked')
      blocking.push({
        code: e.code ?? 'blocked',
        subjectRef: `staged:${e.staged.id}`,
        requiredAction: 'resolve_review_item',
      });
  const categories = new Map<string, number>();
  for (const e of plan.entries)
    if (e.kind !== 'action')
      categories.set(e.code ?? 'unknown', (categories.get(e.code ?? 'unknown') ?? 0) + 1);
  const body: ReportBody = {
    packageRef: pkg.id,
    changeSeq: pkg.change_seq,
    counts: view.counts.map((c) => ({ ...c, declared: declared.get(c.entity) ?? 0 })),
    balanceComparison,
    unappliedCredit: { source: opening.totals.sourceCredit, imported: opening.totals.importedCredit },
    exceptionsByCategory: [...categories]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([code, count]) => ({ code, count })),
    blockingExceptions: blocking.slice(0, 500),
    notImported: plan.entries.filter((e) => e.kind === 'excluded').length,
  };
  return { body, digest: sha256Hex(canonicalJson({ packageDigest: pkg.package_digest, body })) };
}

interface ReportRow extends Record<string, unknown> {
  id: string;
  version: number;
  digest: string;
  body: ReportBody;
}

async function latestReport(tx: TenantTransaction, packageId: string): Promise<ReportRow | null> {
  const { rows } = await tx.query<ReportRow>(
    'SELECT id, version, digest, body FROM cuspatlas.migration_reports WHERE package_id = $1 ORDER BY version DESC LIMIT 1',
    [packageId],
  );
  return rows[0] ?? null;
}

export interface ReportSummary {
  readonly reportRef: string;
  readonly reportVersion: number;
  readonly reportDigest: string;
  readonly blockingExceptions: number;
}

export function createReconciliationOperations(base: MigrationBase, hooks: ApplyHooks) {
  const { deps, execute } = base;
  return {
    buildReconciliationReport(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ReportSummary>> {
      const op = 'migration.reports.build';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ packageRef: string }>(validatePackageQuery, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, p.packageRef, 'FOR UPDATE');
          return execute(ctx, envelope, tx, async () => {
            const { body, digest } = await computeReport(tx, pkg, hooks);
            const latest = await latestReport(tx, pkg.id);
            if (latest && latest.digest === digest) {
              return {
                data: {
                  reportRef: latest.id,
                  reportVersion: latest.version,
                  reportDigest: digest,
                  blockingExceptions: body.blockingExceptions.length,
                },
                version: latest.version,
              };
            }
            // A new version supersedes the prior one; nothing is deleted.
            const { rows } = await tx.query<{ id: string; version: number }>(
              `INSERT INTO cuspatlas.migration_reports (tenant_id, package_id, version, digest, change_seq, body, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id()) RETURNING id, version`,
              [pkg.id, (latest?.version ?? 0) + 1, digest, pkg.change_seq, JSON.stringify(body)],
            );
            const r = rows[0] as { id: string; version: number };
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: 'migrationReport',
                resourceRef: r.id,
                resourceVersion: r.version,
              },
              { changedFields: ['report'] },
            );
            return {
              data: {
                reportRef: r.id,
                reportVersion: r.version,
                reportDigest: digest,
                blockingExceptions: body.blockingExceptions.length,
              },
              version: r.version,
            };
          });
        });
      });
    },

    readReconciliationReport(ctx: ActorContext, query: unknown) {
      const op = 'migration.reports.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ packageRef: string }>(validatePackageQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, query.packageRef);
          const latest = await latestReport(tx, pkg.id);
          if (!latest) throw notFound();
          const current = await computeReport(tx, pkg, hooks);
          const { rows: signoffs } = await tx.query<{
            id: string;
            role: string;
            decision: string;
            signed_by: string;
            report_id: string;
          }>(
            `SELECT id, role, decision, signed_by, report_id FROM cuspatlas.migration_signoffs WHERE package_id = $1 ORDER BY signed_at, id`,
            [pkg.id],
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: MIGRATION_PACKAGE_RESOURCE,
            resourceRefs: [pkg.id],
            queryFields: ['packageRef'],
          });
          return {
            reportRef: latest.id,
            reportVersion: latest.version,
            reportDigest: latest.digest,
            stale: latest.digest !== current.digest,
            cutoverState: pkg.cutover_state,
            report: latest.body,
            signOffs: signoffs.map((s) => ({
              signOffRef: s.id,
              role: s.role,
              decision: s.decision,
              signedByRef: s.signed_by,
              reportRef: s.report_id,
              valid: s.report_id === latest.id && latest.digest === current.digest,
            })),
          };
        });
      });
    },

    recordSignOff(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ signOffRef: string; role: string; decision: string }>> {
      const op = 'migration.signoffs.record';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{
          packageRef: string;
          reportRef: string;
          reportDigest: string;
          role: (typeof ROLES)[number];
          decision: 'approved' | 'rejected';
        }>(validateSignOffRecord, p);
        assertRef(p.reportRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, p.packageRef, 'FOR UPDATE');
          return execute(ctx, envelope, tx, async () => {
            const latest = await latestReport(tx, pkg.id);
            const { rows: own } = await tx.query(
              'SELECT 1 FROM cuspatlas.migration_reports WHERE id = $1 AND package_id = $2',
              [p.reportRef, pkg.id],
            );
            if (own.length === 0) throw notFound();
            const current = await computeReport(tx, pkg, hooks);
            if (
              !latest ||
              latest.id !== p.reportRef ||
              latest.digest !== p.reportDigest ||
              current.digest !== p.reportDigest
            )
              throw conflict('stale_report_version');
            if (p.decision === 'approved' && current.body.blockingExceptions.length > 0)
              throw conflict('unresolved_exception');
            const { rows: other } = await tx.query<{ role: string }>(
              'SELECT role FROM cuspatlas.migration_signoffs WHERE report_id = $1 AND signed_by = cuspatlas.current_actor_id()',
              [p.reportRef],
            );
            if (other.length > 0)
              throw conflict(
                other.some((o) => o.role === p.role) ? 'already_signed' : 'separate_reviewer_required',
              );
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.migration_signoffs (tenant_id, package_id, report_id, report_digest, role, decision, signed_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id())
               ON CONFLICT (report_id, role) DO NOTHING RETURNING id`,
              [pkg.id, p.reportRef, p.reportDigest, p.role, p.decision],
            );
            const id = rows[0]?.id;
            if (!id) throw conflict('already_signed');
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: 'migrationSignOff',
                resourceRef: id,
                resourceVersion: 1,
              },
              { changedFields: ['signOff'] },
            );
            return { data: { signOffRef: id, role: p.role, decision: p.decision }, version: 1 };
          });
        });
      });
    },

    advanceCutover(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ packageRef: string; cutoverState: string }>> {
      const op = 'migration.cutover.advance';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ packageRef: string; reportRef: string }>(validateCutoverAdvance, p);
        assertRef(p.reportRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, p.packageRef, 'FOR UPDATE');
          return execute(ctx, envelope, tx, async () => {
            const latest = await latestReport(tx, pkg.id);
            const current = await computeReport(tx, pkg, hooks);
            if (!latest || latest.id !== p.reportRef || latest.digest !== current.digest)
              throw conflict('stale_report_version');
            if (current.body.blockingExceptions.length > 0) throw conflict('unresolved_exception');
            const { rows } = await tx.query<{ role: string; decision: string; signed_by: string }>(
              'SELECT role, decision, signed_by FROM cuspatlas.migration_signoffs WHERE report_id = $1 AND report_digest = $2',
              [latest.id, latest.digest],
            );
            const approved = rows.filter((r) => r.decision === 'approved');
            if (rows.some((r) => r.decision === 'rejected')) throw conflict('sign_off_rejected');
            if (
              !ROLES.every((role) => approved.some((r) => r.role === role)) ||
              new Set(approved.map((r) => r.signed_by)).size < 2
            )
              throw conflict('sign_off_incomplete');
            const { rows: upd } = await tx.query<{ version: number }>(
              `UPDATE cuspatlas.migration_packages SET cutover_state = 'readyForCutover', version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING version`,
              [pkg.id],
            );
            const version = upd[0]?.version ?? pkg.version + 1;
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: MIGRATION_PACKAGE_RESOURCE,
                resourceRef: pkg.id,
                resourceVersion: version,
              },
              { changedFields: ['cutoverState'] },
            );
            return { data: { packageRef: pkg.id, cutoverState: 'readyForCutover' }, version };
          });
        });
      });
    },
  };
}
