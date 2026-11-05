import {
  type ActorContext,
  assertValid,
  CLINICAL_PROPERTIES,
  type CommandEnvelope,
  type CommandResult,
  type CoverageStatus,
  type Estimate,
  type EstimateAccept,
  type EstimateAssumptionInput,
  type EstimateConsentBinding,
  type EstimateGenerate,
  type EstimatePresent,
  type Money,
  type PatientResponsibility,
  type PlanAlternative,
  type PlanAlternativeCreate,
  RefusalError,
  type TenantTransaction,
  type TreatmentPlanCommandData,
  validateEstimateAccept,
  validateEstimateGenerate,
  validateEstimatePresent,
  validatePlanAlternativeCreate,
} from '@cuspatlas/contracts';
import { transactionNow } from '../clock';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { resolveClinicalAuthor } from './authorship';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, notFound, UUID } from './base';
import { assertNotMerged, loadClinicalPatient, requireOpenEncounter } from './encounters';
import {
  computeInsurerEstimate,
  type InsurerEstimate,
  insurerEstimateAt,
  insurerEstimateUnavailable,
} from './insurer-estimate';
import {
  planById,
  projectPlan,
  recordPlanVersionAcceptance,
  TREATMENT_PLAN_RESOURCE,
} from './treatment-plans';

export const ESTIMATE_RESOURCE = 'clinicalEstimate';
export const PLAN_ACCEPTANCE_RESOURCE = 'clinicalPlanAcceptance';
/**
 * Engineering tolerance (not a payer or practice rule; pending decision C12-P2): a coverage
 * reference whose source is older than this is shown as stale, never silently reused.
 */
export const COVERAGE_STALE_AFTER_MS = 30 * 86_400_000;
const MAX_ESTIMATES = 200;
const OPEN = new Set(['proposed', 'accepted', 'scheduled']);

interface EstimateRow extends Record<string, unknown> {
  id: string;
  plan_version_id: string;
  number: number;
  supersedes_estimate_id: string | null;
  fee_schedule_version_ref: string | null;
  currency: string | null;
  gross_minor: string | null;
  complete: boolean;
  coverage_status: CoverageStatus;
  insurer_estimate: InsurerEstimate | null;
  created_by: string;
  created_at: Date;
  plan_id: string;
  subject_patient_id: string;
}

/** Whether a set of coverage assumptions is entered and fresh, absent or stale at an instant. */
export function coverageStatusAt(
  assumptions: readonly { readonly kind: string; readonly sourceAsOf: string | Date }[],
  at: number,
): CoverageStatus {
  const coverage = assumptions.filter((a) => a.kind === 'coverage');
  if (coverage.length === 0) return 'unknown';
  return coverage.some((a) => at - new Date(a.sourceAsOf).getTime() > COVERAGE_STALE_AFTER_MS)
    ? 'stale'
    : 'entered';
}

/**
 * B5 decides inactive, stale and unknown coverage (R-NIT, H1: an entered assumption never upgrades a
 * B5 `unknown`); otherwise the freshness of the caller-entered sources decides.
 */
export function mergeCoverageStatus(
  b5: 'none' | 'entered' | 'unknown' | 'stale' | 'inactive',
  fromSources: CoverageStatus,
): CoverageStatus {
  return b5 === 'inactive' || b5 === 'stale' || b5 === 'unknown' ? b5 : fromSources;
}

/**
 * The coverage status of a stored estimate now. A status B5 decided at generation (`inactive`, or a
 * `stale` eligibility record) stays; otherwise freshness of the entered sources is re-evaluated.
 */
export function coverageNowOf(
  stored: CoverageStatus,
  assumptions: readonly { readonly kind: string; readonly sourceAsOf: string | Date }[],
  at: number,
): CoverageStatus {
  // R-NIT (H1): a B5 `unknown` stays unknown even when an entered assumption exists.
  if (stored === 'inactive' || stored === 'stale' || stored === 'unknown') return stored;
  return coverageStatusAt(assumptions, at);
}

/** C-D7: a labelled unknown or a bounded range; never a guaranteed patient-responsibility figure. */
function responsibility(
  complete: boolean,
  status: CoverageStatus,
  gross: Money | null,
): PatientResponsibility {
  if (!complete || gross === null) return { kind: 'not_available', label: 'estimate_incomplete' };
  if (status === 'unknown') return { kind: 'unknown', label: 'coverage_unknown' };
  // B5 verified the coverage inactive: no insurer portion, the patient range is the gross alone.
  if (status === 'inactive') return { kind: 'range', low: gross, high: gross, basis: 'coverage_inactive' };
  return {
    kind: 'range',
    low: { currency: gross.currency, minor: 0 },
    high: gross,
    basis: 'coverage_not_applied',
  };
}

/** C12 insurer portion of a stored estimate now (input freshness re-checked at every read). */
function insurerEstimateOf(e: EstimateRow, at: number): InsurerEstimate {
  if (!e.complete) return insurerEstimateUnavailable('estimate_incomplete');
  // An estimate generated before the insurer portion existed carries no inputs: unknown, never guessed.
  if (e.insurer_estimate === null) return insurerEstimateUnavailable('coverage_unknown');
  return insurerEstimateAt(e.insurer_estimate, at);
}

/** The consent binding of an acceptance (C13 writes consents; until then it is outstanding). */
export type ConsentBindingReader = (
  tx: TenantTransaction,
  planVersionId: string,
) => Promise<EstimateConsentBinding>;
let consentBinding: ConsentBindingReader = async () => ({ status: 'outstanding', consentRefs: [] });
/** C13 registers its reader here so C12 never re-derives consent state itself. */
export function registerConsentBindingReader(reader: ConsentBindingReader): void {
  consentBinding = reader;
}

async function loadEstimate(
  tx: TenantTransaction,
  estimateId: string,
  lock = '',
): Promise<EstimateRow | null> {
  if (!UUID.test(estimateId)) return null;
  const { rows } = await tx.query<EstimateRow>(
    `SELECT e.id, e.plan_version_id, e.number, e.supersedes_estimate_id, e.fee_schedule_version_ref, e.currency,
       e.gross_minor::text AS gross_minor, e.complete, e.coverage_status, e.insurer_estimate, e.created_by, e.created_at, v.plan_id,
       p.subject_patient_id
     FROM cuspatlas.clinical_estimates e
     JOIN cuspatlas.clinical_plan_versions v ON v.id = e.plan_version_id AND v.tenant_id = e.tenant_id
     JOIN cuspatlas.clinical_treatment_plans p ON p.id = v.plan_id AND p.tenant_id = v.tenant_id
     WHERE e.id = $1 ${lock}`,
    [estimateId],
  );
  return rows[0] ?? null;
}

async function project(tx: TenantTransaction, e: EstimateRow): Promise<Estimate> {
  const { rows: lines } = await tx.query<{
    item_id: string;
    fee_schedule_ref: string;
    fee_schedule_version_ref: string | null;
    fee_currency: string;
    fee_minor: string;
  }>(
    `SELECT l.item_id, l.fee_schedule_ref, l.fee_schedule_version_ref, l.fee_currency, l.fee_minor::text AS fee_minor
     FROM cuspatlas.clinical_estimate_lines l
     JOIN cuspatlas.clinical_plan_items i ON i.id = l.item_id AND i.tenant_id = l.tenant_id
     WHERE l.estimate_id = $1 ORDER BY i.sequence, i.created_at, i.id`,
    [e.id],
  );
  const { rows: assumptions } = await tx.query<{
    kind: 'coverage' | 'discount';
    source_ref: string;
    source_as_of: Date;
  }>(
    `SELECT kind, source_ref, source_as_of FROM cuspatlas.clinical_estimate_assumptions WHERE estimate_id = $1
     ORDER BY ordinal`,
    [e.id],
  );
  const missing = await itemsWithoutFee(
    tx,
    e.plan_version_id,
    lines.map((l) => l.item_id),
  );
  const { rows: next } = await tx.query<{ id: string }>(
    'SELECT id FROM cuspatlas.clinical_estimates WHERE supersedes_estimate_id = $1',
    [e.id],
  );
  const { rows: pres } = await tx.query<{
    presented_by: string;
    presented_at: Date;
    coverage_status: CoverageStatus;
  }>(
    'SELECT presented_by, presented_at, coverage_status FROM cuspatlas.clinical_estimate_presentations WHERE estimate_id = $1',
    [e.id],
  );
  const { rows: acc } = await tx.query<{ id: string; accepted_by: string; accepted_at: Date }>(
    'SELECT id, accepted_by, accepted_at FROM cuspatlas.clinical_plan_acceptances WHERE estimate_id = $1',
    [e.id],
  );
  const gross: Money | null =
    e.gross_minor === null || e.currency === null
      ? null
      : { currency: e.currency, minor: Number(e.gross_minor) };
  const presentation = pres[0];
  const acceptance = acc[0];
  // Freshness is re-checked at the transaction's now(), the clock B5 decides eligibility freshness
  // with (`now() <= retrieved_at + freshness`), so the two never disagree (clock audit).
  const at = (await transactionNow(tx)).getTime();
  const coverageNow = coverageNowOf(
    e.coverage_status,
    assumptions.map((a) => ({ kind: a.kind, sourceAsOf: a.source_as_of })),
    at,
  );
  return {
    estimateRef: e.id,
    planRef: e.plan_id,
    planVersionRef: e.plan_version_id,
    patientRef: e.subject_patient_id,
    number: e.number,
    state: next[0] ? 'superseded' : 'current',
    supersedesRef: e.supersedes_estimate_id,
    supersededByRef: next[0]?.id ?? null,
    feeScheduleVersionRef: e.fee_schedule_version_ref,
    complete: e.complete,
    lines: lines.map((l) => ({
      planItemRef: l.item_id,
      feeScheduleRef: l.fee_schedule_ref,
      feeScheduleVersionRef: l.fee_schedule_version_ref,
      fee: { currency: l.fee_currency, minor: Number(l.fee_minor) },
    })),
    itemsWithoutFee: missing,
    assumptions: assumptions.map((a) => ({
      kind: a.kind,
      sourceRef: a.source_ref,
      sourceAsOf: a.source_as_of.toISOString(),
    })),
    // Coverage freshness is re-evaluated at every read: an entered source that has aged out reads stale.
    coverageStatus: coverageNow,
    grossAmount: gross,
    patientResponsibility: responsibility(e.complete, coverageNow, gross),
    insurerEstimate: insurerEstimateOf(e, at),
    notAGuarantee: true,
    presentation: presentation
      ? {
          presentedBy: presentation.presented_by,
          presentedAt: presentation.presented_at.toISOString(),
          coverageStatus: presentation.coverage_status,
        }
      : null,
    acceptance: acceptance
      ? {
          acceptanceRef: acceptance.id,
          planVersionRef: e.plan_version_id,
          estimateRef: e.id,
          scope: 'full',
          acceptedBy: acceptance.accepted_by,
          acceptedAt: acceptance.accepted_at.toISOString(),
          estimatePresented: presentation !== undefined,
          consent: await consentBinding(tx, e.plan_version_id),
        }
      : null,
    createdBy: e.created_by,
    createdAt: e.created_at.toISOString(),
  };
}

/** Open items of the version (not declined or discontinued) that this set of lines leaves unpriced. */
async function itemsWithoutFee(
  tx: TenantTransaction,
  versionId: string,
  pricedItemIds: readonly string[],
): Promise<string[]> {
  const { rows } = await tx.query<{ id: string; state: string }>(
    `SELECT i.id, (SELECT e.to_state FROM cuspatlas.clinical_plan_item_events e WHERE e.item_id = i.id
                    AND e.tenant_id = i.tenant_id ORDER BY e.sequence DESC LIMIT 1) AS state
     FROM cuspatlas.clinical_plan_items i WHERE i.plan_version_id = $1 ORDER BY i.sequence, i.created_at, i.id`,
    [versionId],
  );
  const priced = new Set(pricedItemIds);
  return rows.filter((r) => OPEN.has(r.state) && !priced.has(r.id)).map((r) => r.id);
}

type Ack = { readonly ref: string };

/** C12 commands and reads. No command computes coverage, posts money or records consent. */
export function createEstimateOperations(base: ClinicalBase) {
  const { deps, execute } = base;

  /** A plan version, its plan and patient (FOR SHARE for commands). Hidden in another tenant. */
  const locateVersion = async (
    tx: TenantTransaction,
    versionRef: string,
    lock: 'FOR SHARE' | '' = 'FOR SHARE',
  ) => {
    if (!UUID.test(versionRef)) throw notFound();
    const { rows } = await tx.query<{ plan_id: string; revision: number }>(
      'SELECT plan_id, revision FROM cuspatlas.clinical_plan_versions WHERE id = $1',
      [versionRef],
    );
    const v = rows[0];
    if (!v) throw notFound();
    const plan = await planById(tx, v.plan_id);
    if (!plan) throw notFound();
    const patient = await loadClinicalPatient(tx, plan.subject_patient_id, lock);
    return { plan, patient };
  };
  const locateEstimate = async (
    tx: TenantTransaction,
    estimateRef: string,
    lock: 'FOR SHARE' | '' = 'FOR SHARE',
  ) => {
    const e = await loadEstimate(tx, estimateRef);
    if (!e) throw notFound();
    await loadClinicalPatient(tx, e.subject_patient_id, lock);
    return e;
  };
  const answer = async (tx: TenantTransaction, estimateRef: string): Promise<Estimate> => {
    const e = await loadEstimate(tx, estimateRef);
    if (!e) throw notFound();
    return project(tx, e);
  };
  /** The current estimate of a version, after its version row is locked. */
  const currentOf = async (tx: TenantTransaction, versionId: string) => {
    const { rows } = await tx.query<{ id: string; number: number }>(
      `SELECT id, number FROM cuspatlas.clinical_estimates WHERE plan_version_id = $1 ORDER BY number DESC LIMIT 1`,
      [versionId],
    );
    return rows[0] ?? null;
  };
  const supersededConflict = (current: { id: string; number: number }) =>
    conflict('estimate_superseded', {
      currentVersion: current.number,
      blockingRefs: [{ kind: 'estimate', ref: current.id }],
    });
  const versionSuperseded = async (tx: TenantTransaction, versionId: string) => {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM cuspatlas.clinical_plan_versions WHERE supersedes_version_id = $1',
      [versionId],
    );
    if (rows[0])
      throw conflict('plan_version_superseded', { blockingRefs: [{ kind: 'planVersion', ref: rows[0].id }] });
  };

  return {
    generateEstimate(
      ctx: ActorContext,
      planVersionRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Estimate>> {
      const op = 'clinical.estimates.generate';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<EstimateGenerate>(validateEstimateGenerate, p, CLINICAL_PROPERTIES);
        const pricing = deps.estimatePricing;
        if (!pricing) throw conflict('fee_source_unavailable');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { patient } = await locateVersion(tx, planVersionRef);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { planVersionRef, ...p } },
            tx,
            async () => {
              // Serializes estimate versions and acceptance of this plan version.
              await tx.query('SELECT id FROM cuspatlas.clinical_plan_versions WHERE id = $1 FOR UPDATE', [
                planVersionRef,
              ]);
              await versionSuperseded(tx, planVersionRef);
              const { rows: items } = await tx.query<{
                id: string;
                fee_schedule_ref: string | null;
                procedure_code_ref: string;
                state: string;
              }>(
                `SELECT i.id, i.fee_schedule_ref, i.procedure_code_ref, (SELECT e.to_state FROM cuspatlas.clinical_plan_item_events e
                   WHERE e.item_id = i.id AND e.tenant_id = i.tenant_id ORDER BY e.sequence DESC LIMIT 1) AS state
                 FROM cuspatlas.clinical_plan_items i WHERE i.plan_version_id = $1`,
                [planVersionRef],
              );
              const byId = new Map(items.map((i) => [i.id, i]));
              // The service date is today at the plan version's encounter location (its IANA zone), else UTC;
              // the location's practice schedule is preferred over the tenant-wide one (B9).
              const { rows: at } = await tx.query<{ location_id: string | null; service_date: string }>(
                `SELECT en.location_id,
                   to_char((now() AT TIME ZONE coalesce(l.time_zone, 'UTC'))::date, 'YYYY-MM-DD') AS service_date
                 FROM cuspatlas.clinical_plan_versions v
                 LEFT JOIN cuspatlas.clinical_encounters en ON en.id = v.encounter_id AND en.tenant_id = v.tenant_id
                 LEFT JOIN cuspatlas.scheduling_locations l ON l.id = en.location_id AND l.tenant_id = en.tenant_id
                 WHERE v.id = $1`,
                [planVersionRef],
              );
              const serviceDate = at[0]?.service_date ?? new Date().toISOString().slice(0, 10);
              const locationId = at[0]?.location_id ?? null;
              const seen = new Set<string>();
              const priced: {
                planItemRef: string;
                procedureCodeRef: string;
                fee: Money;
                scheduleRef: string;
                versionRef: string;
              }[] = [];
              let currency: string | null = null;
              let gross = 0;
              for (const [n, line] of p.lines.entries()) {
                const item = byId.get(line.planItemRef);
                if (!item) throw failedAt(`/lines/${n}/planItemRef`, 'itemNotInVersion');
                if (seen.has(item.id)) throw failedAt(`/lines/${n}/planItemRef`, 'duplicateLine');
                // A declined or discontinued item is not priced.
                if (!OPEN.has(item.state)) throw failedAt(`/lines/${n}/planItemRef`, 'itemNotOpen');
                seen.add(item.id);
                if (item.fee_schedule_ref === null)
                  throw failedAt(`/lines/${n}/planItemRef`, 'itemWithoutFeeScheduleRef');
                if (line.fee !== undefined && line.fee.minor < 0)
                  throw failedAt(`/lines/${n}/fee/minor`, 'negativeFee');
                if (line.fee !== undefined && line.fee.minor > 10_000_000_000)
                  throw failedAt(`/lines/${n}/fee/minor`, 'feeTooLarge');
                // B9 is authoritative: no configured fee leaves the item unpriced (never a guessed amount);
                // a supplied fee is only a check and is refused when it differs from the server's.
                const server = await pricing.practiceFee(tx, {
                  procedureCodeRef: item.procedure_code_ref,
                  serviceDate,
                  locationId,
                });
                if (
                  line.fee !== undefined &&
                  (server === null ||
                    server.fee.currency !== line.fee.currency ||
                    server.fee.minor !== line.fee.minor)
                ) {
                  throw conflict('fee_mismatch', { blockingRefs: [{ kind: 'planItem', ref: item.id }] });
                }
                if (server === null) continue;
                if (server.fee.minor > 10_000_000_000) throw failedAt(`/lines/${n}/fee/minor`, 'feeTooLarge');
                if (currency !== null && server.fee.currency !== currency)
                  throw failedAt(`/lines/${n}/fee/currency`, 'mixedCurrency');
                currency = server.fee.currency;
                gross += server.fee.minor;
                priced.push({ planItemRef: item.id, procedureCodeRef: item.procedure_code_ref, ...server });
              }
              const missing = await itemsWithoutFee(
                tx,
                planVersionRef,
                priced.map((l) => l.planItemRef),
              );
              const complete = items.length > 0 && missing.length === 0 && priced.length > 0;
              const versions = [...new Set(priced.map((l) => l.versionRef))];
              if (
                p.feeScheduleVersionRef !== undefined &&
                versions.some((v) => v !== p.feeScheduleVersionRef)
              )
                throw conflict('fee_schedule_version_mismatch');
              const assumptions: readonly EstimateAssumptionInput[] = p.assumptions ?? [];
              const fromSources = coverageStatusAt(assumptions, (await transactionNow(tx)).getTime());
              // B5 decides inactive or stale eligibility; entered coverage values stay caller-sourced.
              const b5 = await pricing.coverage(tx, patient.id, serviceDate);
              const status: CoverageStatus = mergeCoverageStatus(b5, fromSources);
              // C12 insurer portion from B5 structured benefits and B9 allowances; unknown inputs fall back.
              let insurer: InsurerEstimate | null = null;
              if (complete && currency !== null) {
                const benefits = await pricing.benefitInputs(tx, patient.id, serviceDate);
                const lines = [];
                for (const l of priced) {
                  const allowance =
                    benefits.coverageRef === null || benefits.status !== 'entered'
                      ? null
                      : await pricing.allowance(tx, {
                          procedureCodeRef: l.procedureCodeRef,
                          serviceDate,
                          coverageRef: benefits.coverageRef,
                        });
                  lines.push({ ...l, allowance });
                }
                insurer = computeInsurerEstimate({
                  currency,
                  serviceDate,
                  readAt: (await transactionNow(tx)).toISOString(),
                  inputs: benefits,
                  lines,
                });
              }
              const head = await currentOf(tx, planVersionRef);
              if ((head?.number ?? 0) >= MAX_ESTIMATES) throw failedAt('/', 'tooManyEstimates');
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.clinical_estimates (tenant_id, plan_version_id, number, supersedes_estimate_id,
                 fee_schedule_version_ref, currency, gross_minor, complete, coverage_status, insurer_estimate, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, cuspatlas.current_actor_id())
               RETURNING id`,
                [
                  planVersionRef,
                  (head?.number ?? 0) + 1,
                  head?.id ?? null,
                  versions.length === 1 ? versions[0] : null,
                  complete ? currency : null,
                  complete ? gross : null,
                  complete,
                  status,
                  insurer === null ? null : JSON.stringify(insurer),
                ],
              );
              const id = rows[0]?.id;
              if (!id) throw new Error('insert returned no row');
              for (const line of priced) {
                await tx.query(
                  `INSERT INTO cuspatlas.clinical_estimate_lines (tenant_id, estimate_id, plan_version_id, item_id,
                   fee_schedule_ref, fee_schedule_version_ref, fee_currency, fee_minor)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
                  [
                    id,
                    planVersionRef,
                    line.planItemRef,
                    line.scheduleRef,
                    line.versionRef,
                    line.fee.currency,
                    line.fee.minor,
                  ],
                );
              }
              for (const [n, a] of assumptions.entries()) {
                await tx.query(
                  `INSERT INTO cuspatlas.clinical_estimate_assumptions (tenant_id, estimate_id, ordinal, kind, source_ref,
                   source_as_of) VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5)`,
                  [id, n + 1, a.kind, a.sourceRef, a.sourceAsOf],
                );
              }
              await recordCommand(
                tx,
                { operation: op, resourceType: ESTIMATE_RESOURCE, resourceRef: id, resourceVersion: 1 },
                { changedFields: ['lines', 'assumptions', 'coverageStatus'] },
              );
              return { data: { ref: id }, version: 1 };
            },
          );
          return { ...r, data: await answer(tx, r.data.ref) };
        });
      });
    },

    presentEstimate(
      ctx: ActorContext,
      estimateRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Estimate>> {
      const op = 'clinical.estimates.present';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<EstimatePresent>(validateEstimatePresent, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const e = await locateEstimate(tx, estimateRef);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { estimateRef, ...p } }, tx, async () => {
            await tx.query('SELECT id FROM cuspatlas.clinical_plan_versions WHERE id = $1 FOR UPDATE', [
              e.plan_version_id,
            ]);
            const current = await currentOf(tx, e.plan_version_id);
            if (current && current.id !== e.id) throw supersededConflict(current);
            if (p.expectedEstimateNumber !== undefined && p.expectedEstimateNumber !== e.number) {
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: e.number } });
            }
            if (!e.complete) {
              throw conflict('estimate_incomplete', { blockingRefs: [{ kind: 'estimate', ref: e.id }] });
            }
            const { rows: done } = await tx.query(
              'SELECT 1 FROM cuspatlas.clinical_estimate_presentations WHERE estimate_id = $1',
              [e.id],
            );
            if (done.length > 0)
              throw conflict('estimate_already_presented', {
                blockingRefs: [{ kind: 'estimate', ref: e.id }],
              });
            const { rows: assumptions } = await tx.query<{ kind: string; source_as_of: Date }>(
              'SELECT kind, source_as_of FROM cuspatlas.clinical_estimate_assumptions WHERE estimate_id = $1',
              [e.id],
            );
            const status = coverageNowOf(
              e.coverage_status,
              assumptions.map((a) => ({ kind: a.kind, sourceAsOf: a.source_as_of })),
              (await transactionNow(tx)).getTime(),
            );
            await tx.query(
              `INSERT INTO cuspatlas.clinical_estimate_presentations (tenant_id, estimate_id, coverage_status, presented_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id())`,
              [e.id, status],
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: ESTIMATE_RESOURCE, resourceRef: e.id, resourceVersion: 2 },
              { changedFields: ['presentation'] },
            );
            return { data: { ref: e.id }, version: 2 };
          });
          return { ...r, data: await answer(tx, r.data.ref) };
        });
      });
    },

    acceptEstimate(
      ctx: ActorContext,
      estimateRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Estimate>> {
      const op = 'clinical.estimates.accept';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<EstimateAccept>(validateEstimateAccept, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const e = await locateEstimate(tx, estimateRef);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { estimateRef, ...p } }, tx, async () => {
            if (p.scope !== 'full') {
              throw conflict('partial_acceptance_unsupported', {
                blockingRefs: [{ kind: 'estimate', ref: e.id }],
              });
            }
            await tx.query('SELECT id FROM cuspatlas.clinical_plan_versions WHERE id = $1 FOR UPDATE', [
              e.plan_version_id,
            ]);
            const current = await currentOf(tx, e.plan_version_id);
            if (current && current.id !== e.id) throw supersededConflict(current);
            // Another alternative for the same problem already accepted: this one stays unselected.
            const { rows: siblings } = await tx.query<{ id: string }>(
              `SELECT v.id FROM cuspatlas.clinical_plan_alternatives mine
               JOIN cuspatlas.clinical_plan_alternatives other ON other.group_id = mine.group_id
                 AND other.tenant_id = mine.tenant_id AND other.plan_id <> mine.plan_id
               JOIN cuspatlas.clinical_plan_versions v ON v.plan_id = other.plan_id AND v.tenant_id = other.tenant_id
               WHERE mine.plan_id = $1 AND v.state = 'accepted' LIMIT 1`,
              [e.plan_id],
            );
            if (siblings[0]) {
              throw conflict('alternative_already_accepted', {
                blockingRefs: [{ kind: 'planVersion', ref: siblings[0].id }],
              });
            }
            const { rows: v } = await tx.query<{ state: string }>(
              'SELECT state FROM cuspatlas.clinical_plan_versions WHERE id = $1',
              [e.plan_version_id],
            );
            if (v[0]?.state === 'accepted') {
              throw conflict('plan_version_accepted', {
                blockingRefs: [{ kind: 'planVersion', ref: e.plan_version_id }],
              });
            }
            const { rows: rev } = await tx.query<{ revision: number }>(
              'SELECT revision FROM cuspatlas.clinical_plan_versions WHERE id = $1',
              [e.plan_version_id],
            );
            if (rev[0]?.revision !== p.expectedRevision) {
              throw new RefusalError({
                code: 'stale_version',
                detail: { currentVersion: rev[0]?.revision ?? 0 },
              });
            }
            // Only what the patient was shown can be accepted, and only while it still holds: the estimate
            // was presented, still prices every open item of the version, and its coverage source did not age
            // out since the presentation.
            const { rows: shown } = await tx.query<{ coverage_status: CoverageStatus }>(
              'SELECT coverage_status FROM cuspatlas.clinical_estimate_presentations WHERE estimate_id = $1',
              [e.id],
            );
            const presentation = shown[0];
            if (!presentation) {
              throw conflict('estimate_not_presented', { blockingRefs: [{ kind: 'estimate', ref: e.id }] });
            }
            const { rows: priced } = await tx.query<{ item_id: string }>(
              'SELECT item_id FROM cuspatlas.clinical_estimate_lines WHERE estimate_id = $1',
              [e.id],
            );
            const unpriced = await itemsWithoutFee(
              tx,
              e.plan_version_id,
              priced.map((l) => l.item_id),
            );
            if (!e.complete || unpriced.length > 0) {
              throw conflict('estimate_incomplete', {
                blockingRefs: [
                  { kind: 'estimate', ref: e.id },
                  ...unpriced.slice(0, 19).map((ref) => ({ kind: 'planItem', ref })),
                ],
              });
            }
            const { rows: assumptions } = await tx.query<{ kind: string; source_as_of: Date }>(
              'SELECT kind, source_as_of FROM cuspatlas.clinical_estimate_assumptions WHERE estimate_id = $1',
              [e.id],
            );
            const coverageNow = coverageNowOf(
              e.coverage_status,
              assumptions.map((a) => ({ kind: a.kind, sourceAsOf: a.source_as_of })),
              (await transactionNow(tx)).getTime(),
            );
            if (coverageNow === 'stale' && presentation.coverage_status !== 'stale') {
              throw conflict('estimate_coverage_stale', { blockingRefs: [{ kind: 'estimate', ref: e.id }] });
            }
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.clinical_plan_acceptances (tenant_id, plan_version_id, estimate_id, scope, accepted_by,
                 accepted_revision)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, 'full', cuspatlas.current_actor_id(), $3) RETURNING id`,
              [e.plan_version_id, e.id, p.expectedRevision],
            );
            const acceptanceRef = rows[0]?.id;
            if (!acceptanceRef) throw new Error('insert returned no row');
            await recordPlanVersionAcceptance(tx, e.plan_version_id, {
              expectedRevision: p.expectedRevision,
              acceptanceRef,
            });
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: PLAN_ACCEPTANCE_RESOURCE,
                resourceRef: acceptanceRef,
                resourceVersion: 1,
              },
              { changedFields: ['planVersion', 'estimate', 'scope'] },
            );
            return { data: { ref: e.id }, version: 1 };
          });
          return { ...r, data: await answer(tx, r.data.ref) };
        });
      });
    },

    readEstimate(ctx: ActorContext, estimateRef: string): Promise<Estimate> {
      const op = 'clinical.estimates.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const e = await locateEstimate(tx, estimateRef, '');
          const out = await project(tx, e);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: ESTIMATE_RESOURCE,
            resourceRefs: [e.id],
            queryFields: [],
          });
          return out;
        });
      });
    },

    listEstimates(ctx: ActorContext, planVersionRef: string): Promise<readonly Estimate[]> {
      const op = 'clinical.estimates.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          await locateVersion(tx, planVersionRef, '');
          const { rows } = await tx.query<{ id: string }>(
            'SELECT id FROM cuspatlas.clinical_estimates WHERE plan_version_id = $1 ORDER BY number',
            [planVersionRef],
          );
          const out: Estimate[] = [];
          for (const r of rows) out.push(await answer(tx, r.id));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: ESTIMATE_RESOURCE,
            resourceRefs: [planVersionRef, ...rows.map((r) => r.id)].slice(0, 100),
            queryFields: [],
          });
          return out;
        });
      });
    },

    /** A new plan for the same patient and clinical problem; the source plan is never changed. */
    createPlanAlternative(
      ctx: ActorContext,
      planRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<TreatmentPlanCommandData>> {
      const op = 'clinical.treatmentPlans.createAlternative';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<PlanAlternativeCreate>(validatePlanAlternativeCreate, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (!UUID.test(planRef)) throw notFound();
          const source = await planById(tx, planRef);
          if (!source) throw notFound();
          const patient = await loadClinicalPatient(tx, source.subject_patient_id);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { planRef, ...p } }, tx, async () => {
            assertNotMerged(patient);
            if (p.encounterRef !== undefined) {
              await requireOpenEncounter(tx, decision, p.encounterRef, {
                patientId: patient.id,
                alternative: 'clinical.encounters.open',
              });
            }
            await tx.query('SELECT id FROM cuspatlas.clinical_treatment_plans WHERE id = $1 FOR UPDATE', [
              source.id,
            ]);
            const { rows: g } = await tx.query<{ group_id: string }>(
              'SELECT group_id FROM cuspatlas.clinical_plan_alternatives WHERE plan_id = $1',
              [source.id],
            );
            let group = g[0]?.group_id;
            if (!group) {
              const { rows: made } = await tx.query<{ group_id: string }>(
                `INSERT INTO cuspatlas.clinical_plan_alternatives (tenant_id, group_id, plan_id, created_by)
                 VALUES (cuspatlas.current_tenant_id(), gen_random_uuid(), $1, cuspatlas.current_actor_id())
                 RETURNING group_id`,
                [source.id],
              );
              group = made[0]?.group_id;
            }
            const { rows: n } = await tx.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_alternatives WHERE group_id = $1',
              [group],
            );
            if ((n[0]?.n ?? 0) >= 50) throw failedAt('/', 'tooManyAlternatives');
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.clinical_treatment_plans (tenant_id, subject_patient_id, origin_patient_id, created_by,
                 created_by_role, created_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $1, cuspatlas.current_actor_id(), $2, $3) RETURNING id`,
              [patient.id, who.role, who.credentialRef],
            );
            const planId = rows[0]?.id;
            if (!planId) throw new Error('insert returned no row');
            await tx.query(
              `INSERT INTO cuspatlas.clinical_plan_versions (tenant_id, plan_id, number, display_text, encounter_id,
                 created_by, created_by_role, created_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, 1, $2, $3, cuspatlas.current_actor_id(), $4, $5)`,
              [planId, p.displayText ?? null, p.encounterRef ?? null, who.role, who.credentialRef],
            );
            await tx.query(
              `INSERT INTO cuspatlas.clinical_plan_alternatives (tenant_id, group_id, plan_id, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id())`,
              [group, planId],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: TREATMENT_PLAN_RESOURCE,
                resourceRef: planId,
                resourceVersion: 1,
              },
              { changedFields: ['patientRef', 'alternativeOf', ...(p.displayText ? ['displayText'] : [])] },
            );
            return { data: { ref: planId }, version: 1 };
          });
          const plan = await planById(tx, r.data.ref);
          if (!plan) throw notFound();
          return { ...r, data: { targetRef: plan.id, plan: await projectPlan(tx, plan) } };
        });
      });
    },

    /** The plans offered for the same problem, oldest first, with their selection. A sensitive read. */
    listPlanAlternatives(ctx: ActorContext, planRef: string): Promise<readonly PlanAlternative[]> {
      const op = 'clinical.treatmentPlans.alternatives';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (!UUID.test(planRef)) throw notFound();
          const plan = await planById(tx, planRef);
          if (!plan) throw notFound();
          await loadClinicalPatient(tx, plan.subject_patient_id, '');
          const { rows } = await tx.query<{
            plan_id: string;
            head_id: string;
            head_state: 'draft' | 'accepted';
          }>(
            `SELECT p.id AS plan_id, v.id AS head_id, v.state AS head_state
             FROM cuspatlas.clinical_treatment_plans p
             JOIN cuspatlas.clinical_plan_versions v ON v.plan_id = p.id AND v.tenant_id = p.tenant_id
             LEFT JOIN cuspatlas.clinical_plan_alternatives a ON a.plan_id = p.id AND a.tenant_id = p.tenant_id
             WHERE (p.id = $1 OR a.group_id = (SELECT group_id FROM cuspatlas.clinical_plan_alternatives WHERE plan_id = $1))
               AND NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_versions s WHERE s.supersedes_version_id = v.id)
             ORDER BY p.created_at, p.id`,
            [plan.id],
          );
          const { rows: accepted } = await tx.query<{ plan_id: string }>(
            `SELECT DISTINCT v.plan_id FROM cuspatlas.clinical_plan_versions v WHERE v.plan_id = ANY ($1::uuid[])
               AND v.state = 'accepted'`,
            [rows.map((r) => r.plan_id)],
          );
          const acceptedPlans = new Set(accepted.map((a) => a.plan_id));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: TREATMENT_PLAN_RESOURCE,
            resourceRefs: rows.map((r) => r.plan_id).slice(0, 100),
            queryFields: [],
          });
          return rows.map((r) => ({
            planRef: r.plan_id,
            headVersionRef: r.head_id,
            headState: r.head_state,
            selection: acceptedPlans.has(r.plan_id)
              ? 'accepted'
              : acceptedPlans.size > 0
                ? 'unselected'
                : 'undecided',
          }));
        });
      });
    },
  };
}
