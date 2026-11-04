import {
  type ActorContext,
  assertValid,
  CLINICAL_PROPERTIES,
  type ClinicalAuthor,
  type ClinicalRole,
  type CommandEnvelope,
  type CommandResult,
  type PlanAreaCode,
  type PlanDetail,
  type PlanDetailAdd,
  type PlanDetailScope,
  type PlanDetailStateSet,
  type PlanItem,
  type PlanItemAdd,
  type PlanItemState,
  type PlanItemStateSet,
  type PlanItemTransition,
  type PlanTransitionCause,
  type PlanVersion,
  type PlanVersionSupersede,
  RefusalError,
  type TenantTransaction,
  type ToothInput,
  type TreatmentPlan,
  type TreatmentPlanCommandData,
  type TreatmentPlanCreate,
  type TreatmentPlanHeader,
  validatePlanDetailAdd,
  validatePlanDetailStateSet,
  validatePlanItemAdd,
  validatePlanItemStateSet,
  validatePlanVersionSupersede,
  validateTreatmentPlanCreate,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { authorOf, resolveClinicalAuthor } from './authorship';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, notFound, UUID } from './base';
import { chartToothStates, loadChartEntry, resolveTooth } from './chart';
import { assertNotMerged, loadClinicalPatient, requireOpenEncounter } from './encounters';
import { checkSurfaces, TOOTH_VOCABULARY, toothRef } from './tooth-identity';

export const TREATMENT_PLAN_RESOURCE = 'clinicalTreatmentPlan';
export const PLAN_VERSION_RESOURCE = 'clinicalPlanVersion';
/** Engineering bounds (not clinical rules): larger plans are refused, never truncated. */
const MAX_PLANS = 200;
const MAX_DETAILS = 100;
const MAX_ITEMS = 300;

/**
 * Designed item transition set (recommended-pending-clinical-approval). Guard, actor and
 * reversibility for each row are recorded in docs/execution/clinical-progress.md (C11). Every
 * transition is authored by a human clinical author; completion is set only by a rendered procedure
 * (C14), never here.
 */
export const PLAN_ITEM_TRANSITIONS: Readonly<Record<PlanItemState, readonly PlanItemState[]>> = {
  proposed: ['accepted', 'declined', 'discontinued'],
  accepted: ['scheduled', 'declined', 'discontinued'],
  scheduled: ['accepted', 'declined', 'discontinued'],
  declined: ['proposed'],
  discontinued: [],
  completed: [],
};
const NEEDS_REASON = (from: PlanItemState, to: PlanItemState) =>
  to === 'declined' ||
  to === 'discontinued' ||
  (from === 'scheduled' && to === 'accepted') ||
  from === 'declined';
const OPEN_STATES: ReadonlySet<PlanItemState> = new Set(['proposed', 'accepted', 'scheduled']);

export interface PlanRow extends Record<string, unknown> {
  id: string;
  subject_patient_id: string;
  origin_patient_id: string;
  head_version: number;
  created_by: string;
  created_by_role: ClinicalRole;
  created_by_credential_ref: string | null;
  created_at: Date;
}
interface VersionRow extends Record<string, unknown> {
  id: string;
  plan_id: string;
  number: number;
  supersedes_version_id: string | null;
  supersede_reason_code: string | null;
  display_text: string | null;
  encounter_id: string | null;
  state: 'draft' | 'accepted';
  revision: number;
  acceptance_ref: string | null;
  accepted_at: Date | null;
  created_by: string;
  created_by_role: ClinicalRole;
  created_by_credential_ref: string | null;
  created_at: Date;
}
interface DetailRow extends Record<string, unknown> {
  id: string;
  plan_version_id: string;
  sequence: number;
  phase: number | null;
  scope: PlanDetailScope;
  tooth_canonical_ref: string | null;
  surfaces: string[] | null;
  area_code: PlanAreaCode | null;
  chart_entry_id: string | null;
  display_text: string | null;
  derived_from_detail_id: string | null;
  created_by: string;
  created_by_role: ClinicalRole;
  created_by_credential_ref: string | null;
  created_at: Date;
}
interface ItemRow extends Record<string, unknown> {
  id: string;
  detail_id: string;
  plan_version_id: string;
  sequence: number;
  procedure_code_ref: string;
  tooth_canonical_ref: string | null;
  surfaces: string[] | null;
  area_code: PlanAreaCode | null;
  fee_schedule_ref: string | null;
  chart_entry_id: string | null;
  display_text: string | null;
  derived_from_item_id: string | null;
  created_by: string;
  created_by_role: ClinicalRole;
  created_by_credential_ref: string | null;
  created_at: Date;
}
interface ItemEventRow extends Record<string, unknown> {
  item_id: string;
  sequence: number;
  from_state: PlanItemState | null;
  to_state: PlanItemState;
  cause: PlanTransitionCause;
  reason_code: string | null;
  parent_detail_id: string | null;
  appointment_id: string | null;
  recorded_by: string;
  recorded_by_role: ClinicalRole;
  recorded_by_credential_ref: string | null;
  recorded_at: Date;
}
interface DetailEventRow extends Record<string, unknown> {
  id: string;
  detail_id: string;
  to_state: 'declined' | 'discontinued';
  reason_code: string;
  recorded_by: string;
  recorded_by_role: ClinicalRole;
  recorded_by_credential_ref: string | null;
  recorded_at: Date;
}

const author = (actor: string, role: ClinicalRole, cred: string | null): ClinicalAuthor =>
  authorOf(actor, role, cred);
const PLAN_COLUMNS = `id, subject_patient_id, origin_patient_id, head_version, created_by, created_by_role,
  created_by_credential_ref, created_at`;
const VERSION_COLUMNS = `id, plan_id, number, supersedes_version_id, supersede_reason_code, display_text, encounter_id,
  state, revision, acceptance_ref, accepted_at, created_by, created_by_role, created_by_credential_ref, created_at`;

export async function planById(tx: TenantTransaction, planId: string): Promise<PlanRow | null> {
  if (!UUID.test(planId)) return null;
  const { rows } = await tx.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM cuspatlas.clinical_treatment_plans WHERE id = $1`,
    [planId],
  );
  return rows[0] ?? null;
}

/** Builds the three-level projection of a plan: every version, its details and their items. */
export async function projectPlan(tx: TenantTransaction, plan: PlanRow): Promise<TreatmentPlan> {
  const { rows: versions } = await tx.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM cuspatlas.clinical_plan_versions WHERE plan_id = $1 ORDER BY number`,
    [plan.id],
  );
  const versionIds = versions.map((v) => v.id);
  const { rows: details } = await tx.query<DetailRow>(
    `SELECT id, plan_version_id, sequence, phase, scope, tooth_canonical_ref, surfaces, area_code, chart_entry_id,
       display_text, derived_from_detail_id, created_by, created_by_role, created_by_credential_ref, created_at
     FROM cuspatlas.clinical_plan_details WHERE plan_version_id = ANY ($1::uuid[]) ORDER BY sequence, id`,
    [versionIds],
  );
  const { rows: items } = await tx.query<ItemRow>(
    `SELECT id, detail_id, plan_version_id, sequence, procedure_code_ref, tooth_canonical_ref, surfaces, area_code,
       fee_schedule_ref, chart_entry_id, display_text, derived_from_item_id, created_by, created_by_role,
       created_by_credential_ref, created_at
     FROM cuspatlas.clinical_plan_items WHERE plan_version_id = ANY ($1::uuid[]) ORDER BY sequence, created_at, id`,
    [versionIds],
  );
  const { rows: itemEvents } = await tx.query<ItemEventRow>(
    `SELECT item_id, sequence, from_state, to_state, cause, reason_code, parent_detail_id, appointment_id, recorded_by,
       recorded_by_role, recorded_by_credential_ref, recorded_at
     FROM cuspatlas.clinical_plan_item_events WHERE item_id = ANY ($1::uuid[]) ORDER BY item_id, sequence`,
    [items.map((i) => i.id)],
  );
  const { rows: detailEvents } = await tx.query<DetailEventRow>(
    `SELECT id, detail_id, to_state, reason_code, recorded_by, recorded_by_role, recorded_by_credential_ref, recorded_at
     FROM cuspatlas.clinical_plan_detail_events WHERE detail_id = ANY ($1::uuid[])`,
    [details.map((d) => d.id)],
  );
  const successor = new Map(
    versions.filter((v) => v.supersedes_version_id).map((v) => [v.supersedes_version_id, v.id]),
  );
  const toItem = (i: ItemRow): PlanItem => {
    const events = itemEvents.filter((e) => e.item_id === i.id);
    const last = events.at(-1);
    return {
      itemRef: i.id,
      detailRef: i.detail_id,
      planVersionRef: i.plan_version_id,
      procedureCodeRef: i.procedure_code_ref,
      sequence: i.sequence,
      tooth: i.tooth_canonical_ref === null ? null : toothRef(i.tooth_canonical_ref, 'universal'),
      surfaces: i.surfaces,
      areaCode: i.area_code,
      feeScheduleRef: i.fee_schedule_ref,
      chartEntryRef: i.chart_entry_id,
      displayText: i.display_text,
      state: last?.to_state ?? 'proposed',
      appointmentRef: last?.to_state === 'scheduled' ? last.appointment_id : null,
      derivedFromItemRef: i.derived_from_item_id,
      createdBy: author(i.created_by, i.created_by_role, i.created_by_credential_ref),
      createdAt: i.created_at.toISOString(),
      transitions: events.map(
        (e): PlanItemTransition => ({
          from: e.from_state,
          to: e.to_state,
          cause: e.cause,
          reasonCode: e.reason_code,
          parentDetailRef: e.parent_detail_id,
          appointmentRef: e.appointment_id,
          recordedBy: author(e.recorded_by, e.recorded_by_role, e.recorded_by_credential_ref),
          recordedAt: e.recorded_at.toISOString(),
        }),
      ),
    };
  };
  const toDetail = (d: DetailRow): PlanDetail => {
    const ev = detailEvents.find((e) => e.detail_id === d.id);
    return {
      detailRef: d.id,
      planVersionRef: d.plan_version_id,
      sequence: d.sequence,
      phase: d.phase,
      scope: d.scope,
      tooth: d.tooth_canonical_ref === null ? null : toothRef(d.tooth_canonical_ref, 'universal'),
      surfaces: d.surfaces,
      areaCode: d.area_code,
      chartEntryRef: d.chart_entry_id,
      displayText: d.display_text,
      state: ev?.to_state ?? 'active',
      reasonCode: ev?.reason_code ?? null,
      stateRecordedBy: ev ? author(ev.recorded_by, ev.recorded_by_role, ev.recorded_by_credential_ref) : null,
      stateRecordedAt: ev ? ev.recorded_at.toISOString() : null,
      derivedFromDetailRef: d.derived_from_detail_id,
      createdBy: author(d.created_by, d.created_by_role, d.created_by_credential_ref),
      createdAt: d.created_at.toISOString(),
      items: items.filter((i) => i.detail_id === d.id).map(toItem),
    };
  };
  const out: PlanVersion[] = versions.map((v) => {
    const ds = details.filter((d) => d.plan_version_id === v.id).map(toDetail);
    const all = ds.flatMap((d) => d.items);
    const missingFee = all.filter((i) => i.feeScheduleRef === null).map((i) => i.itemRef);
    const next = successor.get(v.id) ?? null;
    return {
      planVersionRef: v.id,
      number: v.number,
      state: next === null ? v.state : 'superseded',
      revision: v.revision,
      displayText: v.display_text,
      supersedesRef: v.supersedes_version_id,
      supersededByRef: next,
      supersedeReasonCode: v.supersede_reason_code,
      acceptance:
        v.acceptance_ref !== null && v.accepted_at !== null
          ? { acceptanceRef: v.acceptance_ref, acceptedAt: v.accepted_at.toISOString() }
          : null,
      encounterRef: v.encounter_id,
      createdBy: author(v.created_by, v.created_by_role, v.created_by_credential_ref),
      createdAt: v.created_at.toISOString(),
      // Readiness only: whether every item names a fee schedule reference. Never an amount.
      estimateReadiness: {
        complete: all.length > 0 && missingFee.length === 0,
        itemCount: all.length,
        itemsWithoutFeeScheduleRef: missingFee,
      },
      details: ds,
    };
  });
  const headRow = versions.find((v) => !successor.has(v.id));
  if (!headRow) throw new Error('plan has no head version');
  return {
    planRef: plan.id,
    patientRef: plan.subject_patient_id,
    sourcePatientRef: plan.origin_patient_id,
    headVersionRef: headRow.id,
    createdBy: author(plan.created_by, plan.created_by_role, plan.created_by_credential_ref),
    createdAt: plan.created_at.toISOString(),
    versions: out,
  };
}

/** Locks a plan version for an edit and applies the shared guards in order. */
async function lockVersion(
  tx: TenantTransaction,
  versionId: string,
  expectedRevision: number,
  opts: { content: boolean },
): Promise<VersionRow> {
  const { rows } = await tx.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM cuspatlas.clinical_plan_versions WHERE id = $1 FOR UPDATE`,
    [versionId],
  );
  const v = rows[0];
  if (!v) throw notFound();
  const { rows: next } = await tx.query<{ id: string }>(
    'SELECT id FROM cuspatlas.clinical_plan_versions WHERE supersedes_version_id = $1',
    [v.id],
  );
  if (next[0]) {
    throw conflict('plan_version_superseded', { blockingRefs: [{ kind: 'planVersion', ref: next[0].id }] });
  }
  if (v.revision !== expectedRevision) {
    throw new RefusalError({ code: 'stale_version', detail: { currentVersion: v.revision } });
  }
  if (opts.content && v.state === 'accepted') {
    throw conflict('plan_version_accepted', { blockingRefs: [{ kind: 'planVersion', ref: v.id }] });
  }
  return v;
}

async function bumpRevision(tx: TenantTransaction, versionId: string): Promise<number> {
  const { rows } = await tx.query<{ revision: number }>(
    `UPDATE cuspatlas.clinical_plan_versions SET revision = revision + 1, updated_at = now() WHERE id = $1
     RETURNING revision`,
    [versionId],
  );
  const r = rows[0]?.revision;
  if (r === undefined) throw new Error('update returned no row');
  return r;
}

/**
 * Seam for C12 (versioned acceptance): records that C12's acceptance `acceptanceRef` accepted this
 * exact plan version at this revision. Called by C12 inside its own authorized command transaction;
 * there is no REST or MCP route for it in C11. Refuses a superseded, already accepted, empty or
 * concurrently edited version (stale revision), so acceptance and an edit never interleave.
 */
export async function recordPlanVersionAcceptance(
  tx: TenantTransaction,
  planVersionRef: string,
  input: { readonly expectedRevision: number; readonly acceptanceRef: string },
): Promise<{ readonly planVersionRef: string; readonly revision: number }> {
  if (!UUID.test(planVersionRef) || !UUID.test(input.acceptanceRef)) throw notFound();
  const v = await lockVersion(tx, planVersionRef, input.expectedRevision, { content: true });
  const { rows } = await tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_items WHERE plan_version_id = $1',
    [v.id],
  );
  if ((rows[0]?.n ?? 0) === 0) throw conflict('plan_version_empty');
  const { rows: updated } = await tx.query<{ revision: number }>(
    `UPDATE cuspatlas.clinical_plan_versions SET state = 'accepted', acceptance_ref = $2, accepted_at = now(),
       revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING revision`,
    [v.id, input.acceptanceRef],
  );
  const revision = updated[0]?.revision;
  if (revision === undefined) throw new Error('update returned no row');
  await recordCommand(
    tx,
    {
      operation: 'clinical.treatmentPlans.acceptVersion',
      resourceType: PLAN_VERSION_RESOURCE,
      resourceRef: v.id,
      resourceVersion: revision,
    },
    { changedFields: ['state', 'acceptance'] },
  );
  return { planVersionRef: v.id, revision };
}

interface Placement {
  readonly tooth: string | null;
  readonly surfaces: readonly string[] | null;
  readonly chartEntryId: string | null;
}

/**
 * A tooth on a plan must be on the chart: either the named chart entry (same patient, current, same
 * tooth) or an active chart state for the tooth. Nothing is charted implicitly. A tooth charted
 * missing is plannable only through its chart entry.
 */
async function placement(
  tx: TenantTransaction,
  patientId: string,
  input: { tooth?: ToothInput; surfaces?: readonly string[]; chartEntryRef?: string },
  detailTooth: string | null,
): Promise<Placement> {
  const tooth = input.tooth === undefined ? null : resolveTooth(input.tooth, '/tooth');
  if (detailTooth !== null && tooth !== null && tooth !== detailTooth)
    throw failedAt('/tooth', 'toothOutsideDetail');
  let surfaces: readonly string[] | null = null;
  if (input.surfaces !== undefined) {
    if (tooth === null) throw failedAt('/surfaces', 'surfacesNeedTooth');
    const checked = checkSurfaces(tooth, input.surfaces);
    if (!checked.ok) throw failedAt('/surfaces', checked.reason);
    surfaces = checked.surfaces;
  }
  if (input.chartEntryRef !== undefined) {
    const entry = await loadChartEntry(tx, input.chartEntryRef);
    if (!entry) throw notFound();
    if (entry.patientRef !== patientId) throw failedAt('/chartEntryRef', 'chartEntryPatientMismatch');
    if (entry.state === 'superseded') {
      throw conflict('chart_entry_superseded', {
        blockingRefs: [{ kind: 'chartEntry', ref: entry.supersededByEntryRef as string }],
      });
    }
    if (entry.state === 'entered_in_error') {
      throw conflict('chart_entry_entered_in_error', {
        blockingRefs: [{ kind: 'chartEntry', ref: entry.entryRef }],
      });
    }
    if (tooth !== null && entry.tooth?.canonicalRef !== tooth)
      throw failedAt('/tooth', 'toothMismatchWithChartEntry');
    const named = tooth ?? entry.tooth?.canonicalRef ?? null;
    if (named !== null) {
      const state = (await chartToothStates(tx, patientId)).get(named);
      if (state?.status === 'missing' && !state.missingEntryRefs.includes(entry.entryRef)) {
        throw conflict('tooth_absent_on_chart', {
          blockingRefs: state.missingEntryRefs.slice(0, 20).map((ref) => ({ kind: 'chartEntry', ref })),
        });
      }
    }
    return { tooth, surfaces, chartEntryId: entry.entryRef };
  }
  if (tooth !== null && tooth !== detailTooth) {
    const state = (await chartToothStates(tx, patientId)).get(tooth);
    if (!state) throw conflict('tooth_not_charted');
    if (state.status === 'missing') {
      throw conflict('tooth_absent_on_chart', {
        blockingRefs: state.missingEntryRefs.slice(0, 20).map((ref) => ({ kind: 'chartEntry', ref })),
      });
    }
  }
  return { tooth, surfaces, chartEntryId: null };
}

async function appendItemEvent(
  tx: TenantTransaction,
  e: {
    itemId: string;
    sequence: number;
    from: PlanItemState | null;
    to: PlanItemState;
    cause: PlanTransitionCause;
    reasonCode: string | null;
    parentDetailId: string | null;
    appointmentId: string | null;
  },
  who: ClinicalAuthor,
): Promise<void> {
  await tx.query(
    `INSERT INTO cuspatlas.clinical_plan_item_events (tenant_id, item_id, sequence, from_state, to_state, cause,
       reason_code, parent_detail_id, appointment_id, recorded_by, recorded_by_role, recorded_by_credential_ref)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, cuspatlas.current_actor_id(), $9, $10)`,
    [
      e.itemId,
      e.sequence,
      e.from,
      e.to,
      e.cause,
      e.reasonCode,
      e.parentDetailId,
      e.appointmentId,
      who.role,
      who.credentialRef,
    ],
  );
}

async function itemStates(
  tx: TenantTransaction,
  itemIds: readonly string[],
): Promise<
  Map<string, { state: PlanItemState; sequence: number; reason: string | null; appointment: string | null }>
> {
  const { rows } = await tx.query<ItemEventRow>(
    `SELECT DISTINCT ON (item_id) item_id, sequence, to_state, reason_code, appointment_id
     FROM cuspatlas.clinical_plan_item_events WHERE item_id = ANY ($1::uuid[]) ORDER BY item_id, sequence DESC`,
    [itemIds],
  );
  return new Map(
    rows.map((r) => [
      r.item_id,
      { state: r.to_state, sequence: r.sequence, reason: r.reason_code, appointment: r.appointment_id },
    ]),
  );
}

type Ack = { readonly ref: string };

/** C11 commands and reads. No command prices, schedules (S owns booking) or completes treatment. */
export function createTreatmentPlanOperations(base: ClinicalBase) {
  const { deps, execute } = base;

  /** Resolves any C11 target to its plan and locates the plan's patient (FOR SHARE for commands). */
  const locate = async (
    tx: TenantTransaction,
    kind: 'plan' | 'version' | 'detail' | 'item',
    ref: string,
    lock: 'FOR SHARE' | '' = 'FOR SHARE',
  ) => {
    if (!UUID.test(ref)) throw notFound();
    const sql = {
      plan: 'SELECT id AS plan_id FROM cuspatlas.clinical_treatment_plans WHERE id = $1',
      version: 'SELECT plan_id FROM cuspatlas.clinical_plan_versions WHERE id = $1',
      detail: `SELECT v.plan_id FROM cuspatlas.clinical_plan_details d
                JOIN cuspatlas.clinical_plan_versions v ON v.id = d.plan_version_id AND v.tenant_id = d.tenant_id WHERE d.id = $1`,
      item: `SELECT v.plan_id FROM cuspatlas.clinical_plan_items i
             JOIN cuspatlas.clinical_plan_versions v ON v.id = i.plan_version_id AND v.tenant_id = i.tenant_id WHERE i.id = $1`,
    }[kind];
    const { rows } = await tx.query<{ plan_id: string }>(sql, [ref]);
    const planId = rows[0]?.plan_id;
    if (!planId) throw notFound();
    const plan = await planById(tx, planId);
    if (!plan) throw notFound();
    const patient = await loadClinicalPatient(tx, plan.subject_patient_id, lock);
    return { plan, patient };
  };

  const answer = async (tx: TenantTransaction, kind: 'plan' | 'version' | 'detail' | 'item', ref: string) => {
    const { plan } = await locate(tx, kind, ref, '');
    return { targetRef: ref, plan: await projectPlan(tx, plan) };
  };

  return {
    createTreatmentPlan(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<TreatmentPlanCommandData>> {
      const op = 'clinical.treatmentPlans.create';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<TreatmentPlanCreate>(validateTreatmentPlanCreate, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, p.patientRef);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, envelope, tx, async () => {
            assertNotMerged(patient);
            if (p.encounterRef !== undefined) {
              await requireOpenEncounter(tx, decision, p.encounterRef, {
                patientId: patient.id,
                alternative: 'clinical.encounters.open',
              });
            }
            const { rows: n } = await tx.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM cuspatlas.clinical_treatment_plans WHERE subject_patient_id = $1',
              [patient.id],
            );
            if ((n[0]?.n ?? 0) >= MAX_PLANS) throw failedAt('/', 'tooManyPlans');
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
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: TREATMENT_PLAN_RESOURCE,
                resourceRef: planId,
                resourceVersion: 1,
              },
              { changedFields: ['patientRef', ...(p.displayText ? ['displayText'] : [])] },
            );
            return { data: { ref: planId }, version: 1 };
          });
          return { ...r, data: await answer(tx, 'plan', r.data.ref) };
        });
      });
    },

    addPlanDetail(
      ctx: ActorContext,
      planVersionRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<TreatmentPlanCommandData>> {
      const op = 'clinical.treatmentPlans.addDetail';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<PlanDetailAdd>(validatePlanDetailAdd, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { patient } = await locate(tx, 'version', planVersionRef);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { planVersionRef, ...p } },
            tx,
            async () => {
              const v = await lockVersion(tx, planVersionRef, p.expectedRevision, { content: true });
              const needsTooth = p.scope === 'tooth' || p.scope === 'surface_set';
              if (needsTooth && p.tooth === undefined) throw failedAt('/tooth', 'required');
              if (!needsTooth && p.tooth !== undefined) throw failedAt('/tooth', 'notForScope');
              if (p.scope === 'surface_set' && p.surfaces === undefined)
                throw failedAt('/surfaces', 'required');
              if (p.scope !== 'surface_set' && p.surfaces !== undefined)
                throw failedAt('/surfaces', 'notForScope');
              if (p.scope === 'area' && p.areaCode === undefined) throw failedAt('/areaCode', 'required');
              if (p.scope !== 'area' && p.areaCode !== undefined) throw failedAt('/areaCode', 'notForScope');
              const at = await placement(tx, patient.id, p, null);
              const { rows: n } = await tx.query<{ n: number }>(
                'SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_details WHERE plan_version_id = $1',
                [v.id],
              );
              const count = n[0]?.n ?? 0;
              if (count >= MAX_DETAILS) throw failedAt('/', 'tooManyDetails');
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.clinical_plan_details (tenant_id, plan_version_id, sequence, phase, scope,
                 tooth_canonical_ref, tooth_vocabulary, surfaces, area_code, chart_entry_id, display_text, created_by,
                 created_by_role, created_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, cuspatlas.current_actor_id(),
                 $11, $12) RETURNING id`,
                [
                  v.id,
                  count + 1,
                  p.phase ?? null,
                  p.scope,
                  at.tooth,
                  at.tooth === null ? null : TOOTH_VOCABULARY,
                  at.surfaces,
                  p.areaCode ?? null,
                  at.chartEntryId,
                  p.displayText ?? null,
                  who.role,
                  who.credentialRef,
                ],
              );
              const id = rows[0]?.id;
              if (!id) throw new Error('insert returned no row');
              const revision = await bumpRevision(tx, v.id);
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: PLAN_VERSION_RESOURCE,
                  resourceRef: v.id,
                  resourceVersion: revision,
                },
                { changedFields: ['details'] },
              );
              return { data: { ref: id }, version: revision };
            },
          );
          return { ...r, data: await answer(tx, 'detail', r.data.ref) };
        });
      });
    },

    addPlanItem(
      ctx: ActorContext,
      planDetailRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<TreatmentPlanCommandData>> {
      const op = 'clinical.treatmentPlans.addItem';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<PlanItemAdd>(validatePlanItemAdd, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { patient } = await locate(tx, 'detail', planDetailRef);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { planDetailRef, ...p } },
            tx,
            async () => {
              const { rows: ds } = await tx.query<DetailRow>(
                `SELECT id, plan_version_id, tooth_canonical_ref FROM cuspatlas.clinical_plan_details WHERE id = $1`,
                [planDetailRef],
              );
              const detail = ds[0];
              if (!detail) throw notFound();
              const v = await lockVersion(tx, detail.plan_version_id, p.expectedRevision, { content: true });
              const { rows: ev } = await tx.query(
                'SELECT 1 FROM cuspatlas.clinical_plan_detail_events WHERE detail_id = $1',
                [detail.id],
              );
              if ((ev.length ?? 0) > 0) {
                throw conflict('detail_not_active', {
                  blockingRefs: [{ kind: 'planDetail', ref: detail.id }],
                });
              }
              if (p.areaCode !== undefined && p.tooth !== undefined)
                throw failedAt('/areaCode', 'notWithTooth');
              const at = await placement(tx, patient.id, p, detail.tooth_canonical_ref);
              const { rows: n } = await tx.query<{ n: number }>(
                'SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_items WHERE plan_version_id = $1',
                [v.id],
              );
              if ((n[0]?.n ?? 0) >= MAX_ITEMS) throw failedAt('/', 'tooManyItems');
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.clinical_plan_items (tenant_id, detail_id, plan_version_id, sequence, procedure_code_ref,
                 tooth_canonical_ref, tooth_vocabulary, surfaces, area_code, fee_schedule_ref, chart_entry_id, display_text,
                 created_by, created_by_role, created_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 cuspatlas.current_actor_id(), $12, $13) RETURNING id`,
                [
                  detail.id,
                  v.id,
                  p.sequence,
                  p.procedureCodeRef,
                  at.tooth,
                  at.tooth === null ? null : TOOTH_VOCABULARY,
                  at.surfaces,
                  p.areaCode ?? null,
                  p.feeScheduleRef ?? null,
                  at.chartEntryId,
                  p.displayText ?? null,
                  who.role,
                  who.credentialRef,
                ],
              );
              const id = rows[0]?.id;
              if (!id) throw new Error('insert returned no row');
              await appendItemEvent(
                tx,
                {
                  itemId: id,
                  sequence: 1,
                  from: null,
                  to: 'proposed',
                  cause: 'created',
                  reasonCode: null,
                  parentDetailId: null,
                  appointmentId: null,
                },
                who,
              );
              const revision = await bumpRevision(tx, v.id);
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: PLAN_VERSION_RESOURCE,
                  resourceRef: v.id,
                  resourceVersion: revision,
                },
                { changedFields: ['items'] },
              );
              return { data: { ref: id }, version: revision };
            },
          );
          return { ...r, data: await answer(tx, 'item', r.data.ref) };
        });
      });
    },

    setPlanItemState(
      ctx: ActorContext,
      planItemRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<TreatmentPlanCommandData>> {
      const op = 'clinical.treatmentPlans.setItemState';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<PlanItemStateSet>(validatePlanItemStateSet, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { patient } = await locate(tx, 'item', planItemRef);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { planItemRef, ...p } }, tx, async () => {
            const { rows: is } = await tx.query<ItemRow>(
              'SELECT id, detail_id, plan_version_id FROM cuspatlas.clinical_plan_items WHERE id = $1',
              [planItemRef],
            );
            const item = is[0];
            if (!item) throw notFound();
            // State changes are facts about the item, allowed on an accepted version; never on a superseded one.
            const v = await lockVersion(tx, item.plan_version_id, p.expectedRevision, { content: false });
            const { rows: ev } = await tx.query(
              'SELECT 1 FROM cuspatlas.clinical_plan_detail_events WHERE detail_id = $1',
              [item.detail_id],
            );
            if (ev.length > 0) {
              throw conflict('detail_not_active', {
                blockingRefs: [{ kind: 'planDetail', ref: item.detail_id }],
              });
            }
            const current = (await itemStates(tx, [item.id])).get(item.id);
            if (!current) throw new Error('item has no state');
            if (p.state === 'completed') {
              throw conflict('completion_requires_rendered_procedure', {
                blockingRefs: [{ kind: 'planItem', ref: item.id }],
                alternative: 'clinical.procedures.render',
              });
            }
            if (!PLAN_ITEM_TRANSITIONS[current.state].includes(p.state)) {
              throw conflict('transition_not_allowed', {
                blockingRefs: [{ kind: 'planItem', ref: item.id }],
              });
            }
            if (p.state === 'scheduled' && p.appointmentRef === undefined)
              throw failedAt('/appointmentRef', 'required');
            if (p.state !== 'scheduled' && p.appointmentRef !== undefined)
              throw failedAt('/appointmentRef', 'notForState');
            if (NEEDS_REASON(current.state, p.state) && p.reasonCode === undefined)
              throw failedAt('/reasonCode', 'required');
            let appointmentId: string | null = null;
            if (p.appointmentRef !== undefined) {
              if (!UUID.test(p.appointmentRef)) throw notFound();
              // Read-only reference to the S booking; no scheduling table is written here.
              const { rows: ap } = await tx.query<{ subject_patient_id: string; status: string }>(
                'SELECT subject_patient_id, status FROM cuspatlas.appointments WHERE id = $1',
                [p.appointmentRef],
              );
              const a = ap[0];
              if (!a) throw notFound();
              if (a.subject_patient_id !== patient.id)
                throw failedAt('/appointmentRef', 'appointmentPatientMismatch');
              if (a.status !== 'booked') throw failedAt('/appointmentRef', 'appointmentNotBooked');
              appointmentId = p.appointmentRef;
            }
            await appendItemEvent(
              tx,
              {
                itemId: item.id,
                sequence: current.sequence + 1,
                from: current.state,
                to: p.state,
                cause: 'direct',
                reasonCode: p.reasonCode ?? null,
                parentDetailId: null,
                appointmentId,
              },
              who,
            );
            const revision = await bumpRevision(tx, v.id);
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: PLAN_VERSION_RESOURCE,
                resourceRef: v.id,
                resourceVersion: revision,
              },
              { changedFields: ['itemState'] },
            );
            return { data: { ref: item.id }, version: revision };
          });
          return { ...r, data: await answer(tx, 'item', r.data.ref) };
        });
      });
    },

    setPlanDetailState(
      ctx: ActorContext,
      planDetailRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<TreatmentPlanCommandData>> {
      const op = 'clinical.treatmentPlans.setDetailState';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<PlanDetailStateSet>(validatePlanDetailStateSet, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          await locate(tx, 'detail', planDetailRef);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { planDetailRef, ...p } },
            tx,
            async () => {
              const { rows: ds } = await tx.query<DetailRow>(
                'SELECT id, plan_version_id FROM cuspatlas.clinical_plan_details WHERE id = $1',
                [planDetailRef],
              );
              const detail = ds[0];
              if (!detail) throw notFound();
              const v = await lockVersion(tx, detail.plan_version_id, p.expectedRevision, { content: false });
              const { rows: ev } = await tx.query(
                'SELECT 1 FROM cuspatlas.clinical_plan_detail_events WHERE detail_id = $1',
                [detail.id],
              );
              if (ev.length > 0) {
                throw conflict('detail_not_active', {
                  blockingRefs: [{ kind: 'planDetail', ref: detail.id }],
                });
              }
              await tx.query(
                `INSERT INTO cuspatlas.clinical_plan_detail_events (tenant_id, detail_id, to_state, reason_code, recorded_by,
                 recorded_by_role, recorded_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id(), $4, $5)`,
                [detail.id, p.state, p.reasonCode, who.role, who.credentialRef],
              );
              // The consequence for each item is recorded explicitly, item by item, never as a silent cascade.
              const { rows: items } = await tx.query<{ id: string }>(
                'SELECT id FROM cuspatlas.clinical_plan_items WHERE detail_id = $1 ORDER BY sequence, created_at, id',
                [detail.id],
              );
              const states = await itemStates(
                tx,
                items.map((i) => i.id),
              );
              for (const i of items) {
                const s = states.get(i.id);
                if (!s || !OPEN_STATES.has(s.state)) continue;
                await appendItemEvent(
                  tx,
                  {
                    itemId: i.id,
                    sequence: s.sequence + 1,
                    from: s.state,
                    to: p.state,
                    cause: p.state === 'declined' ? 'detail_declined' : 'detail_discontinued',
                    reasonCode: p.reasonCode,
                    parentDetailId: detail.id,
                    appointmentId: null,
                  },
                  who,
                );
              }
              const revision = await bumpRevision(tx, v.id);
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: PLAN_VERSION_RESOURCE,
                  resourceRef: v.id,
                  resourceVersion: revision,
                },
                { changedFields: ['detailState', 'itemState'] },
              );
              return { data: { ref: detail.id }, version: revision };
            },
          );
          return { ...r, data: await answer(tx, 'detail', r.data.ref) };
        });
      });
    },

    supersedePlanVersion(
      ctx: ActorContext,
      planVersionRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<TreatmentPlanCommandData>> {
      const op = 'clinical.treatmentPlans.supersede';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<PlanVersionSupersede>(validatePlanVersionSupersede, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { plan, patient } = await locate(tx, 'version', planVersionRef);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { planVersionRef, ...p } },
            tx,
            async () => {
              assertNotMerged(patient);
              await tx.query('SELECT id FROM cuspatlas.clinical_treatment_plans WHERE id = $1 FOR UPDATE', [
                plan.id,
              ]);
              // The old version is locked but never changed: the new version names it.
              const old = await lockVersion(tx, planVersionRef, p.expectedRevision, { content: false });
              const { rows: created } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.clinical_plan_versions (tenant_id, plan_id, number, supersedes_version_id,
                 supersede_reason_code, display_text, created_by, created_by_role, created_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id(), $6, $7) RETURNING id`,
                [
                  plan.id,
                  old.number + 1,
                  old.id,
                  p.reasonCode,
                  p.displayText ?? old.display_text,
                  who.role,
                  who.credentialRef,
                ],
              );
              const newId = created[0]?.id;
              if (!newId) throw new Error('insert returned no row');
              const { rows: details } = await tx.query<DetailRow>(
                `SELECT id, sequence, phase, scope, tooth_canonical_ref, surfaces, area_code, chart_entry_id, display_text
               FROM cuspatlas.clinical_plan_details WHERE plan_version_id = $1 ORDER BY sequence`,
                [old.id],
              );
              const { rows: detailEvents } = await tx.query<DetailEventRow>(
                `SELECT id, detail_id, to_state, reason_code FROM cuspatlas.clinical_plan_detail_events
               WHERE detail_id = ANY ($1::uuid[])`,
                [details.map((d) => d.id)],
              );
              const { rows: items } = await tx.query<ItemRow>(
                `SELECT id, detail_id, sequence, procedure_code_ref, tooth_canonical_ref, surfaces, area_code, fee_schedule_ref,
                 chart_entry_id, display_text FROM cuspatlas.clinical_plan_items WHERE plan_version_id = $1
               ORDER BY sequence, created_at, id`,
                [old.id],
              );
              const states = await itemStates(
                tx,
                items.map((i) => i.id),
              );
              for (const d of details) {
                const { rows } = await tx.query<{ id: string }>(
                  `INSERT INTO cuspatlas.clinical_plan_details (tenant_id, plan_version_id, sequence, phase, scope,
                   tooth_canonical_ref, tooth_vocabulary, surfaces, area_code, chart_entry_id, display_text,
                   derived_from_detail_id, created_by, created_by_role, created_by_credential_ref)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   cuspatlas.current_actor_id(), $12, $13) RETURNING id`,
                  [
                    newId,
                    d.sequence,
                    d.phase,
                    d.scope,
                    d.tooth_canonical_ref,
                    d.tooth_canonical_ref === null ? null : TOOTH_VOCABULARY,
                    d.surfaces,
                    d.area_code,
                    d.chart_entry_id,
                    d.display_text,
                    d.id,
                    who.role,
                    who.credentialRef,
                  ],
                );
                const detailId = rows[0]?.id;
                if (!detailId) throw new Error('insert returned no row');
                const ev = detailEvents.find((e) => e.detail_id === d.id);
                if (ev) {
                  await tx.query(
                    `INSERT INTO cuspatlas.clinical_plan_detail_events (tenant_id, detail_id, to_state, reason_code,
                     carried_from_event_id, recorded_by, recorded_by_role, recorded_by_credential_ref)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id(), $5, $6)`,
                    [detailId, ev.to_state, ev.reason_code, ev.id, who.role, who.credentialRef],
                  );
                }
                for (const i of items.filter((x) => x.detail_id === d.id)) {
                  const { rows: ir } = await tx.query<{ id: string }>(
                    `INSERT INTO cuspatlas.clinical_plan_items (tenant_id, detail_id, plan_version_id, sequence,
                     procedure_code_ref, tooth_canonical_ref, tooth_vocabulary, surfaces, area_code, fee_schedule_ref,
                     chart_entry_id, display_text, derived_from_item_id, created_by, created_by_role, created_by_credential_ref)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                     cuspatlas.current_actor_id(), $13, $14) RETURNING id`,
                    [
                      detailId,
                      newId,
                      i.sequence,
                      i.procedure_code_ref,
                      i.tooth_canonical_ref,
                      i.tooth_canonical_ref === null ? null : TOOTH_VOCABULARY,
                      i.surfaces,
                      i.area_code,
                      i.fee_schedule_ref,
                      i.chart_entry_id,
                      i.display_text,
                      i.id,
                      who.role,
                      who.credentialRef,
                    ],
                  );
                  const itemId = ir[0]?.id;
                  if (!itemId) throw new Error('insert returned no row');
                  const s = states.get(i.id);
                  if (!s) throw new Error('item has no state');
                  await appendItemEvent(
                    tx,
                    {
                      itemId,
                      sequence: 1,
                      from: null,
                      to: s.state,
                      cause: 'carried_forward',
                      reasonCode: s.reason,
                      parentDetailId: null,
                      appointmentId: s.state === 'scheduled' ? s.appointment : null,
                    },
                    who,
                  );
                }
              }
              await tx.query(
                `UPDATE cuspatlas.clinical_treatment_plans SET head_version = head_version + 1, version = version + 1,
                 updated_at = now() WHERE id = $1`,
                [plan.id],
              );
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: PLAN_VERSION_RESOURCE,
                  resourceRef: newId,
                  resourceVersion: 1,
                },
                { changedFields: ['supersedes', 'details', 'items'] },
              );
              return { data: { ref: newId }, version: 1 };
            },
          );
          return { ...r, data: await answer(tx, 'version', r.data.ref) };
        });
      });
    },

    /** One plan with every version, detail and item. A sensitive read. */
    readTreatmentPlan(ctx: ActorContext, planRef: string): Promise<TreatmentPlan> {
      const op = 'clinical.treatmentPlans.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { plan } = await locate(tx, 'plan', planRef, '');
          const out = await projectPlan(tx, plan);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: TREATMENT_PLAN_RESOURCE,
            resourceRefs: [plan.id],
            queryFields: [],
          });
          return out;
        });
      });
    },

    /** A patient's plans (headers), oldest first. A sensitive read. */
    listTreatmentPlans(ctx: ActorContext, patientRef: string): Promise<readonly TreatmentPlanHeader[]> {
      const op = 'clinical.treatmentPlans.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, patientRef, '');
          assertNotMerged(patient);
          const { rows } = await tx.query<
            PlanRow & { head_id: string; head_number: number; head_state: 'draft' | 'accepted' }
          >(
            `SELECT p.id, p.subject_patient_id, p.origin_patient_id, p.created_at, v.id AS head_id, v.number AS head_number,
               v.state AS head_state
             FROM cuspatlas.clinical_treatment_plans p
             JOIN cuspatlas.clinical_plan_versions v ON v.plan_id = p.id AND v.tenant_id = p.tenant_id
             WHERE p.subject_patient_id = $1 AND NOT EXISTS (
               SELECT 1 FROM cuspatlas.clinical_plan_versions s WHERE s.supersedes_version_id = v.id)
             ORDER BY p.created_at, p.id`,
            [patient.id],
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: TREATMENT_PLAN_RESOURCE,
            resourceRefs: [patient.id, ...rows.map((r) => r.id)].slice(0, 100),
            queryFields: [],
          });
          return rows.map((r) => ({
            planRef: r.id,
            patientRef: r.subject_patient_id,
            sourcePatientRef: r.origin_patient_id,
            headVersionRef: r.head_id,
            headVersionNumber: r.head_number,
            headState: r.head_state,
            createdAt: r.created_at.toISOString(),
          }));
        });
      });
    },
  };
}
