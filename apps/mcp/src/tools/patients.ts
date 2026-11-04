import { patientSchema } from '@cuspatlas/contracts';
import { inputSchema, type ToolDefinition, without } from './synthetic-tasks';

type Defs = Record<string, unknown>;
const DEFS = patientSchema.$defs as Defs;
type Body = { properties: Record<string, object>; required?: string[] };
const body = (name: string) => DEFS[name] as Body;

/** A REST body's properties plus transport additions (path reference, Idempotency-Key header). */
function fromBody(name: string, transport: Record<string, string>) {
  const b = body(name);
  return inputSchema(
    { ...b.properties, ...transport },
    [...(b.required ?? []), ...Object.keys(transport)],
    DEFS,
  );
}

const key = (args: Record<string, unknown>) => args.idempotencyKey as string;

/**
 * MCP twins of the patient routes (S4). Input schemas are built mechanically from
 * patient.schema.json; `idempotencyKey` (the Idempotency-Key header) and `patientRef` (the path
 * parameter) are the only transport additions. Every handler calls the same domain service REST
 * uses. Invalid arguments are authorized first and then refused with `invalid_request`, so no domain
 * statement runs.
 */
export const PATIENT_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'patients_create',
    operationId: 'patients.create',
    description:
      'Register a synthetic patient. Absent field groups are stored as explicit unknowns. Requires an idempotencyKey.',
    inputSchema: fromBody('PatientCreate', { idempotencyKey: 'IdempotencyKey' }),
    readOnly: false,
    onInvalid: { action: 'patients.create' },
    run: (deps, actor, args) =>
      deps.patients.createPatient(actor, {
        operation: 'patients.create',
        idempotencyKey: key(args),
        payload: without(args, 'idempotencyKey'),
      }),
  },
  {
    name: 'patients_search',
    operationId: 'patients.search',
    description:
      'Search patients visible to the caller (summaries only, no contact values). Audited as a sensitive read.',
    inputSchema: fromBody('PatientSearch', {}),
    readOnly: true,
    onInvalid: { action: 'patients.search' },
    run: (deps, actor, args) => deps.patients.searchPatients(actor, { ...args }),
  },
  {
    name: 'patients_get',
    operationId: 'patients.read',
    description: 'Read one patient by patientRef. Hidden and missing patients are indistinguishable.',
    inputSchema: fromBody('PatientReadQuery', { patientRef: 'PatientRef' }),
    readOnly: true,
    onInvalid: { action: 'patients.read' },
    async run(deps, actor, args) {
      return {
        data: await deps.patients.readPatient(actor, String(args.patientRef), without(args, 'patientRef')),
      };
    },
  },
  {
    name: 'patients_update_demographics',
    operationId: 'patients.updateDemographics',
    description:
      'Replace the given demographic field groups if expectedVersion matches. Requires an idempotencyKey.',
    inputSchema: fromBody('PatientDemographicsUpdate', {
      patientRef: 'PatientRef',
      idempotencyKey: 'IdempotencyKey',
    }),
    readOnly: false,
    onInvalid: { action: 'patients.updateDemographics' },
    run: (deps, actor, args) =>
      deps.patients.updatePatientDemographics(actor, String(args.patientRef), {
        operation: 'patients.updateDemographics',
        idempotencyKey: key(args),
        payload: without(args, 'idempotencyKey', 'patientRef'),
      }),
  },
  {
    name: 'patients_set_status',
    operationId: 'patients.setStatus',
    description:
      'Record an effective-dated patient status (active, inactive, deceased). Never deletes. Requires an idempotencyKey.',
    inputSchema: fromBody('PatientStatusChange', {
      patientRef: 'PatientRef',
      idempotencyKey: 'IdempotencyKey',
    }),
    readOnly: false,
    onInvalid: { action: 'patients.setStatus' },
    run: (deps, actor, args) =>
      deps.patients.setPatientStatus(actor, String(args.patientRef), {
        operation: 'patients.setStatus',
        idempotencyKey: key(args),
        payload: without(args, 'idempotencyKey', 'patientRef'),
      }),
  },
  // S5 relationships.
  {
    name: 'patients_add_relationship',
    operationId: 'patients.relationships.add',
    description:
      'Record a guardian, guarantor, dependent or proxy relationship towards the patient, with relationship scopes. Requires an idempotencyKey.',
    inputSchema: fromBody('RelationshipCreate', {
      patientRef: 'PatientRef',
      idempotencyKey: 'IdempotencyKey',
    }),
    readOnly: false,
    onInvalid: { action: 'patients.relationships.add' },
    run: (deps, actor, args) =>
      deps.patients.addRelationship(actor, String(args.patientRef), {
        operation: 'patients.relationships.add',
        idempotencyKey: key(args),
        payload: without(args, 'idempotencyKey', 'patientRef'),
      }),
  },
  {
    name: 'patients_list_relationships',
    operationId: 'patients.relationships.list',
    description: 'List relationships about or held by the patient, with their status computed now.',
    inputSchema: fromBody('RelationshipListQuery', { patientRef: 'PatientRef' }),
    readOnly: true,
    onInvalid: { action: 'patients.relationships.list' },
    run: (deps, actor, args) =>
      deps.patients.listRelationships(actor, String(args.patientRef), without(args, 'patientRef')),
  },
  {
    name: 'patients_revoke_relationship',
    operationId: 'patients.relationships.revoke',
    description:
      'Revoke a relationship now (sets its end instant; never deletes). Requires expectedVersion and an idempotencyKey.',
    inputSchema: fromBody('RelationshipRevoke', {
      patientRef: 'PatientRef',
      relationshipRef: 'RelationshipRef',
      idempotencyKey: 'IdempotencyKey',
    }),
    readOnly: false,
    onInvalid: { action: 'patients.relationships.revoke' },
    run: (deps, actor, args) =>
      deps.patients.revokeRelationship(actor, String(args.patientRef), String(args.relationshipRef), {
        operation: 'patients.relationships.revoke',
        idempotencyKey: key(args),
        payload: without(args, 'idempotencyKey', 'patientRef', 'relationshipRef'),
      }),
  },
  {
    name: 'patients_resolve_access',
    operationId: 'patients.access.resolve',
    description:
      'Show what a related person may do for the patient now (relationship scopes, expiry, reason), evaluated with the server clock.',
    inputSchema: fromBody('PatientAccessQuery', { patientRef: 'PatientRef' }),
    readOnly: true,
    onInvalid: { action: 'patients.access.resolve' },
    run: (deps, actor, args) =>
      deps.patients.resolvePatientAccess(actor, String(args.patientRef), without(args, 'patientRef')),
  },
];
