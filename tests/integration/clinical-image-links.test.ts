import { randomUUID } from 'node:crypto';
import {
  validateImageLinkCommandResult,
  validateImageLinkList,
  validateImageLinkRead,
} from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLINICAL_RECORD_ROUTES } from '../../apps/api/src/routes/clinical-record-manifest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  leakTables,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  T_BETA,
  USER_A1,
} from './support/appointment-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { actorFor, domainClinical, envelope } from './support/domain-harness';
import { fakeImageResolver } from './support/image-ref-resolver';
import { MARKER } from './support/marker';

/**
 * C15: encounter image links by opaque `imageRef` only (synthetic engineering implementation). I owns
 * the image object, bytes, digest, patient association and matching; C stores a link from an
 * encounter to an imageRef and asks I3 (the `ImageRefResolver` seam, a test double here) whether the
 * imageRef is current and for which patient. No bytes, no digest, no matchStatus exist in C. Every
 * denial runs under the runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
const images = fakeImageResolver();
const LOC = 'loc-images';
type Link = {
  imageLinkRef: string;
  encounterRef: string;
  patientRef: string;
  imageRef: string;
  state: string;
  endKind: string | null;
  endReasonCode: string | null;
  relinkedFromRef: string | null;
  relinkedToRef: string | null;
  linkedBy: string;
  linkedByRole: string;
  image: { status: string; reviewRequired: boolean };
};

beforeAll(async () => {
  db = await openTestDatabase('clinical_image_links');
  h = await openAppointmentHarness(db, { mcp: true, imageRefResolver: images });
  await seedClinicalScopes(db.admin);
  await seedLocation(h, LOC);
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

const imageFor = (tenant: string, patientRef: string, associationRef = 'syn-assoc-1') => {
  const ref = `syn-img-${randomUUID()}`;
  images.put(tenant, ref, { status: 'current', patientRef, associationRef });
  return ref;
};
async function encounter(patientRef: string, who = 'a1') {
  return h.ok<{ data: { encounter: { encounterRef: string } } }>(
    await h.call(who, 'POST', '/v1/clinical/encounters', { patientRef, locationRef: LOC }),
    201,
  ).data.encounter.encounterRef;
}
const link = (encounterRef: string, body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', `/v1/clinical/encounters/${encounterRef}/image-links`, body, key);
const okL = (res: Awaited<ReturnType<AppointmentHarness['call']>>, status = 201) => {
  const json = h.ok<{ data: Link; replayed: boolean }>(res, status);
  expect(validateImageLinkCommandResult(json)).toBe(true);
  return json.data;
};
const reason = (res: Awaited<ReturnType<AppointmentHarness['call']>>) => [
  res.statusCode,
  res.json().detail?.reason ?? res.json().detail?.violations?.[0]?.rule ?? res.json().code,
];
async function list(encounterRef: string) {
  const json = h.ok<{ data: { links: Link[] } }>(
    await h.call('a1', 'GET', `/v1/clinical/encounters/${encounterRef}/image-links`),
  );
  expect(validateImageLinkList(json)).toBe(true);
  return json.data.links;
}
async function read(ref: string, who = 'a1') {
  const json = h.ok<{ data: Link }>(await h.call(who, 'GET', `/v1/clinical/image-links/${ref}`));
  expect(validateImageLinkRead(json)).toBe(true);
  return json.data;
}

describe('C15 acceptance cases', () => {
  it('1. an imageRef whose current I3 association names the same patient links once and reads back with encounter and author', async () => {
    const p = await createPatient(h, 'Synthetic Image Link');
    const e = await encounter(p);
    const img = imageFor(T_ALPHA, p);
    const l = okL(await link(e, { imageRef: img }));
    expect([l.encounterRef, l.patientRef, l.imageRef, l.state, l.linkedByRole]).toStrictEqual([
      e,
      p,
      img,
      'active',
      'dentist',
    ]);
    expect(l.image).toStrictEqual({ status: 'current', reviewRequired: false });
    expect(await read(l.imageLinkRef)).toStrictEqual(l);
    expect((await list(e)).map((x) => x.imageLinkRef)).toStrictEqual([l.imageLinkRef]);
  });

  it('2. an imageRef associated with another patient is denied (image_patient_mismatch) and writes nothing', async () => {
    const p = await createPatient(h, 'Synthetic Image Mismatch');
    const other = await createPatient(h, 'Synthetic Image Other');
    const e = await encounter(p);
    const before = [await count(db, 'clinical_encounter_image_links'), await count(db, 'audit_events')];
    const res = await link(e, { imageRef: imageFor(T_ALPHA, other) });
    expect(reason(res)).toStrictEqual([409, 'image_patient_mismatch']);
    expect([
      await count(db, 'clinical_encounter_image_links'),
      await count(db, 'audit_events'),
    ]).toStrictEqual(before);
  });

  it('3. unlinking keeps the link history with its reason; the image stays I’s record', async () => {
    const p = await createPatient(h, 'Synthetic Image Unlink');
    const e = await encounter(p);
    const img = imageFor(T_ALPHA, p);
    const l = okL(await link(e, { imageRef: img }));
    const un = okL(
      await h.call('a1', 'POST', `/v1/clinical/image-links/${l.imageLinkRef}/unlink`, {
        reasonCode: 'wrong_visit',
      }),
      200,
    );
    expect([un.state, un.endKind, un.endReasonCode]).toStrictEqual(['ended', 'unlinked', 'wrong_visit']);
    expect(await list(e)).toMatchObject([{ imageLinkRef: l.imageLinkRef, state: 'ended' }]);
    const again = await h.call('a1', 'POST', `/v1/clinical/image-links/${l.imageLinkRef}/unlink`, {
      reasonCode: 'wrong_visit',
    });
    expect(reason(again)).toStrictEqual([409, 'image_link_ended']);
    // The image can be linked again (a new link; the ended one stays).
    const relinked = okL(await link(e, { imageRef: img }));
    expect(relinked.imageLinkRef).not.toBe(l.imageLinkRef);
  });

  it('4. an image linked elsewhere needs the explicit relink command; both links stay addressable', async () => {
    const p = await createPatient(h, 'Synthetic Image Relink');
    const e1 = await encounter(p);
    const e2 = await encounter(p);
    const img = imageFor(T_ALPHA, p);
    const first = okL(await link(e1, { imageRef: img }));
    const direct = await link(e2, { imageRef: img });
    expect(reason(direct)).toStrictEqual([409, 'image_linked_elsewhere']);
    expect(direct.json().detail.blockingRefs).toStrictEqual([{ kind: 'imageLink', ref: first.imageLinkRef }]);
    const moved = okL(
      await h.call('a1', 'POST', `/v1/clinical/image-links/${first.imageLinkRef}/relink`, {
        encounterRef: e2,
        reasonCode: 'wrong_visit',
      }),
    );
    expect([moved.encounterRef, moved.relinkedFromRef, moved.state]).toStrictEqual([
      e2,
      first.imageLinkRef,
      'active',
    ]);
    const old = await read(first.imageLinkRef);
    expect([old.state, old.endKind, old.relinkedToRef]).toStrictEqual([
      'ended',
      'relinked',
      moved.imageLinkRef,
    ]);
    // A relink to another patient's encounter is the same mismatch as a link.
    const other = await createPatient(h, 'Synthetic Image Relink Other');
    const e3 = await encounter(other);
    const bad = await h.call('a1', 'POST', `/v1/clinical/image-links/${moved.imageLinkRef}/relink`, {
      encounterRef: e3,
      reasonCode: 'wrong_visit',
    });
    expect(reason(bad)).toStrictEqual([409, 'image_patient_mismatch']);
  });

  it('5. another tenant’s imageRef is denied exactly like a missing one', async () => {
    const p = await createPatient(h, 'Synthetic Image Tenant');
    const e = await encounter(p);
    const betaPatient = await createPatient(h, 'Synthetic Image Beta', 'b1');
    const foreign = await link(e, { imageRef: imageFor(T_BETA, betaPatient) });
    const missing = await link(e, { imageRef: `syn-img-${randomUUID()}` });
    expect([foreign.statusCode, foreign.json().code]).toStrictEqual([404, 'not_found']);
    expect(Object.keys(foreign.json()).sort()).toStrictEqual(Object.keys(missing.json()).sort());
    // Another tenant's member cannot see or touch the link either.
    const l = okL(await link(e, { imageRef: imageFor(T_ALPHA, p) }));
    expect((await h.call('b1', 'GET', `/v1/clinical/image-links/${l.imageLinkRef}`)).statusCode).toBe(404);
    expect((await h.call('b1', 'GET', `/v1/clinical/encounters/${e}/image-links`)).statusCode).toBe(404);
  });

  it('6. C registers no image object, digest or match status: such fields are refused and no such command exists', async () => {
    const p = await createPatient(h, 'Synthetic Image Object');
    const e = await encounter(p);
    const img = imageFor(T_ALPHA, p);
    for (const extra of [
      { digest: `sha256:${'a'.repeat(64)}` },
      { matchStatus: 'matched' },
      { bytes: 'AAAA' },
    ]) {
      const res = await link(e, { imageRef: img, ...extra });
      expect(res.statusCode).toBe(400);
    }
    expect(
      CLINICAL_RECORD_ROUTES.filter((r) => /image/i.test(r.path))
        .map((r) => r.operationId)
        .sort(),
    ).toStrictEqual([
      'clinical.imageLinks.link',
      'clinical.imageLinks.list',
      'clinical.imageLinks.read',
      'clinical.imageLinks.relink',
      'clinical.imageLinks.unlink',
    ]);
    const { rows } = await db.admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'cuspatlas'
       AND table_name = 'clinical_encounter_image_links' AND column_name ~ '(digest|match|byte|modality|locator|captured)'`,
    );
    expect(rows).toStrictEqual([]);
  });
});

describe('C15 failure and recovery cases', () => {
  it('1. an imageRef I cannot resolve is an explicit unavailable state, never a fabricated link; no resolver is the same', async () => {
    const p = await createPatient(h, 'Synthetic Image Unavailable');
    const e = await encounter(p);
    const ref = `syn-img-${randomUUID()}`;
    images.put(T_ALPHA, ref, { status: 'unavailable', reason: 'imaging_store_unreachable' });
    const before = await count(db, 'clinical_encounter_image_links');
    const res = await link(e, { imageRef: ref });
    expect(reason(res)).toStrictEqual([409, 'image_unavailable']);
    // A deployment without the I3 seam wired refuses typed (the seam is the integrator's to wire).
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    await expect(
      domainClinical(db).linkImageToEncounter(
        a1,
        e,
        envelope('clinical.imageLinks.link', { imageRef: imageFor(T_ALPHA, p) }),
      ),
    ).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'image_resolver_unavailable' } });
    expect(await count(db, 'clinical_encounter_image_links')).toBe(before);
    // Once I resolves it, the same command succeeds (the refusal was not stored as the answer).
    images.put(T_ALPHA, ref, { status: 'current', patientRef: p, associationRef: 'syn-assoc-9' });
    okL(await link(e, { imageRef: ref }));
  });

  it('2. a link whose I association was superseded afterwards stays readable and is flagged for review', async () => {
    const p = await createPatient(h, 'Synthetic Image Superseded');
    const e = await encounter(p);
    const img = imageFor(T_ALPHA, p, 'syn-assoc-a');
    const l = okL(await link(e, { imageRef: img }));
    images.put(T_ALPHA, img, { status: 'current', patientRef: p, associationRef: 'syn-assoc-b' });
    const after = await read(l.imageLinkRef);
    expect([after.state, after.encounterRef, after.image]).toStrictEqual([
      'active',
      e,
      { status: 'association_changed', reviewRequired: true },
    ]);
    images.put(T_ALPHA, img, { status: 'unavailable', reason: 'imaging_store_unreachable' });
    expect((await read(l.imageLinkRef)).image).toStrictEqual({ status: 'unavailable', reviewRequired: true });
  });

  it('3. a merge re-points the encounter patient through S6 and leaves the link and I evidence intact', async () => {
    const survivor = await createPatient(h, 'Synthetic Image Merge');
    const merged = await createPatient(h, 'Synthetic Image Merge');
    const e = await encounter(merged);
    const img = imageFor(T_ALPHA, merged);
    const l = okL(await link(e, { imageRef: img }));
    const row = async () =>
      (
        await db.admin.query(
          'SELECT encounter_id, image_ref, association_ref FROM cuspatlas.clinical_encounter_image_links WHERE id = $1',
          [l.imageLinkRef],
        )
      ).rows[0];
    const before = await row();
    await mergePatients(h, survivor, merged);
    expect(await row()).toStrictEqual(before);
    const after = await read(l.imageLinkRef);
    expect([after.patientRef, after.imageRef, after.state]).toStrictEqual([survivor, img, 'active']);
  });

  it('4. a failed link rolls back its link row, audit and outbox together', async () => {
    const p = await createPatient(h, 'Synthetic Image Rollback');
    const e = await encounter(p);
    const counts = async () => [
      await count(db, 'clinical_encounter_image_links'),
      await count(db, 'audit_events'),
      await count(db, 'outbox_events'),
    ];
    const before = await counts();
    await db.admin.query('REVOKE INSERT ON cuspatlas.outbox_events FROM cuspatlas_app');
    try {
      const res = await link(e, { imageRef: imageFor(T_ALPHA, p) });
      expect(res.statusCode).toBe(500);
    } finally {
      await db.admin.query('GRANT INSERT ON cuspatlas.outbox_events TO cuspatlas_app');
    }
    expect(await counts()).toStrictEqual(before);
  });
});

describe('C15 boundaries', () => {
  it('a read-only member reads but cannot link; a service principal cannot link; no caller tenant is accepted', async () => {
    const p = await createPatient(h, 'Synthetic Image Roles');
    const e = await encounter(p);
    const img = imageFor(T_ALPHA, p);
    expect(reason(await link(e, { imageRef: img }, 'a4'))).toStrictEqual([403, 'forbidden']);
    expect(reason(await link(e, { imageRef: img }, 'svcA1'))).toStrictEqual([403, 'forbidden']);
    expect((await h.call('a4', 'GET', `/v1/clinical/encounters/${e}/image-links`)).statusCode).toBe(200);
    const res = await link(e, { imageRef: img, tenantId: T_BETA });
    expect(res.statusCode).toBe(400);
  });

  it('the marker never leaks; MCP link replays a REST key and reads match', async () => {
    const p = await createPatient(h, 'Synthetic Image Mcp');
    const e = await encounter(p);
    const img = imageFor(T_ALPHA, p);
    await link(e, { imageRef: img, reasonCode: MARKER });
    const key = randomUUID();
    const rest = okL(await link(e, { imageRef: img }, 'a1', key));
    const m = await h.mcp(
      'a1',
      'clinical_image_links_link',
      { encounterRef: e, imageRef: img, idempotencyKey: key },
      201,
    );
    expect([m.code, (m.body as { replayed: boolean }).replayed]).toStrictEqual([null, true]);
    const got = await h.mcp('a1', 'clinical_image_links_get', { imageLinkRef: rest.imageLinkRef });
    expect((got.body as { data: Link }).data).toStrictEqual(await read(rest.imageLinkRef));
    const foreign = await h.mcp('b1', 'clinical_image_links_get', { imageLinkRef: rest.imageLinkRef });
    expect(foreign.status).toBe(404);
    expect(`${await leakTables(db)}${h.logLines.join('\n')}`).not.toContain(MARKER);
  });

  it('link rows are append-only in content under the runtime role', async () => {
    const p = await createPatient(h, 'Synthetic Image Immutable');
    const e = await encounter(p);
    const l = okL(await link(e, { imageRef: imageFor(T_ALPHA, p) }));
    const client = await db.app.connect();
    try {
      for (const sql of [
        `UPDATE cuspatlas.clinical_encounter_image_links SET image_ref = 'syn-img-x' WHERE id = $1`,
        'DELETE FROM cuspatlas.clinical_encounter_image_links WHERE id = $1',
      ]) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
        const code = await client.query(sql, [l.imageLinkRef]).then(
          () => 'ok',
          (err: { code?: string }) => err.code,
        );
        await client.query('ROLLBACK');
        expect(code).toBe('42501');
      }
    } finally {
      client.release();
    }
  });
});
