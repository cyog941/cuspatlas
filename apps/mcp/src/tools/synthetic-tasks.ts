import {
  ACTION_PROPOSAL_PROPERTIES,
  type ActorContext,
  createAjv,
  PATIENT_PROPERTIES,
  RefusalError,
  SYNTHETIC_TASK_PROPERTIES,
  safeViolations,
  syntheticTaskSchema,
} from '@cuspatlas/contracts';
import {
  type ActionName,
  type AttemptRecordingDeps,
  type Authorize,
  type PatientService,
  type ProposalService,
  type SyntheticTaskService,
  withAttemptRecording,
  withRefusalRecording,
} from '@cuspatlas/domain';

type Defs = Record<string, unknown>;
const DEFS = syntheticTaskSchema.$defs as Defs;

/** Collects the $defs a fragment references, transitively, so each tool schema is self-contained. */
function closure(fragment: unknown, into: Defs = {}, defs: Defs = DEFS): Defs {
  if (Array.isArray(fragment)) {
    for (const f of fragment) closure(f, into, defs);
  } else if (fragment !== null && typeof fragment === 'object') {
    for (const [k, v] of Object.entries(fragment)) {
      if (k === '$ref' && typeof v === 'string') {
        const name = v.replace('#/$defs/', '');
        if (!(name in into)) {
          into[name] = defs[name];
          closure(defs[name], into, defs);
        }
      } else {
        closure(v, into, defs);
      }
    }
  }
  return into;
}

export interface ToolInputSchema {
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: Record<string, object>;
  readonly $defs: Defs;
}

/** A property is a $defs name, or a schema object copied from the contract (the list query inlines its own). */
type PropertySource = string | object;

/**
 * Builds a tool input schema mechanically from the published contract: every property is a $ref to
 * a definition in synthetic-task.schema.json (or the contract's own inline property schema), copied
 * with its transitive closure. REST body properties keep their names; `idempotencyKey` (the
 * Idempotency-Key header) and `taskRef` (the path parameter) are the only transport additions.
 */
export function inputSchema(
  properties: Record<string, PropertySource>,
  required: readonly string[],
  defs: Defs = DEFS,
): ToolInputSchema {
  const props: Record<string, object> = Object.fromEntries(
    Object.entries(properties).map(([k, d]) => [k, typeof d === 'string' ? { $ref: `#/$defs/${d}` } : d]),
  );
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties: props,
    $defs: closure(props, {}, defs),
  };
}

export type Args = Record<string, unknown>;
type Violations = { pointer: string; rule: string }[];

export interface ToolDeps {
  readonly service: SyntheticTaskService;
  readonly proposals: ProposalService;
  readonly patients: PatientService;
  readonly authorize: Authorize;
  readonly recording: AttemptRecordingDeps;
}

export interface ToolDefinition {
  readonly name: string;
  /** The REST operationId this tool is the MCP twin of. */
  readonly operationId: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly readOnly: boolean;
  /**
   * What happens when the arguments fail the tool schema. The handler never runs with invalid
   * arguments unless this is `domain`, which is allowed only where the domain service validates every
   * argument itself, after authorization and before it reads or writes domain data (the same order
   * and the same refusal REST produces). Otherwise the caller is authorized for `action` (so a
   * caller without access still gets the identical denial and attempt row) and refused with
   * `invalid_request`; no domain statement runs.
   */
  readonly onInvalid: 'domain' | { readonly action: ActionName; readonly recordAll?: boolean };
  /** Runs the shared domain handler with a server-built actor; throws RefusalError on refusal. */
  run(
    deps: ToolDeps,
    actor: ActorContext,
    args: Args,
    valid: boolean,
    violations: Violations,
  ): Promise<unknown>;
}

const KNOWN_PROPERTIES: ReadonlySet<string> = new Set([
  ...SYNTHETIC_TASK_PROPERTIES,
  ...ACTION_PROPOSAL_PROPERTIES,
  ...PATIENT_PROPERTIES,
  'idempotencyKey',
  'proposalRef',
  'patientRef',
  'relationshipRef',
  'mergeRef',
]);

const ajv = createAjv();
export const compileInput = (schema: ToolInputSchema) => ajv.compile(schema);

export function violationsOf(errors: Parameters<typeof safeViolations>[0]): Violations {
  return safeViolations(errors, KNOWN_PROPERTIES);
}

export const without = (args: Args, ...keys: string[]): Args =>
  Object.fromEntries(Object.entries(args).filter(([k]) => !keys.includes(k)));

/**
 * A schema-invalid call never reaches its handler. To keep the frozen ordering (authorization, then
 * schema) it is authorized first, so a caller without access gets the same denial and
 * security-attempt row REST produces; only an authorized caller sees the schema error. Proposal
 * tools record every refusal (as their domain does), the others only denials.
 */
export function refuseInvalid(
  deps: ToolDeps,
  actor: ActorContext,
  tool: ToolDefinition,
  violations: Violations,
): Promise<never> {
  if (tool.onInvalid === 'domain') throw new Error('tool validates in the domain');
  const { action, recordAll } = tool.onInvalid;
  return (recordAll ? withRefusalRecording : withAttemptRecording)(
    deps.recording,
    {
      correlationId: actor.correlationId,
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      operation: tool.operationId,
    },
    async (): Promise<never> => {
      await deps.authorize(actor, action, { tenantId: actor.tenantId, id: 'invalid' });
      throw new RefusalError({ code: 'invalid_request', detail: { violations } });
    },
  );
}

const listProperties = (syntheticTaskSchema.$defs.SyntheticTaskListQuery as { properties: Defs }).properties;

export const SYNTHETIC_TASK_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'synthetic_tasks_create',
    operationId: 'syntheticTasks.create',
    description:
      'Create a synthetic task. Requires an idempotencyKey; repeating it replays the first result.',
    inputSchema: inputSchema(
      { label: 'Label', locationRef: 'LocationRef', idempotencyKey: 'IdempotencyKey' },
      ['label', 'idempotencyKey'],
    ),
    readOnly: false,
    onInvalid: { action: 'syntheticTasks.create' },
    async run(deps, actor, args) {
      return deps.service.createSyntheticTask(actor, {
        operation: 'syntheticTasks.create',
        idempotencyKey: args.idempotencyKey as string,
        payload: without(args, 'idempotencyKey'),
      });
    },
  },
  {
    name: 'synthetic_tasks_list',
    operationId: 'syntheticTasks.list',
    description: 'List synthetic tasks visible to the caller, one bounded page at a time.',
    inputSchema: inputSchema({ limit: listProperties.limit as object, cursor: 'Cursor' }, []),
    readOnly: true,
    onInvalid: { action: 'syntheticTasks.read' },
    run: (deps, actor, args) => deps.service.listSyntheticTasks(actor, { ...args }),
  },
  {
    name: 'synthetic_tasks_get',
    operationId: 'syntheticTasks.read',
    description: 'Read one synthetic task by taskRef. Hidden and missing tasks are indistinguishable.',
    inputSchema: inputSchema({ taskRef: 'TaskRef' }, ['taskRef']),
    readOnly: true,
    onInvalid: { action: 'syntheticTasks.read' },
    async run(deps, actor, args) {
      return { data: await deps.service.getSyntheticTask(actor, args.taskRef as string) };
    },
  },
  {
    name: 'synthetic_tasks_relabel',
    operationId: 'syntheticTasks.relabel',
    description: 'Change a synthetic task label if expectedVersion matches. Requires an idempotencyKey.',
    inputSchema: inputSchema(
      { taskRef: 'TaskRef', label: 'Label', expectedVersion: 'Version', idempotencyKey: 'IdempotencyKey' },
      ['taskRef', 'label', 'expectedVersion', 'idempotencyKey'],
    ),
    readOnly: false,
    onInvalid: { action: 'syntheticTasks.relabel' },
    async run(deps, actor, args) {
      return deps.service.relabelSyntheticTask(actor, args.taskRef as string, {
        operation: 'syntheticTasks.relabel',
        idempotencyKey: args.idempotencyKey as string,
        payload: without(args, 'idempotencyKey', 'taskRef'),
      });
    },
  },
];
