import { createHash, randomUUID } from 'node:crypto';
import type { ImagingBlobBundle, ImagingExport, SchedulingExport } from '@cuspatlas/contracts';
import { importImagingBlobs, importImagingExport, importSchedulingExport } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA } from './support/fixtures';
import {
  type ImagingStack,
  ingestVia,
  pngBytes,
  sha256,
  startImagingStack,
} from './support/imaging-fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * I9 imaging export and re-import round trip (synthetic). The export is a versioned JSON document of
 * object metadata with digests, provenance, association decisions and imageRefs, mounts, annotations,
 * derived lineage, retention policies, legal holds and deletion requests; bytes travel as
 * content-addressed blob bundles (REST only). The round trip re-imports the scheduling export (which
 * carries the patients) and the imaging export into a fresh synthetic database and store through the
 * privileged import routines (every foreign key validated, every blob digest verified), exports again
 * identically, and serves the same bytes and imageRefs through the domain.
 */
let src: ImagingStack;
let dst: ImagingStack;
let pOne: string;
let pTwo: string;
let doc: ImagingExport;
let bundles: ImagingBlobBundle[];
let associated: { objectRef: string; imageRef: string; bytes: Uint8Array };
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;

async function allBundles(s: ImagingStack): Promise<ImagingBlobBundle[]> {
  const out: ImagingBlobBundle[] = [];
  let after: string | null = '';
  while (after !== null) {
    const r = await s.inject('owner', 'GET', `/v1/imaging/export/blobs${after ? `?after=${after}` : ''}`);
    expect(r.status).toBe(200);
    const page = data<ImagingBlobBundle & { next: string | null }>(r);
    out.push(page);
    after = page.next;
  }
  return out;
}

beforeAll(async () => {
  src = await startImagingStack('imaging_export_src');
  const mk = async (name: string) =>
    data<{ patientRef: string }>(await src.command('owner', '/v1/patients', patientBody(name))).patientRef;
  pOne = await mk('Export One');
  pTwo = await mk('Export Two');
  // An associated original with a derived image, a mount, an annotation and a superseded annotation.
  const bytes = pngBytes(8101, 8, 8);
  const a = await ingestVia(src, bytes, { intendedPatientRef: pOne });
  const c = await src.command('owner', `/v1/imaging/objects/${a.objectRef}/association`, {
    patientRef: pOne,
    basis: 'operatorSelected',
  });
  associated = { objectRef: a.objectRef, imageRef: data<{ imageRef: string }>(c).imageRef, bytes };
  await src.command('owner', `/v1/imaging/objects/${a.objectRef}/derived`, { transform: { kind: 'invert' } });
  await src.command('owner', '/v1/imaging/mounts', {
    template: 'pa-1',
    slots: [{ slot: 1, objectRef: a.objectRef }],
  });
  const ann = await src.command('owner', `/v1/imaging/objects/${a.objectRef}/annotations`, {
    kind: 'marker',
    geometry: { kind: 'point', x: 0.5, y: 0.5 },
  });
  await src.command(
    'owner',
    `/v1/imaging/annotations/${data<{ annotationRef: string }>(ann).annotationRef}/supersede`,
    {
      expectedVersion: 1,
      reasonCode: 'position_corrected',
      geometry: { kind: 'point', x: 0.4, y: 0.5 },
    },
  );
  // A corrected association, a legal hold, retention policies and an executed deletion (tombstone).
  const b = await ingestVia(src, pngBytes(8102, 8, 8), { intendedPatientRef: pOne });
  const cb = await src.command('owner', `/v1/imaging/objects/${b.objectRef}/association`, {
    patientRef: pOne,
    basis: 'operatorSelected',
  });
  await src.command(
    'owner',
    `/v1/imaging/associations/${data<{ decisionRef: string }>(cb).decisionRef}/correct`,
    {
      patientRef: pTwo,
      reasonCode: 'wrong_patient',
    },
  );
  await src.command('owner', '/v1/imaging/legal-holds', {
    subject: { kind: 'patient', ref: pTwo },
    reasonCode: 'records_request',
  });
  for (const recordClass of ['associated_original', 'unassociated_original', 'derived'])
    await src.command('owner', '/v1/imaging/retention/policies', {
      recordClass,
      minimumRetentionMonths: 0,
      basisCode: 'synthetic_test_policy',
      jurisdictionCode: 'us-synthetic',
    });
  const loose = await ingestVia(src, pngBytes(8103, 8, 8));
  const del = await src.command('owner', `/v1/imaging/objects/${loose.objectRef}/deletion-requests`, {
    reasonCode: 'requested_by_practice',
  });
  expect(
    (
      await src.command(
        'owner',
        `/v1/imaging/deletion-requests/${data<{ deletionRef: string }>(del).deletionRef}/execute`,
        {},
      )
    ).status,
  ).toBe(200);
  const r = await src.inject('owner', 'GET', '/v1/imaging/export');
  expect(r.status).toBe(200);
  doc = data<ImagingExport>(r);
  bundles = await allBundles(src);
  dst = await startImagingStack('imaging_export_dst');
}, 180_000);
afterAll(async () => {
  await src?.close();
  await dst?.close();
});

describe('I9 imaging export', () => {
  it('is versioned, carries every imaging record class with digests and no tenant, and lists content-addressed blobs', () => {
    expect(doc.format).toBe('cuspatlas-imaging-export/1');
    const t = doc.tables;
    for (const [table, min] of [
      ['imaging_objects', 4],
      ['imaging_object_provenance', 3],
      ['imaging_match_decisions', 3],
      ['imaging_image_refs', 2],
      ['imaging_mounts', 1],
      ['imaging_mount_slots', 1],
      ['imaging_annotations', 2],
      ['imaging_derivations', 1],
      ['imaging_retention_policies', 3],
      ['imaging_legal_holds', 1],
      ['imaging_deletion_requests', 1],
    ] as const)
      expect([table, (t[table] ?? []).length >= min]).toStrictEqual([table, true]);
    expect(JSON.stringify(doc)).not.toContain('"tenant_id"');
    expect(JSON.stringify(doc)).not.toContain(T_ALPHA);
    // The deleted object's row stays (tombstone) but its bytes are not in the blob manifest.
    const deleted = (t.imaging_objects ?? []).filter((o) => o.state === 'deleted');
    expect(deleted.length).toBeGreaterThanOrEqual(1);
    for (const d of deleted) expect(doc.blobs.map((b) => b.digestSha256)).not.toContain(d.digest_sha256);
    expect(doc.blobs.map((b) => b.digestSha256)).toContain(sha256(associated.bytes));
    // Every bundled blob hashes to its digest.
    for (const b of bundles.flatMap((x) => x.blobs))
      expect(createHash('sha256').update(Buffer.from(b.contentBase64, 'base64')).digest('hex')).toBe(
        b.digestSha256,
      );
  });

  it('is a tenant-wide human administrator read on REST and MCP; blobs are REST only', async () => {
    expect((await src.inject('writer', 'GET', '/v1/imaging/export')).status).toBe(403);
    expect((await src.inject('service', 'GET', '/v1/imaging/export')).status).toBe(403);
    expect((await src.inject('writer', 'GET', '/v1/imaging/export/blobs')).status).toBe(403);
    const m = await src.mcp('owner', 'imaging_export', {});
    expect(m.isError).toBe(false);
    expect((m.body.data as ImagingExport).tables).toStrictEqual(doc.tables);
    expect(await src.mcpToolNames('owner')).not.toContain('imaging_export_blobs');
    const other = data<ImagingExport>(await src.inject('crossTenant', 'GET', '/v1/imaging/export'));
    expect(other.tables.imaging_objects).toStrictEqual([]);
  });
});

describe('I9 imaging re-import round trip', () => {
  it('re-imports into a fresh synthetic database and store, verifies digests and foreign keys, and exports identically', async () => {
    const sched = data<SchedulingExport>(await src.inject('owner', 'GET', '/v1/scheduling/export'));
    await importSchedulingExport(dst.db.admin, T_ALPHA, sched);
    const counts = await importImagingExport(dst.db.admin, T_ALPHA, doc);
    expect(counts.imaging_objects).toBe(doc.tables.imaging_objects?.length);
    expect(await importImagingBlobs(dst.store, T_ALPHA, doc, bundles)).toStrictEqual({
      blobs: doc.blobs.length,
    });
    const again = data<ImagingExport>(await dst.inject('owner', 'GET', '/v1/imaging/export'));
    expect(again.tables).toStrictEqual(doc.tables);
    expect(again.blobs).toStrictEqual(doc.blobs);
    // Served through the domain with the same digest; the imageRef resolves without identifier loss.
    const g = await dst.inject(
      'owner',
      'POST',
      `/v1/imaging/objects/${associated.objectRef}/read-grants`,
      {},
    );
    const c = await dst.inject(
      'owner',
      'GET',
      `/v1/imaging/objects/${associated.objectRef}/content`,
      undefined,
      {
        'x-object-read-token': data<{ token: string }>(g).token,
      },
    );
    expect([c.status, sha256(c.raw)]).toStrictEqual([200, sha256(associated.bytes)]);
    const ref = await dst.inject(
      'owner',
      'GET',
      `/v1/imaging/image-refs/${associated.imageRef}?expectedPatientRef=${pOne}`,
    );
    expect(ref.json.data).toMatchObject({
      objectRef: associated.objectRef,
      matchesExpected: true,
      digestSha256: sha256(associated.bytes),
    });
  });

  it('refuses a tampered blob, a blob outside the manifest, a missing blob and an unknown format', async () => {
    const one = bundles.flatMap((b) => b.blobs)[0] as ImagingBlobBundle['blobs'][number];
    const bad = { ...one, contentBase64: Buffer.from('tampered').toString('base64') };
    await expect(
      importImagingBlobs(dst.store, T_ALPHA, doc, [{ format: 'cuspatlas-imaging-blobs/1', blobs: [bad] }]),
    ).rejects.toThrow(/digest/);
    const extra = Buffer.from('not listed');
    await expect(
      importImagingBlobs(dst.store, T_ALPHA, doc, [
        {
          format: 'cuspatlas-imaging-blobs/1',
          blobs: [
            {
              digestSha256: sha256(extra),
              byteLength: extra.byteLength,
              contentBase64: extra.toString('base64'),
            },
          ],
        },
      ]),
    ).rejects.toThrow(/not listed/);
    await expect(importImagingBlobs(dst.store, T_ALPHA, doc, [])).rejects.toThrow(/missing/);
    await expect(
      importImagingExport(dst.db.admin, T_ALPHA, {
        ...doc,
        format: 'cuspatlas-imaging-export/0',
      } as unknown as ImagingExport),
    ).rejects.toThrow(/format/);
  });

  it('a document naming a patient that does not exist in the target fails foreign-key validation and rolls back', async () => {
    const fresh = await startImagingStack('imaging_export_fk');
    try {
      const crafted = JSON.parse(JSON.stringify(doc)) as ImagingExport;
      const d = (crafted.tables.imaging_match_decisions ?? [])[0] as Record<string, unknown>;
      d.subject_patient_id = randomUUID();
      await expect(importImagingExport(fresh.db.admin, T_ALPHA, crafted)).rejects.toThrow(/foreign key/);
      const n = await fresh.db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.imaging_objects');
      expect(n.rows[0].n).toBe(0);
    } finally {
      await fresh.close();
    }
  }, 120_000);
});
