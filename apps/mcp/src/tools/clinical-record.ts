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
  estimateRef: 'EstimateRef',
  consentRef: 'ConsentRef',
  procedureRef: 'ProcedureRef',
  encounterRef: 'EncounterRef',
  imageLinkRef: 'ImageLinkRef',
  labCaseRef: 'LabCaseRef',
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
  // C16 lab cases (record-keeping and print/export only; no electronic ordering).
  {
    name: 'clinical_lab_cases_create',
    operationId: 'clinical.labCases.create',
    description: `Record a lab case in draft for a patient: the lab as recorded data, a case reference unique per lab, the plan detail or item and the appointment it serves, dates and attachment object references. Nothing is ordered or sent electronically. ${SAFETY}`,
    body: 'LabCaseCreate',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) => d.clinical.createLabCase(actor, envelope('clinical.labCases.create', args)),
  },
  {
    name: 'clinical_lab_cases_set_state',
    operationId: 'clinical.labCases.setState',
    description: `Record a lab case transition (sent, in_progress, seated, cancelled) from the proposed configurable set; each transition records actor and instant. ${SAFETY}`,
    body: 'LabCaseSetState',
    transport: ['labCaseRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.setLabCaseState(
        actor,
        args.labCaseRef as string,
        envelope('clinical.labCases.setState', args, 'labCaseRef'),
      ),
  },
  {
    name: 'clinical_lab_cases_record_return',
    operationId: 'clinical.labCases.recordReturn',
    description: `Record the lab return with a received date and either attachment references or a stated reason. ${SAFETY}`,
    body: 'LabCaseReturn',
    transport: ['labCaseRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.recordLabReturn(
        actor,
        args.labCaseRef as string,
        envelope('clinical.labCases.recordReturn', args, 'labCaseRef'),
      ),
  },
  {
    name: 'clinical_lab_cases_attach',
    operationId: 'clinical.labCases.attach',
    description: `Add an attachment object reference to a lab case (the document itself is stored elsewhere). ${SAFETY}`,
    body: 'LabCaseAttach',
    transport: ['labCaseRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.attachLabDocument(
        actor,
        args.labCaseRef as string,
        envelope('clinical.labCases.attach', args, 'labCaseRef'),
      ),
  },
  {
    name: 'clinical_lab_cases_remake',
    operationId: 'clinical.labCases.remake',
    description: `Create a remake case linked to a received or seated case; the original ends as remake with its history unchanged. ${SAFETY}`,
    body: 'LabCaseRemake',
    transport: ['labCaseRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.remakeLabCase(
        actor,
        args.labCaseRef as string,
        envelope('clinical.labCases.remake', args, 'labCaseRef'),
      ),
  },
  {
    name: 'clinical_lab_cases_get',
    operationId: 'clinical.labCases.read',
    description: `One lab case with its transition history, attachment references, derived overdue flag and review flags. ${SAFETY}`,
    body: null,
    transport: ['labCaseRef'],
    readOnly: true,
    run: async (d, actor, args) => ({ data: await d.clinical.readLabCase(actor, args.labCaseRef as string) }),
  },
  {
    name: 'clinical_lab_cases_list',
    operationId: 'clinical.labCases.list',
    description: `A patient's lab cases. ${SAFETY}`,
    body: null,
    transport: ['patientRef'],
    readOnly: true,
    run: async (d, actor, args) => ({
      data: await d.clinical.listLabCases(actor, args.patientRef as string),
    }),
  },
  {
    name: 'clinical_lab_cases_export',
    operationId: 'clinical.labCases.export',
    description: `The printable lab case package (the only channel to a lab; nothing is transmitted). ${SAFETY}`,
    body: null,
    transport: ['labCaseRef'],
    readOnly: true,
    run: async (d, actor, args) => ({
      data: await d.clinical.exportLabCase(actor, args.labCaseRef as string),
    }),
  },
  {
    name: 'clinical_lab_cases_worklist',
    operationId: 'clinical.labCases.worklist',
    description: `Exception-first lab work items: overdue returns and cases whose plan link or appointment needs review. ${SAFETY}`,
    body: 'LabWorklistQuery',
    transport: [],
    readOnly: true,
    run: async (d, actor, args) => ({ data: await d.clinical.labWorklist(actor, args) }),
  },
  // C15 encounter image links (by I3 imageRef only).
  {
    name: 'clinical_image_links_link',
    operationId: 'clinical.imageLinks.link',
    description: `Link an I3 imageRef to an encounter. The imageRef must currently resolve in I3 to the encounter's patient; an image already linked elsewhere needs the relink tool. Stores no image, bytes, digest or match status (those are I's). ${SAFETY}`,
    body: 'ImageLinkCreate',
    transport: ['encounterRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.linkImageToEncounter(
        actor,
        args.encounterRef as string,
        envelope('clinical.imageLinks.link', args, 'encounterRef'),
      ),
  },
  {
    name: 'clinical_image_links_relink',
    operationId: 'clinical.imageLinks.relink',
    description: `Move an active image link to another encounter of the same patient with a reason; the prior link stays in history. ${SAFETY}`,
    body: 'ImageLinkRelink',
    transport: ['imageLinkRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.relinkImage(
        actor,
        args.imageLinkRef as string,
        envelope('clinical.imageLinks.relink', args, 'imageLinkRef'),
      ),
  },
  {
    name: 'clinical_image_links_unlink',
    operationId: 'clinical.imageLinks.unlink',
    description: `End an active image link with a reason; the link stays in history and the image stays I's record. ${SAFETY}`,
    body: 'ImageLinkUnlink',
    transport: ['imageLinkRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.unlinkImage(
        actor,
        args.imageLinkRef as string,
        envelope('clinical.imageLinks.unlink', args, 'imageLinkRef'),
      ),
  },
  {
    name: 'clinical_image_links_get',
    operationId: 'clinical.imageLinks.read',
    description: `One encounter image link with its history and I3's current status for the imageRef (review flag when it changed). ${SAFETY}`,
    body: null,
    transport: ['imageLinkRef'],
    readOnly: true,
    run: async (d, actor, args) => ({
      data: await d.clinical.readImageLink(actor, args.imageLinkRef as string),
    }),
  },
  {
    name: 'clinical_image_links_list',
    operationId: 'clinical.imageLinks.list',
    description: `Every image link of an encounter, active and ended, with I3's current status per imageRef. ${SAFETY}`,
    body: null,
    transport: ['encounterRef'],
    readOnly: true,
    run: async (d, actor, args) => ({
      data: await d.clinical.listEncounterImages(actor, args.encounterRef as string),
    }),
  },
  // C14 rendered procedures.
  {
    name: 'clinical_procedures_render',
    operationId: 'clinical.procedures.render',
    description: `Record that a procedure was actually performed in an open encounter: rendering provider (assigned to the encounter, or with an override reason), date of service, sequence, and either the plan item it completes (code, tooth and surfaces from the item) or an unscheduled SYN- code. A duplicate needs an explicit indicator. No amount. Publishes the billing event. ${SAFETY}`,
    body: 'ProcedureRender',
    transport: ['encounterRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.renderProcedure(
        actor,
        args.encounterRef as string,
        envelope('clinical.procedures.render', args, 'encounterRef'),
      ),
  },
  {
    name: 'clinical_procedures_correct',
    operationId: 'clinical.procedures.correct',
    description: `Correct a rendered procedure by a linked reversal and an optional replacement with a reason; the original stays. A completed plan item returns to accepted when its procedure is reversed. Publishes correcting events. ${SAFETY}`,
    body: 'ProcedureCorrect',
    transport: ['procedureRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.correctProcedure(
        actor,
        args.procedureRef as string,
        envelope('clinical.procedures.correct', args, 'procedureRef'),
      ),
  },
  {
    name: 'clinical_procedures_get',
    operationId: 'clinical.procedures.read',
    description: `One rendered procedure with its correction links, chart discrepancy flag and billing event payload. ${SAFETY}`,
    body: null,
    transport: ['procedureRef'],
    readOnly: true,
    run: async (d, actor, args) => ({
      data: await d.clinical.readProcedure(actor, args.procedureRef as string),
    }),
  },
  {
    name: 'clinical_procedures_list',
    operationId: 'clinical.procedures.list',
    description: `Every procedure fact of an encounter (the history) and the net set still standing. ${SAFETY}`,
    body: null,
    transport: ['encounterRef'],
    readOnly: true,
    run: async (d, actor, args) => ({
      data: await d.clinical.listProcedures(actor, args.encounterRef as string),
    }),
  },
  // C13 consent capture.
  {
    name: 'clinical_consents_capture',
    operationId: 'clinical.consents.capture',
    description: `Record a treatment consent (structured attestation; paper and portal captures name an artifact reference and digest, never bytes) bound to a plan version, a plan item or general treatment. The signer is the patient (refused when recorded as a minor) or a related person whose S5 consent-scope authority is evaluated now. Not messaging consent. ${SAFETY}`,
    body: 'ConsentCapture',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) => d.clinical.captureConsent(actor, envelope('clinical.consents.capture', args)),
  },
  {
    name: 'clinical_consents_get',
    operationId: 'clinical.consents.read',
    description: `One consent with its signer authority as recorded, evidence reference, template digest status and withdrawal. ${SAFETY}`,
    body: null,
    transport: ['consentRef'],
    readOnly: true,
    run: async (d, actor, args) => ({ data: await d.clinical.readConsent(actor, args.consentRef as string) }),
  },
  {
    name: 'clinical_consents_withdraw',
    operationId: 'clinical.consents.withdraw',
    description: `Withdraw a consent as a new record with reason, instant and the signer's authority evaluated now; the consent itself and care already delivered are never rewritten. ${SAFETY}`,
    body: 'ConsentWithdraw',
    transport: ['consentRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.withdrawConsent(
        actor,
        args.consentRef as string,
        envelope('clinical.consents.withdraw', args, 'consentRef'),
      ),
  },
  {
    name: 'clinical_consents_list',
    operationId: 'clinical.consents.list',
    description: `A patient's consents as of an instant (default now), optionally for one plan version. ${SAFETY}`,
    body: 'ConsentListQuery',
    transport: ['patientRef'],
    readOnly: true,
    run: (d, actor, args) =>
      d.clinical.listConsents(actor, args.patientRef as string, without(args, 'patientRef')),
  },
  {
    name: 'clinical_consent_templates_register',
    operationId: 'clinical.consentTemplates.register',
    description: `Register a consent text version by reference and digest (practice configuration; the text lives elsewhere). ${SAFETY}`,
    body: 'ConsentTemplateRegister',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.registerConsentTemplate(actor, envelope('clinical.consentTemplates.register', args)),
  },
  // C12 estimates, alternatives and acceptance.
  {
    name: 'clinical_estimates_generate',
    operationId: 'clinical.estimates.generate',
    description: `Generate the next immutable estimate version of a plan version from staff-entered per-item fee placeholders (Money) and coverage or discount references with their source freshness. Never a coverage guarantee: unknown coverage is a labelled unknown, otherwise a bounded range. ${SAFETY}`,
    body: 'EstimateGenerate',
    transport: ['planVersionRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.generateEstimate(
        actor,
        args.planVersionRef as string,
        envelope('clinical.estimates.generate', args, 'planVersionRef'),
      ),
  },
  {
    name: 'clinical_estimates_list',
    operationId: 'clinical.estimates.list',
    description: `Every estimate version of a plan version, oldest first, with presentation and acceptance. ${SAFETY}`,
    body: null,
    transport: ['planVersionRef'],
    readOnly: true,
    run: async (d, actor, args) => ({
      data: await d.clinical.listEstimates(actor, args.planVersionRef as string),
    }),
  },
  {
    name: 'clinical_estimates_get',
    operationId: 'clinical.estimates.read',
    description: `One estimate version with its lines, assumptions, coverage status, presentation and acceptance. ${SAFETY}`,
    body: null,
    transport: ['estimateRef'],
    readOnly: true,
    run: async (d, actor, args) => ({
      data: await d.clinical.readEstimate(actor, args.estimateRef as string),
    }),
  },
  {
    name: 'clinical_estimates_present',
    operationId: 'clinical.estimates.present',
    description: `Mark the current complete estimate as presented, re-evaluating coverage freshness; a superseded or incomplete estimate is refused. ${SAFETY}`,
    body: 'EstimatePresent',
    transport: ['estimateRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.presentEstimate(
        actor,
        args.estimateRef as string,
        envelope('clinical.estimates.present', args, 'estimateRef'),
      ),
  },
  {
    name: 'clinical_estimates_accept',
    operationId: 'clinical.estimates.accept',
    description: `Record acceptance of the plan version against this exact current estimate (full scope only). Consent is a separate later fact (C13); an acceptance is never consented treatment by itself. ${SAFETY}`,
    body: 'EstimateAccept',
    transport: ['estimateRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.acceptEstimate(
        actor,
        args.estimateRef as string,
        envelope('clinical.estimates.accept', args, 'estimateRef'),
      ),
  },
  {
    name: 'clinical_treatment_plans_create_alternative',
    operationId: 'clinical.treatmentPlans.createAlternative',
    description: `Create an alternative plan for the same patient and clinical problem; the source plan is never changed. ${SAFETY}`,
    body: 'PlanAlternativeCreate',
    transport: ['planRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.createPlanAlternative(
        actor,
        args.planRef as string,
        envelope('clinical.treatmentPlans.createAlternative', args, 'planRef'),
      ),
  },
  {
    name: 'clinical_treatment_plans_list_alternatives',
    operationId: 'clinical.treatmentPlans.alternatives',
    description: `The plans offered for the same problem with their head version and selection (accepted, unselected, undecided). ${SAFETY}`,
    body: null,
    transport: ['planRef'],
    readOnly: true,
    run: async (d, actor, args) => ({
      data: await d.clinical.listPlanAlternatives(actor, args.planRef as string),
    }),
  },
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
