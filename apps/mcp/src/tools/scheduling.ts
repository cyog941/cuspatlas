import { schedulingSchema } from '@cuspatlas/contracts';
import { inputSchema, type ToolDefinition, without } from './synthetic-tasks';

const DEFS = schedulingSchema.$defs as Record<string, unknown>;
const props = (name: string) => (DEFS[name] as { properties: Record<string, unknown> }).properties;
const listResources = props('ResourceListQuery');
const listLocations = props('LocationListQuery');

/**
 * MCP twins of the S7 scheduling routes. Input schemas are built mechanically from
 * scheduling.schema.json; `idempotencyKey` (the Idempotency-Key header), `resourceRef` and the path
 * `locationRef` are the only transport additions. Every handler calls the same domain service REST
 * uses, which authorizes before it validates.
 */
export const SCHEDULING_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'scheduling_locations_define',
    operationId: 'scheduling.locations.define',
    description:
      'Define a practice location with its IANA time zone. Requires admin.configure and an idempotencyKey.',
    inputSchema: inputSchema(
      {
        locationRef: 'LocationRef',
        displayLabel: 'DisplayLabel',
        timeZone: 'TimeZone',
        idempotencyKey: 'IdempotencyKey',
      },
      ['locationRef', 'displayLabel', 'timeZone', 'idempotencyKey'],
      DEFS,
    ),
    readOnly: false,
    onInvalid: { action: 'scheduling.locations.define' },
    run: (deps, actor, args) =>
      deps.scheduling.defineLocation(actor, {
        operation: 'scheduling.locations.define',
        idempotencyKey: args.idempotencyKey as string,
        payload: without(args, 'idempotencyKey'),
      }),
  },
  {
    name: 'scheduling_locations_list',
    operationId: 'scheduling.locations.list',
    description: 'List locations visible to the caller, one bounded page at a time.',
    inputSchema: inputSchema({ limit: listLocations.limit as object, cursor: 'Cursor' }, [], DEFS),
    readOnly: true,
    onInvalid: { action: 'scheduling.locations.list' },
    run: (deps, actor, args) => deps.scheduling.listLocations(actor, { ...args }),
  },
  {
    name: 'scheduling_locations_change_time_zone',
    operationId: 'scheduling.locations.changeTimeZone',
    description:
      'Change a location time zone if expectedVersion matches. Refused while the location has future occupied time.',
    inputSchema: inputSchema(
      {
        locationRef: 'LocationRef',
        timeZone: 'TimeZone',
        expectedVersion: 'Version',
        idempotencyKey: 'IdempotencyKey',
      },
      ['locationRef', 'timeZone', 'expectedVersion', 'idempotencyKey'],
      DEFS,
    ),
    readOnly: false,
    onInvalid: { action: 'scheduling.locations.changeTimeZone' },
    run: (deps, actor, args) =>
      deps.scheduling.changeLocationTimeZone(actor, args.locationRef as string, {
        operation: 'scheduling.locations.changeTimeZone',
        idempotencyKey: args.idempotencyKey as string,
        payload: without(args, 'idempotencyKey', 'locationRef'),
      }),
  },
  {
    name: 'scheduling_resources_define',
    operationId: 'scheduling.resources.define',
    description:
      'Define a provider, operatory, equipment or staff resource at a location. A label naming an appointment state is refused.',
    inputSchema: inputSchema(
      {
        kind: 'ResourceKind',
        locationRef: 'LocationRef',
        displayLabel: 'DisplayLabel',
        displayOrder: 'DisplayOrder',
        idempotencyKey: 'IdempotencyKey',
      },
      ['kind', 'locationRef', 'idempotencyKey'],
      DEFS,
    ),
    readOnly: false,
    onInvalid: { action: 'scheduling.resources.define' },
    run: (deps, actor, args) =>
      deps.scheduling.defineResource(actor, {
        operation: 'scheduling.resources.define',
        idempotencyKey: args.idempotencyKey as string,
        payload: without(args, 'idempotencyKey'),
      }),
  },
  {
    name: 'scheduling_resources_list',
    operationId: 'scheduling.resources.list',
    description:
      'List resources visible to the caller, optionally by location and kind, one bounded page at a time.',
    inputSchema: inputSchema(
      {
        locationRef: 'LocationRef',
        kind: 'ResourceKind',
        limit: listResources.limit as object,
        cursor: 'Cursor',
      },
      [],
      DEFS,
    ),
    readOnly: true,
    onInvalid: { action: 'scheduling.resources.list' },
    run: (deps, actor, args) => deps.scheduling.listResources(actor, { ...args }),
  },
  {
    name: 'scheduling_resources_get',
    operationId: 'scheduling.resources.read',
    description:
      'Read one resource and its effective-dated availability versions. Hidden and missing are identical.',
    inputSchema: inputSchema({ resourceRef: 'ResourceRefId' }, ['resourceRef'], DEFS),
    readOnly: true,
    onInvalid: { action: 'scheduling.resources.read' },
    async run(deps, actor, args) {
      return { data: await deps.scheduling.getResource(actor, args.resourceRef as string) };
    },
  },
  {
    name: 'scheduling_resources_set_availability',
    operationId: 'scheduling.resources.setAvailability',
    description:
      'Add an availability version from effectiveFrom (weekly local hours). Prior versions are never rewritten; an empty week ends availability.',
    inputSchema: inputSchema(
      {
        resourceRef: 'ResourceRefId',
        effectiveFrom: 'LocalDate',
        weekly: 'WeeklyHours',
        idempotencyKey: 'IdempotencyKey',
      },
      ['resourceRef', 'effectiveFrom', 'weekly', 'idempotencyKey'],
      DEFS,
    ),
    readOnly: false,
    onInvalid: { action: 'scheduling.resources.setAvailability' },
    run: (deps, actor, args) =>
      deps.scheduling.setResourceAvailability(actor, args.resourceRef as string, {
        operation: 'scheduling.resources.setAvailability',
        idempotencyKey: args.idempotencyKey as string,
        payload: without(args, 'idempotencyKey', 'resourceRef'),
      }),
  },
  {
    name: 'scheduling_resources_deactivate',
    operationId: 'scheduling.resources.deactivate',
    description:
      'Deactivate a resource if expectedVersion matches. Refused with the bookings enumerated while it has future bookings.',
    inputSchema: inputSchema(
      { resourceRef: 'ResourceRefId', expectedVersion: 'Version', idempotencyKey: 'IdempotencyKey' },
      ['resourceRef', 'expectedVersion', 'idempotencyKey'],
      DEFS,
    ),
    readOnly: false,
    onInvalid: { action: 'scheduling.resources.deactivate' },
    run: (deps, actor, args) =>
      deps.scheduling.deactivateResource(actor, args.resourceRef as string, {
        operation: 'scheduling.resources.deactivate',
        idempotencyKey: args.idempotencyKey as string,
        payload: without(args, 'idempotencyKey', 'resourceRef'),
      }),
  },
  {
    name: 'scheduling_time_blocks_create',
    operationId: 'scheduling.timeBlocks.create',
    description:
      'Block time on resources (or the whole location when resources is empty) with a reason and no patient.',
    inputSchema: inputSchema(
      {
        locationRef: 'LocationRef',
        startsAt: 'Instant',
        endsAt: 'Instant',
        reasonCode: 'TimeBlockReason',
        resources: (DEFS.TimeBlockCreate as { properties: Record<string, object> }).properties
          .resources as object,
        idempotencyKey: 'IdempotencyKey',
      },
      ['locationRef', 'startsAt', 'endsAt', 'reasonCode', 'resources', 'idempotencyKey'],
      DEFS,
    ),
    readOnly: false,
    onInvalid: { action: 'scheduling.timeBlocks.create' },
    run: (deps, actor, args) =>
      deps.scheduling.createTimeBlock(actor, {
        operation: 'scheduling.timeBlocks.create',
        idempotencyKey: args.idempotencyKey as string,
        payload: without(args, 'idempotencyKey'),
      }),
  },
  {
    name: 'scheduling_resources_data_quality',
    operationId: 'scheduling.resources.dataQuality',
    description:
      'Report resources whose label resembles an appointment state (pseudo-resources). Requires admin.configure.',
    inputSchema: inputSchema({}, [], DEFS),
    readOnly: true,
    onInvalid: { action: 'scheduling.resources.dataQuality' },
    async run(deps, actor) {
      return { data: await deps.scheduling.stateLabelledResources(actor) };
    },
  },
];
