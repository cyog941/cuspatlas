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
  /**
   * I6: `device` routes authenticate a device assertion on the bridge audience (never a staff token);
   * `pairing` is the one anonymous bridge route (the one-time code authenticates it). Default: staff.
   */
  readonly transport?: 'device' | 'pairing';
  /** I6 pairing only: the call made without an authenticated actor. */
  invokeAnonymous?(svc: ImagingService, input: ImagingOpInput, correlationId: string): Promise<unknown>;
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
  {
    method: 'post',
    path: '/v1/imaging/storage/orphan-bytes/sweep',
    operationId: 'imaging.storage.sweepOrphanBytes',
    protected: true,
    requestBody: I('StorageOrphanSweep'),
    success: { status: '200', schema: I('StorageOrphanSweepResult') },
    refusals: ['400', '401', '403', '409', '503'],
    tool: 'imaging_storage_sweep_orphan_bytes',
    description:
      "Orphan-bytes sweep of the tenant's object store: report (dryRun, the default) or remove content no image object, legal hold or export references, written before the grace period (graceHours, default 24). Removal also needs imaging.delete; every run leaves an audit record.",
    invoke: (svc, actor, i) => svc.sweepOrphanBytes(actor, env('imaging.storage.sweepOrphanBytes', i)),
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
  // I8 retention, deletion and legal hold (mechanism; values recommended-pending-approval).
  {
    method: 'post',
    path: '/v1/imaging/retention/policies',
    operationId: 'imaging.retention.setPolicy',
    protected: true,
    requestBody: I('RetentionPolicySet'),
    success: { status: '201', schema: I('RetentionPolicyCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_retention_set_policy',
    description:
      'Record a new version of the minimum retention of one record class (recommended_pending_approval; no universal default ships). A policy change never deletes anything.',
    invoke: (svc, actor, i) => svc.setRetentionPolicy(actor, env('imaging.retention.setPolicy', i)),
  },
  {
    method: 'get',
    path: '/v1/imaging/retention/policies',
    operationId: 'imaging.retention.policies',
    protected: true,
    success: { status: '200', schema: I('RetentionPolicyList') },
    refusals: ['401', '403', '503'],
    tool: 'imaging_retention_policies',
    description: 'The current retention policy version of each record class.',
    invoke: (svc, actor) => data(svc.listRetentionPolicies(actor)),
  },
  {
    method: 'post',
    path: '/v1/imaging/legal-holds',
    operationId: 'imaging.legalHolds.place',
    protected: true,
    requestBody: I('LegalHoldPlace'),
    success: { status: '201', schema: I('LegalHoldCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_legal_holds_place',
    description:
      'Place a legal hold on one object or on every image ever associated with a patient. A hold blocks deletion and overrides retention.',
    invoke: (svc, actor, i) => svc.placeLegalHold(actor, env('imaging.legalHolds.place', i)),
  },
  {
    method: 'post',
    path: '/v1/imaging/legal-holds/{legalHoldRef}/release',
    operationId: 'imaging.legalHolds.release',
    protected: true,
    requestBody: I('LegalHoldRelease'),
    success: { status: '200', schema: I('LegalHoldCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_legal_holds_release',
    description: 'Release a legal hold with a reason (once; the hold stays in history).',
    invoke: (svc, actor, i) =>
      svc.releaseLegalHold(actor, param(i, 'legalHoldRef'), env('imaging.legalHolds.release', i)),
  },
  {
    method: 'get',
    path: '/v1/imaging/legal-holds',
    operationId: 'imaging.legalHolds.list',
    protected: true,
    success: { status: '200', schema: I('LegalHoldList') },
    refusals: ['401', '403', '503'],
    tool: 'imaging_legal_holds_list',
    description: 'Legal holds, active first (at most 100).',
    invoke: (svc, actor) => data(svc.listLegalHolds(actor)),
  },
  {
    method: 'post',
    path: `${OBJ}/deletion-requests`,
    operationId: 'imaging.deletions.request',
    protected: true,
    requestBody: I('DeletionRequestCreate'),
    success: { status: '201', schema: I('DeletionRequestCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_deletions_request',
    description:
      'Request deletion of an object. Refused with the reason when a legal hold is active, no retention policy exists, or the minimum retention is not met (with the computed earliest date).',
    invoke: (svc, actor, i) =>
      svc.requestDeletion(actor, param(i, 'objectRef'), env('imaging.deletions.request', i)),
  },
  {
    method: 'get',
    path: '/v1/imaging/deletion-requests/{deletionRef}',
    operationId: 'imaging.deletions.evaluate',
    protected: true,
    success: { status: '200', schema: I('DeletionEvaluation') },
    refusals: READ,
    tool: 'imaging_deletions_evaluate',
    description:
      'Evaluate a deletion request now: blocked or not, the rule, the earliest date and what blocks it.',
    invoke: (svc, actor, i) => data(svc.evaluateDeletion(actor, param(i, 'deletionRef'))),
  },
  {
    method: 'post',
    path: '/v1/imaging/deletion-requests/{deletionRef}/execute',
    operationId: 'imaging.deletions.execute',
    protected: true,
    requestBody: I('DeletionExecute'),
    success: { status: '200', schema: I('DeletionExecuteResult') },
    refusals: COMMAND,
    tool: 'imaging_deletions_execute',
    description:
      'Execute a deletion (re-evaluated now; a second person for any image ever associated with a patient): tombstone with audit and provenance kept, derived objects included, read grants revoked, bytes removed unless shared by another live object. Retrying reports the same outcome.',
    invoke: (svc, actor, i) =>
      svc.executeDeletion(actor, param(i, 'deletionRef'), env('imaging.deletions.execute', i)),
  },
  // I5 DICOM boundary (I-S2 blocked-on-discovery): recognition only; parsing is refused.
  {
    method: 'get',
    path: `${OBJ}/container`,
    operationId: 'imaging.containers.inspect',
    protected: true,
    success: { status: '200', schema: I('ContainerInspection') },
    refusals: ['401', '403', '404', '409', '503'],
    tool: 'imaging_containers_inspect',
    description:
      'Container inspection of an available object: whether its verified bytes carry the DICOM marker. Parsing is refused (I-S2 conformance and parser licensing are blocked-on-discovery): no summary, identifier or element is ever extracted and the original is stored opaquely.',
    invoke: (svc, actor, i) => data(svc.inspectContainer(actor, param(i, 'objectRef'))),
  },
  // I6 device bridge, staff side (server contracts only; I-S1/I-S3 blocked-on-discovery).
  {
    method: 'post',
    path: '/v1/imaging/devices',
    operationId: 'imaging.devices.register',
    protected: true,
    requestBody: I('DeviceRegister'),
    success: { status: '201', schema: I('DeviceCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_devices_register',
    description:
      'Register a bridge device (pending until it pairs) with its capability allowlist: allowed job kinds and allowed relative path prefixes. Human practice administration (admin.configure).',
    invoke: (svc, actor, i) => svc.registerDevice(actor, env('imaging.devices.register', i)),
  },
  {
    method: 'get',
    path: '/v1/imaging/devices',
    operationId: 'imaging.devices.list',
    protected: true,
    success: { status: '200', schema: I('DeviceList') },
    refusals: ['401', '403', '503'],
    tool: 'imaging_devices_list',
    description:
      'Bridge devices with state, allowlist, key version and heartbeat-derived availability (unavailable is not empty).',
    invoke: (svc, actor) => data(svc.listDevices(actor)),
  },
  {
    method: 'get',
    path: '/v1/imaging/devices/{deviceRef}',
    operationId: 'imaging.devices.read',
    protected: true,
    success: { status: '200', schema: I('DeviceRead') },
    refusals: READ,
    tool: 'imaging_devices_get',
    description: 'One bridge device. Never a key, code or secret.',
    invoke: (svc, actor, i) => data(svc.readDevice(actor, param(i, 'deviceRef'))),
  },
  {
    method: 'post',
    path: '/v1/imaging/devices/{deviceRef}/pairing-codes',
    operationId: 'imaging.devices.issuePairingCode',
    protected: true,
    requestBody: I('PairingCodeIssue'),
    success: { status: '201', schema: I('PairingCodeResult') },
    refusals: COMMAND,
    unkeyed: true,
    tool: 'imaging_devices_issue_pairing_code',
    description:
      'Issue a one-time pairing code for a pending device (default 10 minutes, at most 1 hour); it supersedes any open code and is shown once (only its SHA-256 is stored).',
    invoke: (svc, actor, i) => svc.issuePairingCode(actor, param(i, 'deviceRef'), i.body),
  },
  {
    method: 'post',
    path: '/v1/imaging/devices/{deviceRef}/capabilities',
    operationId: 'imaging.devices.setCapabilities',
    protected: true,
    requestBody: I('DeviceCapabilitiesSet'),
    success: { status: '200', schema: I('DeviceCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_devices_set_capabilities',
    description:
      'Replace the allowlist of a device (expected version required). Queued jobs it no longer allows are denied when the device claims them.',
    invoke: (svc, actor, i) =>
      svc.setDeviceCapabilities(actor, param(i, 'deviceRef'), env('imaging.devices.setCapabilities', i)),
  },
  {
    method: 'post',
    path: '/v1/imaging/devices/{deviceRef}/revoke',
    operationId: 'imaging.devices.revoke',
    protected: true,
    requestBody: I('DeviceRevoke'),
    success: { status: '200', schema: I('DeviceCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_devices_revoke',
    description:
      'Revoke a device (final): its keys stop working at once and every open job, including one already claimed, is denied.',
    invoke: (svc, actor, i) =>
      svc.revokeDevice(actor, param(i, 'deviceRef'), env('imaging.devices.revoke', i)),
  },
  {
    method: 'post',
    path: '/v1/imaging/bridge-jobs',
    operationId: 'imaging.bridgeJobs.enqueue',
    protected: true,
    requestBody: I('BridgeJobEnqueue'),
    success: { status: '201', schema: I('BridgeJobCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_bridge_jobs_enqueue',
    description:
      "Queue a typed bridge job (acquire, import or probe) for a paired device. Refused when the kind or the relative path is outside the device's allowlist or the path is not a safe relative path.",
    invoke: (svc, actor, i) => svc.enqueueBridgeJob(actor, env('imaging.bridgeJobs.enqueue', i)),
  },
  {
    method: 'get',
    path: '/v1/imaging/bridge-jobs/{jobRef}',
    operationId: 'imaging.bridgeJobs.read',
    protected: true,
    success: { status: '200', schema: I('BridgeJobRead') },
    refusals: READ,
    tool: 'imaging_bridge_jobs_get',
    description: 'One bridge job: state, attempts, lease, expiry, outcome and duplicate or late reports.',
    invoke: (svc, actor, i) => data(svc.readBridgeJob(actor, param(i, 'jobRef'))),
  },
  // I6 bridge-facing routes: device principals on the bridge audience only, REST only (no MCP tool).
  {
    method: 'post',
    path: '/v1/bridge/pair',
    operationId: 'imaging.bridge.pair',
    protected: false,
    transport: 'pairing',
    requestBody: I('BridgePair'),
    success: { status: '201', schema: I('BridgePairResult') },
    refusals: ['400', '401', '503'],
    restOnly: true,
    unkeyed: true,
    tool: 'imaging_bridge_pair',
    description:
      'Bridge pairing: a one-time code plus a new Ed25519 public key and a proof of possession. Returns the device reference and the server job-signing public key. Every failure is the same 401.',
    invoke: () => Promise.reject(new Error('pairing is anonymous')),
    invokeAnonymous: (svc, i, correlationId) => svc.pairDevice(correlationId, i.body),
  },
  {
    method: 'post',
    path: '/v1/bridge/jobs/claim',
    operationId: 'imaging.bridge.claim',
    protected: true,
    transport: 'device',
    requestBody: I('BridgeClaim'),
    success: { status: '200', schema: I('BridgeClaimResult') },
    refusals: ['400', '401', '403', '503'],
    restOnly: true,
    unkeyed: true,
    tool: 'imaging_bridge_claim',
    description:
      'Claim the next ready job as a server-signed envelope (or an explicit null). The allowlist is rechecked at claim time.',
    invoke: (svc, actor) => svc.claimJob(actor),
  },
  {
    method: 'post',
    path: '/v1/bridge/jobs/{jobRef}/content',
    operationId: 'imaging.bridge.content',
    protected: true,
    transport: 'device',
    requestBody: I('ObjectBytes'),
    requestMedia: 'application/octet-stream',
    success: { status: '200', schema: I('BridgeContentResult') },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
    restOnly: true,
    unkeyed: true,
    tool: 'imaging_bridge_content',
    description: 'Stage the bytes of a claimed acquire or import job (application/octet-stream).',
    invoke: (svc, actor, i) => svc.uploadJobContent(actor, param(i, 'jobRef'), i.body),
  },
  {
    method: 'post',
    path: '/v1/bridge/jobs/{jobRef}/result',
    operationId: 'imaging.bridge.result',
    protected: true,
    transport: 'device',
    requestBody: I('BridgeResultReport'),
    success: { status: '200', schema: I('BridgeResultAck') },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
    restOnly: true,
    unkeyed: true,
    tool: 'imaging_bridge_result',
    description:
      'Report a device-signed job result. The signed artifact digest must equal the staged bytes; the I2 gates then run. A replayed result is a recorded duplicate (409), never a second object.',
    invoke: (svc, actor, i) => svc.reportJobResult(actor, param(i, 'jobRef'), i.body),
  },
  {
    method: 'post',
    path: '/v1/bridge/heartbeat',
    operationId: 'imaging.bridge.heartbeat',
    protected: true,
    transport: 'device',
    requestBody: I('BridgeHeartbeat'),
    success: { status: '200', schema: I('BridgeHeartbeatResult') },
    refusals: ['400', '401', '403', '503'],
    restOnly: true,
    unkeyed: true,
    tool: 'imaging_bridge_heartbeat',
    description: 'Device heartbeat; availability is derived from it.',
    invoke: (svc, actor) => svc.heartbeat(actor),
  },
  {
    method: 'post',
    path: '/v1/bridge/keys/rotate',
    operationId: 'imaging.bridge.rotateKey',
    protected: true,
    transport: 'device',
    requestBody: I('BridgeKeyRotate'),
    success: { status: '200', schema: I('BridgeKeyRotateResult') },
    refusals: ['400', '401', '403', '422', '503'],
    restOnly: true,
    unkeyed: true,
    tool: 'imaging_bridge_rotate_key',
    description:
      'Rotate the device key: asserted with the current key, proven by the new key. The old key stops working at once.',
    invoke: (svc, actor, i) => svc.rotateKey(actor, i.body),
  },
  // I7 offline device, bridge failure and recovery worklist (staff side; REST and MCP).
  {
    method: 'post',
    path: '/v1/imaging/acquisitions',
    operationId: 'imaging.acquisitions.request',
    protected: true,
    requestBody: I('AcquisitionRequest'),
    success: { status: '201', schema: I('AcquisitionCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_acquisitions_request',
    description:
      'Request an acquisition or import on a bridge device: queued when the device is available, otherwise a visible deferred item with the reason (bounded per tenant: beyond the bound a typed refusal).',
    invoke: (svc, actor, i) => svc.requestAcquisition(actor, env('imaging.acquisitions.request', i)),
  },
  {
    method: 'post',
    path: '/v1/imaging/acquisitions/{deferralRef}/resolve',
    operationId: 'imaging.acquisitions.resolve',
    protected: true,
    requestBody: I('DeferralResolve'),
    success: { status: '200', schema: I('DeferralCommandResult') },
    refusals: COMMAND,
    tool: 'imaging_acquisitions_resolve',
    description:
      'Release a deferred acquisition to exactly one job once its device is available (a changed patient record needs re-confirmation), or cancel it with a reason (for example after a manual import). A person decides.',
    invoke: (svc, actor, i) =>
      svc.resolveDeferral(actor, param(i, 'deferralRef'), env('imaging.acquisitions.resolve', i)),
  },
  {
    method: 'post',
    path: '/v1/imaging/bridge-jobs/{jobRef}/reconcile',
    operationId: 'imaging.bridgeJobs.reconcile',
    protected: true,
    requestBody: I('BridgeJobReconcile'),
    success: { status: '200', schema: I('BridgeJobReconcileResult') },
    refusals: COMMAND,
    tool: 'imaging_bridge_jobs_reconcile',
    description:
      'Reconcile a bridge job whose outcome is unknown, that failed or that expired: requeue it (re-imported bytes deduplicate by digest) or cancel it, with a reason. Never automatic.',
    invoke: (svc, actor, i) =>
      svc.reconcileJob(actor, param(i, 'jobRef'), env('imaging.bridgeJobs.reconcile', i)),
  },
  {
    method: 'get',
    path: '/v1/imaging/worklists/bridge',
    operationId: 'imaging.bridge.worklist',
    protected: true,
    success: { status: '200', schema: I('BridgeWorklist') },
    refusals: ['401', '403', '503'],
    tool: 'imaging_bridge_worklist',
    description:
      'Exception-first bridge worklist: deferred acquisitions, failed jobs, unknown outcomes, late results and unavailable devices with waiting work, each with owner, reason, due time and next action. Coverage names devices whose job picture is unknown (unavailable is not empty).',
    invoke: (svc, actor) => data(svc.bridgeWorklist(actor)),
  },
  // I9 imaging export (versioned JSON; blobs are a separate content-addressed bundle, REST only).
  {
    method: 'get',
    path: '/v1/imaging/export',
    operationId: 'imaging.export',
    protected: true,
    success: { status: '200', schema: I('ImagingExportRead') },
    refusals: ['401', '403', '422', '503'],
    tool: 'imaging_export',
    description:
      'Versioned imaging export of the caller tenant: object metadata with digests, provenance, association decisions and imageRefs, mounts, annotations, derived lineage, retention policies, legal holds and deletion requests, plus the content-addressed blob manifest. Tenant-wide human administrators only.',
    invoke: (svc, actor) => data(svc.exportImaging(actor)),
  },
  {
    method: 'get',
    path: '/v1/imaging/export/blobs',
    operationId: 'imaging.export.blobs',
    protected: true,
    success: { status: '200', schema: I('ImagingBlobBundle') },
    refusals: ['400', '401', '403', '409', '503'],
    query: 'ImagingExportBlobsQuery',
    restOnly: true,
    tool: 'imaging_export_blobs',
    description:
      'One page of the content-addressed blob bundle (verified bytes in digest order after `after`; base64). REST only: MCP never carries bytes.',
    invoke: (svc, actor, i) => data(svc.exportImagingBlobs(actor, i.body)),
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
