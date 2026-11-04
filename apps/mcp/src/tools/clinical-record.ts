import type { ActorContext } from '@cuspatlas/contracts';
import { clinicalSchema } from '@cuspatlas/contracts';
import type { ActionName } from '@cuspatlas/domain';
import { type Args, inputSchema, type ToolDefinition, type ToolDeps, without } from './synthetic-tasks';

const DEFS = clinicalSchema.$defs as Record<string, unknown>;
type Def = { properties: Record<string, object>; required?: string[] };
const def = (name: string) => DEFS[name] as Def;

/** Transport-only properties of the clinical record tools and the contract definition each uses. */
const TRANSPORT: Record<string, string> = {
  idempotencyKey: 'IdempotencyKey',
  patientRef: 'PatientRef',
  chartEntryRef: 'ChartEntryRef',
  perioExamRef: 'PerioExamRef',
  planRef: 'TreatmentPlanRef',
  planVersionRef: 'PlanVersionRef',
  planDetailRef: 'PlanDetailRef',
  planItemRef: 'PlanItemRef',
};

/**
 * Input schema = the REST body (or query) definition's properties plus the transport-only
 * properties (Idempotency-Key header and path parameters), built mechanically from
 * clinical.schema.json so REST and MCP cannot drift.
 */
function schemaFor(body: string | null, transport: readonly string[]) {
  const d = body === null ? { properties: {}, required: [] } : def(body);
  const props: Record<string, object | string> = { ...d.properties };
  for (const t of transport) props[t] = TRANSPORT[t] as string;
  return inputSchema(props, [...(d.required ?? []), ...transport], DEFS);
}

interface Spec {
  readonly name: string;
  readonly operationId: ActionName;
  readonly description: string;
  readonly body: string | null;
  readonly transport: readonly string[];
  readonly readOnly: boolean;
  run(deps: ToolDeps, actor: ActorContext, args: Args): Promise<unknown>;
}

const envelope = (operation: string, args: Args, ...pathParams: string[]) => ({
  operation,
  idempotencyKey: args.idempotencyKey as string,
  payload: without(args, 'idempotencyKey', ...pathParams),
});

const SAFETY =
  'Synthetic engineering implementation; clinical semantics are recommended-pending-clinical-approval and not clinically validated. No diagnosis and no decision support.';

const SPECS: readonly Spec[] = [
  // C6 structured chart.
  {
    name: 'clinical_chart_record_entry',
    operationId: 'clinical.chart.recordEntry',
    description: `Record one append-only chart entry (condition, existing restoration, missing, supernumerary, implant, prosthodontic) for a canonical tooth named in Universal, FDI or canonical form, with an optional surface set validated per tooth type and a provisional SYN- finding code. A duplicate of an active entry returns it. Human clinical authors only. ${SAFETY}`,
    body: 'ChartEntryRecord',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) => d.clinical.recordChartEntry(actor, envelope('clinical.chart.recordEntry', args)),
  },
  {
    name: 'clinical_chart_correct_entry',
    operationId: 'clinical.chart.correctEntry',
    description: `Correct a chart entry by writing a superseding entry with a reason; the prior entry stays retrievable as superseded. A superseded base is refused naming the current successor. ${SAFETY}`,
    body: 'ChartEntryCorrect',
    transport: ['chartEntryRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.correctChartEntry(
        actor,
        args.chartEntryRef as string,
        envelope('clinical.chart.correctEntry', args, 'chartEntryRef'),
      ),
  },
  {
    name: 'clinical_chart_read',
    operationId: 'clinical.chart.read',
    description:
      'Read a patient chart as of an instant (default now) in Universal or FDI display: every entry with its state, author and provenance, plus the per-tooth state from active entries. recorded=false is an explicit empty chart.',
    body: 'ChartReadQuery',
    transport: ['patientRef'],
    readOnly: true,
    async run(d, actor, args) {
      return {
        data: await d.clinical.readChart(actor, args.patientRef as string, without(args, 'patientRef')),
      };
    },
  },
  // C7 periodontal exams.
  {
    name: 'clinical_perio_record_exam',
    operationId: 'clinical.perio.recordExam',
    description: `Record one complete periodontal exam: every listed tooth with every site of the provisional six-site scheme (probing depth, recession, bleeding) plus mobility and furcation grades from the configured vocabulary, each measured or explicitly not_measured (never zero). A partial exam, a tooth charted missing or an unconfigured grade is refused as a whole. Raw values only. ${SAFETY}`,
    body: 'PerioExamRecord',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) => d.clinical.recordPerioExam(actor, envelope('clinical.perio.recordExam', args)),
  },
  {
    name: 'clinical_perio_correct_exam',
    operationId: 'clinical.perio.correctExam',
    description: `Supersede named current measurements of an exam with a reason; prior values remain readable. A superseded measurement is refused naming its successor. ${SAFETY}`,
    body: 'PerioExamCorrect',
    transport: ['perioExamRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.correctPerioExam(
        actor,
        args.perioExamRef as string,
        envelope('clinical.perio.correctExam', args, 'perioExamRef'),
      ),
  },
  {
    name: 'clinical_perio_derive',
    operationId: 'clinical.perio.derive',
    description: `Compute derived values of an exam with one configured formula version (synthetic SYN- registry, every formula pending clinical approval); stored with the version, labelled derived_pending_clinical_approval, never rewritten. Unmeasured inputs make a site not_computable. ${SAFETY}`,
    body: 'PerioDerive',
    transport: ['perioExamRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.derivePerioValues(
        actor,
        args.perioExamRef as string,
        envelope('clinical.perio.derive', args, 'perioExamRef'),
      ),
  },
  {
    name: 'clinical_perio_get_exam',
    operationId: 'clinical.perio.readExam',
    description:
      'Read one periodontal exam with every measurement (current and superseded, with correction reasons) and every derivation with its formula version and pending-approval label.',
    body: null,
    transport: ['perioExamRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.clinical.readPerioExam(actor, args.perioExamRef as string) };
    },
  },
  {
    name: 'clinical_perio_list_exams',
    operationId: 'clinical.perio.listExams',
    description:
      'List a patient’s periodontal exams, each with its source patient (merged exams stay distinct).',
    body: null,
    transport: ['patientRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.clinical.listPerioExams(actor, args.patientRef as string) };
    },
  },
  {
    name: 'clinical_perio_compare',
    operationId: 'clinical.perio.compare',
    description:
      'Compare two exams of one patient per site (probing depth, recession): only measured pairs carry a delta; unmeasured and absent sites are listed with the reason. Optional derived comparison names each formula version (pending approval).',
    body: 'PerioCompareQuery',
    transport: [],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.clinical.comparePerioExams(actor, args) };
    },
  },
  // C11 treatment plans.
  {
    name: 'clinical_treatment_plans_create',
    operationId: 'clinical.treatmentPlans.create',
    description: `Create a treatment plan with its first draft version for a patient. No amount exists on any level. ${SAFETY}`,
    body: 'TreatmentPlanCreate',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.createTreatmentPlan(actor, envelope('clinical.treatmentPlans.create', args)),
  },
  {
    name: 'clinical_treatment_plans_get',
    operationId: 'clinical.treatmentPlans.read',
    description:
      'Read one treatment plan at all three levels (versions, details, items) with item states, transitions and estimate readiness (fee schedule references present or not; never an amount).',
    body: null,
    transport: ['planRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.clinical.readTreatmentPlan(actor, args.planRef as string) };
    },
  },
  {
    name: 'clinical_treatment_plans_list',
    operationId: 'clinical.treatmentPlans.list',
    description: 'List a patient’s treatment plans with their head version and its state.',
    body: null,
    transport: ['patientRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.clinical.listTreatmentPlans(actor, args.patientRef as string) };
    },
  },
  {
    name: 'clinical_treatment_plans_add_detail',
    operationId: 'clinical.treatmentPlans.addDetail',
    description: `Add a detail (tooth, surface set, area or whole mouth) to a draft plan version if expectedRevision matches. A tooth must be on the chart or name its chart entry; nothing is charted implicitly. ${SAFETY}`,
    body: 'PlanDetailAdd',
    transport: ['planVersionRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.addPlanDetail(
        actor,
        args.planVersionRef as string,
        envelope('clinical.treatmentPlans.addDetail', args, 'planVersionRef'),
      ),
  },
  {
    name: 'clinical_treatment_plans_add_item',
    operationId: 'clinical.treatmentPlans.addItem',
    description: `Add an item (provisional SYN- procedure code, sequence, optional tooth, fee schedule reference and chart entry) to an active detail of a draft version. No amount. ${SAFETY}`,
    body: 'PlanItemAdd',
    transport: ['planDetailRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.addPlanItem(
        actor,
        args.planDetailRef as string,
        envelope('clinical.treatmentPlans.addItem', args, 'planDetailRef'),
      ),
  },
  {
    name: 'clinical_treatment_plans_set_item_state',
    operationId: 'clinical.treatmentPlans.setItemState',
    description: `Move an item through the designed transition set (proposed, accepted, scheduled with a booked appointment of the same patient, declined, discontinued). Completion is only by a rendered procedure. ${SAFETY}`,
    body: 'PlanItemStateSet',
    transport: ['planItemRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.setPlanItemState(
        actor,
        args.planItemRef as string,
        envelope('clinical.treatmentPlans.setItemState', args, 'planItemRef'),
      ),
  },
  {
    name: 'clinical_treatment_plans_set_detail_state',
    operationId: 'clinical.treatmentPlans.setDetailState',
    description: `Decline or discontinue a detail with a reason; each open item's resulting state is recorded explicitly with the detail as parent. ${SAFETY}`,
    body: 'PlanDetailStateSet',
    transport: ['planDetailRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.setPlanDetailState(
        actor,
        args.planDetailRef as string,
        envelope('clinical.treatmentPlans.setDetailState', args, 'planDetailRef'),
      ),
  },
  {
    name: 'clinical_treatment_plans_supersede',
    operationId: 'clinical.treatmentPlans.supersede',
    description: `Create a new plan version that names the version it supersedes and carries its details and items; the superseded version stays readable and unchanged. ${SAFETY}`,
    body: 'PlanVersionSupersede',
    transport: ['planVersionRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.supersedePlanVersion(
        actor,
        args.planVersionRef as string,
        envelope('clinical.treatmentPlans.supersede', args, 'planVersionRef'),
      ),
  },
];

/**
 * MCP twins of the clinical record routes. Every handler calls the same domain service REST uses,
 * which authorizes before it validates; invalid arguments are refused after authorization for the
 * same action, so a caller without access gets the identical denial and attempt row.
 */
export const CLINICAL_RECORD_TOOLS: readonly ToolDefinition[] = SPECS.map((s) => ({
  name: s.name,
  operationId: s.operationId,
  description: s.description,
  inputSchema: schemaFor(s.body, s.transport),
  readOnly: s.readOnly,
  onInvalid: { action: s.operationId },
  run: (deps, actor, args) => s.run(deps, actor, args),
}));
