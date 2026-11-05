import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA, T_BETA, USER_A1, USER_B1 } from './support/fixtures';
import {
  type ImagingStack,
  imagingLeakSurface,
  ingestVia,
  pngBytes,
  putFixtureObject,
  sha256,
  startImagingStack,
  type Who,
} from './support/imaging-fixtures';
import { MARKER } from './support/marker';
import { patientBody } from './support/patient-fixtures';

/**
 * I4 mounts, annotations and derived images as separate objects (synthetic images only). The original
 * is never modified: its registered digest and its stored bytes are checked before and after every
 * operation. Mount revisions and annotation supersessions are new versions; earlier ones stay readable.
 * Derived images are new objects with their own provenance, never presented as originals.
 */
let s: ImagingStack;
let pOne: string;
let pTwo: string;
let seed = 300;
const next = () => {
  seed += 1;
  return pngBytes(seed, 10, 8);
};

const mkPatient = async (given: string) =>
  ((await s.command('owner', '/v1/patients', patientBody(given))).json.data as { patientRef: string })
    .patientRef;

async function associated(patientRef: string, bytes = next()) {
  const { objectRef } = await ingestVia(s, bytes);
  const c = await s.command('owner', `/v1/imaging/objects/${objectRef}/association`, {
    patientRef,
    basis: 'operatorSelected',
  });
  expect(c.status).toBe(201);
  return { objectRef, bytes, decisionRef: (c.json.data as { decisionRef: string }).decisionRef };
}

/** The original's registered digest and the SHA-256 of its stored bytes on disk. */
async function fingerprint(objectRef: string) {
  const { rows } = await s.db.admin.query(
    'SELECT digest_sha256, storage_key, version, state FROM cuspatlas.imaging_objects WHERE id = $1',
    [objectRef],
  );
  const r = rows[0];
  return {
    digest: r.digest_sha256,
    onDisk: sha256(readFileSync(join(s.storeRoot, ...String(r.storage_key).split('/')))),
    state: r.state,
  };
}

const reason = (r: { json: Record<string, unknown> }) =>
  (r.json.detail as { reason?: string } | undefined)?.reason;
const mount = (body: unknown, who: Who = 'owner') => s.command(who, '/v1/imaging/mounts', body);

beforeAll(async () => {
  s = await startImagingStack('imaging_composition');
  pOne = await mkPatient('Imaging Mount One');
  pTwo = await mkPatient('Imaging Mount Two');
});
afterAll(async () => {
  await s?.close();
});

describe('I4 mounts', () => {
  it('a revision is a new version; the prior version stays readable; originals are unchanged', async () => {
    const a = await associated(pOne);
    const b = await associated(pOne);
    const c = await associated(pOne);
    const before = await Promise.all([a, b, c].map((x) => fingerprint(x.objectRef)));
    const m = await mount({
      template: 'bitewing-4',
      slots: [
        { slot: 1, objectRef: a.objectRef },
        { slot: 2, objectRef: b.objectRef },
      ],
    });
    expect(m.status).toBe(201);
    const { mountRef } = m.json.data as { mountRef: string };
    const r = await s.command('owner', `/v1/imaging/mounts/${mountRef}/revise`, {
      expectedVersion: 1,
      slots: [
        { slot: 1, objectRef: a.objectRef },
        { slot: 2, objectRef: c.objectRef },
        { slot: 4, objectRef: b.objectRef },
      ],
    });
    expect([r.status, (r.json.data as { version: number }).version]).toStrictEqual([200, 2]);
    const stale = await s.command('owner', `/v1/imaging/mounts/${mountRef}/revise`, {
      expectedVersion: 1,
      slots: [{ slot: 1, objectRef: a.objectRef }],
    });
    expect([stale.status, stale.json.code]).toStrictEqual([409, 'stale_version']);
    const v1 = await s.inject('owner', 'GET', `/v1/imaging/mounts/${mountRef}?version=1`);
    const v2 = await s.inject('owner', 'GET', `/v1/imaging/mounts/${mountRef}`);
    expect(
      (v1.json.data as { slots: { slot: number; objectRef: string }[] }).slots.map((x) => [
        x.slot,
        x.objectRef,
      ]),
    ).toStrictEqual([
      [1, a.objectRef],
      [2, b.objectRef],
    ]);
    expect(v2.json.data).toMatchObject({
      version: 2,
      currentVersion: 2,
      template: 'bitewing-4',
      patientRef: pOne,
      mixedAssociation: false,
    });
    expect((v2.json.data as { slots: { state: string }[] }).slots.map((x) => x.state)).toStrictEqual([
      'present',
      'present',
      'present',
    ]);
    expect(await Promise.all([a, b, c].map((x) => fingerprint(x.objectRef)))).toStrictEqual(before);
  });

  it('invalid slots, unknown templates, mixed or missing associations and foreign objects are refused as a whole', async () => {
    const a = await associated(pOne);
    const other = await associated(pTwo);
    const { objectRef: loose } = await ingestVia(s, next());
    const foreign = await putFixtureObject(s.db.admin, s.store, {
      tenantId: T_BETA,
      createdBy: USER_B1,
      bytes: next(),
    });
    const count = async () =>
      (await s.db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.imaging_mounts')).rows[0].n;
    const before = await count();
    for (const [body, status, why] of [
      [{ template: 'bitewing-4', slots: [{ slot: 5, objectRef: a.objectRef }] }, 422, 'invalid_slot'],
      [
        {
          template: 'bitewing-4',
          slots: [
            { slot: 1, objectRef: a.objectRef },
            { slot: 1, objectRef: other.objectRef },
          ],
        },
        422,
        'invalid_slot',
      ],
      [{ template: 'mystery-9', slots: [{ slot: 1, objectRef: a.objectRef }] }, 400, undefined],
      [
        {
          template: 'bitewing-2',
          slots: [
            { slot: 1, objectRef: a.objectRef },
            { slot: 2, objectRef: other.objectRef },
          ],
        },
        409,
        'mixed_association',
      ],
      [
        {
          template: 'bitewing-2',
          slots: [
            { slot: 1, objectRef: a.objectRef },
            { slot: 2, objectRef: loose },
          ],
        },
        409,
        'object_unassociated',
      ],
      [
        {
          template: 'bitewing-2',
          slots: [
            { slot: 1, objectRef: a.objectRef },
            { slot: 2, objectRef: foreign },
          ],
        },
        404,
        undefined,
      ],
    ] as const) {
      const r = await mount(body);
      expect([r.status, reason(r)]).toStrictEqual([status, why]);
    }
    expect(await count()).toBe(before);
    void T_ALPHA;
  });

  it('an object in a current mount cannot be moved to another patient without amending the mount', async () => {
    const a = await associated(pOne);
    const m = await mount({ template: 'pa-1', slots: [{ slot: 1, objectRef: a.objectRef }] });
    const { mountRef } = m.json.data as { mountRef: string };
    const fix = await s.command('owner', `/v1/imaging/associations/${a.decisionRef}/correct`, {
      patientRef: pTwo,
      reasonCode: 'wrong_patient',
    });
    expect([fix.status, reason(fix)]).toStrictEqual([409, 'mount_amendment_required']);
    expect((fix.json.detail as { blockingRefs: unknown[] }).blockingRefs).toStrictEqual([
      { kind: 'imagingMount', ref: mountRef },
    ]);
  });
});

describe('I4 annotations', () => {
  it('annotations are separate versioned records; superseding keeps the earlier version; the original never changes', async () => {
    const a = await associated(pOne);
    const before = await fingerprint(a.objectRef);
    const c = await s.command('owner', `/v1/imaging/objects/${a.objectRef}/annotations`, {
      kind: 'region',
      geometry: { kind: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
      label: `synthetic note ${MARKER}`,
    });
    expect(c.status).toBe(201);
    const { annotationRef } = c.json.data as { annotationRef: string };
    const sup = await s.command('owner', `/v1/imaging/annotations/${annotationRef}/supersede`, {
      expectedVersion: 1,
      reasonCode: 'position_corrected',
      geometry: { kind: 'rect', x: 0.15, y: 0.2, width: 0.3, height: 0.2 },
    });
    expect([sup.status, (sup.json.data as { version: number }).version]).toStrictEqual([201, 2]);
    const withdraw = await s.command('owner', `/v1/imaging/annotations/${annotationRef}/supersede`, {
      expectedVersion: 2,
      reasonCode: 'not_needed',
    });
    expect((withdraw.json.data as { state: string }).state).toBe('withdrawn');
    const list = await s.inject('owner', 'GET', `/v1/imaging/objects/${a.objectRef}/annotations`);
    const versions = (list.json.data as { annotations: { version: number; state: string }[] }).annotations;
    expect(versions.map((v) => [v.version, v.state])).toStrictEqual([
      [1, 'superseded'],
      [2, 'superseded'],
      [3, 'withdrawn'],
    ]);
    expect(await fingerprint(a.objectRef)).toStrictEqual(before);
    for (const bad of [
      { kind: 'region', geometry: { kind: 'rect', x: 1.2, y: 0, width: 0.1, height: 0.1 } },
      { kind: 'region', geometry: { kind: 'polyline', points: [{ x: 0.1, y: 0.1 }] } },
    ]) {
      expect((await s.command('owner', `/v1/imaging/objects/${a.objectRef}/annotations`, bad)).status).toBe(
        400,
      );
    }
    // The label (caller text) never reaches audit, outbox, attempts or idempotency.
    expect(await imagingLeakSurface(s.db.admin)).not.toContain(MARKER);
  });

  it('an annotation on an unavailable object is refused, not queued', async () => {
    const q = await putFixtureObject(s.db.admin, s.store, {
      tenantId: T_ALPHA,
      createdBy: USER_A1,
      bytes: next(),
    });
    await s.db.admin.query(
      `UPDATE cuspatlas.imaging_objects SET state = 'quarantined', quarantine_reason = 'digest_mismatch', version = version + 1 WHERE id = $1`,
      [q],
    );
    const r = await s.command('owner', `/v1/imaging/objects/${q}/annotations`, {
      kind: 'marker',
      geometry: { kind: 'point', x: 0.5, y: 0.5 },
    });
    expect([r.status, reason(r)]).toStrictEqual([409, 'annotation_object_unavailable']);
  });
});

describe('I4 derived images', () => {
  it('a derived image is a new object with provenance, follows its source association, and never alters the original', async () => {
    const a = await associated(pOne);
    const before = await fingerprint(a.objectRef);
    const d = await s.command('owner', `/v1/imaging/objects/${a.objectRef}/derived`, {
      transform: { kind: 'crop', x: 2, y: 1, width: 4, height: 3 },
    });
    expect(d.status).toBe(201);
    const out = d.json.data as {
      objectRef: string;
      sourceObjectRef: string;
      created: boolean;
      digestSha256: string;
    };
    expect([out.sourceObjectRef, out.created]).toStrictEqual([a.objectRef, true]);
    const read = await s.inject('owner', 'GET', `/v1/imaging/objects/${out.objectRef}`);
    expect(read.json.data).toMatchObject({
      kind: 'derived',
      state: 'available',
      contentType: 'image/png',
      derivation: {
        sourceObjectRef: a.objectRef,
        transform: { kind: 'crop', x: 2, y: 1, width: 4, height: 3 },
        authorRef: USER_A1,
      },
      association: { status: 'associated', patientRef: pOne, inherited: true },
    });
    const g = await s.inject('owner', 'POST', `/v1/imaging/objects/${out.objectRef}/read-grants`, {});
    const bytes = await s.inject('owner', 'GET', `/v1/imaging/objects/${out.objectRef}/content`, undefined, {
      'x-object-read-token': (g.json.data as { token: string }).token,
    });
    const raster = decodePng(new Uint8Array(bytes.raw));
    expect([raster.width, raster.height]).toStrictEqual([4, 3]);
    expect(sha256(bytes.raw)).toBe(out.digestSha256);
    // Same transform again: the existing derivation, not a second object.
    const again = await s.command('owner', `/v1/imaging/objects/${a.objectRef}/derived`, {
      transform: { kind: 'crop', x: 2, y: 1, width: 4, height: 3 },
    });
    expect(again.json.data).toMatchObject({ objectRef: out.objectRef, created: false });
    for (const t of [{ kind: 'rotate', degrees: 90 }, { kind: 'invert' }]) {
      expect(
        (await s.command('owner', `/v1/imaging/objects/${a.objectRef}/derived`, { transform: t })).status,
      ).toBe(201);
    }
    // A derived image cannot be associated on its own or derived again.
    const assoc = await s.command('owner', `/v1/imaging/objects/${out.objectRef}/association`, {
      patientRef: pTwo,
      basis: 'operatorSelected',
    });
    expect([assoc.status, reason(assoc)]).toStrictEqual([422, 'derived_not_associable']);
    const chain = await s.command('owner', `/v1/imaging/objects/${out.objectRef}/derived`, {
      transform: { kind: 'invert' },
    });
    expect([chain.status, reason(chain)]).toStrictEqual([422, 'derived_source_not_original']);
    const src = await s.inject('owner', 'GET', `/v1/imaging/objects/${a.objectRef}`);
    expect((src.json.data as { derivedObjects: string[] }).derivedObjects).toContain(out.objectRef);
    expect(await fingerprint(a.objectRef)).toStrictEqual(before);
  });

  it('a failed derivation leaves the source untouched and is recorded; out-of-bounds crops are refused', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4\n% synthetic test document\n%%EOF\n');
    const { objectRef } = await ingestVia(s, pdf, { contentType: 'application/pdf' });
    const before = await fingerprint(objectRef);
    const r = await s.command('owner', `/v1/imaging/objects/${objectRef}/derived`, {
      transform: { kind: 'invert' },
    });
    expect([r.status, reason(r)]).toStrictEqual([422, 'transform_unsupported']);
    const failedRows = await s.db.admin.query(
      `SELECT state, failure_reason FROM cuspatlas.imaging_derivations WHERE source_object_id = $1`,
      [objectRef],
    );
    expect(failedRows.rows).toStrictEqual([{ state: 'failed', failure_reason: 'transform_unsupported' }]);
    expect(await fingerprint(objectRef)).toStrictEqual(before);
    const a = await associated(pOne);
    const big = await s.command('owner', `/v1/imaging/objects/${a.objectRef}/derived`, {
      transform: { kind: 'crop', x: 8, y: 0, width: 5, height: 2 },
    });
    expect([big.status, reason(big)]).toStrictEqual([422, 'crop_out_of_bounds']);
  });

  it('MCP creates mounts, annotations and derived images with the same outcomes (no bytes)', async () => {
    const a = await associated(pOne);
    const m = await s.mcp('owner', 'imaging_mounts_create', {
      template: 'pa-1',
      slots: [{ slot: 1, objectRef: a.objectRef }],
      idempotencyKey: randomUUID(),
    });
    expect(m.isError).toBe(false);
    const an = await s.mcp('owner', 'imaging_annotations_create', {
      objectRef: a.objectRef,
      kind: 'marker',
      geometry: { kind: 'point', x: 0.3, y: 0.4 },
      idempotencyKey: randomUUID(),
    });
    expect(an.isError).toBe(false);
    const d = await s.mcp('owner', 'imaging_derived_create', {
      objectRef: a.objectRef,
      transform: { kind: 'rotate', degrees: 180 },
      idempotencyKey: randomUUID(),
    });
    expect([d.isError, (d.body.data as { created: boolean }).created]).toStrictEqual([false, true]);
    const r = await s.mcp('owner', 'imaging_mounts_get', {
      mountRef: (m.body.data as { mountRef: string }).mountRef,
    });
    expect((r.body.data as { slots: unknown[] }).slots).toHaveLength(1);
  });
});
