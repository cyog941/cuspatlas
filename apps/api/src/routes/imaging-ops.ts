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
  // I2 ingress: staging, gating and patient-scoped dedupe (bytes on REST only).
  {
    method: 'post',
    path: '/v1/imaging/ingress',
    operationId: 'imaging.ingress.begin',
    protected: true,
    requestBody: I('IngressBegin'),
    success: { status: '201', schema: I('IngressBeginResult') },
    refusals: COMMAND,
    tool: 'imaging_ingress_begin',
    description:
      'Begin an ingress: declare media type, exact length, SHA-256 and provenance (and optionally the patient the uploader names). Oversize is refused here. The bytes go to the content path on REST.',
    invoke: (svc, actor, i) => svc.beginIngress(actor, env('imaging.ingress.begin', i)),
  },
  {
    method: 'get',
    path: '/v1/imaging/ingress/failures',
    operationId: 'imaging.ingress.failures',
    protected: true,
    success: { status: '200', schema: I('ImagingWorkItemList') },
    refusals: ['401', '403', '503'],
    tool: 'imaging_ingress_failures',
    description:
      'Work items for uploads that did not become objects: quarantined (with the gate that failed), held on an undecided malware scan, or incomplete.',
    invoke: (svc, actor) => data(svc.listIngressFailures(actor)),
  },
  {
    method: 'get',
    path: '/v1/imaging/ingress/{ingressRef}',
    operationId: 'imaging.ingress.read',
    protected: true,
    success: { status: '200', schema: I('IngressRead') },
    refusals: READ,
    tool: 'imaging_ingress_get',
    description:
      'Read one ingress: declared and observed digest and length, scan verdict, quarantine reason and the resulting object.',
    invoke: (svc, actor, i) => data(svc.readIngress(actor, param(i, 'ingressRef'))),
  },
  {
    method: 'post',
    path: '/v1/imaging/ingress/{ingressRef}/content',
    operationId: 'imaging.ingress.upload',
    protected: true,
    requestBody: I('ObjectBytes'),
    requestMedia: 'application/octet-stream',
    success: { status: '200', schema: I('IngressUploadResult') },
    refusals: COMMAND,
    restOnly: true,
    tool: 'imaging_ingress_upload',
    description:
      'Upload the bytes of your own ingress (application/octet-stream, at most the declared length). Staged only: nothing is available until completion. REST only.',
    invoke: (svc, actor, i) => svc.uploadIngressContent(actor, param(i, 'ingressRef'), i.key, i.body),
  },
  {
    method: 'post',
    path: '/v1/imaging/ingress/{ingressRef}/complete',
    operationId: 'imaging.ingress.complete',
    protected: true,
    requestBody: I('IngressComplete'),
    success: { status: '201', schema: I('IngressCompleteResult') },
    refusals: COMMAND,
    tool: 'imaging_ingress_complete',
    description:
      'Complete your own ingress: length, digest, malware scan (unknown is never clean) and magic-byte media checks, then patient-scoped dedupe. A failed gate quarantines the bytes and refuses with the reason; nothing failed is ever served.',
    invoke: (svc, actor, i) =>
      svc.completeIngress(actor, param(i, 'ingressRef'), env('imaging.ingress.complete', i)),
  },
  // I3 patient matching, association correction and the imageRef.
  {
    method: 'get',
    path: `${OBJ}/match-candidates`,
    operationId: 'imaging.associations.candidates',
    protected: true,
    success: { status: '200', schema: I('MatchCandidateList') },
    refusals: READ,
    tool: 'imaging_associations_candidates',
    description:
      'Patient candidates for an object from its upload metadata, each with its reasons (identifier, legal name, birth date; a shared phone alone never qualifies). Candidates never bind; nothing is associated automatically.',
    invoke: (svc, actor, i) => data(svc.proposeMatch(actor, param(i, 'objectRef'))),
  },
  {
    method: 'post',
    path: `${OBJ}/association`,
    operationId: 'imaging.associations.confirm',
    protected: true,
    requestBody: I('AssociationConfirm'),
    success: { status: '201', schema: I('AssociationCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_associations_confirm',
    description:
      'Record the association decision for an available original (a person decides; a metadata basis must match the candidate evidence). Mints the stable imageRef on the first decision; an existing current decision is a conflict (use the correction).',
    invoke: (svc, actor, i) =>
      svc.confirmAssociation(actor, param(i, 'objectRef'), env('imaging.associations.confirm', i)),
  },
  {
    method: 'post',
    path: '/v1/imaging/associations/{decisionRef}/correct',
    operationId: 'imaging.associations.correct',
    protected: true,
    requestBody: I('AssociationCorrect'),
    success: { status: '201', schema: I('AssociationCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_associations_correct',
    description:
      'Move an object to another patient with a reason: appends a decision superseding the current one (both stay readable). The imageRef stays stable; its reference read reports the change.',
    invoke: (svc, actor, i) =>
      svc.correctAssociation(actor, param(i, 'decisionRef'), env('imaging.associations.correct', i)),
  },
  {
    method: 'get',
    path: `${OBJ}/associations`,
    operationId: 'imaging.associations.history',
    protected: true,
    success: { status: '200', schema: I('AssociationHistory') },
    refusals: READ,
    tool: 'imaging_associations_history',
    description:
      'Every association decision of an object in order, with who decided, why and what superseded it.',
    invoke: (svc, actor, i) => data(svc.associationHistory(actor, param(i, 'objectRef'))),
  },
  {
    method: 'get',
    path: '/v1/imaging/worklists/unmatched',
    operationId: 'imaging.associations.unmatched',
    protected: true,
    success: { status: '200', schema: I('ImagingWorkItemList') },
    refusals: ['401', '403', '503'],
    tool: 'imaging_associations_unmatched',
    description:
      'Work items for available images with no patient association, with their age; escalated after the configured age (I-D8), never discarded.',
    invoke: (svc, actor) => data(svc.listUnmatched(actor)),
  },
  {
    method: 'get',
    path: '/v1/imaging/image-refs/{imageRef}',
    operationId: 'imaging.imageRefs.resolve',
    protected: true,
    success: { status: '200', schema: I('ImageRefRead') },
    refusals: ['400', '401', '403', '404', '503'],
    query: 'ImageRefQuery',
    tool: 'imaging_image_refs_resolve',
    description:
      'Reference read for consumers (C15 encounters, B attachment packages): object state, media type, length, SHA-256 and the current association; matchesExpected is false when it no longer matches the patient the consumer expected.',
    invoke: (svc, actor, i) => data(svc.resolveImageRef(actor, param(i, 'imageRef'), i.body)),
  },
  // I4 mounts, annotations and derived images (separate records; the original never changes).
  {
    method: 'post',
    path: '/v1/imaging/mounts',
    operationId: 'imaging.mounts.create',
    protected: true,
    requestBody: I('MountCreate'),
    success: { status: '201', schema: I('MountCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_mounts_create',
    description:
      'Create a mount (an ordered group of available objects of one patient) on a configured template; invalid slots, unknown templates and mixed or missing associations refuse the whole mount.',
    invoke: (svc, actor, i) => svc.createMount(actor, env('imaging.mounts.create', i)),
  },
  {
    method: 'post',
    path: '/v1/imaging/mounts/{mountRef}/revise',
    operationId: 'imaging.mounts.revise',
    protected: true,
    requestBody: I('MountRevise'),
    success: { status: '200', schema: I('MountCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_mounts_revise',
    description: 'Revise a mount: a new version with the given slots; every earlier version stays readable.',
    invoke: (svc, actor, i) => svc.reviseMount(actor, param(i, 'mountRef'), env('imaging.mounts.revise', i)),
  },
  {
    method: 'get',
    path: '/v1/imaging/mounts/{mountRef}',
    operationId: 'imaging.mounts.read',
    protected: true,
    success: { status: '200', schema: I('MountRead') },
    refusals: ['400', '401', '403', '404', '503'],
    query: 'MountQuery',
    tool: 'imaging_mounts_get',
    description:
      'Read a mount version (current by default): slots with object state (present, unavailable, missing after deletion), digest and current patient.',
    invoke: (svc, actor, i) => data(svc.readMount(actor, param(i, 'mountRef'), i.body)),
  },
  {
    method: 'post',
    path: `${OBJ}/annotations`,
    operationId: 'imaging.annotations.create',
    protected: true,
    requestBody: I('AnnotationCreate'),
    success: { status: '201', schema: I('AnnotationCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_annotations_create',
    description:
      'Add an annotation (normalized geometry, optional label) as its own record; never burned into the object. No diagnostic interpretation or measurement claim.',
    invoke: (svc, actor, i) =>
      svc.createAnnotation(actor, param(i, 'objectRef'), env('imaging.annotations.create', i)),
  },
  {
    method: 'post',
    path: '/v1/imaging/annotations/{annotationRef}/supersede',
    operationId: 'imaging.annotations.supersede',
    protected: true,
    requestBody: I('AnnotationSupersede'),
    success: { status: '201', schema: I('AnnotationCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_annotations_supersede',
    description:
      'Supersede an annotation with a reason: a new version with the new geometry, or a withdrawal; earlier versions stay readable.',
    invoke: (svc, actor, i) =>
      svc.supersedeAnnotation(actor, param(i, 'annotationRef'), env('imaging.annotations.supersede', i)),
  },
  {
    method: 'get',
    path: `${OBJ}/annotations`,
    operationId: 'imaging.annotations.list',
    protected: true,
    success: { status: '200', schema: I('AnnotationList') },
    refusals: READ,
    tool: 'imaging_annotations_list',
    description: 'Every annotation version of an object (current, superseded and withdrawn).',
    invoke: (svc, actor, i) => data(svc.listAnnotations(actor, param(i, 'objectRef'))),
  },
  {
    method: 'post',
    path: `${OBJ}/derived`,
    operationId: 'imaging.derived.create',
    protected: true,
    requestBody: I('DerivedCreate'),
    success: { status: '201', schema: I('DerivedCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_derived_create',
    description:
      'Derive a new object (crop, quarter-turn rotation or inversion) from an available PNG original. The original is never modified; the derived object records its source digest, transform and author and is never an original. Same transform again returns the existing derivation.',
    invoke: (svc, actor, i) =>
      svc.createDerivedImage(actor, param(i, 'objectRef'), env('imaging.derived.create', i)),
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
