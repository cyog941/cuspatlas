import { randomUUID } from 'node:crypto';
import type { ImagingBlobBundle } from '@cuspatlas/contracts';
import { createTenantTransactionRunner, importExports, importImagingBlobs } from '@cuspatlas/db';
import {
  createImagingAttachmentRefResolver,
  createImagingImageRefResolver,
  verifyImportedNoteDigests,
} from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { actorFor } from './support/domain-harness';
import { seedEngagementScopes } from './support/engagement-fixtures';
import { T_ALPHA, T_BETA, USER_B1 } from './support/fixtures';
import { type ImagingStack, ingestVia, pngBytes, startImagingStack } from './support/imaging-fixtures';
import { patientBody } from './support/patient-fixtures';
import { seedSchedulingScopes } from './support/scheduling-fixtures';

/**
 * Integration seams to I3 (synthetic data only): C15 encounter image links and E5 message attachments
 * read I3's consumer reference read (`imageReference`, expected patient required) through the real
 * resolvers the API and MCP builders wire; another tenant's reference is `not_found` / not attachable.
 * Then one combined S17 + I9 + C18 + E9 round trip into a fresh database and object store.
 */
type Doc = { format: string; exportedAt: string; tables: Record<string, Record<string, unknown>[]> };
let src: ImagingStack;
let dst: ImagingStack;
let p1: string;
let p2: string;
let img1: { objectRef: string; imageRef: string };
let img2: { objectRef: string; imageRef: string };
const LOC = 'loc-integration-imaging';
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;

async function associated(s: ImagingStack, patientRef: string, seed: number) {
  const a = await ingestVia(s, pngBytes(seed, 8, 8), { intendedPatientRef: patientRef });
  const c = await s.command('owner', `/v1/imaging/objects/${a.objectRef}/association`, {
    patientRef,
    basis: 'operatorSelected',
  });
  expect(c.status).toBe(201);
  return { objectRef: a.objectRef, imageRef: data<{ imageRef: string }>(c).imageRef };
}

beforeAll(async () => {
  src = await startImagingStack('integration_imaging_src');
  await seedSchedulingScopes(src.db.admin);
  await seedClinicalScopes(src.db.admin);
  await seedEngagementScopes(src.db.admin);
  const mk = async (name: string) =>
    data<{ patientRef: string }>(await src.command('owner', '/v1/patients', patientBody(name))).patientRef;
  p1 = await mk('Integration Imaging One');
  p2 = await mk('Integration Imaging Two');
  expect(
    (
      await src.command('owner', '/v1/scheduling/locations', {
        locationRef: LOC,
        displayLabel: 'Synthetic integration imaging',
        timeZone: 'America/New_York',
      })
    ).status,
  ).toBe(201);
  img1 = await associated(src, p1, 9101);
  img2 = await associated(src, p2, 9102);
}, 180_000);

afterAll(async () => {
  await src?.close();
  await dst?.close();
});

async function encounter(s: ImagingStack, patientRef: string) {
  const r = await s.command('owner', '/v1/clinical/encounters', { patientRef, locationRef: LOC });
  expect(r.status).toBe(201);
  return data<{ encounter: { encounterRef: string } }>(r).encounter.encounterRef;
}

describe('C15 and E5 read I3 through the wired resolvers', () => {
  it('C15: an encounter links its own patient`s current imageRef; another patient`s is a mismatch; a made-up one is 404', async () => {
    const e = await encounter(src, p1);
    const ok = await src.command('owner', `/v1/clinical/encounters/${e}/image-links`, {
      imageRef: img1.imageRef,
    });
    expect(ok.status).toBe(201);
    const link = data<{ imageLinkRef: string; imageResolution?: string }>(ok);
    const read = data<Record<string, unknown>>(
      await src.inject('owner', 'GET', `/v1/clinical/image-links/${link.imageLinkRef}`),
    );
    expect(JSON.stringify(read)).toContain('"current"');
    const other = await src.command('owner', `/v1/clinical/encounters/${e}/image-links`, {
      imageRef: img2.imageRef,
    });
    expect([other.status, (other.json.detail as { reason?: string })?.reason]).toStrictEqual([
      409,
      'image_patient_mismatch',
    ]);
    const missing = await src.command('owner', `/v1/clinical/encounters/${e}/image-links`, {
      imageRef: randomUUID(),
    });
    expect(missing.status).toBe(404);
  });

  it('another tenant`s imageRef is not_found and never attachable (tenant transaction, RLS)', async () => {
    const beta = await actorFor(src.db, USER_B1, T_BETA);
    const run = createTenantTransactionRunner(src.db.app);
    const images = createImagingImageRefResolver();
    const attachments = createImagingAttachmentRefResolver();
    const seen = await run(beta, async (tx) => ({
      image: await images.resolve(tx, img1.imageRef, p1),
      byImageRef: await attachments.belongsToPatient(tx, p1, { kind: 'imageRef', ref: img1.imageRef }),
      byObjectRef: await attachments.belongsToPatient(tx, p1, { kind: 'objectRef', ref: img1.objectRef }),
    }));
    expect(seen).toStrictEqual({ image: { status: 'not_found' }, byImageRef: false, byObjectRef: false });
  });

  it('E5: a staff message attaches its own patient`s image (by imageRef or objectRef) and refuses another`s', async () => {
    const open = (patientRef: string, attachment: { kind: string; ref: string }) =>
      src.command('owner', `/v1/patients/${patientRef}/message-threads`, {
        topic: 'general',
        locationRef: LOC,
        body: 'Synthetic integration message',
        attachments: [attachment],
      });
    expect((await open(p1, { kind: 'imageRef', ref: img1.imageRef })).status).toBe(201);
    expect((await open(p1, { kind: 'objectRef', ref: img1.objectRef })).status).toBe(201);
    const foreign = await open(p1, { kind: 'imageRef', ref: img2.imageRef });
    expect(foreign.status).not.toBe(201);
    expect([400, 404, 409, 422]).toContain(foreign.status);
  });
});

describe('S17 + I9 + C18 + E9 combined round trip', () => {
  it('imports all four documents and the blobs in one order into a fresh database and store and exports identically', {
    timeout: 240_000,
  }, async () => {
    const exportOf = async (s: ImagingStack, path: string) => {
      const r = await s.inject('owner', 'GET', path);
      expect([path, r.status]).toStrictEqual([path, 200]);
      return data<Doc>(r);
    };
    const paths = [
      '/v1/scheduling/export',
      '/v1/imaging/export',
      '/v1/clinical/export',
      '/v1/communications/export',
    ];
    const docs = await Promise.all(paths.map((p) => exportOf(src, p)));
    const bundles: ImagingBlobBundle[] = [];
    let after: string | null = '';
    while (after !== null) {
      const r = await src.inject('owner', 'GET', `/v1/imaging/export/blobs${after ? `?after=${after}` : ''}`);
      const page = data<ImagingBlobBundle & { next: string | null }>(r);
      bundles.push(page);
      after = page.next;
    }
    expect(docs[2]?.tables.clinical_encounter_image_links?.length).toBeGreaterThan(0);
    expect(docs[3]?.tables.thread_messages?.length).toBeGreaterThan(0);
    dst = await startImagingStack('integration_imaging_dst');
    // Tenancy is A's (exported by none of these): the target members get the source scopes.
    for (const m of (
      await src.db.admin.query('SELECT tenant_id, principal_id, scopes FROM cuspatlas.memberships')
    ).rows) {
      await dst.db.admin.query(
        'UPDATE cuspatlas.memberships SET scopes = $3 WHERE tenant_id = $1 AND principal_id = $2',
        [m.tenant_id, m.principal_id, m.scopes],
      );
    }
    // Given in reverse order; loaded S, I, C, E.
    const counts = await importExports(dst.db.admin, T_ALPHA, [...docs].reverse() as never, {
      verifyNoteDigests: verifyImportedNoteDigests,
    });
    expect(counts.imaging_image_refs).toBe(docs[1]?.tables.imaging_image_refs?.length);
    expect(counts.clinical_encounter_image_links).toBe(
      docs[2]?.tables.clinical_encounter_image_links?.length,
    );
    await importImagingBlobs(dst.store, T_ALPHA, docs[1] as never, bundles);
    for (const [i, p] of paths.entries()) {
      const again = await exportOf(dst, p);
      expect([p, { ...again, exportedAt: null }]).toStrictEqual([p, { ...docs[i], exportedAt: null }]);
    }
    // The imported link still resolves through I3 in the target.
    const link = docs[2]?.tables.clinical_encounter_image_links?.[0]?.id as string;
    const read = data<Record<string, unknown>>(
      await dst.inject('owner', 'GET', `/v1/clinical/image-links/${link}`),
    );
    expect(JSON.stringify(read)).toContain('"current"');
  });
});
