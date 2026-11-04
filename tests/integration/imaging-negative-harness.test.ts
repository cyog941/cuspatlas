import { randomUUID } from 'node:crypto';
import { IMAGING_OPS } from '@cuspatlas/api';
import { REFUSAL_HTTP_STATUS, type RefusalCode } from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA, T_BETA, USER_A1 } from './support/fixtures';
import {
  attemptReasons,
  type ImagingStack,
  pngBytes,
  putFixtureObject,
  sha256,
  startImagingStack,
  type Who,
} from './support/imaging-fixtures';
import { MARKER } from './support/marker';
import { patientBody } from './support/patient-fixtures';
import { SyntheticBridge } from './support/synthetic-bridge';

/**
 * Imaging negative harness (Global Constraints of the imaging plan): every imaging command is
 * attempted cross-tenant, with a revoked membership, with a downgraded role and through MCP, under the
 * runtime role, with identical codes and attempt rows on both surfaces and no state change on refusal.
 * It mirrors tests/integration/negative-harness.test.ts in its own file so the shared S harness and
 * its fixture setup stay untouched (recorded in docs/execution/imaging-progress.md). Append a row per
 * new imaging command; a completeness check fails when an IMAGING_OPS operation has no row.
 */
let s: ImagingStack;

export interface ImagingFixture {
  readonly [name: string]: string;
}
let f: ImagingFixture;

interface Call {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly body?: unknown;
  readonly keyed: boolean;
  readonly status: number;
  readonly headers?: Record<string, string>;
}

export interface ImagingHarnessRow {
  readonly operation: string;
  readonly crossTenant: 'not_found' | 'empty_list' | 'own_tenant_only';
  readonly downgradedTo: Who;
  rest(f: ImagingFixture): Call;
  /** Absent for REST-only byte transports (no MCP tool exists). */
  mcpArgs?(f: ImagingFixture): Record<string, unknown>;
}

const HARNESS_BYTES = pngBytes(12);
const BEGIN = {
  contentType: 'image/png',
  byteLength: HARNESS_BYTES.byteLength,
  declaredDigest: sha256(HARNESS_BYTES),
  provenance: { source: 'operatorUpload', originalFilename: `harness-${MARKER}.png` },
};

const POLICY = {
  recordClass: 'derived',
  minimumRetentionMonths: 0,
  basisCode: 'synthetic_test_policy',
  jurisdictionCode: 'us-synthetic',
};

const toolOf = (operation: string) => IMAGING_OPS.find((o) => o.operationId === operation)?.tool ?? '';

export const ROWS: ImagingHarnessRow[] = [
  // I1 object storage boundary.
  {
    operation: 'imaging.objects.list',
    crossTenant: 'empty_list',
    downgradedTo: 'noImagingScopes',
    rest: () => ({ method: 'GET', url: '/v1/imaging/objects', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'imaging.objects.read',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({ method: 'GET', url: `/v1/imaging/objects/${x.object}`, keyed: false, status: 200 }),
    mcpArgs: (x) => ({ objectRef: x.object }),
  },
  {
    operation: 'imaging.objects.grantRead',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/objects/${x.object}/read-grants`,
      body: { ttlSeconds: 30 },
      keyed: false,
      status: 201,
    }),
    mcpArgs: (x) => ({ objectRef: x.object, ttlSeconds: 30 }),
  },
  {
    operation: 'imaging.objects.revokeGrant',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/read-grants/${x.grant}/revoke`,
      body: {},
      keyed: true,
      status: 200,
    }),
    mcpArgs: (x) => ({ grantRef: x.grant, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'imaging.objects.content',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({
      method: 'GET',
      url: `/v1/imaging/objects/${x.object}/content`,
      keyed: false,
      status: 200,
      headers: { 'x-object-read-token': x.token as string },
    }),
  },
  {
    operation: 'imaging.storage.reconcile',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'imagingReadOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/imaging/storage/reconcile',
      body: {},
      keyed: true,
      status: 200,
    }),
    mcpArgs: () => ({ idempotencyKey: randomUUID() }),
  },
  // I2 ingress.
  {
    operation: 'imaging.ingress.begin',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'imagingReadOnly',
    rest: () => ({ method: 'POST', url: '/v1/imaging/ingress', body: BEGIN, keyed: true, status: 201 }),
    mcpArgs: () => ({ ...BEGIN, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'imaging.ingress.upload',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/ingress/${x.ingress}/content`,
      body: HARNESS_BYTES,
      keyed: true,
      status: 200,
    }),
  },
  {
    operation: 'imaging.ingress.complete',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/ingress/${x.staged}/complete`,
      body: { observedDigest: sha256(HARNESS_BYTES) },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (x) => ({
      ingressRef: x.staged,
      observedDigest: sha256(HARNESS_BYTES),
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.ingress.read',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({ method: 'GET', url: `/v1/imaging/ingress/${x.ingress}`, keyed: false, status: 200 }),
    mcpArgs: (x) => ({ ingressRef: x.ingress }),
  },
  {
    operation: 'imaging.ingress.failures',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'noImagingScopes',
    rest: () => ({ method: 'GET', url: '/v1/imaging/ingress/failures', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  // I3 association and the imageRef.
  {
    operation: 'imaging.associations.candidates',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'GET',
      url: `/v1/imaging/objects/${x.object}/match-candidates`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (x) => ({ objectRef: x.object }),
  },
  {
    operation: 'imaging.associations.confirm',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/objects/${x.object}/association`,
      body: { patientRef: x.patient, basis: 'operatorSelected' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (x) => ({
      objectRef: x.object,
      patientRef: x.patient,
      basis: 'operatorSelected',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.associations.correct',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/associations/${x.decision}/correct`,
      body: { patientRef: x.patient2, reasonCode: 'wrong_patient' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (x) => ({
      decisionRef: x.decision,
      patientRef: x.patient2,
      reasonCode: 'wrong_patient',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.associations.history',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({
      method: 'GET',
      url: `/v1/imaging/objects/${x.associated}/associations`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (x) => ({ objectRef: x.associated }),
  },
  {
    operation: 'imaging.associations.unmatched',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'noImagingScopes',
    rest: () => ({ method: 'GET', url: '/v1/imaging/worklists/unmatched', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'imaging.imageRefs.resolve',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({
      method: 'GET',
      url: `/v1/imaging/image-refs/${x.imageRef}?expectedPatientRef=${x.patient}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (x) => ({ imageRef: x.imageRef, expectedPatientRef: x.patient }),
  },
  // I4 mounts, annotations and derived images.
  {
    operation: 'imaging.mounts.create',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: '/v1/imaging/mounts',
      body: { template: 'pa-1', slots: [{ slot: 1, objectRef: x.associated }] },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (x) => ({
      template: 'pa-1',
      slots: [{ slot: 1, objectRef: x.associated }],
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.mounts.revise',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/mounts/${x.mount}/revise`,
      body: { expectedVersion: 1, slots: [{ slot: 2, objectRef: x.associated }] },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (x) => ({
      mountRef: x.mount,
      expectedVersion: 1,
      slots: [{ slot: 2, objectRef: x.associated }],
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.mounts.read',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({ method: 'GET', url: `/v1/imaging/mounts/${x.mount}`, keyed: false, status: 200 }),
    mcpArgs: (x) => ({ mountRef: x.mount }),
  },
  {
    operation: 'imaging.annotations.create',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/objects/${x.associated}/annotations`,
      body: { kind: 'marker', geometry: { kind: 'point', x: 0.5, y: 0.5 }, label: `harness ${MARKER}` },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (x) => ({
      objectRef: x.associated,
      kind: 'marker',
      geometry: { kind: 'point', x: 0.5, y: 0.5 },
      label: `harness ${MARKER}`,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.annotations.supersede',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/annotations/${x.annotation}/supersede`,
      body: { expectedVersion: 1, reasonCode: 'not_needed' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (x) => ({
      annotationRef: x.annotation,
      expectedVersion: 1,
      reasonCode: 'not_needed',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.annotations.list',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({
      method: 'GET',
      url: `/v1/imaging/objects/${x.associated}/annotations`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (x) => ({ objectRef: x.associated }),
  },
  {
    operation: 'imaging.derived.create',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/objects/${x.associated}/derived`,
      body: { transform: { kind: 'invert' } },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (x) => ({
      objectRef: x.associated,
      transform: { kind: 'invert' },
      idempotencyKey: randomUUID(),
    }),
  },
  // I8 retention, deletion and legal hold.
  {
    operation: 'imaging.retention.setPolicy',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'imagingReadOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/imaging/retention/policies',
      body: POLICY,
      keyed: true,
      status: 201,
    }),
    mcpArgs: () => ({ ...POLICY, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'imaging.retention.policies',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'noImagingScopes',
    rest: () => ({ method: 'GET', url: '/v1/imaging/retention/policies', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'imaging.legalHolds.place',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: '/v1/imaging/legal-holds',
      body: { subject: { kind: 'object', ref: x.associated }, reasonCode: 'records_request' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (x) => ({
      subject: { kind: 'object', ref: x.associated },
      reasonCode: 'records_request',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.legalHolds.release',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/legal-holds/${x.hold}/release`,
      body: { reasonCode: 'matter_closed' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (x) => ({ legalHoldRef: x.hold, reasonCode: 'matter_closed', idempotencyKey: randomUUID() }),
  },
  {
    operation: 'imaging.legalHolds.list',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'noImagingScopes',
    rest: () => ({ method: 'GET', url: '/v1/imaging/legal-holds', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'imaging.deletions.request',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/objects/${x.object}/deletion-requests`,
      body: { reasonCode: 'requested_by_practice' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (x) => ({
      objectRef: x.object,
      reasonCode: 'requested_by_practice',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.deletions.evaluate',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({
      method: 'GET',
      url: `/v1/imaging/deletion-requests/${x.deletion}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (x) => ({ deletionRef: x.deletion }),
  },
  {
    operation: 'imaging.deletions.execute',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/deletion-requests/${x.deletion}/execute`,
      body: {},
      keyed: true,
      status: 200,
    }),
    mcpArgs: (x) => ({ deletionRef: x.deletion, idempotencyKey: randomUUID() }),
  },
  // I5 DICOM boundary.
  {
    operation: 'imaging.containers.inspect',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({
      method: 'GET',
      url: `/v1/imaging/objects/${x.object}/container`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (x) => ({ objectRef: x.object }),
  },
  // I6 device bridge, staff side (bridge-facing device routes have their own matrix: imaging-negative-matrix).
  {
    operation: 'imaging.devices.register',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'writer',
    rest: () => ({
      method: 'POST',
      url: '/v1/imaging/devices',
      body: { label: 'Harness Bridge', allowedJobKinds: ['import'], allowedPathPrefixes: ['exports'] },
      keyed: true,
      status: 201,
    }),
    mcpArgs: () => ({
      ...{ label: 'Harness Bridge', allowedJobKinds: ['import'], allowedPathPrefixes: ['exports'] },
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.devices.list',
    // The register row's cross-tenant case creates a beta device: the list is beta's own only.
    crossTenant: 'own_tenant_only',
    downgradedTo: 'noImagingScopes',
    rest: () => ({ method: 'GET', url: '/v1/imaging/devices', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'imaging.devices.read',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({ method: 'GET', url: `/v1/imaging/devices/${x.device}`, keyed: false, status: 200 }),
    mcpArgs: (x) => ({ deviceRef: x.device }),
  },
  {
    operation: 'imaging.devices.issuePairingCode',
    crossTenant: 'not_found',
    downgradedTo: 'writer',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/devices/${x.pendingDevice}/pairing-codes`,
      body: {},
      keyed: false,
      status: 201,
    }),
    mcpArgs: (x) => ({ deviceRef: x.pendingDevice }),
  },
  {
    operation: 'imaging.devices.setCapabilities',
    crossTenant: 'not_found',
    downgradedTo: 'writer',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/devices/${x.device}/capabilities`,
      body: { expectedVersion: 2, allowedJobKinds: ['import'], allowedPathPrefixes: ['exports'] },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (x) => ({
      deviceRef: x.device,
      expectedVersion: 2,
      allowedJobKinds: ['import'],
      allowedPathPrefixes: ['exports'],
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.devices.revoke',
    crossTenant: 'not_found',
    downgradedTo: 'writer',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/devices/${x.device}/revoke`,
      body: { reasonCode: 'device_lost' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (x) => ({ deviceRef: x.device, reasonCode: 'device_lost', idempotencyKey: randomUUID() }),
  },
  {
    operation: 'imaging.bridgeJobs.enqueue',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: '/v1/imaging/bridge-jobs',
      body: { deviceRef: x.device, kind: 'import', importPath: 'exports/a.png' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (x) => ({
      deviceRef: x.device,
      kind: 'import',
      importPath: 'exports/a.png',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.bridgeJobs.read',
    crossTenant: 'not_found',
    downgradedTo: 'noImagingScopes',
    rest: (x) => ({ method: 'GET', url: `/v1/imaging/bridge-jobs/${x.job}`, keyed: false, status: 200 }),
    mcpArgs: (x) => ({ jobRef: x.job }),
  },
  // I7 offline devices, deferred acquisitions and the bridge worklist.
  {
    operation: 'imaging.acquisitions.request',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: '/v1/imaging/acquisitions',
      body: { deviceRef: x.device, kind: 'import', importPath: 'exports/b.png' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (x) => ({
      deviceRef: x.device,
      kind: 'import',
      importPath: 'exports/b.png',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.acquisitions.resolve',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/acquisitions/${x.deferral}/resolve`,
      body: { action: 'cancel', reasonCode: 'manual_import' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (x) => ({
      deferralRef: x.deferral,
      action: 'cancel',
      reasonCode: 'manual_import',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.bridgeJobs.reconcile',
    crossTenant: 'not_found',
    downgradedTo: 'imagingReadOnly',
    rest: (x) => ({
      method: 'POST',
      url: `/v1/imaging/bridge-jobs/${x.job}/reconcile`,
      body: { action: 'cancel', reasonCode: 'device_lost' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (x) => ({
      jobRef: x.job,
      action: 'cancel',
      reasonCode: 'device_lost',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'imaging.bridge.worklist',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'noImagingScopes',
    rest: () => ({ method: 'GET', url: '/v1/imaging/worklists/bridge', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  // I9 imaging export (a tenant-wide human administrator; blobs are REST only).
  {
    operation: 'imaging.export',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'writer',
    rest: () => ({ method: 'GET', url: '/v1/imaging/export', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'imaging.export.blobs',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'writer',
    rest: () => ({ method: 'GET', url: '/v1/imaging/export/blobs', keyed: false, status: 200 }),
  },
];

beforeAll(async () => {
  s = await startImagingStack('imaging_negative_harness');
  const object = await putFixtureObject(s.db.admin, s.store, {
    tenantId: T_ALPHA,
    createdBy: USER_A1,
    bytes: pngBytes(11),
    originalFilename: `harness-${MARKER}.png`,
  });
  const g = await s.inject('owner', 'POST', `/v1/imaging/objects/${object}/read-grants`, { ttlSeconds: 300 });
  expect(g.status).toBe(201);
  const grant = g.json.data as { grantRef: string; token: string };
  const begin = async () => {
    const r = await s.inject('owner', 'POST', '/v1/imaging/ingress', BEGIN, {
      'idempotency-key': randomUUID(),
    });
    expect(r.status).toBe(201);
    return (r.json.data as { ingressRef: string }).ingressRef;
  };
  const ingress = await begin();
  const staged = await begin();
  const up = await s.inject('owner', 'POST', `/v1/imaging/ingress/${staged}/content`, HARNESS_BYTES, {
    'idempotency-key': randomUUID(),
  });
  expect(up.status).toBe(200);
  const patientOf = async (given: string) => {
    const r = await s.inject('owner', 'POST', '/v1/patients', patientBody(given), {
      'idempotency-key': randomUUID(),
    });
    return (r.json.data as { patientRef: string }).patientRef;
  };
  const patient = await patientOf('Synthetic Harness Imaging');
  const patient2 = await patientOf('Synthetic Harness Imaging Two');
  const associated = await putFixtureObject(s.db.admin, s.store, {
    tenantId: T_ALPHA,
    createdBy: USER_A1,
    bytes: pngBytes(13),
  });
  const c = await s.inject(
    'owner',
    'POST',
    `/v1/imaging/objects/${associated}/association`,
    { patientRef: patient, basis: 'operatorSelected' },
    { 'idempotency-key': randomUUID() },
  );
  expect(c.status).toBe(201);
  const assoc = c.json.data as { decisionRef: string; imageRef: string };
  const post = (url: string, body: unknown) =>
    s.inject('owner', 'POST', url, body, { 'idempotency-key': randomUUID() });
  const mnt = await post('/v1/imaging/mounts', {
    template: 'bitewing-2',
    slots: [{ slot: 1, objectRef: associated }],
  });
  expect(mnt.status).toBe(201);
  const ann = await post(`/v1/imaging/objects/${associated}/annotations`, {
    kind: 'marker',
    geometry: { kind: 'point', x: 0.2, y: 0.2 },
  });
  expect(ann.status).toBe(201);
  const hold = await post('/v1/imaging/legal-holds', {
    subject: { kind: 'object', ref: object },
    reasonCode: 'records_request',
  });
  expect(hold.status).toBe(201);
  const pol = await post('/v1/imaging/retention/policies', { ...POLICY, recordClass: 'associated_original' });
  expect(pol.status).toBe(201);
  const del = await post(`/v1/imaging/objects/${associated}/deletion-requests`, {
    reasonCode: 'requested_by_practice',
  });
  expect(del.status).toBe(201);
  // I6: one paired device with a queued job and one pending device (synthetic bridge client).
  const reg = async () =>
    (
      (
        await post('/v1/imaging/devices', {
          label: 'Harness Bridge',
          allowedJobKinds: ['import'],
          allowedPathPrefixes: ['exports'],
        })
      ).json.data as {
        deviceRef: string;
      }
    ).deviceRef;
  const device = await reg();
  const pendingDevice = await reg();
  const code = (await s.inject('owner', 'POST', `/v1/imaging/devices/${device}/pairing-codes`, {})).json
    .data as { pairingCode: string };
  const bridge = new SyntheticBridge(s.app);
  expect((await bridge.pair(code.pairingCode)).status).toBe(201);
  const jobRes = await post('/v1/imaging/bridge-jobs', {
    deviceRef: device,
    kind: 'import',
    importPath: 'exports/a.png',
  });
  expect(jobRes.status).toBe(201);
  // I7: a deferred acquisition (the paired harness device has sent no heartbeat, so it is offline).
  const acq = await post('/v1/imaging/acquisitions', {
    deviceRef: device,
    kind: 'import',
    importPath: 'exports/c.png',
  });
  expect((acq.json.data as { state: string }).state).toBe('deferred');
  f = {
    deferral: (acq.json.data as { deferralRef: string }).deferralRef,
    device,
    pendingDevice,
    job: (jobRes.json.data as { jobRef: string }).jobRef,
    object,
    grant: grant.grantRef,
    token: grant.token,
    ingress,
    staged,
    patient,
    patient2,
    associated,
    decision: assoc.decisionRef,
    imageRef: assoc.imageRef,
    mount: (mnt.json.data as { mountRef: string }).mountRef,
    annotation: (ann.json.data as { annotationRef: string }).annotationRef,
    hold: (hold.json.data as { legalHoldRef: string }).legalHoldRef,
    deletion: (del.json.data as { deletionRef: string }).deletionRef,
  };
});
afterAll(async () => {
  await s?.close();
});

interface Outcome {
  readonly status: number;
  readonly code: string | null;
  readonly correlationId: unknown;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function viaRest(who: Who, call: Call): Promise<Outcome> {
  const r = await s.inject(who, call.method, call.url, call.body, {
    ...(call.keyed ? { 'idempotency-key': randomUUID() } : {}),
    ...(call.headers ?? {}),
  });
  return {
    status: r.status,
    code: typeof r.json.code === 'string' ? r.json.code : null,
    correlationId: r.json.correlationId,
    body: r.json,
    raw: `${r.body}${JSON.stringify(r.headers)}`,
  };
}

async function viaMcp(
  who: Who,
  tool: string,
  args: Record<string, unknown>,
  okStatus: number,
): Promise<Outcome> {
  try {
    const r = await s.mcp(who, tool, args);
    return {
      status: r.isError ? REFUSAL_HTTP_STATUS[r.body.code as RefusalCode] : okStatus,
      code: r.isError ? (r.body.code as string) : null,
      correlationId: r.body.correlationId,
      body: r.body,
      raw: r.raw,
    };
  } catch (e) {
    const err = e as { code?: unknown; message?: string };
    if (typeof err.code !== 'number') throw e;
    const message = String(err.message);
    const start = message.indexOf('{');
    const body = start >= 0 ? (JSON.parse(message.slice(start)) as Record<string, unknown>) : {};
    return {
      status: err.code,
      code: (body.code as string) ?? null,
      correlationId: body.correlationId,
      body,
      raw: message,
    };
  }
}

/** Snapshot of every imaging write surface plus audit, outbox and idempotency. */
async function state(): Promise<string> {
  const parts: string[] = [];
  const { rows: tables } = await s.db.admin.query<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'cuspatlas' AND c.relkind = 'r' AND c.relname LIKE 'imaging%' ORDER BY 1`,
  );
  for (const { t } of tables) {
    const { rows } = await s.db.admin.query(
      `SELECT md5(coalesce(json_agg(x ORDER BY x)::text, '')) AS h FROM cuspatlas.${t} x`,
    );
    parts.push(`${t}:${rows[0].h}`);
  }
  for (const t of ['audit_events', 'outbox_events', 'command_idempotency']) {
    const { rows } = await s.db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${t}`);
    parts.push(`${t}:${rows[0].n}`);
  }
  return parts.join('|');
}

type Dimension = 'crossTenant' | 'revoked' | 'downgraded';
const DIMENSIONS: Dimension[] = ['crossTenant', 'revoked', 'downgraded'];

function expected(row: ImagingHarnessRow, d: Dimension) {
  if (d === 'revoked') return { status: 403, code: 'forbidden', reason: 'membership_inactive' };
  if (d === 'downgraded') return { status: 403, code: 'forbidden', reason: 'scope_missing' };
  if (row.crossTenant === 'not_found')
    return { status: 404, code: 'not_found', reason: 'resource_hidden_or_missing' };
  return { status: row.rest(f).status, code: null, reason: null };
}

describe('imaging negative harness: every imaging command, every dimension, REST and MCP', () => {
  const cases = ROWS.flatMap((row) => DIMENSIONS.map((d) => [row.operation, d, row] as const));

  it.each(cases)('%s %s', async (_op, d, row) => {
    const want = expected(row, d);
    const who: Who = d === 'downgraded' ? row.downgradedTo : d;
    const before = await state();
    const outcomes: [string, Outcome][] = [['REST', await viaRest(who, row.rest(f))]];
    if (row.mcpArgs)
      outcomes.push(['MCP', await viaMcp(who, toolOf(row.operation), row.mcpArgs(f), row.rest(f).status)]);
    for (const [surface, o] of outcomes) {
      expect([surface, o.status, o.code]).toStrictEqual([surface, want.status, want.code]);
      if (want.code !== null) expect(o.raw).not.toContain(MARKER);
      if (want.reason !== null) {
        expect([surface, await attemptReasons(s.db.admin, o.correlationId)]).toStrictEqual([
          surface,
          [want.reason],
        ]);
      }
      if (want.code === null) {
        // A success for another tenant is computed over its own tenant only.
        for (const ref of Object.values(f)) expect(o.raw).not.toContain(ref);
        if (row.crossTenant === 'empty_list') expect(o.body.data).toStrictEqual([]);
      }
    }
    if (want.code !== null) expect(await state()).toBe(before);
  });

  it('every imaging operation has a harness row; byte transports have no MCP tool', async () => {
    const STAFF = IMAGING_OPS.filter((o) => o.transport === undefined);
    expect(ROWS.map((r) => r.operation).sort()).toStrictEqual(STAFF.map((o) => o.operationId).sort());
    const names = await s.mcpToolNames('owner');
    for (const op of IMAGING_OPS)
      expect([op.operationId, op.transport !== undefined && names.includes(op.tool)]).toStrictEqual([
        op.operationId,
        false,
      ]);
    for (const op of STAFF) {
      expect([op.operationId, names.includes(op.tool)]).toStrictEqual([op.operationId, op.restOnly !== true]);
      expect([
        op.operationId,
        ROWS.find((r) => r.operation === op.operationId)?.mcpArgs !== undefined,
      ]).toStrictEqual([op.operationId, op.restOnly !== true]);
    }
  });

  it('the owner succeeds with the same calls (the harness is not vacuous)', async () => {
    for (const row of ROWS.filter((r) => r.rest(f).method === 'GET')) {
      const r = await viaRest('owner', row.rest(f));
      expect([row.operation, r.status]).toStrictEqual([row.operation, row.rest(f).status]);
    }
  });

  it('no caller-supplied tenant is accepted by any imaging body or tool', async () => {
    for (const row of ROWS) {
      const call = row.rest(f);
      if (call.body === undefined || call.body instanceof Uint8Array) continue;
      const r = await viaRest('owner', { ...call, body: { ...(call.body as object), tenantId: T_BETA } });
      expect([row.operation, r.status]).toStrictEqual([row.operation, 400]);
      if (row.mcpArgs) {
        const m = await viaMcp('owner', toolOf(row.operation), { ...row.mcpArgs(f), tenantId: T_BETA }, 200);
        expect([row.operation, m.code]).toStrictEqual([row.operation, 'invalid_request']);
      }
    }
    expect(s.logLines.join('\n')).not.toContain(MARKER);
  });
});
