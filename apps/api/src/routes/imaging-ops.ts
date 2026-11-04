import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import type { ActionName, ImagingService } from '@cuspatlas/domain';
import type { RouteContract } from './manifest';

/**
 * One table for every imaging operation (workstream I): the REST route contract, the MCP tool name and
 * the call into the shared domain service. REST registration (imaging-routes.ts), the MCP tool list
 * (apps/mcp/src/tools/imaging-ops.ts), the drift checks and the imaging parity matrix derive from it.
 *
 * Bytes travel on REST only (`restOnly`): MCP returns references and metadata, never object bytes
 * (decision recorded in docs/execution/imaging-progress.md).
 */
export interface ImagingOpInput {
  readonly params: Readonly<Record<string, string>>;
  /** JSON body of a POST, the query object of a GET, or the raw bytes of a binary upload. */
  readonly body: unknown;
  /** Idempotency-Key header (REST) or `idempotencyKey` argument (MCP); validated by the domain. */
  readonly key: string;
  /** REST only: the x-object-read-token header of a content read. */
  readonly token?: string;
}

export interface ImagingOp extends RouteContract {
  readonly operationId: ActionName;
  readonly tool: string;
  readonly description: string;
  /** GET only: the imaging.schema.json definition of the query object. */
  readonly query?: string;
  /** A POST that is not idempotent by key (no Idempotency-Key; mints a fresh short-lived grant). */
  readonly unkeyed?: boolean;
  /** Byte transport: never exposed as an MCP tool. */
  readonly restOnly?: boolean;
  invoke(svc: ImagingService, actor: ActorContext, input: ImagingOpInput): Promise<unknown>;
}

const I = (name: string) => `imaging:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
const READ = ['401', '403', '404', '503'] as const;
const LIST = ['400', '401', '403', '503'] as const;
const OBJ = '/v1/imaging/objects/{objectRef}';

const env = (operation: string, input: ImagingOpInput): CommandEnvelope<unknown> => ({
  operation,
  idempotencyKey: input.key,
  payload: input.body,
});
const param = (input: ImagingOpInput, name: string) => input.params[name] ?? '';
const data = async (p: Promise<unknown>) => ({ data: await p });

export const IMAGING_OPS: readonly ImagingOp[] = [
  // I1 private object storage boundary.
  {
    method: 'get',
    path: '/v1/imaging/objects',
    operationId: 'imaging.objects.list',
    protected: true,
    success: { status: '200', schema: I('ImageObjectList') },
    refusals: LIST,
    query: 'ObjectListQuery',
    tool: 'imaging_objects_list',
    description:
      'List image objects (newest first, at most 100), optionally by state. Metadata and provenance only; never bytes or storage paths.',
    invoke: (svc, actor, i) => data(svc.listObjects(actor, i.body)),
  },
  {
    method: 'get',
    path: OBJ,
    operationId: 'imaging.objects.read',
    protected: true,
    success: { status: '200', schema: I('ImageObjectRead') },
    refusals: READ,
    tool: 'imaging_objects_get',
    description:
      "Read one image object: state, media type, length, SHA-256 digest, provenance and (once decided) its patient association. Another tenant's object is indistinguishable from a missing one.",
    invoke: (svc, actor, i) => data(svc.readObject(actor, param(i, 'objectRef'))),
  },
  {
    method: 'post',
    path: `${OBJ}/read-grants`,
    operationId: 'imaging.objects.grantRead',
    protected: true,
    requestBody: I('ReadGrantRequest'),
    success: { status: '201', schema: I('ReadGrantResult') },
    refusals: COMMAND,
    unkeyed: true,
    tool: 'imaging_objects_grant_read',
    description:
      "Issue a short-lived read grant (default 60 s, at most 300 s) bound to the caller, the object and the expiry. The bytes are fetched on REST with the caller's own bearer token plus the grant token; the grant is useless to anyone else.",
    invoke: (svc, actor, i) => data(svc.grantRead(actor, param(i, 'objectRef'), i.body)),
  },
  {
    method: 'post',
    path: '/v1/imaging/read-grants/{grantRef}/revoke',
    operationId: 'imaging.objects.revokeGrant',
    protected: true,
    requestBody: I('ReadGrantRevoke'),
    success: { status: '200', schema: I('ReadGrantCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_objects_revoke_grant',
    description:
      'Revoke a read grant (its holder, or a member who may write imaging records). Takes effect at once.',
    invoke: (svc, actor, i) =>
      svc.revokeGrant(actor, param(i, 'grantRef'), env('imaging.objects.revokeGrant', i)),
  },
  {
    method: 'get',
    path: `${OBJ}/content`,
    operationId: 'imaging.objects.content',
    protected: true,
    success: { status: '200', schema: I('ObjectBytes'), media: 'application/octet-stream' },
    refusals: ['401', '403', '404', '409', '503'],
    restOnly: true,
    tool: 'imaging_objects_content',
    description:
      "The object bytes, verified against the registered digest on every read. Requires the caller's bearer token and a live read grant in the x-object-read-token header. REST only.",
    invoke: (svc, actor, i) => svc.readContent(actor, param(i, 'objectRef'), i.token),
  },
  {
    method: 'post',
    path: '/v1/imaging/storage/reconcile',
    operationId: 'imaging.storage.reconcile',
    protected: true,
    requestBody: I('StorageReconcile'),
    success: { status: '200', schema: I('StorageReconcileResult') },
    refusals: ['400', '401', '403', '409', '503'],
    tool: 'imaging_storage_reconcile',
    description:
      'Integrity sweep: verify stored bytes of available objects against their digest and quarantine missing or altered ones (bounded per run).',
    invoke: (svc, actor, i) => svc.reconcileStorage(actor, env('imaging.storage.reconcile', i)),
  },
];

/** The route contracts only (spread into ROUTES). */
export const IMAGING_OP_ROUTES: readonly RouteContract[] = IMAGING_OPS.map((o) => ({
  method: o.method,
  path: o.path,
  operationId: o.operationId,
  protected: o.protected,
  ...(o.requestBody === undefined ? {} : { requestBody: o.requestBody }),
  ...(o.requestMedia === undefined ? {} : { requestMedia: o.requestMedia }),
  success: o.success,
  refusals: o.refusals,
}));
