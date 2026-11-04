import type { ActorContext } from '@cuspatlas/contracts';
import { clinicalSchema } from '@cuspatlas/contracts';
import type { ActionName } from '@cuspatlas/domain';
import { type Args, inputSchema, type ToolDefinition, type ToolDeps, without } from './synthetic-tasks';

const DEFS = clinicalSchema.$defs as Record<string, unknown>;
type Def = { properties: Record<string, object>; required?: string[] };
const def = (name: string) => DEFS[name] as Def;

/** Transport-only properties and the contract definition each one uses. */
const TRANSPORT: Record<string, string> = {
  idempotencyKey: 'IdempotencyKey',
  encounterRef: 'EncounterRef',
  patientRef: 'PatientRef',
  itemRef: 'HistoryItemRef',
  historyVersionRef: 'HistoryVersionRef',
};

/**
 * Input schema = the REST body (or list query) definition's properties, plus the transport-only
 * properties (Idempotency-Key header and path parameters). Built mechanically from
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
  'Synthetic engineering implementation; clinical semantics are recommended-pending-clinical-approval and not clinically validated.';

const SPECS: readonly Spec[] = [
  {
    name: 'clinical_authors_define',
    operationId: 'clinical.authors.define',
    description: `Define or change the clinical author profile (role, credential reference) of a tenant member. Human admin only. ${SAFETY}`,
    body: 'ClinicalAuthorDefine',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.defineClinicalAuthor(actor, envelope('clinical.authors.define', args)),
  },
  {
    name: 'clinical_author_context',
    operationId: 'clinical.authors.context',
    description:
      'The caller’s own clinical author context; not resolvable is an explicit answer with its reason.',
    body: null,
    transport: [],
    readOnly: true,
    async run(d, actor) {
      return { data: await d.clinical.getAuthorContext(actor) };
    },
  },
  {
    name: 'clinical_encounters_open',
    operationId: 'clinical.encounters.open',
    description: `Open an encounter for a patient (optionally an appointment; one encounter per appointment, a second open returns the first). Attendance is not clinical completion. Human clinical authors only. ${SAFETY}`,
    body: 'EncounterOpen',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) => d.clinical.openEncounter(actor, envelope('clinical.encounters.open', args)),
  },
  {
    name: 'clinical_encounters_get',
    operationId: 'clinical.encounters.read',
    description: 'Read one encounter with its assignments and authorship. Hidden and missing are identical.',
    body: null,
    transport: ['encounterRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.clinical.readEncounter(actor, args.encounterRef as string) };
    },
  },
  {
    name: 'clinical_encounters_assign',
    operationId: 'clinical.encounters.assign',
    description:
      'Append one role assignment (treating, secondary, supervising, staff, completing) or an unassignment, if expectedVersion matches. Other roles are unchanged.',
    body: 'EncounterAssign',
    transport: ['encounterRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.assignEncounterRole(
        actor,
        args.encounterRef as string,
        envelope('clinical.encounters.assign', args, 'encounterRef'),
      ),
  },
  {
    name: 'clinical_encounters_close',
    operationId: 'clinical.encounters.close',
    description:
      'Close an open encounter with a configured disposition. One-way; changes no plan item, attendance or billing fact.',
    body: 'EncounterClose',
    transport: ['encounterRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.closeEncounter(
        actor,
        args.encounterRef as string,
        envelope('clinical.encounters.close', args, 'encounterRef'),
      ),
  },
  {
    name: 'clinical_encounters_list',
    operationId: 'clinical.encounters.list',
    description: 'List a patient’s encounters at visible locations, one bounded page at a time.',
    body: 'EncounterListQuery',
    transport: ['patientRef'],
    readOnly: true,
    run: (d, actor, args) =>
      d.clinical.listEncounters(actor, args.patientRef as string, without(args, 'patientRef')),
  },
  // C8 medical history, allergies and medications.
  {
    name: 'clinical_history_record_change',
    operationId: 'clinical.history.recordChange',
    description: `Record one append-only history version (conditions, allergies, medications, vitals, social) with who reported it and its source. Removal is a state change with a reason. Free text and provisional SYN- codes only; no drug database and no interaction checking. ${SAFETY}`,
    body: 'HistoryChangeRecord',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.recordHistoryChange(actor, envelope('clinical.history.recordChange', args)),
  },
  {
    name: 'clinical_history_read',
    operationId: 'clinical.history.read',
    description:
      'Read a patient history as of an instant (default now) with every change, provenance and verification. recorded=false means unknown, not empty.',
    body: 'HistoryReadQuery',
    transport: ['patientRef'],
    readOnly: true,
    async run(d, actor, args) {
      return {
        data: await d.clinical.readHistory(actor, args.patientRef as string, without(args, 'patientRef')),
      };
    },
  },
  {
    name: 'clinical_history_get_version',
    operationId: 'clinical.history.readVersion',
    description: 'Read one recorded history version and its change set.',
    body: null,
    transport: ['historyVersionRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.clinical.getHistoryVersion(actor, args.historyVersionRef as string) };
    },
  },
  {
    name: 'clinical_history_alerts',
    operationId: 'clinical.history.alerts',
    description:
      'Allergies, conditions and medications as recorded: unknown (nothing recorded, never "none"), none_reported, reviewed_none or present. Interaction checking and decision support are not provided.',
    body: null,
    transport: ['patientRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.clinical.getActiveAlerts(actor, args.patientRef as string) };
    },
  },
  {
    name: 'clinical_history_verify_item',
    operationId: 'clinical.history.verifyItem',
    description:
      'Record a clinician verification of the exact current change of an item; never alters the reported value. A later change needs a new verification.',
    body: 'HistoryVerify',
    transport: ['itemRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.verifyHistoryItem(
        actor,
        args.itemRef as string,
        envelope('clinical.history.verifyItem', args, 'itemRef'),
      ),
  },
  {
    name: 'clinical_history_attest_review',
    operationId: 'clinical.history.attestReview',
    description:
      'Attest at an open encounter that allergies, conditions or medications were reviewed: none present, or the recorded list confirmed.',
    body: 'HistoryReviewAttest',
    transport: ['encounterRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.clinical.attestHistoryReview(
        actor,
        args.encounterRef as string,
        envelope('clinical.history.attestReview', args, 'encounterRef'),
      ),
  },
];

/**
 * MCP twins of the clinical routes. Every handler calls the same domain service REST uses, which
 * authorizes before it validates; invalid arguments are refused after authorization for the same
 * action, so a caller without access gets the identical denial and attempt row.
 */
export const CLINICAL_TOOLS: readonly ToolDefinition[] = SPECS.map((s) => ({
  name: s.name,
  operationId: s.operationId,
  description: s.description,
  inputSchema: schemaFor(s.body, s.transport),
  readOnly: s.readOnly,
  onInvalid: { action: s.operationId },
  run: (deps, actor, args) => s.run(deps, actor, args),
}));
