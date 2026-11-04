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
