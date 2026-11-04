import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REFUSAL_CODES } from '@cuspatlas/contracts';
import { parse } from 'yaml';
import {
  CLINICAL_SCHEMA_FILE,
  PATIENT_SCHEMA_FILE,
  PROPOSAL_SCHEMA_FILE,
  ROUTES,
  SCHEDULING_SCHEMA_FILE,
  SCHEMA_FILE,
} from './routes/manifest';

export interface ContractSources {
  readonly openapiText: string;
  readonly schemaText: string;
  readonly proposalSchemaText: string;
  readonly patientSchemaText: string;
  readonly schedulingSchemaText: string;
  readonly clinicalSchemaText: string;
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
export const CLINICAL_SCHEMA_PATH = `packages/contracts/src/${CLINICAL_SCHEMA_FILE}`;
const CLINICAL_REF_PREFIX = `../../${CLINICAL_SCHEMA_PATH}#`;

export function loadContractSources(root: string): ContractSources {
  return {
    openapiText: readFileSync(resolve(root, OPENAPI_PATH), 'utf8'),
    schemaText: readFileSync(resolve(root, SCHEMA_PATH), 'utf8'),
    proposalSchemaText: readFileSync(resolve(root, PROPOSAL_SCHEMA_PATH), 'utf8'),
    patientSchemaText: readFileSync(resolve(root, PATIENT_SCHEMA_PATH), 'utf8'),
    schedulingSchemaText: readFileSync(resolve(root, SCHEDULING_SCHEMA_PATH), 'utf8'),
    clinicalSchemaText: readFileSync(resolve(root, CLINICAL_SCHEMA_PATH), 'utf8'),
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
    : name.startsWith('proposal:')
      ? `${PROPOSAL_REF_PREFIX}/$defs/${name.slice('proposal:'.length)}`
      : name.startsWith('patient:')
        ? `${PATIENT_REF_PREFIX}/$defs/${name.slice('patient:'.length)}`
        : name.startsWith('scheduling:')
          ? `${SCHEDULING_REF_PREFIX}/$defs/${name.slice('scheduling:'.length)}`
          : name.startsWith('clinical:')
            ? `${CLINICAL_REF_PREFIX}/$defs/${name.slice('clinical:'.length)}`
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
  let clinical: Json;
  try {
    api = parse(src.openapiText) as Json;
    schema = JSON.parse(src.schemaText) as Json;
    proposal = JSON.parse(src.proposalSchemaText) as Json;
    patient = JSON.parse(src.patientSchemaText) as Json;
    scheduling = JSON.parse(src.schedulingSchemaText) as Json;
    clinical = JSON.parse(src.clinicalSchemaText) as Json;
  } catch {
    return ['OpenAPI or JSON Schema does not parse'];
  }

  for (const ref of collectRefs(api)) {
    if (ref.startsWith(CLINICAL_REF_PREFIX)) {
      if (pointer(clinical, ref.slice(CLINICAL_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${CLINICAL_SCHEMA_FILE}: ${ref}`);
      }
    } else if (ref.startsWith(SCHEDULING_REF_PREFIX)) {
      if (pointer(scheduling, ref.slice(SCHEDULING_REF_PREFIX.length)) === undefined) {
        problems.push(`OpenAPI $ref does not resolve in ${SCHEDULING_SCHEMA_FILE}: ${ref}`);
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
    const reqRef = pointer(op, '/requestBody/content/application~1json/schema/$ref');
    if (route.requestBody !== undefined && reqRef !== schemaRef(route.requestBody)) {
      problems.push(`${route.operationId}: request body must reference ${schemaRef(route.requestBody)}`);
    }
    if (route.requestBody === undefined && op.requestBody !== undefined) {
      problems.push(`${route.operationId}: OpenAPI documents a request body the service does not accept`);
    }
    const responses = isObj(op.responses) ? op.responses : {};
    const okRef = pointer(responses, `/${route.success.status}/content/application~1json/schema/$ref`);
    if (okRef !== schemaRef(route.success.schema)) {
      problems.push(
        `${route.operationId}: ${route.success.status} must reference ${schemaRef(route.success.schema)}`,
      );
    }
    const refusalStatuses = Object.keys(responses)
      .filter((s) => s !== route.success.status)
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
  for (const name of SCHEDULING_BODIES) {
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
  const codes = pointer(def('Refusal'), '/properties/code/enum');
  if (!Array.isArray(codes) || codes.join(',') !== REFUSAL_CODES.join(',')) {
    problems.push('Refusal.code enum differs from the shared REFUSAL_CODES contract');
  }
  return problems;
}
