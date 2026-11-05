import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REFUSAL_CODES } from '@cuspatlas/contracts';
import { parse } from 'yaml';
import { extractBillingOpsBlock, renderBillingOpsBlock } from './billing-openapi';
import { extractMigrationOpsBlock, extractOpsBlock, renderMigrationOpsBlock } from './migration-openapi';
import { AGENT_OPS, AGENT_OPS_BLOCK, renderAgentOpsBlock } from './routes/agent-ops';
import { AUTOMATION_OPS, AUTOMATION_OPS_BLOCK, renderAutomationOpsBlock } from './routes/automation-ops';
import { BILLING_OPS } from './routes/billing-ops';
import { ENGAGEMENT_OPS } from './routes/engagement-ops';
import { IMAGING_OPS } from './routes/imaging-ops';
import {
  BILLING_SCHEMA_FILE,
  CLINICAL_SCHEMA_FILE,
  ENGAGEMENT_SCHEMA_FILE,
  IMAGING_SCHEMA_FILE,
  MIGRATION_SCHEMA_FILE,
  PATIENT_SCHEMA_FILE,
  PROPOSAL_SCHEMA_FILE,
  ROUTES,
  SCHEDULING_SCHEMA_FILE,
  SCHEMA_FILE,
} from './routes/manifest';
import { MIGRATION_OPS } from './routes/migration-ops';
import { PORTAL_OPS } from './routes/portal-ops';
import { SCHEDULING_OPS } from './routes/scheduling-ops';

export interface ContractSources {
  readonly openapiText: string;
  readonly schemaText: string;
  readonly proposalSchemaText: string;
  readonly patientSchemaText: string;
  readonly schedulingSchemaText: string;
  readonly billingSchemaText: string;
  readonly clinicalSchemaText: string;
  readonly engagementSchemaText: string;
  readonly imagingSchemaText: string;
  readonly migrationSchemaText: string;
  readonly agentsSchemaText: string;
  /** Workstream A batch 4 (A14/A15); optional so older callers keep working. */
  readonly automationSchemaText?: string;
}

export const OPENAPI_PATH = 'docs/api/openapi.yaml';
export const SCHEMA_PATH = `packages/contracts/src/${SCHEMA_FILE}`;
const SCHEMA_REF_PREFIX = `../../${SCHEMA_PATH}#`;
export const PROPOSAL_SCHEMA_PATH = `packages/contracts/src/${PROPOSAL_SCHEMA_FILE}`;
const PROPOSAL_REF_PREFIX = `../../${PROPOSAL_SCHEMA_PATH}#`;
export const PATIENT_SCHEMA_PATH = `packages/contracts/src/${PATIENT_SCHEMA_FILE}`;
const PATIENT_REF_PREFIX = `../../${PATIENT_SCHEMA_PATH}#`;
export const SCHEDULING_SCHEMA_PATH = `packages/contracts/src/${SCHEDULING_SCHEMA_FILE}`;
const SCHEDULING_REF_PREFIX = `../../${SCHEDULING_SCHEMA_PATH}#`;
export const BILLING_SCHEMA_PATH = `packages/contracts/src/${BILLING_SCHEMA_FILE}`;
const BILLING_REF_PREFIX = `../../${BILLING_SCHEMA_PATH}#`;
export const CLINICAL_SCHEMA_PATH = `packages/contracts/src/${CLINICAL_SCHEMA_FILE}`;
const CLINICAL_REF_PREFIX = `../../${CLINICAL_SCHEMA_PATH}#`;
export const ENGAGEMENT_SCHEMA_PATH = `packages/contracts/src/${ENGAGEMENT_SCHEMA_FILE}`;
const ENGAGEMENT_REF_PREFIX = `../../${ENGAGEMENT_SCHEMA_PATH}#`;
export const IMAGING_SCHEMA_PATH = `packages/contracts/src/${IMAGING_SCHEMA_FILE}`;
const IMAGING_REF_PREFIX = `../../${IMAGING_SCHEMA_PATH}#`;
export const MIGRATION_SCHEMA_PATH = `packages/contracts/src/${MIGRATION_SCHEMA_FILE}`;
const MIGRATION_REF_PREFIX = `../../${MIGRATION_SCHEMA_PATH}#`;
export const AGENTS_SCHEMA_FILE = 'agents.schema.json';
export const AGENTS_SCHEMA_PATH = `packages/contracts/src/${AGENTS_SCHEMA_FILE}`;
const AGENTS_REF_PREFIX = `../../${AGENTS_SCHEMA_PATH}#`;
export const AUTOMATION_SCHEMA_FILE = 'automation.schema.json';
export const AUTOMATION_SCHEMA_PATH = `packages/contracts/src/${AUTOMATION_SCHEMA_FILE}`;
const AUTOMATION_REF_PREFIX = `../../${AUTOMATION_SCHEMA_PATH}#`;

export function loadContractSources(root: string): ContractSources {
  return {
    openapiText: readFileSync(resolve(root, OPENAPI_PATH), 'utf8'),
    schemaText: readFileSync(resolve(root, SCHEMA_PATH), 'utf8'),
    proposalSchemaText: readFileSync(resolve(root, PROPOSAL_SCHEMA_PATH), 'utf8'),
    patientSchemaText: readFileSync(resolve(root, PATIENT_SCHEMA_PATH), 'utf8'),
    schedulingSchemaText: readFileSync(resolve(root, SCHEDULING_SCHEMA_PATH), 'utf8'),
    billingSchemaText: readFileSync(resolve(root, BILLING_SCHEMA_PATH), 'utf8'),
    clinicalSchemaText: readFileSync(resolve(root, CLINICAL_SCHEMA_PATH), 'utf8'),
    engagementSchemaText: readFileSync(resolve(root, ENGAGEMENT_SCHEMA_PATH), 'utf8'),
    imagingSchemaText: readFileSync(resolve(root, IMAGING_SCHEMA_PATH), 'utf8'),
    migrationSchemaText: readFileSync(resolve(root, MIGRATION_SCHEMA_PATH), 'utf8'),
    agentsSchemaText: readFileSync(resolve(root, AGENTS_SCHEMA_PATH), 'utf8'),
    automationSchemaText: readFileSync(resolve(root, AUTOMATION_SCHEMA_PATH), 'utf8'),
  };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

function pointer(doc: unknown, ptr: string): unknown {
  if (ptr === '' || ptr === '/') return doc;
  let cur: unknown = doc;
  for (const raw of ptr.replace(/^\//, '').split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(cur) || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) collectRefs(n, out);
  else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

const schemaRef = (name: string) =>
  name.startsWith('#/')
    ? name
    : name.startsWith('automation:')
      ? `${AUTOMATION_REF_PREFIX}/$defs/${name.slice('automation:'.length)}`
      : name.startsWith('agents:')
        ? `${AGENTS_REF_PREFIX}/$defs/${name.slice('agents:'.length)}`
        : name.startsWith('migration:')
          ? `${MIGRATION_REF_PREFIX}/$defs/${name.slice('migration:'.length)}`
          : name.startsWith('proposal:')
            ? `${PROPOSAL_REF_PREFIX}/$defs/${name.slice('proposal:'.length)}`
            : name.startsWith('patient:')
              ? `${PATIENT_REF_PREFIX}/$defs/${name.slice('patient:'.length)}`
              : name.startsWith('scheduling:')
                ? `${SCHEDULING_REF_PREFIX}/$defs/${name.slice('scheduling:'.length)}`
                : name.startsWith('clinical:')
                  ? `${CLINICAL_REF_PREFIX}/$defs/${name.slice('clinical:'.length)}`
                  : name.startsWith('engagement:')
                    ? `${ENGAGEMENT_REF_PREFIX}/$defs/${name.slice('engagement:'.length)}`
                    : name.startsWith('imaging:')
                      ? `${IMAGING_REF_PREFIX}/$defs/${name.slice('imaging:'.length)}`
                      : name.startsWith('billing:')
                        ? `${BILLING_REF_PREFIX}/$defs/${name.slice('billing:'.length)}`
                        : `${SCHEMA_REF_PREFIX}/$defs/${name}`;

/** Definitions the scheduling contract copies from the task contract; they must stay byte-identical. */
const SCHEDULING_SHARED_DEFS = ['LocationRef', 'Version', 'IdempotencyKey'] as const;
/** Scheduling request bodies and queries: closed objects only. */
const SCHEDULING_BODIES = [
  'LocationDefine',
  'LocationTimeZoneChange',
  'LocationListQuery',
  'ResourceDefine',
  'ResourceListQuery',
  'AvailabilitySet',
  'ResourceDeactivate',
  'TimeBlockCreate',
  'ResourceRef',
  'WeeklyInterval',
  'AvailabilitySearch',
  'AvailabilityRequirement',
  // S8, S10, S11 request bodies, list queries and nested inputs.
  'AppointmentRequestCreate',
  'AppointmentRequestPreferences',
  'AppointmentRequestReview',
  'AppointmentRequestClose',
  'AppointmentRequestReopen',
  'AppointmentRequestListQuery',
  'PreferredWindow',
  'ProviderRef',
  'BookingOverride',
  'BookingCreate',
  'AppointmentReschedule',
  'AppointmentCancel',
  'HoldCreate',
  'HoldRelease',
  'HoldReconcile',
  'AttendanceRecord',
  'WorklistQuery',
] as const;

/** B1/B2: definitions the billing contract copies from the task contract (byte-identical). */
const BILLING_SHARED_DEFS = ['Version', 'IdempotencyKey'] as const;
/** Billing request bodies and queries: closed objects only. */
export const BILLING_BODIES = [
  'Money',
  'PositiveMoney',
  'ChargePost',
  'EntryReverse',
  'LedgerQuery',
  'BalanceQuery',
  // B2.
  'PaymentRecord',
  'PaymentSettle',
  'AllocationLine',
  'PaymentAllocate',
  'PaymentRefund',
  'FundsTransfer',
  'ResponsibilityTransfer',
  'AttemptReconcile',
  'WorklistQuery',
  // B3.
  'PlanCreate',
  'PlanAuthorize',
  'PlanAmend',
  'PlanAutopay',
  'PlanCollect',
  'PlanClose',
  'PlanWorklistQuery',
  // B4.
  'StatementGenerate',
  // B5.
  'CoverageRecord',
  'CoverageChange',
  'OverlapOverride',
  'EnteredBenefits',
  'EligibilityRecord',
  'CoverageQuery',
] as const;

/** Definitions the clinical contract copies from the task contract; they must stay byte-identical. */
const CLINICAL_SHARED_DEFS = ['LocationRef', 'Version', 'IdempotencyKey', 'Cursor'] as const;
/** Clinical request bodies, queries and nested inputs (C5, C8): closed objects only. */
export const CLINICAL_BODIES = [
  'ClinicalAuthorDefine',
  'EncounterOpen',
  'EncounterAssign',
  'EncounterClose',
  'EncounterListQuery',
  'AssignmentInput',
  'Assignee',
  'HistoryChangeRecord',
  'HistoryChangeInput',
  'HistoryReadQuery',
  'HistoryVerify',
  'HistoryReviewAttest',
  // C6/C7/C11 clinical record bodies, queries and nested inputs.
  'ChartEntryRecord',
  'ChartEntryCorrect',
  'ChartReadQuery',
  'ToothInput',
  'PerioExamRecord',
  'PerioToothInput',
  'PerioExamCorrect',
  'PerioCorrectionInput',
  'PerioCorrectionValue',
  'PerioDerive',
  'PerioCompareQuery',
  'TreatmentPlanCreate',
  'PlanDetailAdd',
  'PlanItemAdd',
  'PlanItemStateSet',
  'PlanDetailStateSet',
  'PlanVersionSupersede',
  // C12 estimates, alternatives and acceptance.
  'EstimateGenerate',
  'EstimateLineInput',
  'EstimateAssumptionInput',
  'EstimatePresent',
  'EstimateAccept',
  'PlanAlternativeCreate',
  'Money',
  // C13 consent capture.
  'ConsentCapture',
  'ConsentWithdraw',
  'ConsentListQuery',
  'ConsentTemplateRegister',
  'ConsentEvidence',
  // C17 referrals.
  'ReferralCreate',
  'ReferralPackage',
  'ReferralSelection',
  'ReferralShareCreate',
  'ReferralSend',
  'ReferralTransmissionFailure',
  'ReferralResponse',
  'ReferralClose',
  'ReferralRecall',
  'ReferralWorklistQuery',
  // C16 lab cases.
  'LabCaseCreate',
  'LabCaseSetState',
  'LabCaseReturn',
  'LabCaseAttach',
  'LabCaseRemake',
  'LabWorklistQuery',
  // C15 encounter image links.
  'ImageLinkCreate',
  'ImageLinkRelink',
  'ImageLinkUnlink',
  // C14 rendered procedures.
  'ProcedureRender',
  'ProcedureCorrect',
  'ProcedureReplacement',
  // C9 note templates.
  'NoteTemplateDefine',
  'NoteTemplateRevise',
  'NoteTemplateRetire',
  'NoteTemplateApplicableQuery',
  'NoteTemplateSection',
  // C10 notes.
  'NoteDraftCreate',
  'NoteDraftUpdate',
  'NoteSign',
  'NoteAmend',
  'NoteAddendum',
  'NoteCosign',
  'NoteContent',
  'NoteSectionEntry',
] as const;
/** Definitions the imaging contract copies from the task contract; byte-identical too (I). */
const IMAGING_SHARED_DEFS = ['Version', 'IdempotencyKey'] as const;
/** JSON pointer segment of a media type. */
const mediaKey = (media: string | undefined) => (media ?? 'application/json').replace('/', '~1');

/** Definitions the proposal contract copies from the task contract; they must stay byte-identical. */
const SHARED_DEFS = ['TaskRef', 'LocationRef', 'Label', 'Version', 'IdempotencyKey'] as const;
/** Definitions the patient contract copies from the task contract (S4); byte-identical too. */
const PATIENT_SHARED_DEFS = ['LocationRef', 'Version', 'IdempotencyKey', 'Cursor'] as const;
/** Patient request bodies and queries: each must refuse unknown properties. */
export const PATIENT_BODIES = [
  'PatientCreate',
  'PatientDemographicsUpdate',
  'PatientStatusChange',
  'PatientReadQuery',
  'PatientSearch',
  'RelationshipCreate',
  'RelationshipRevoke',
  'RelationshipListQuery',
  'PatientAccessQuery',
  'DuplicateQuery',
  'MergeRequest',
  'UnmergeRequest',
  'MergeHistoryQuery',
] as const;

/** Every operation the OpenAPI document declares, parsed (method, path, operationId). */
export function documentedOperations(
  openapiText: string,
): { method: string; path: string; operationId: string }[] {
  const api = parse(openapiText) as Json;
  const out: { method: string; path: string; operationId: string }[] = [];
  const paths = isObj(api.paths) ? api.paths : {};
  for (const [p, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const [method, op] of Object.entries(item)) {
      if (isObj(op) && typeof op.operationId === 'string')
        out.push({ method, path: p, operationId: op.operationId });
    }
  }
  return out;
}

/**
 * Returns every disagreement between the OpenAPI document, the JSON Schema it references, the
 * service route table and the shared refusal contract. An empty list means no drift.
 */
export function checkContractDrift(src: ContractSources): string[] {
  const problems: string[] = [];
  let api: Json;
  let schema: Json;
  let proposal: Json;
  let patient: Json;
  let scheduling: Json;
  let billing: Json;
  let clinical: Json;
  let engagement: Json;
  let imaging: Json;
  let migration: Json;
  let agents: Json;
  let automation: Json = {};
  try {
    api = parse(src.openapiText) as Json;
    schema = JSON.parse(src.schemaText) as Json;
    proposal = JSON.parse(src.proposalSchemaText) as Json;
    patient = JSON.parse(src.patientSchemaText) as Json;
    scheduling = JSON.parse(src.schedulingSchemaText) as Json;
    billing = JSON.parse(src.billingSchemaText) as Json;
    clinical = JSON.parse(src.clinicalSchemaText) as Json;
    engagement = JSON.parse(src.engagementSchemaText) as Json;
    imaging = JSON.parse(src.imagingSchemaText) as Json;
    migration = JSON.parse(src.migrationSchemaText) as Json;
    agents = JSON.parse(src.agentsSchemaText) as Json;
    if (src.automationSchemaText !== undefined) automation = JSON.parse(src.automationSchemaText) as Json;
  } catch {
    return ['OpenAPI or JSON Schema does not parse'];
  }

  for (const ref of collectRefs(api)) {
    if (ref.startsWith(AUTOMATION_REF_PREFIX)) {
      if (pointer(automation, ref.slice(AUTOMATION_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${AUTOMATION_SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith(AGENTS_REF_PREFIX)) {
      if (pointer(agents, ref.slice(AGENTS_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${AGENTS_SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith(MIGRATION_REF_PREFIX)) {
      if (pointer(migration, ref.slice(MIGRATION_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${MIGRATION_SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith(BILLING_REF_PREFIX)) {
      if (pointer(billing, ref.slice(BILLING_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${BILLING_SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith(CLINICAL_REF_PREFIX)) {
      if (pointer(clinical, ref.slice(CLINICAL_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${CLINICAL_SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith(ENGAGEMENT_REF_PREFIX)) {
      if (pointer(engagement, ref.slice(ENGAGEMENT_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${ENGAGEMENT_SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith(SCHEDULING_REF_PREFIX)) {
      if (pointer(scheduling, ref.slice(SCHEDULING_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${SCHEDULING_SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith(IMAGING_REF_PREFIX)) {
      if (pointer(imaging, ref.slice(IMAGING_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${IMAGING_SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith(SCHEMA_REF_PREFIX)) {
      if (pointer(schema, ref.slice(SCHEMA_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith(PROPOSAL_REF_PREFIX)) {
      if (pointer(proposal, ref.slice(PROPOSAL_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${PROPOSAL_SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith(PATIENT_REF_PREFIX)) {
      if (pointer(patient, ref.slice(PATIENT_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${PATIENT_SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith('#/')) {
      if (pointer(api, ref.slice(1)) === undefined)
        problems.push(`OpenAPI local $ref does not resolve: ${ref}`);
    } else {
      problems.push(`OpenAPI $ref points outside the contract: ${ref}`);
    }
  }

  const paths = isObj(api.paths) ? api.paths : {};
  const documented = new Map<string, Json>();
  for (const [p, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const [method, op] of Object.entries(item)) {
      if (!isObj(op)) continue;
      documented.set(`${method} ${p}`, op);
      const id = String(op.operationId);
      if (!ROUTES.some((r) => r.method === method && r.path === p && r.operationId === id)) {
        problems.push(
          `OpenAPI documents ${method.toUpperCase()} ${p} (${id}) which the service does not implement`,
        );
      }
    }
  }

  for (const route of ROUTES) {
    const op = documented.get(`${route.method} ${route.path}`);
    if (!op || op.operationId !== route.operationId) {
      problems.push(`Service implements ${route.operationId} but OpenAPI does not document it`);
      continue;
    }
    const reqRef = pointer(op, `/requestBody/content/${mediaKey(route.requestMedia)}/schema/$ref`);
    if (route.requestBody !== undefined && reqRef !== schemaRef(route.requestBody)) {
      problems.push(`${route.operationId}: request body must reference ${schemaRef(route.requestBody)}`);
    }
    if (route.requestMedia !== undefined && reqRef === undefined) {
      problems.push(`${route.operationId}: request body must be documented as ${route.requestMedia}`);
    }
    if (route.requestBody === undefined && route.requestMedia === undefined && op.requestBody !== undefined) {
      problems.push(`${route.operationId}: OpenAPI documents a request body the service does not accept`);
    }
    const responses = isObj(op.responses) ? op.responses : {};
    const okRef = pointer(
      responses,
      `/${route.success.status}/content/${mediaKey(route.success.media)}/schema/$ref`,
    );
    if (okRef !== schemaRef(route.success.schema)) {
      problems.push(
        `${route.operationId}: ${route.success.status} must reference ${schemaRef(route.success.schema)}`,
      );
    }
    // A8: a byte-range operation documents 206 and 416, answered only to a request carrying a Range.
    const rangeStatuses = route.ranges === 'bytes' ? ['206', '416'] : [];
    for (const s of rangeStatuses)
      if (!isObj(responses[s])) problems.push(`${route.operationId}: ${s} must be documented (byte ranges)`);
    const refusalStatuses = Object.keys(responses)
      .filter((s) => s !== route.success.status && !rangeStatuses.includes(s))
      .sort();
    if (refusalStatuses.join(',') !== [...route.refusals].sort().join(',')) {
      problems.push(`${route.operationId}: documented refusal statuses differ from the service`);
    }
    for (const s of refusalStatuses) {
      if (pointer(responses, `/${s}/$ref`) !== '#/components/responses/Refusal') {
        problems.push(`${route.operationId}: ${s} must use the shared Refusal response`);
      }
    }
  }

  const def = (name: string) => pointer(schema, `/$defs/${name}`);
  for (const name of ['SyntheticTaskCreate', 'SyntheticTaskRelabel', 'SyntheticTaskListQuery', 'Refusal']) {
    if (pointer(def(name), '/additionalProperties') !== false) {
      problems.push(`${name} must set additionalProperties: false`);
    }
  }
  if (pointer(def('Label'), '/minLength') !== 1 || pointer(def('Label'), '/maxLength') !== 120) {
    problems.push('Label must be bounded with minLength 1 and maxLength 120');
  }
  if (pointer(def('SyntheticTaskListQuery'), '/properties/limit/pattern') !== '^([1-9]|[1-9][0-9]|100)$') {
    problems.push('SyntheticTaskListQuery.limit must be bounded to 1..100');
  }
  const pdef = (name: string) => pointer(proposal, `/$defs/${name}`);
  for (const name of [
    'ProposalPrepare',
    'ProposalApprove',
    'ProposalCommit',
    'CreatePayload',
    'RelabelPayload',
  ]) {
    if (pointer(pdef(name), '/additionalProperties') !== false) {
      problems.push(`${name} must set additionalProperties: false`);
    }
  }
  for (const name of SHARED_DEFS) {
    if (JSON.stringify(pdef(name)) !== JSON.stringify(def(name))) {
      problems.push(`${PROPOSAL_SCHEMA_FILE} ${name} differs from ${SCHEMA_FILE}`);
    }
  }
  if (
    JSON.stringify(pointer(pdef('CreatePayload'), '/properties')) !==
    JSON.stringify(pointer(def('SyntheticTaskCreate'), '/properties'))
  ) {
    problems.push('CreatePayload must match SyntheticTaskCreate');
  }
  const patdef = (name: string) => pointer(patient, `/$defs/${name}`);
  for (const name of PATIENT_BODIES) {
    if (pointer(patdef(name), '/additionalProperties') !== false) {
      problems.push(`${name} must set additionalProperties: false`);
    }
  }
  for (const name of PATIENT_SHARED_DEFS) {
    if (JSON.stringify(patdef(name)) !== JSON.stringify(def(name))) {
      problems.push(`${PATIENT_SCHEMA_FILE} ${name} differs from ${SCHEMA_FILE}`);
    }
  }
  if (pointer(patdef('PatientSearch'), '/properties/limit/maximum') !== 100) {
    problems.push('PatientSearch.limit must be bounded to 1..100');
  }
  const sdef = (name: string) => pointer(scheduling, `/$defs/${name}`);
  // S12-S16: every request body and GET query of the operation table is a closed object too.
  const opBodies = SCHEDULING_OPS.flatMap((o) => [
    ...(o.requestBody ? [o.requestBody.replace('scheduling:', '')] : []),
    ...(o.query ? [o.query] : []),
  ]);
  for (const name of [...SCHEDULING_BODIES, ...opBodies]) {
    if (pointer(sdef(name), '/additionalProperties') !== false) {
      problems.push(`${name} must set additionalProperties: false`);
    }
  }
  for (const name of SCHEDULING_SHARED_DEFS) {
    if (JSON.stringify(sdef(name)) !== JSON.stringify(def(name))) {
      problems.push(`${SCHEDULING_SCHEMA_FILE} ${name} differs from ${SCHEMA_FILE}`);
    }
  }
  for (const name of ['ResourceListQuery', 'LocationListQuery']) {
    if (pointer(sdef(name), '/properties/limit/pattern') !== '^([1-9]|[1-9][0-9]|100)$') {
      problems.push(`${name}.limit must be bounded to 1..100`);
    }
  }
  const bdef = (name: string) => pointer(billing, `/$defs/${name}`);
  // The generated BILLING_OPS block is exactly what scripts/openapi-billing.ts renders today.
  try {
    const committed = extractBillingOpsBlock(src.openapiText);
    const rendered = renderBillingOpsBlock(BILLING_OPS, (billing as { $defs: never }).$defs);
    if (committed !== rendered) {
      problems.push(
        'generated BILLING_OPS block differs from scripts/openapi-billing.ts (run openapi:billing)',
      );
    }
  } catch (err) {
    problems.push(`generated BILLING_OPS block cannot be rendered: ${String(err)}`);
  }
  // B6/B7/B9: every request body and GET query of the billing operation table is closed too.
  const billingOpBodies = BILLING_OPS.flatMap((o) => [
    ...(o.requestBody ? [o.requestBody.replace('billing:', '')] : []),
    ...(o.query ? [o.query] : []),
  ]);
  for (const name of [...BILLING_BODIES, ...billingOpBodies]) {
    if (pointer(bdef(name), '/additionalProperties') !== false) {
      problems.push(`${name} must set additionalProperties: false`);
    }
  }
  for (const name of BILLING_SHARED_DEFS) {
    if (JSON.stringify(bdef(name)) !== JSON.stringify(def(name))) {
      problems.push(`${BILLING_SCHEMA_FILE} ${name} differs from ${SCHEMA_FILE}`);
    }
  }
  for (const name of ['MinorUnits', 'PositiveMinorUnits']) {
    if (pointer(bdef(name), '/type') !== 'integer')
      problems.push(`${name} must be an integer (no float money)`);
  }
  const cdef = (name: string) => pointer(clinical, `/$defs/${name}`);
  for (const name of CLINICAL_BODIES) {
    if (pointer(cdef(name), '/additionalProperties') !== false) {
      problems.push(`${name} must set additionalProperties: false`);
    }
  }
  for (const name of CLINICAL_SHARED_DEFS) {
    if (JSON.stringify(cdef(name)) !== JSON.stringify(def(name))) {
      problems.push(`${CLINICAL_SCHEMA_FILE} ${name} differs from ${SCHEMA_FILE}`);
    }
  }
  if (pointer(cdef('EncounterListQuery'), '/properties/limit/pattern') !== '^([1-9]|[1-9][0-9]|100)$') {
    problems.push('EncounterListQuery.limit must be bounded to 1..100');
  }
  // Workstream E: every staff and portal request body and GET query is a closed object.
  const edef = (name: string) => pointer(engagement, `/$defs/${name}`);
  const eBodies = [...ENGAGEMENT_OPS, ...PORTAL_OPS].flatMap((o) => [
    ...(o.requestBody ? [o.requestBody.replace('engagement:', '')] : []),
    ...(o.query ? [o.query] : []),
  ]);
  for (const name of eBodies) {
    if (pointer(edef(name), '/additionalProperties') !== false) {
      problems.push(`${name} must set additionalProperties: false`);
    }
  }
  for (const name of ['Version', 'IdempotencyKey'] as const) {
    if (JSON.stringify(edef(name)) !== JSON.stringify(sdef(name))) {
      problems.push(`${ENGAGEMENT_SCHEMA_FILE} ${name} differs from ${SCHEDULING_SCHEMA_FILE}`);
    }
  }
  // I: every imaging request body and GET query is a closed object; shared definitions stay identical.
  const idef = (name: string) => pointer(imaging, `/$defs/${name}`);
  const imagingBodies = IMAGING_OPS.flatMap((o) => [
    ...(o.requestBody && !o.requestMedia ? [o.requestBody.replace('imaging:', '')] : []),
    ...(o.query ? [o.query] : []),
  ]);
  for (const name of imagingBodies) {
    if (pointer(idef(name), '/additionalProperties') !== false) {
      problems.push(`${name} must set additionalProperties: false`);
    }
  }
  for (const name of IMAGING_SHARED_DEFS) {
    if (JSON.stringify(idef(name)) !== JSON.stringify(def(name))) {
      problems.push(`${IMAGING_SCHEMA_FILE} ${name} differs from ${SCHEMA_FILE}`);
    }
  }
  // Workstream M: the generated MIGRATION_OPS block matches the table; every body and query is closed;
  // the shared definitions stay identical to the task contract.
  try {
    const committed = extractMigrationOpsBlock(src.openapiText);
    const rendered = renderMigrationOpsBlock(MIGRATION_OPS, (migration as { $defs: never }).$defs);
    if (committed !== rendered)
      problems.push(
        'generated MIGRATION_OPS block differs from scripts/openapi-migration.ts (run openapi:migration)',
      );
  } catch (err) {
    problems.push(`generated MIGRATION_OPS block cannot be rendered: ${String(err)}`);
  }
  const mdef = (name: string) => pointer(migration, `/$defs/${name}`);
  for (const name of MIGRATION_OPS.flatMap((o) => [
    ...(o.requestBody ? [o.requestBody.replace('migration:', '')] : []),
    ...(o.query ? [o.query] : []),
  ])) {
    if (pointer(mdef(name), '/additionalProperties') !== false)
      problems.push(`${name} must set additionalProperties: false`);
  }
  for (const name of ['IdempotencyKey', 'Version']) {
    if (JSON.stringify(mdef(name)) !== JSON.stringify(def(name)))
      problems.push(`${MIGRATION_SCHEMA_FILE} ${name} differs from ${SCHEMA_FILE}`);
  }
  // Workstream A batch 2: the generated AGENT_OPS block matches the table; every body and query is
  // closed; the shared definitions stay identical to the task contract.
  try {
    const committed = extractOpsBlock(src.openapiText, AGENT_OPS_BLOCK);
    if (committed !== renderAgentOpsBlock((agents as { $defs: never }).$defs))
      problems.push('generated AGENT_OPS block differs from scripts/openapi-agents.ts (run openapi:agents)');
  } catch (err) {
    problems.push(`generated AGENT_OPS block cannot be rendered: ${String(err)}`);
  }
  const adef = (name: string) => pointer(agents, `/$defs/${name}`);
  for (const name of AGENT_OPS.flatMap((o) => [
    ...(o.requestBody ? [o.requestBody.replace('agents:', '')] : []),
    ...(o.query ? [o.query] : []),
  ])) {
    if (pointer(adef(name), '/additionalProperties') !== false)
      problems.push(`${name} must set additionalProperties: false`);
  }
  for (const name of ['IdempotencyKey', 'Version', 'Cursor']) {
    if (JSON.stringify(adef(name)) !== JSON.stringify(def(name)))
      problems.push(`${AGENTS_SCHEMA_FILE} ${name} differs from ${SCHEMA_FILE}`);
  }
  // Workstream A batch 4: the generated AUTOMATION_OPS block matches the table; bodies and queries
  // are closed; the shared definitions stay identical to the task contract.
  if (src.automationSchemaText !== undefined) {
    try {
      const committed = extractOpsBlock(src.openapiText, AUTOMATION_OPS_BLOCK);
      if (committed !== renderAutomationOpsBlock((automation as { $defs: never }).$defs))
        problems.push(
          'generated AUTOMATION_OPS block differs from scripts/openapi-automation.ts (run openapi:automation)',
        );
    } catch (err) {
      problems.push(`generated AUTOMATION_OPS block cannot be rendered: ${String(err)}`);
    }
    const xdef = (name: string) => pointer(automation, `/$defs/${name}`);
    for (const name of AUTOMATION_OPS.flatMap((o) => [
      ...(o.requestBody ? [o.requestBody.replace('automation:', '')] : []),
      ...(o.query ? [o.query] : []),
    ])) {
      if (pointer(xdef(name), '/additionalProperties') !== false)
        problems.push(`${name} must set additionalProperties: false`);
    }
    for (const name of ['IdempotencyKey', 'Version', 'Cursor']) {
      if (JSON.stringify(xdef(name)) !== JSON.stringify(def(name)))
        problems.push(`${AUTOMATION_SCHEMA_FILE} ${name} differs from ${SCHEMA_FILE}`);
    }
  }
  if (pointer(mdef('MinorUnits'), '/type') !== 'integer')
    problems.push('MinorUnits must be an integer (no float money)');
  const codes = pointer(def('Refusal'), '/properties/code/enum');
  if (!Array.isArray(codes) || codes.join(',') !== REFUSAL_CODES.join(',')) {
    problems.push('Refusal.code enum differs from the shared REFUSAL_CODES contract');
  }
  return problems;
}
