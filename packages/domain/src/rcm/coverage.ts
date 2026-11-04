import { createHash } from 'node:crypto';
import {
  type ActorContext,
  type BenefitFrequency,
  type BenefitLimit,
  type BenefitProvenance,
  type Benefits,
  type CommandEnvelope,
  type CommandResult,
  type CoverageChangeInput,
  type CoverageCommandData,
  type CoverageQuery,
  type CoverageRecordInput,
  type CoverageResolution,
  type CoverageSummary,
  type CoverageVersionView,
  type CoverageView,
  type EligibilityCommandData,
  type EligibilityInput,
  type EligibilityState,
  type EligibilityView,
  moneyFromMinorText,
  RefusalError,
  type TenantTransaction,
  validateCoverageChange,
  validateCoverageQuery,
  validateCoverageRecord,
  validateEligibilityRecord,
} from '@cuspatlas/contracts';
import {
  assertNotMerged,
  assertRef,
  type BillingBase,
  checkEnvelope,
  conflict,
  failed,
  inTenantCurrency,
  loadPatient,
  loadSettings,
  mergeSet,
  notFound,
  type PatientRow,
  validate,
} from '../billing/base';
import { committedReplay, providerTiming, withTimeout } from '../billing/payments';
import { canonicalJson, idempotencyKeyDigest, sha256Hex } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';

export const COVERAGE_RESOURCE = 'coverage';
export const ELIGIBILITY_RESOURCE = 'coverageEligibility';
/** Default freshness window of an eligibility record (synthetic default, pending approval). */
export const DEFAULT_FRESHNESS_HOURS = 168;
const RANK = { primary: 1, secondary: 2, tertiary: 3 } as const;
const RANK_NAME = ['primary', 'secondary', 'tertiary'] as const;

/**
 * Eligibility source port (B5; B-S3 eligibility source qualification is blocked-on-discovery). It
 * accepts a stable request key and answers `confirmed` (with a response detail), `declined` (the
 * payer reports the member inactive) or `unknown` (timeout: never ineligible). The detail is mapped
 * by the domain; an unmappable detail is kept as raw evidence, never partially interpreted.
 */
export interface EligibilityRequest {
  readonly requestKey: string;
  readonly payerRef: string;
  readonly memberRef: string;
  readonly serviceDate: string;
}
export interface EligibilityAnswer {
  readonly outcome: 'confirmed' | 'declined' | 'unknown';
  readonly receiptId?: string;
  readonly detail?: unknown;
}
export interface EligibilityPort {
  check(request: EligibilityRequest): Promise<EligibilityAnswer>;
}

/**
 * The only eligibility source: synthetic, in-process and deterministic, chosen by the synthetic payer
 * reference: `syn-payer-timeout...` times out, `syn-payer-unmapped...` answers an unknown format,
 * `syn-payer-inactive...` declines, anything else confirms an active member with synthetic limits.
 * Not a model of any real payer or clearinghouse.
 */
export function createFakeEligibilityAdapter(): EligibilityPort {
  const receipt = (key: string) =>
    `syn-elig-${createHash('sha256').update(`synthetic-eligibility:${key}`).digest('hex').slice(0, 32)}`;
  return {
    async check(r) {
      if (r.payerRef.startsWith('syn-payer-timeout')) return { outcome: 'unknown' };
      if (r.payerRef.startsWith('syn-payer-unmapped')) {
        return {
          outcome: 'confirmed',
          receiptId: receipt(r.requestKey),
          detail: { format: 'syn-unknown-v9', segments: ['syn-seg-1', 'syn-seg-2'] },
        };
      }
      if (r.payerRef.startsWith('syn-payer-inactive'))
        return { outcome: 'declined', receiptId: receipt(r.requestKey) };
      return {
        outcome: 'confirmed',
        receiptId: receipt(r.requestKey),
        detail: {
          format: 'syn-elig-v1',
          active: true,
          annualMaximumMinor: 150000,
          deductibleMinor: 5000,
          frequencies: [{ code: 'SYN-PROPHY', count: 2, periodMonths: 12 }],
        },
      };
    },
  };
}

interface MappedDetail {
  readonly active: boolean;
  readonly annualMaximumMinor: number;
  readonly deductibleMinor: number;
  readonly frequencies: readonly BenefitFrequency[];
}
const isCount = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;

/** Maps the synthetic v1 response format exactly, or returns null (the response stays unparsed). */
function mapDetail(detail: unknown): MappedDetail | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as Record<string, unknown>;
  if (d.format !== 'syn-elig-v1' || typeof d.active !== 'boolean') return null;
  if (!isCount(d.annualMaximumMinor, 99999999999) || !isCount(d.deductibleMinor, 99999999999)) return null;
  if (!Array.isArray(d.frequencies) || d.frequencies.length > 20) return null;
  const frequencies: BenefitFrequency[] = [];
  for (const f of d.frequencies as unknown[]) {
    const x = f as Record<string, unknown>;
    if (typeof x?.code !== 'string' || !/^SYN-[A-Z0-9]{1,12}$/.test(x.code)) return null;
    if (!isCount(x.count, 99) || !isCount(x.periodMonths, 120) || x.periodMonths === 0) return null;
    frequencies.push({ categoryCode: x.code, count: x.count, periodMonths: x.periodMonths });
  }
  return {
    active: d.active,
    annualMaximumMinor: d.annualMaximumMinor,
    deductibleMinor: d.deductibleMinor,
    frequencies,
  };
}

interface CoverageRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  payer_ref: string;
  version: number;
}

async function loadCoverage(tx: TenantTransaction, coverageRef: string, lock = ''): Promise<CoverageRow> {
  assertRef(coverageRef);
  const { rows } = await tx.query<CoverageRow>(
    `SELECT id, patient_id, payer_ref, version FROM cuspatlas.rcm_coverages WHERE id = $1 ${lock}`,
    [coverageRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * The B1/B2 seam: the coverage an insurer responsibility line names. Hidden, missing and malformed
 * references are one 404; `effectiveOn` checks the latest version against a service date.
 */
export async function loadCoverageForCharge(
  tx: TenantTransaction,
  coverageRef: string,
): Promise<CoverageRow & { effectiveOn(serviceDate: string): Promise<boolean> }> {
  const row = await loadCoverage(tx, coverageRef);
  return {
    ...row,
    async effectiveOn(serviceDate) {
      const { rows } = await tx.query<{ ok: boolean }>(
        `SELECT (v.effective_from <= $2::date AND (v.effective_until IS NULL OR v.effective_until >= $2::date)) AS ok
         FROM cuspatlas.rcm_coverage_versions v WHERE v.coverage_id = $1 ORDER BY v.coverage_version DESC LIMIT 1`,
        [row.id, serviceDate],
      );
      return rows[0]?.ok === true;
    },
  };
}

interface VersionRow extends Record<string, unknown> {
  coverage_id: string;
  coverage_version: number;
  benefit_rank: 1 | 2 | 3;
  subscriber_patient_id: string;
  relationship_to_subscriber: CoverageVersionView['relationshipToSubscriber'];
  member_ref: string;
  group_ref: string | null;
  fee_schedule_ref: string | null;
  effective_from: string;
  effective_until: string | null;
  overlap_override_reason: string | null;
  reason_code: string | null;
  created_at: Date;
  created_by: string;
}
const VERSION_COLUMNS = `v.coverage_id, v.coverage_version, v.benefit_rank, v.subscriber_patient_id,
  v.relationship_to_subscriber, v.member_ref, v.group_ref, v.fee_schedule_ref,
  to_char(v.effective_from, 'YYYY-MM-DD') AS effective_from, to_char(v.effective_until, 'YYYY-MM-DD') AS effective_until,
  v.overlap_override_reason, v.reason_code, v.created_at, v.created_by`;
const toVersion = (v: VersionRow): CoverageVersionView => ({
  coverageVersion: v.coverage_version,
  rank: RANK_NAME[v.benefit_rank - 1] as CoverageVersionView['rank'],
  subscriberRef: v.subscriber_patient_id,
  relationshipToSubscriber: v.relationship_to_subscriber,
  memberRef: v.member_ref,
  groupRef: v.group_ref,
  feeScheduleRef: v.fee_schedule_ref,
  effectiveFrom: v.effective_from,
  effectiveUntil: v.effective_until,
  overlapOverrideReasonCode: v.overlap_override_reason,
  reasonCode: v.reason_code,
  recordedAt: v.created_at.toISOString(),
  recordedByRef: v.created_by,
});

interface EligibilityRow extends Record<string, unknown> {
  id: string;
  coverage_id: string;
  coverage_version: number;
  source: EligibilityView['source'];
  state: EligibilityState;
  service_date: string;
  retrieved_at: Date;
  fresh_until: Date;
  freshness_hours: number;
  benefits: Benefits;
  raw_evidence_digest: string | null;
  created_by: string;
  current?: boolean;
}
const ELIGIBILITY_COLUMNS = `e.id, e.coverage_id, e.coverage_version, e.source, e.state,
  to_char(e.service_date, 'YYYY-MM-DD') AS service_date, e.retrieved_at,
  e.retrieved_at + make_interval(hours => e.freshness_hours) AS fresh_until, e.freshness_hours, e.benefits,
  e.raw_evidence_digest, e.created_by`;
const toEligibility = (e: EligibilityRow): EligibilityView => ({
  eligibilityRef: e.id,
  coverageVersion: e.coverage_version,
  source: e.source,
  state: e.state,
  serviceDate: e.service_date,
  retrievedAt: e.retrieved_at.toISOString(),
  freshUntil: e.fresh_until.toISOString(),
  freshnessHours: e.freshness_hours,
  benefits: e.benefits,
  rawEvidenceDigest: e.raw_evidence_digest,
  recordedByRef: e.created_by,
});

/**
 * B5 coverage, eligibility records and coverage provenance (ADR 0008, recommended-pending-billing-
 * approval; live eligibility blocked-on-discovery, B-S3). Coverage is versioned and effective-dated;
 * eligibility is a dated record with source, capture instant and freshness window; the coverage
 * status C12 estimates read is derived per service date. No estimate is constructed here, and no
 * eligibility result is ever presented as a payment guarantee (CL-01).
 */
export function createCoverageOperations(
  base: BillingBase,
  port: EligibilityPort = createFakeEligibilityAdapter(),
) {
  const { deps, execute } = base;
  const timing = providerTiming(deps);

  /** Serializes coverage writes of one patient (overlap checks cannot race). */
  const lockPatient = (tx: TenantTransaction, patientId: string) =>
    tx.query('SELECT id FROM cuspatlas.patients WHERE id = $1 FOR NO KEY UPDATE', [patientId]);

  function checkTerms(
    patient: PatientRow,
    subscriber: PatientRow,
    p: Pick<CoverageRecordInput, 'relationshipToSubscriber' | 'effectiveFrom' | 'effectiveUntil'>,
  ): void {
    assertNotMerged(patient);
    assertNotMerged(subscriber);
    if ((subscriber.id === patient.id) !== (p.relationshipToSubscriber === 'self'))
      throw failed('subscriber_relationship_mismatch');
    if (p.effectiveUntil !== undefined && p.effectiveUntil < p.effectiveFrom)
      throw failed('invalid_effective_range');
  }

  async function assertNoOverlap(
    tx: TenantTransaction,
    patientId: string,
    selfId: string | null,
    p: Pick<CoverageRecordInput, 'rank' | 'effectiveFrom' | 'effectiveUntil' | 'overlapOverride'>,
  ): Promise<void> {
    const set = await mergeSet(tx, patientId);
    const { rows } = await tx.query<{ id: string }>(
      `SELECT c.id FROM cuspatlas.rcm_coverages c
       JOIN LATERAL (SELECT * FROM cuspatlas.rcm_coverage_versions v WHERE v.coverage_id = c.id
                     ORDER BY v.coverage_version DESC LIMIT 1) v ON true
       WHERE c.patient_id = ANY ($1::uuid[]) AND ($2::uuid IS NULL OR c.id <> $2::uuid) AND v.benefit_rank = $3
         AND daterange(v.effective_from, v.effective_until, '[]') && daterange($4::date, $5::date, '[]')
       ORDER BY c.created_at, c.id LIMIT 5`,
      [set.ids, selfId, RANK[p.rank], p.effectiveFrom, p.effectiveUntil ?? null],
    );
    if (rows.length > 0 && p.overlapOverride === undefined) {
      throw conflict(
        'overlapping_coverage',
        rows.map((r) => ({ kind: 'coverage', ref: r.id })),
      );
    }
  }

  async function insertVersion(
    tx: TenantTransaction,
    coverageId: string,
    version: number,
    subscriberId: string,
    p: CoverageRecordInput | CoverageChangeInput,
    reasonCode: string | null,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO cuspatlas.rcm_coverage_versions (tenant_id, coverage_id, coverage_version, benefit_rank,
         subscriber_patient_id, relationship_to_subscriber, member_ref, group_ref, fee_schedule_ref, effective_from,
         effective_until, overlap_override_reason, reason_code, created_by)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12,
         cuspatlas.current_actor_id())`,
      [
        coverageId,
        version,
        RANK[p.rank],
        subscriberId,
        p.relationshipToSubscriber,
        p.memberRef,
        p.groupRef ?? null,
        p.feeScheduleRef ?? null,
        p.effectiveFrom,
        p.effectiveUntil ?? null,
        p.overlapOverride?.reasonCode ?? null,
        reasonCode,
      ],
    );
  }

  async function eligibilityOf(
    tx: TenantTransaction,
    coverageIds: readonly string[],
    serviceDate: string | null,
  ) {
    // Review S3: a record is current for a service date only when it was checked for that date, on
    // the coverage's latest version, and it is still inside its freshness window now.
    const { rows } = await tx.query<EligibilityRow>(
      `SELECT ${ELIGIBILITY_COLUMNS},
         (e.service_date = $2::date
           AND e.coverage_version = (SELECT max(v.coverage_version) FROM cuspatlas.rcm_coverage_versions v
                                     WHERE v.coverage_id = e.coverage_id)
           AND now() <= e.retrieved_at + make_interval(hours => e.freshness_hours)) AS current
       FROM cuspatlas.rcm_eligibility_records e WHERE e.coverage_id = ANY ($1::uuid[])
       ORDER BY e.retrieved_at, e.created_at, e.id LIMIT 1000`,
      [[...coverageIds], serviceDate],
    );
    return rows;
  }

  return {
    /** recordCoverage (B5 contract). */
    recordCoverage(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<CoverageCommandData>> {
      const op = 'rcm.coverages.record';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<CoverageRecordInput>(validateCoverageRecord, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadPatient(tx, p.patientRef);
          const subscriber = p.subscriberRef === undefined ? patient : await loadPatient(tx, p.subscriberRef);
          await lockPatient(tx, patient.id);
          return execute<CoverageCommandData>(ctx, envelope, tx, async () => {
            checkTerms(patient, subscriber, p);
            await assertNoOverlap(tx, patient.id, null, p);
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.rcm_coverages (tenant_id, patient_id, payer_ref, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id()) RETURNING id`,
              [patient.id, p.payerRef],
            );
            const coverageRef = rows[0]?.id as string;
            await insertVersion(tx, coverageRef, 1, subscriber.id, p, null);
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: COVERAGE_RESOURCE,
                resourceRef: coverageRef,
                resourceVersion: 1,
              },
              { changedFields: ['coverage'] },
            );
            return { data: { coverageRef, coverageVersion: 1 }, version: 1 };
          });
        });
      });
    },

    /** A new coverage version (changing coverage history); earlier versions are never rewritten. */
    changeCoverage(
      ctx: ActorContext,
      coverageRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<CoverageCommandData>> {
      const op = 'rcm.coverages.change';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<CoverageChangeInput>(validateCoverageChange, p);
        assertRef(coverageRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const cov = await loadCoverage(tx, coverageRef);
          const patient = await loadPatient(tx, cov.patient_id);
          const subscriber = p.subscriberRef === undefined ? patient : await loadPatient(tx, p.subscriberRef);
          await lockPatient(tx, patient.id);
          await loadCoverage(tx, coverageRef, 'FOR UPDATE');
          return execute<CoverageCommandData>(
            ctx,
            { ...envelope, payload: { coverageRef, ...p } },
            tx,
            async () => {
              const current = await loadCoverage(tx, coverageRef);
              if (p.expectedVersion !== current.version) {
                throw new RefusalError({
                  code: 'stale_version',
                  detail: { currentVersion: current.version },
                });
              }
              checkTerms(patient, subscriber, p);
              await assertNoOverlap(tx, patient.id, current.id, p);
              const version = current.version + 1;
              await insertVersion(tx, current.id, version, subscriber.id, p, p.reasonCode);
              await tx.query(
                'UPDATE cuspatlas.rcm_coverages SET version = version + 1, updated_at = now() WHERE id = $1',
                [current.id],
              );
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: COVERAGE_RESOURCE,
                  resourceRef: current.id,
                  resourceVersion: version,
                },
                { changedFields: ['coverageVersion'] },
              );
              return { data: { coverageRef: current.id, coverageVersion: version }, version };
            },
          );
        });
      });
    },

    getCoverage(ctx: ActorContext, coverageRef: string): Promise<CoverageView> {
      const op = 'rcm.coverages.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertRef(coverageRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const cov = await loadCoverage(tx, coverageRef);
          const { rows } = await tx.query<VersionRow>(
            `SELECT ${VERSION_COLUMNS} FROM cuspatlas.rcm_coverage_versions v WHERE v.coverage_id = $1
             ORDER BY v.coverage_version`,
            [cov.id],
          );
          const history = rows.map(toVersion);
          const eligibility = (await eligibilityOf(tx, [cov.id], null)).map(toEligibility);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: COVERAGE_RESOURCE,
            resourceRefs: [cov.id],
            queryFields: [],
          });
          return {
            coverageRef: cov.id,
            patientRef: cov.patient_id,
            payerRef: cov.payer_ref,
            current: history[history.length - 1] as CoverageVersionView,
            history,
            eligibility,
            version: cov.version,
          };
        });
      });
    },

    /**
     * resolveActiveCoverage (B5 contract) and the coverage-status read C12 estimates use: the
     * coverages of the patient's account effective on the service date, in benefit order, each with
     * the latest usable eligibility record, its freshness for that date and the derived status.
     */
    resolveCoverage(ctx: ActorContext, patientRef: string, query: unknown): Promise<CoverageResolution> {
      const op = 'rcm.coverages.resolve';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<CoverageQuery>(validateCoverageQuery, query);
        assertRef(patientRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadPatient(tx, patientRef);
          const set = await mergeSet(tx, patient.id);
          const { rows } = await tx.query<VersionRow & { payer_ref: string }>(
            `SELECT ${VERSION_COLUMNS}, c.payer_ref FROM cuspatlas.rcm_coverages c
             JOIN LATERAL (SELECT * FROM cuspatlas.rcm_coverage_versions x WHERE x.coverage_id = c.id
                           ORDER BY x.coverage_version DESC LIMIT 1) v ON true
             WHERE c.patient_id = ANY ($1::uuid[]) AND v.effective_from <= $2::date
               AND (v.effective_until IS NULL OR v.effective_until >= $2::date)
             ORDER BY v.benefit_rank, v.effective_from, c.created_at, c.id LIMIT 10`,
            [set.ids, query.serviceDate],
          );
          const records = await eligibilityOf(
            tx,
            rows.map((r) => r.coverage_id),
            query.serviceDate,
          );
          const coverages: CoverageSummary[] = rows.map((r) => {
            const mine = records.filter((e) => e.coverage_id === r.coverage_id);
            const usable = mine.filter((e) => e.state === 'verified' || e.state === 'unverified');
            const best = usable[usable.length - 1];
            const last = mine[mine.length - 1];
            const v = toVersion(r);
            return {
              coverageRef: r.coverage_id,
              coverageVersion: v.coverageVersion,
              payerRef: r.payer_ref,
              rank: v.rank,
              subscriberRef: v.subscriberRef,
              relationshipToSubscriber: v.relationshipToSubscriber,
              feeScheduleRef: v.feeScheduleRef,
              effectiveFrom: v.effectiveFrom,
              effectiveUntil: v.effectiveUntil,
              coverageStatus: !best
                ? 'unknown'
                : best.current !== true
                  ? 'stale'
                  : best.state === 'verified' &&
                      (best.benefits as { status?: { value?: string } }).status?.value === 'inactive'
                    ? 'inactive'
                    : 'entered',
              eligibility: best
                ? { ...toEligibility(best), freshness: best.current === true ? 'current' : 'stale' }
                : null,
              latestAttempt: last
                ? { eligibilityRef: last.id, state: last.state, retrievedAt: last.retrieved_at.toISOString() }
                : null,
              paymentAssurance: 'none',
            };
          });
          const { rows: at } = await tx.query<{ at: Date }>('SELECT now() AS at');
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'patient',
            resourceRefs: set.ids.slice(0, 100),
            queryFields: ['serviceDate'],
          });
          return {
            patientRef: patient.id,
            serviceDate: query.serviceDate,
            coverages,
            checkedAt: (at[0]?.at ?? new Date()).toISOString(),
          };
        });
      });
    },

    /** recordEligibility (B5 contract): staff entry (unverified) or one fake-adapter request. */
    recordEligibility(
      ctx: ActorContext,
      coverageRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<EligibilityCommandData>> {
      const op = 'rcm.eligibility.record';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<EligibilityInput>(validateEligibilityRecord, p);
        assertRef(coverageRef);
        // Review M2: the fake adapter is called outside any transaction (no coverage lock is held
        // while it answers) and with a timeout; a throw or a timeout is an unknown result. The call is
        // a side-effect-free status check, so a lost result only means a new check (no request row).
        let checked: { coverageVersion: number; answer: EligibilityAnswer } | null = null;
        if (p.source === 'fake_adapter') {
          if (p.benefits !== undefined || p.retrievedAt !== undefined) throw failed('benefits_not_allowed');
          const pre = await deps.withTenantTransaction(ctx, async (tx) => {
            const cov = await loadCoverage(tx, coverageRef);
            if (await committedReplay(tx, op, envelope.idempotencyKey)) return null;
            const { rows: vr } = await tx.query<VersionRow>(
              `SELECT ${VERSION_COLUMNS} FROM cuspatlas.rcm_coverage_versions v WHERE v.coverage_id = $1
               ORDER BY v.coverage_version DESC LIMIT 1`,
              [cov.id],
            );
            return { cov, version: vr[0] as VersionRow };
          });
          if (pre !== null) {
            const unknown: EligibilityAnswer = { outcome: 'unknown' };
            const answer = await withTimeout(
              () =>
                port.check({
                  requestKey: sha256Hex(
                    `rcm-eligibility:${ctx.tenantId}:${pre.cov.id}:${idempotencyKeyDigest(envelope.idempotencyKey)}`,
                  ),
                  payerRef: pre.cov.payer_ref,
                  memberRef: pre.version.member_ref,
                  serviceDate: p.serviceDate,
                }),
              timing.timeoutMs,
              unknown,
            );
            checked = { coverageVersion: pre.version.coverage_version, answer };
          }
        }
        return deps.withTenantTransaction(ctx, async (tx) => {
          const cov = await loadCoverage(tx, coverageRef, 'FOR SHARE');
          return execute<EligibilityCommandData>(
            ctx,
            { ...envelope, payload: { coverageRef, ...p } },
            tx,
            async () => {
              const { rows: vr } = await tx.query<VersionRow>(
                `SELECT ${VERSION_COLUMNS} FROM cuspatlas.rcm_coverage_versions v WHERE v.coverage_id = $1
                 ORDER BY v.coverage_version DESC LIMIT 1`,
                [cov.id],
              );
              // The record names the coverage version the adapter was asked about.
              const version = checked
                ? ({ ...(vr[0] as VersionRow), coverage_version: checked.coverageVersion } as VersionRow)
                : (vr[0] as VersionRow);
              const { rows: clock } = await tx.query<{ now: Date; future: boolean }>(
                `SELECT now() AS now, coalesce($1::timestamptz > now() + interval '5 minutes', false) AS future`,
                [p.retrievedAt ?? null],
              );
              const now = (clock[0] as { now: Date }).now;
              let state: EligibilityState;
              let benefits: Benefits = {};
              let receipt: string | null = null;
              let raw: unknown = null;
              let retrievedAt = now.toISOString();
              if (p.source === 'entered') {
                if (clock[0]?.future === true) throw failed('retrieved_in_future');
                if (p.retrievedAt !== undefined) retrievedAt = new Date(p.retrievedAt).toISOString();
                const settings = await loadSettings(tx);
                const prov: BenefitProvenance = {
                  source: 'entered',
                  capturedAt: retrievedAt,
                  recordedByRef: ctx.actorId,
                  receiptRef: null,
                };
                const b = p.benefits ?? {};
                const limits: BenefitLimit[] = (b.limits ?? []).map((l) => {
                  const amount = inTenantCurrency(settings, l.amount);
                  if (amount.minor < 0) throw failed('invalid_limit');
                  return { kind: l.kind, amount };
                });
                benefits = {
                  ...(b.activeStatus === undefined
                    ? {}
                    : { status: { value: b.activeStatus, provenance: prov } }),
                  ...(b.limits === undefined ? {} : { limits: { items: limits, provenance: prov } }),
                  ...(b.frequencies === undefined
                    ? {}
                    : { frequencies: { items: [...b.frequencies], provenance: prov } }),
                };
                // Staff-entered eligibility is labeled unverified until a qualified source exists (B-S3).
                state = 'unverified';
              } else {
                // Only a stored result can be replayed; without a check there is nothing to record.
                if (checked === null) throw new RefusalError({ code: 'conflict', retryable: true });
                const answer = checked.answer;
                receipt =
                  typeof answer.receiptId === 'string' && /^syn-elig-[a-z0-9]{1,64}$/.test(answer.receiptId)
                    ? answer.receiptId
                    : null;
                const prov: BenefitProvenance = {
                  source: 'fake_adapter',
                  capturedAt: retrievedAt,
                  recordedByRef: ctx.actorId,
                  receiptRef: receipt,
                };
                if (answer.outcome === 'unknown') {
                  // A timeout is unknown, never ineligible, and draws no coverage conclusion.
                  state = 'unknown';
                } else if (answer.outcome === 'declined') {
                  state = 'verified';
                  benefits = { status: { value: 'inactive', provenance: prov } };
                } else {
                  const mapped = mapDetail(answer.detail);
                  if (mapped === null) {
                    state = 'unparsed';
                    raw = answer.detail ?? {};
                  } else {
                    const currency = (await loadSettings(tx)).currency;
                    const money = (minor: number) => moneyFromMinorText(currency, String(minor));
                    state = 'verified';
                    benefits = {
                      status: { value: mapped.active ? 'active' : 'inactive', provenance: prov },
                      limits: {
                        items: [
                          { kind: 'annual_maximum', amount: money(mapped.annualMaximumMinor) },
                          { kind: 'deductible', amount: money(mapped.deductibleMinor) },
                        ],
                        provenance: prov,
                      },
                      frequencies: { items: [...mapped.frequencies], provenance: prov },
                    };
                  }
                }
              }
              const rawText = raw === null ? null : canonicalJson(raw);
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.rcm_eligibility_records (tenant_id, coverage_id, coverage_version, source, state,
                   service_date, retrieved_at, freshness_hours, benefits, adapter_receipt, raw_evidence, raw_evidence_digest,
                   created_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5::date, $6, $7, $8::jsonb, $9, $10::jsonb, $11,
                   cuspatlas.current_actor_id())
                 RETURNING id`,
                [
                  cov.id,
                  version.coverage_version,
                  p.source,
                  state,
                  p.serviceDate,
                  retrievedAt,
                  p.freshnessHours ?? DEFAULT_FRESHNESS_HOURS,
                  canonicalJson(benefits),
                  receipt,
                  rawText,
                  rawText === null ? null : sha256Hex(rawText),
                ],
              );
              const eligibilityRef = rows[0]?.id as string;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: ELIGIBILITY_RESOURCE,
                  resourceRef: eligibilityRef,
                  resourceVersion: 1,
                },
                { changedFields: ['eligibility'] },
              );
              return { data: { eligibilityRef, state }, version: 1 };
            },
          );
        });
      });
    },
  };
}
