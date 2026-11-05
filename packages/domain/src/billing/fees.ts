import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  type FeeResolution,
  type FeeResolveQuery,
  type FeeScheduleCommandData,
  type FeeSchedulePublish,
  type Money,
  moneyFromMinorText,
  RefusalError,
  type ResolvedFee,
  type TenantTransaction,
  validateFeeResolveQuery,
  validateFeeSchedulePublish,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { coverageOf, locationIdOf } from '../rcm/lookups';
import {
  type BillingBase,
  checkEnvelope,
  conflict,
  failed,
  inTenantCurrency,
  isPgError,
  loadSettings,
  mergeSet,
  validate,
} from './base';

export const FEE_SCHEDULE_RESOURCE = 'billingFeeSchedule';

interface FeeRow extends Record<string, unknown> {
  schedule_id: string;
  schedule_ref: string;
  version_id: string;
  version_no: number;
  effective_from: string;
  fee: string;
  currency: string;
}

const toResolved = (r: FeeRow): ResolvedFee => ({
  fee: moneyFromMinorText(r.currency, r.fee),
  feeScheduleRef: r.schedule_id,
  scheduleRef: r.schedule_ref,
  versionRef: r.version_id,
  versionNo: r.version_no,
  effectiveFrom: r.effective_from,
});

/** The version of one schedule effective on a date: latest effective date, then highest number. */
const EFFECTIVE = `
  SELECT s.id AS schedule_id, s.schedule_ref, v.id AS version_id, v.version_no,
    to_char(v.effective_from, 'YYYY-MM-DD') AS effective_from, i.fee_minor::text AS fee, s.currency
  FROM cuspatlas.billing_fee_schedules s
  JOIN LATERAL (SELECT * FROM cuspatlas.billing_fee_schedule_versions x
                WHERE x.schedule_id = s.id AND x.effective_from <= $2::date
                ORDER BY x.effective_from DESC, x.version_no DESC LIMIT 1) v ON true
  JOIN cuspatlas.billing_fee_schedule_items i ON i.version_id = v.id AND i.tenant_id = v.tenant_id AND i.code_ref = $1`;

/**
 * The practice fee of a code on a service date at a location: the location's practice schedule,
 * else the tenant-wide one. null when nothing is configured (never a guessed amount).
 */
export async function resolvePracticeFee(
  tx: TenantTransaction,
  codeRef: string,
  serviceDate: string,
  locationId: string | null,
): Promise<ResolvedFee | null> {
  const { rows } = await tx.query<FeeRow>(
    `${EFFECTIVE}
     WHERE s.purpose = 'practice' AND (s.location_id = $3::uuid OR s.location_id IS NULL)
     ORDER BY (s.location_id IS NULL), s.id LIMIT 1`,
    [codeRef, serviceDate, locationId],
  );
  return rows[0] ? toResolved(rows[0]) : null;
}

/** The payer allowance of a code under a coverage (its latest version's fee_schedule_ref). */
export async function resolveAllowance(
  tx: TenantTransaction,
  codeRef: string,
  serviceDate: string,
  coverageId: string,
): Promise<ResolvedFee | null> {
  const cov = await coverageOf(tx, coverageId);
  if (!cov || cov.feeScheduleRef === null) return null;
  const { rows } = await tx.query<FeeRow>(
    `${EFFECTIVE}
     WHERE s.purpose = 'allowance' AND s.schedule_ref = $3 LIMIT 1`,
    [codeRef, serviceDate, cov.feeScheduleRef],
  );
  return rows[0] ? toResolved(rows[0]) : null;
}

/** B9 fee schedules: versioned publication and the read C12 estimates use (seam, no C code edited). */
export function createFeeOperations(base: BillingBase) {
  const { deps, execute } = base;
  return {
    publishFeeSchedule(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<FeeScheduleCommandData>> {
      const op = 'billing.feeSchedules.publish';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<FeeSchedulePublish>(validateFeeSchedulePublish, p);
        if (p.purpose === 'allowance' && p.locationRef !== undefined)
          throw failed('allowance_location_not_allowed');
        const codes = new Set(p.items.map((i) => i.codeRef));
        if (codes.size !== p.items.length) throw failed('duplicate_code');
        return deps.withTenantTransaction(ctx, async (tx) =>
          execute<FeeScheduleCommandData>(ctx, envelope, tx, async () => {
            const settings = await loadSettings(tx);
            const fees: Money[] = p.items.map((i) => inTenantCurrency(settings, i.fee));
            if (fees.some((f) => f.minor < 0)) throw failed('negative_fee');
            const locationId = p.locationRef === undefined ? null : await locationIdOf(tx, p.locationRef);
            if (p.locationRef !== undefined && locationId === null) throw failed('location_unknown');
            const { rows: found } = await tx.query<{
              id: string;
              purpose: string;
              location_id: string | null;
            }>(
              'SELECT id, purpose, location_id FROM cuspatlas.billing_fee_schedules WHERE schedule_ref = $1',
              [p.scheduleRef],
            );
            let scheduleId = found[0]?.id;
            if (found[0] && (found[0].purpose !== p.purpose || found[0].location_id !== locationId)) {
              throw conflict('schedule_identity_mismatch', [{ kind: 'feeSchedule', ref: found[0].id }]);
            }
            try {
              if (!scheduleId) {
                const { rows } = await tx.query<{ id: string }>(
                  `INSERT INTO cuspatlas.billing_fee_schedules (tenant_id, schedule_ref, purpose, location_id, currency,
                     created_by)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id()) RETURNING id`,
                  [p.scheduleRef, p.purpose, locationId, settings.currency],
                );
                scheduleId = rows[0]?.id as string;
              }
              const { rows: last } = await tx.query<{ n: number; from: string | null; late: boolean }>(
                `SELECT coalesce(max(version_no), 0)::int AS n, to_char(max(effective_from), 'YYYY-MM-DD') AS from,
                   coalesce(max(effective_from) > $2::date, false) AS late
                 FROM cuspatlas.billing_fee_schedule_versions WHERE schedule_id = $1`,
                [scheduleId, p.effectiveFrom],
              );
              // A version may not be inserted before the latest one (that would reprice history).
              if (last[0]?.late === true) throw conflict('effective_date_out_of_order');
              const versionNo = (last[0]?.n ?? 0) + 1;
              const { rows: v } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.billing_fee_schedule_versions (tenant_id, schedule_id, version_no, effective_from,
                   item_count, reason_code, created_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3::date, $4, $5, cuspatlas.current_actor_id()) RETURNING id`,
                [scheduleId, versionNo, p.effectiveFrom, p.items.length, p.reasonCode ?? null],
              );
              const versionId = v[0]?.id as string;
              await tx.query(
                `INSERT INTO cuspatlas.billing_fee_schedule_items (tenant_id, version_id, code_ref, fee_minor)
                 SELECT cuspatlas.current_tenant_id(), $1, c, f FROM unnest($2::text[], $3::bigint[]) AS x (c, f)`,
                [versionId, p.items.map((i) => i.codeRef), fees.map((f) => String(f.minor))],
              );
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: FEE_SCHEDULE_RESOURCE,
                  resourceRef: scheduleId,
                  resourceVersion: versionNo,
                },
                { changedFields: ['version', 'items'] },
              );
              return {
                data: { feeScheduleRef: scheduleId, versionRef: versionId, versionNo },
                version: versionNo,
              };
            } catch (err) {
              if (isPgError(err, '23505'))
                throw new RefusalError({
                  code: 'conflict',
                  retryable: true,
                  detail: { reason: 'concurrent_publish' },
                });
              throw err;
            }
          }),
        );
      });
    },

    /** resolveFee (B9 contract) and the C12 read: practice fee and, with a coverage, the allowance. */
    resolveFee(ctx: ActorContext, query: unknown): Promise<FeeResolution> {
      const op = 'billing.fees.resolve';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<FeeResolveQuery>(validateFeeResolveQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const locationId =
            query.locationRef === undefined ? null : await locationIdOf(tx, query.locationRef);
          let allowance: ResolvedFee | null = null;
          if (query.coverageRef !== undefined) {
            const cov = await coverageOf(tx, query.coverageRef);
            if (!cov) throw failed('coverage_unknown');
            await mergeSet(tx, cov.patientId);
            allowance = await resolveAllowance(tx, query.codeRef, query.serviceDate, cov.id);
          }
          const practice = await resolvePracticeFee(tx, query.codeRef, query.serviceDate, locationId);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: FEE_SCHEDULE_RESOURCE,
            resourceRefs: [practice?.feeScheduleRef, allowance?.feeScheduleRef].filter(
              (x): x is string => x !== undefined,
            ),
            queryFields: Object.keys(query as object),
          });
          return { codeRef: query.codeRef, serviceDate: query.serviceDate, practice, allowance };
        });
      });
    },
  };
}
