import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA, USER_A1 } from './support/fixtures';
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
 * I3 patient matching, association correction and the imageRef (synthetic patients and images).
 * Candidates are proposals with reasons and never bind; every association is a recorded human
 * decision; a correction appends a superseding decision and keeps the earlier one readable; the object
 * is never current for two patients; the imageRef is stable across corrections and merges, and its
 * reference read tells a consumer when the association no longer matches what it expected.
 */
let s: ImagingStack;
let pOne: string;
let pTwo: string;
let pBeta: string;
let seed = 100;
const next = () => {
  seed += 1;
  return pngBytes(seed);
};

const mkPatient = async (who: Who, given: string, birth = '2001-02-03') =>
  (
    (
      await s.command(
        who,
        '/v1/patients',
        patientBody(given, { birthDate: { known: true, value: birth, precision: 'day' } }),
      )
    ).json.data as { patientRef: string }
  ).patientRef;

beforeAll(async () => {
  s = await startImagingStack('imaging_association');
  pOne = await mkPatient('owner', 'Imaging Match One', '1990-05-06');
  pTwo = await mkPatient('owner', 'Imaging Match Two', '1985-01-02');
  pBeta = await mkPatient('crossTenant', 'Imaging Match Beta');
});
afterAll(async () => {
  await s?.close();
});

const hints = (o: Record<string, unknown>) => ({ patientHints: o });
const candidates = async (objectRef: string, who: Who = 'owner') =>
  s.inject(who, 'GET', `/v1/imaging/objects/${objectRef}/match-candidates`);
const confirm = (objectRef: string, body: Record<string, unknown>, who: Who = 'owner', key?: string) =>
  s.command(who, `/v1/imaging/objects/${objectRef}/association`, body, key);
const correct = (decisionRef: string, body: Record<string, unknown>, who: Who = 'owner') =>
  s.command(who, `/v1/imaging/associations/${decisionRef}/correct`, body);
const reason = (r: { json: Record<string, unknown> }) =>
  (r.json.detail as { reason?: string } | undefined)?.reason;

describe('I3 candidates never bind', () => {
  it('exact metadata proposes a candidate with reasons but the object stays unassociated until decided', async () => {
    const { objectRef } = await ingestVia(
      s,
      next(),
      hints({ familyName: 'Synthetic', givenName: 'Imaging Match One', birthDate: '1990-05-06' }),
    );
    const c = await candidates(objectRef);
    expect(c.status).toBe(200);
    const d = c.json.data as {
      candidates: { patientRef: string; reasons: string[]; exact: boolean }[];
      autoAssociated: boolean;
    };
    expect(d.autoAssociated).toBe(false);
    expect(d.candidates[0]).toMatchObject({
      patientRef: pOne,
      reasons: ['same_birth_date', 'same_legal_name'],
      exact: true,
      suggestedBasis: 'metadataExact',
    });
    const read = await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}`);
    expect((read.json.data as { association: unknown }).association).toStrictEqual({
      status: 'unassociated',
    });
    const work = await s.inject('owner', 'GET', '/v1/imaging/worklists/unmatched');
    const item = (
      work.json.data as { items: { workItemRef: string; ageHours: number; kind: string }[] }
    ).items.find((i) => i.workItemRef === objectRef);
    expect(item).toMatchObject({ kind: 'image_unmatched', ageHours: 0 });
    // The recorded decision makes it part of the patient's record and mints the imageRef.
    const r = await confirm(objectRef, { patientRef: pOne, basis: 'metadataExact' });
    expect(r.status).toBe(201);
    const data = r.json.data as { decisionRef: string; imageRef: string; patientRef: string };
    expect(data.patientRef).toBe(pOne);
    const after = await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}`);
    expect((after.json.data as { association: unknown }).association).toMatchObject({
      status: 'associated',
      patientRef: pOne,
      imageRef: data.imageRef,
      decisionRef: data.decisionRef,
    });
    const work2 = await s.inject('owner', 'GET', '/v1/imaging/worklists/unmatched');
    expect(JSON.stringify(work2.json)).not.toContain(objectRef);
  });

  it('weak evidence never qualifies: a shared phone alone is no candidate; a basis must match the evidence', async () => {
    const phoneOnly = await ingestVia(s, next(), hints({ phone: '+15555550100' }));
    expect((await candidates(phoneOnly.objectRef)).json.data).toMatchObject({ candidates: [] });
    expect(reason(await confirm(phoneOnly.objectRef, { patientRef: pOne, basis: 'metadataAssisted' }))).toBe(
      'candidate_not_confirmed',
    );
    const nameOnly = await ingestVia(
      s,
      next(),
      hints({ familyName: 'Synthetic', givenName: 'Imaging Match Two' }),
    );
    const c = (await candidates(nameOnly.objectRef)).json.data as {
      candidates: { patientRef: string; exact: boolean }[];
    };
    expect(c.candidates).toStrictEqual([expect.objectContaining({ patientRef: pTwo, exact: false })]);
    expect(reason(await confirm(nameOnly.objectRef, { patientRef: pTwo, basis: 'metadataExact' }))).toBe(
      'candidate_not_confirmed',
    );
    expect((await confirm(nameOnly.objectRef, { patientRef: pTwo, basis: 'metadataAssisted' })).status).toBe(
      201,
    );
    // An operator may still decide explicitly with no metadata at all.
    expect((await confirm(phoneOnly.objectRef, { patientRef: pOne, basis: 'operatorSelected' })).status).toBe(
      201,
    );
    const none = await ingestVia(s, next());
    expect((await candidates(none.objectRef)).json.data).toMatchObject({
      limitations: ['no_patient_metadata'],
    });
  });

  it('hint values are stored only as tenant-bound match keys, never as text', async () => {
    await ingestVia(
      s,
      next(),
      hints({ familyName: `Synthetic${MARKER}`, givenName: 'Hidden', birthDate: '1970-01-01' }),
    );
    const all = await s.db.admin.query(
      `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.imaging_ingress_sessions t`,
    );
    expect(all.rows[0].j).not.toContain(MARKER);
    expect(all.rows[0].j).not.toContain('Hidden');
    expect(await imagingLeakSurface(s.db.admin)).not.toContain(MARKER);
  });
});

describe('I3 decisions, corrections and the imageRef', () => {
  it('correction appends a superseding decision, keeps history, and the imageRef stays stable', async () => {
    const { objectRef } = await ingestVia(s, next());
    const first = await confirm(objectRef, { patientRef: pOne, basis: 'operatorSelected' });
    const { decisionRef, imageRef } = first.json.data as { decisionRef: string; imageRef: string };
    // A second confirmation while one is current is a conflict, never a second current patient.
    const dup = await confirm(objectRef, { patientRef: pTwo, basis: 'operatorSelected' });
    expect([dup.status, reason(dup)]).toStrictEqual([409, 'association_conflict']);
    expect((await correct(decisionRef, { patientRef: pTwo })).status).toBe(400);
    expect(reason(await correct(decisionRef, { patientRef: pOne, reasonCode: 'wrong_patient' }))).toBe(
      'same_patient',
    );
    expect((await correct(decisionRef, { patientRef: pBeta, reasonCode: 'wrong_patient' })).status).toBe(404);
    const fix = await correct(decisionRef, { patientRef: pTwo, reasonCode: 'wrong_patient' });
    expect(fix.status).toBe(201);
    expect(fix.json.data).toMatchObject({ supersededRef: decisionRef, imageRef, patientRef: pTwo });
    const history = await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}/associations`);
    const decisions = (
      history.json.data as {
        decisions: { decisionRef: string; patientRef: string; supersededBy: string | null }[];
      }
    ).decisions;
    expect(decisions.map((d) => [d.patientRef, d.supersededBy === null])).toStrictEqual([
      [pOne, false],
      [pTwo, true],
    ]);
    const current = await s.db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.imaging_match_decisions WHERE object_id = $1 AND superseded_by_id IS NULL',
      [objectRef],
    );
    expect(current.rows[0].n).toBe(1);
    // A superseded decision cannot be corrected again.
    expect(reason(await correct(decisionRef, { patientRef: pOne, reasonCode: 'wrong_patient' }))).toBe(
      'decision_superseded',
    );
    // The reference read (C15 / CL-04 seam): stable handle, current patient, explicit mismatch.
    const asOne = await s.inject(
      'owner',
      'GET',
      `/v1/imaging/image-refs/${imageRef}?expectedPatientRef=${pOne}`,
    );
    expect(asOne.json.data).toMatchObject({
      imageRef,
      objectRef,
      matchesExpected: false,
      decisionCount: 2,
      association: { patientRef: pTwo },
    });
    const asTwo = await s.inject(
      'owner',
      'GET',
      `/v1/imaging/image-refs/${imageRef}?expectedPatientRef=${pTwo}`,
    );
    expect(asTwo.json.data).toMatchObject({ matchesExpected: true, objectState: 'available' });
    expect((asTwo.json.data as { digestSha256: string }).digestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('concurrent confirmations and corrections resolve to one current decision', async () => {
    const { objectRef } = await ingestVia(s, next());
    const both = await Promise.all([
      confirm(objectRef, { patientRef: pOne, basis: 'operatorSelected' }),
      confirm(objectRef, { patientRef: pTwo, basis: 'operatorSelected' }),
    ]);
    expect(both.map((r) => r.status).sort()).toStrictEqual([201, 409]);
    const winner = both.find((r) => r.status === 201)?.json.data as {
      decisionRef: string;
      patientRef: string;
    };
    const other = winner.patientRef === pOne ? pTwo : pOne;
    const pTri = await mkPatient('owner', 'Imaging Match Three', '1979-09-09');
    const fixes = await Promise.all([
      correct(winner.decisionRef, { patientRef: other, reasonCode: 'wrong_patient' }),
      correct(winner.decisionRef, { patientRef: pTri, reasonCode: 'wrong_patient' }),
    ]);
    expect(fixes.map((r) => r.status).sort()).toStrictEqual([201, 409]);
    const current = await s.db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.imaging_match_decisions WHERE object_id = $1 AND superseded_by_id IS NULL',
      [objectRef],
    );
    expect(current.rows[0].n).toBe(1);
  });

  it('only an available original can be associated; association is a human decision; another tenant is hidden', async () => {
    const q = await putFixtureObject(s.db.admin, s.store, {
      tenantId: T_ALPHA,
      createdBy: USER_A1,
      bytes: next(),
    });
    await s.db.admin.query(
      `UPDATE cuspatlas.imaging_objects SET state = 'quarantined', quarantine_reason = 'digest_mismatch', version = version + 1 WHERE id = $1`,
      [q],
    );
    expect(reason(await confirm(q, { patientRef: pOne, basis: 'operatorSelected' }))).toBe(
      'object_not_available',
    );
    const { objectRef } = await ingestVia(s, next());
    const svc = await confirm(objectRef, { patientRef: pOne, basis: 'operatorSelected' }, 'service');
    expect([svc.status, svc.json.code]).toStrictEqual([403, 'forbidden']);
    const writer = await confirm(objectRef, { patientRef: pOne, basis: 'operatorSelected' }, 'writer');
    expect(writer.status).toBe(403);
    const foreign = await confirm(objectRef, { patientRef: pBeta, basis: 'operatorSelected' }, 'crossTenant');
    expect(foreign.status).toBe(404);
    expect((await confirm(objectRef, { patientRef: pBeta, basis: 'operatorSelected' })).status).toBe(404);
    const ok = await confirm(objectRef, { patientRef: pOne, basis: 'operatorSelected' }, 'associator');
    expect(ok.status).toBe(201);
    // Idempotent by key.
    const key = randomUUID();
    const { objectRef: o2 } = await ingestVia(s, next());
    const a = await confirm(o2, { patientRef: pOne, basis: 'operatorSelected' }, 'owner', key);
    const b = await confirm(o2, { patientRef: pOne, basis: 'operatorSelected' }, 'owner', key);
    expect([a.status, b.status, b.json.replayed]).toStrictEqual([201, 201, true]);
  });

  it('MCP proposes, confirms, corrects and resolves with the same outcomes', async () => {
    const { objectRef } = await ingestVia(s, next());
    const c = await s.mcp('owner', 'imaging_associations_candidates', { objectRef });
    expect(c.isError).toBe(false);
    const m = await s.mcp('owner', 'imaging_associations_confirm', {
      objectRef,
      patientRef: pOne,
      basis: 'operatorSelected',
      idempotencyKey: randomUUID(),
    });
    expect(m.isError).toBe(false);
    const { decisionRef, imageRef } = m.body.data as { decisionRef: string; imageRef: string };
    const fix = await s.mcp('owner', 'imaging_associations_correct', {
      decisionRef,
      patientRef: pTwo,
      reasonCode: 'wrong_patient',
      idempotencyKey: randomUUID(),
    });
    expect(fix.isError).toBe(false);
    const again = await s.mcp('owner', 'imaging_associations_correct', {
      decisionRef,
      patientRef: pOne,
      reasonCode: 'wrong_patient',
      idempotencyKey: randomUUID(),
    });
    expect([again.isError, (again.body.detail as { reason: string }).reason]).toStrictEqual([
      true,
      'decision_superseded',
    ]);
    const r = await s.mcp('owner', 'imaging_image_refs_resolve', { imageRef, expectedPatientRef: pTwo });
    expect((r.body.data as { matchesExpected: boolean }).matchesExpected).toBe(true);
  });
});

describe('I3 merge registration (S6) keeps bytes and the imageRef unchanged', () => {
  it('a merge relinks the association with a digest proof; object bytes and digest never change', async () => {
    const dupA = await mkPatient('owner', 'Imaging Duplicate', '1999-12-31');
    const dupB = await mkPatient('owner', 'Imaging Duplicate', '1999-12-31');
    const bytes = next();
    const { objectRef } = await ingestVia(s, bytes);
    const c = await confirm(objectRef, { patientRef: dupB, basis: 'operatorSelected' });
    const { imageRef } = c.json.data as { imageRef: string };
    const before = await s.db.admin.query(
      'SELECT digest_sha256, version FROM cuspatlas.imaging_objects WHERE id = $1',
      [objectRef],
    );
    const review = await s.inject('owner', 'GET', `/v1/patients/${dupA}/duplicate-candidates`);
    const token = (review.json.data as { candidateRef: string; confirmationToken: string }[]).find(
      (x) => x.candidateRef === dupB,
    )?.confirmationToken;
    const merged = await s.command('owner', '/v1/patients/merges', {
      survivorRef: dupA,
      mergedRef: dupB,
      confirmationToken: token,
      reasonCode: 'duplicate_registration',
    });
    expect(merged.status).toBe(201);
    const moves = await s.db.admin.query(
      `SELECT record_class, content_digest_before, content_digest_after FROM cuspatlas.patient_merge_moves
       WHERE merge_id = $1 AND record_class = 'imagingAssociation'`,
      [(merged.json.data as { mergeRef: string }).mergeRef],
    );
    expect(moves.rows).toHaveLength(1);
    expect(moves.rows[0].content_digest_before).toBe(moves.rows[0].content_digest_after);
    const after = await s.db.admin.query(
      'SELECT digest_sha256, version FROM cuspatlas.imaging_objects WHERE id = $1',
      [objectRef],
    );
    expect(after.rows).toStrictEqual(before.rows);
    const ref = await s.inject(
      'owner',
      'GET',
      `/v1/imaging/image-refs/${imageRef}?expectedPatientRef=${dupA}`,
    );
    expect(ref.json.data).toMatchObject({ imageRef, matchesExpected: true, digestSha256: sha256(bytes) });
    const g = await s.inject('owner', 'POST', `/v1/imaging/objects/${objectRef}/read-grants`, {});
    const content = await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}/content`, undefined, {
      'x-object-read-token': (g.json.data as { token: string }).token,
    });
    expect(sha256(content.raw)).toBe(sha256(bytes));
    // The merged identity cannot receive new associations.
    const { objectRef: o2 } = await ingestVia(s, next());
    expect(reason(await confirm(o2, { patientRef: dupB, basis: 'operatorSelected' }))).toBe('patient_merged');
  });
});
