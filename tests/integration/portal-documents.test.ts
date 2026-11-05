import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';
import { T_ALPHA, USER_A1 } from './support/fixtures';
import { pngBytes, putFixtureObject, seedImagingScopes, tempObjectStore } from './support/imaging-fixtures';
import { MARKER } from './support/marker';

/**
 * E2 portal documents (closeout B): the documents view lists only images a clinician has explicitly
 * released to the portal (a human-only, audited, revocable release fact on the imaging side), each
 * downloadable through an I1 short-lived grant bound to the portal principal. Unreleased, revoked and
 * another patient's images are never listed or served. Synthetic data only.
 */
let db: TestDatabase;
let h: EngagementHarness;
const objects = tempObjectStore();
let parent: string;
let child: string;
let other: string;
let parentP: string;
let otherP: string;

beforeAll(async () => {
  db = await openTestDatabase('portal_documents');
  h = await openEngagementHarness(db, { objectStore: objects.store });
  await seedImagingScopes(db.admin);
  parent = await h.person(`Synthetic Doc Parent ${MARKER}`, [email('docs.parent')]);
  child = await h.person(`Synthetic Doc Child ${MARKER}`, [email('docs.child')], {
    birthDate: { known: true, value: '2016-05-05', precision: 'day' },
  });
  other = await h.person(`Synthetic Doc Other ${MARKER}`, [email('docs.other')]);
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${child}/relationships`, {
      counterpartyRef: parent,
      kind: 'guardian',
      scopes: ['demographics', 'clinical_read'],
    }),
    201,
  );
  parentP = await h.enroll(parent, { channel: 'email', value: 'docs.parent@example.invalid' });
  otherP = await h.enroll(other, { channel: 'email', value: 'docs.other@example.invalid' });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
  objects.cleanup();
});

async function associatedImage(patientRef: string, seed: number): Promise<string> {
  const id = await putFixtureObject(db.admin, objects.store, {
    tenantId: T_ALPHA,
    createdBy: USER_A1,
    bytes: pngBytes(seed),
  });
  await db.admin.query(
    `INSERT INTO cuspatlas.imaging_match_decisions (tenant_id, object_id, subject_patient_id, basis, decided_by)
     VALUES ($1, $2, $3, 'operatorSelected', $4)`,
    [T_ALPHA, id, patientRef, USER_A1],
  );
  return id;
}
const release = (objectRef: string, patientRef: string, who: 'a1' | 'a4' | 'svcA1' = 'a1') =>
  h.call(who, 'POST', `/v1/imaging/objects/${objectRef}/portal-releases`, { patientRef });
const revoke = (releaseRef: string) =>
  h.call('a1', 'POST', `/v1/imaging/portal-releases/${releaseRef}/revoke`, {});
type Doc = { releaseRef: string; kind: string; contentType: string; byteLength: number; releasedAt: string };
const docs = async (principal: string, patientRef: string) => {
  const v = h.ok<{ data: { coverage: { status: string }; fields: { documents: Doc[] } } }>(
    await h.portal(principal, 'GET', `/portal/v1/patients/${patientRef}/views/documents`),
  ).data;
  expect(v.coverage).toStrictEqual({ status: 'available' });
  return v.fields.documents;
};
const grant = (principal: string, patientRef: string, releaseRef: string) =>
  h.portal(
    principal,
    'POST',
    `/portal/v1/patients/${patientRef}/documents/${releaseRef}/read-grants`,
    {},
    null,
  );
const content = async (principal: string, patientRef: string, releaseRef: string, token: string) =>
  h.app.inject({
    method: 'GET',
    url: `/portal/v1/patients/${patientRef}/documents/${releaseRef}/content`,
    headers: { authorization: `Bearer ${await h.portalToken(principal)}`, 'x-object-read-token': token },
  });

describe('E2 portal documents', () => {
  it('lists only released images; a guardian downloads through a short-lived grant', async () => {
    const shown = await associatedImage(child, 1);
    await associatedImage(child, 2); // never released
    expect(await docs(parentP, child)).toStrictEqual([]);
    const r = h.ok<{ data: { releaseRef: string; state: string } }>(await release(shown, child), 201).data;
    expect(r.state).toBe('released');
    const list = await docs(parentP, child);
    expect(list.map((d) => [d.releaseRef, d.kind, d.contentType])).toStrictEqual([
      [r.releaseRef, 'image', 'image/png'],
    ]);
    expect(JSON.stringify(list)).not.toContain(shown); // object identifiers stay staff-side
    const g = h.ok<{ data: { token: string; expiresAt: string; contentPath: string } }>(
      await grant(parentP, child, r.releaseRef),
      201,
    ).data;
    expect(Date.parse(g.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    const res = await content(parentP, child, r.releaseRef, g.token);
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, Buffer.from(pngBytes(1)))).toBe(0);
  });

  it('a revoked release disappears and its grants stop working', async () => {
    const id = await associatedImage(child, 3);
    const r = h.ok<{ data: { releaseRef: string } }>(await release(id, child), 201).data;
    const g = h.ok<{ data: { token: string } }>(await grant(parentP, child, r.releaseRef), 201).data;
    h.ok(await revoke(r.releaseRef));
    expect((await docs(parentP, child)).map((d) => d.releaseRef)).not.toContain(r.releaseRef);
    expect((await content(parentP, child, r.releaseRef, g.token)).statusCode).toBe(404);
    expect((await grant(parentP, child, r.releaseRef)).statusCode).toBe(404);
    // Revocation is a recorded fact, never a delete.
    const { rows } = await db.admin.query(
      'SELECT revoked_at IS NOT NULL AS revoked FROM cuspatlas.portal_document_releases WHERE id = $1',
      [r.releaseRef],
    );
    expect(rows[0]?.revoked).toBe(true);
  });

  it("another patient's image is refused: not listed, not grantable, not releasable to the wrong patient", async () => {
    const mine = await associatedImage(child, 4);
    const r = h.ok<{ data: { releaseRef: string } }>(await release(mine, child), 201).data;
    // The other patient's principal cannot reach the child at all, nor via its own path.
    expect((await h.portal(otherP, 'GET', `/portal/v1/patients/${child}/views/documents`)).statusCode).toBe(
      404,
    );
    expect(await docs(otherP, other)).toStrictEqual([]);
    expect((await grant(otherP, other, r.releaseRef)).statusCode).toBe(404);
    // A release must name the patient the image is currently associated with.
    expect((await release(mine, other)).statusCode).toBe(409);
  });

  it('release is human-only and needs imaging.write', async () => {
    const id = await associatedImage(child, 5);
    expect((await release(id, child, 'a4')).statusCode).toBe(403);
    expect((await release(id, child, 'svcA1')).statusCode).toBe(403);
  });
});
