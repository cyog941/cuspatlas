import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObjectStorePort } from '@cuspatlas/contracts';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ctxFor, T_ALPHA, USER_A1 } from './support/fixtures';
import {
  type ImagingStack,
  ingestVia,
  pngBytes,
  sha256,
  startImagingStack,
} from './support/imaging-fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * Independent review of I1-I8 (c5e1b8e), synthetic data only. A legal hold placed while a deletion
 * executes is never lost (advisory lock on the hold subject plus a database re-check on the deleted
 * transition); a hold on a derived object blocks deleting its original; byte removal and an ingest of
 * the same bytes serialize on the content; an unscoped upload never deduplicates into an associated
 * object; a decision's patient changes only along a merge or unmerge; the consumer read names the
 * patient it expects; a corrupt content-addressed file is repaired by verified bytes.
 */
let s: ImagingStack;
let pOne: string;
let pTwo: string;
let seed = 9000;
const next = () => {
  seed += 1;
  return pngBytes(seed, 5, 5);
};
const reason = (r: { json: Record<string, unknown> }) =>
  (r.json.detail as { reason?: string } | undefined)?.reason;
const blobPath = (bytes: Uint8Array) =>
  join(s.storeRoot, 't', T_ALPHA, 'sha256', sha256(bytes).slice(0, 2), sha256(bytes));

/** Test-only gate: pauses once after a successful promote until released. */
let promoteGate: { armed: boolean; reached: () => void; release: Promise<void> } | null = null;
const wrapStore = (inner: ObjectStorePort): ObjectStorePort => ({
  ...inner,
  async promote(tenantId, stagingKey, digest) {
    const out = await inner.promote(tenantId, stagingKey, digest);
    const g = promoteGate;
    if (g?.armed) {
      g.armed = false;
      g.reached();
      await g.release;
    }
    return out;
  },
});

const waitFor = async (cond: () => Promise<boolean>, ms = 10_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};
const advisoryWaiters = async () =>
  (
    await s.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
    )
  ).rows[0]?.n ?? 0;

const setPolicy = (recordClass: string) =>
  s.command('owner', '/v1/imaging/retention/policies', {
    recordClass,
    minimumRetentionMonths: 0,
    basisCode: 'synthetic_test_policy',
    jurisdictionCode: 'us-synthetic',
  });
const requestDeletion = (objectRef: string) =>
  s.command('owner', `/v1/imaging/objects/${objectRef}/deletion-requests`, {
    reasonCode: 'requested_by_practice',
  });
const executeDeletion = (deletionRef: string, who: 'owner' | 'deleter' = 'owner') =>
  s.command(who, `/v1/imaging/deletion-requests/${deletionRef}/execute`, {});
const stateOf = async (objectRef: string) =>
  (await s.db.admin.query('SELECT state FROM cuspatlas.imaging_objects WHERE id = $1', [objectRef])).rows[0]
    ?.state as string;

beforeAll(async () => {
  s = await startImagingStack('imaging_review_hardening', { wrapStore });
  const mk = async (name: string) =>
    ((await s.command('owner', '/v1/patients', patientBody(name))).json.data as { patientRef: string })
      .patientRef;
  pOne = await mk('Hardening One');
  pTwo = await mk('Hardening Two');
  await setPolicy('unassociated_original');
  await setPolicy('associated_original');
  await setPolicy('derived');
});
afterAll(async () => {
  await s?.close();
});

describe('MUST 1: a hold placed while a deletion executes is not lost', () => {
  it('an uncommitted hold makes the execution wait and then refuses it; the object stays available', async () => {
    const { objectRef } = await ingestVia(s, next());
    const r = await requestDeletion(objectRef);
    expect(r.status).toBe(201);
    const deletionRef = (r.json.data as { deletionRef: string }).deletionRef;
    const tx = createTenantTransactionRunner(s.db.app);
    let commitHold: () => void = () => undefined;
    const holdOpen = new Promise<void>((res) => {
      commitHold = res;
    });
    let inserted: () => void = () => undefined;
    const holdInserted = new Promise<void>((res) => {
      inserted = res;
    });
    // A hold inserted under the runtime role and kept open (the placing transaction has not committed).
    const holding = tx(ctxFor(T_ALPHA, USER_A1, 'human'), async (t) => {
      await t.query(
        `INSERT INTO cuspatlas.imaging_legal_holds (tenant_id, subject_kind, subject_ref, reason_code, placed_by)
         VALUES (cuspatlas.current_tenant_id(), 'object', $1, 'litigation_hold', cuspatlas.current_actor_id())`,
        [objectRef],
      );
      inserted();
      await holdOpen;
    });
    await holdInserted;
    let settled = false;
    const executing = executeDeletion(deletionRef).finally(() => {
      settled = true;
    });
    await waitFor(async () => settled || (await advisoryWaiters()) > 0);
    commitHold();
    await holding;
    const x = await executing;
    expect([x.status, reason(x)]).toStrictEqual([409, 'legal_hold_active']);
    expect(await stateOf(objectRef)).toBe('available');
  });

  it('the database refuses the deleted transition while a hold is active (runtime role)', async () => {
    const { objectRef } = await ingestVia(s, next());
    await s.command('owner', '/v1/imaging/legal-holds', {
      subject: { kind: 'object', ref: objectRef },
      reasonCode: 'records_request',
    });
    const tx = createTenantTransactionRunner(s.db.app);
    const code = await tx(ctxFor(T_ALPHA, USER_A1, 'human'), (t) =>
      t.query(
        `UPDATE cuspatlas.imaging_objects SET state = 'deleted', deleted_at = now(), version = version + 1
         WHERE id = $1`,
        [objectRef],
      ),
    ).then(
      () => 'ok',
      (e: { code?: string }) => e.code,
    );
    expect(code).toBe('42501');
  });
});

describe('MUST 2: a hold on a derived object blocks deleting its original', () => {
  it('request and the database transition are both refused with the derived hold named', async () => {
    const { objectRef } = await ingestVia(s, next(), { intendedPatientRef: pOne });
    await s.command('owner', `/v1/imaging/objects/${objectRef}/association`, {
      patientRef: pOne,
      basis: 'operatorSelected',
    });
    const d = await s.command('owner', `/v1/imaging/objects/${objectRef}/derived`, {
      transform: { kind: 'invert' },
    });
    const derivedRef = (d.json.data as { objectRef: string }).objectRef;
    const h = await s.command('owner', '/v1/imaging/legal-holds', {
      subject: { kind: 'object', ref: derivedRef },
      reasonCode: 'records_request',
    });
    const holdRef = (h.json.data as { legalHoldRef: string }).legalHoldRef;
    const r = await requestDeletion(objectRef);
    expect([r.status, reason(r)]).toStrictEqual([409, 'legal_hold_active']);
    expect((r.json.detail as { blockingRefs: unknown[] }).blockingRefs).toStrictEqual([
      { kind: 'imagingLegalHold', ref: holdRef },
    ]);
    const tx = createTenantTransactionRunner(s.db.app);
    const code = await tx(ctxFor(T_ALPHA, USER_A1, 'human'), (t) =>
      t.query(
        `UPDATE cuspatlas.imaging_objects SET state = 'deleted', deleted_at = now(), version = version + 1
         WHERE id = $1`,
        [objectRef],
      ),
    ).then(
      () => 'ok',
      (e: { code?: string }) => e.code,
    );
    expect(code).toBe('42501');
    expect([await stateOf(objectRef), await stateOf(derivedRef)]).toStrictEqual(['available', 'available']);
  });
});

describe('SHOULD 3: byte removal and an ingest of the same bytes serialize on the content', () => {
  it('a deletion that removes bytes while the same bytes are being ingested keeps them for the new object', async () => {
    const bytes = next();
    const first = await ingestVia(s, bytes);
    const r = await requestDeletion(first.objectRef);
    const deletionRef = (r.json.data as { deletionRef: string }).deletionRef;
    let reached: () => void = () => undefined;
    const atGate = new Promise<void>((res) => {
      reached = res;
    });
    let release: () => void = () => undefined;
    promoteGate = {
      armed: true,
      reached: () => reached(),
      release: new Promise<void>((res) => {
        release = res;
      }),
    };
    // The same bytes for a named patient: a separate object sharing the content-addressed blob.
    const ingesting = ingestVia(s, bytes, { intendedPatientRef: pTwo });
    await atGate;
    let settled = false;
    const executing = executeDeletion(deletionRef).finally(() => {
      settled = true;
    });
    await waitFor(async () => settled || (await advisoryWaiters()) > 0);
    release();
    const second = await ingesting;
    const x = await executing;
    promoteGate = null;
    expect(second.status).toBe(201);
    expect(x.status).toBe(200);
    expect((x.json.data as { bytes: string }).bytes).toBe('retained_shared');
    const g = await s.inject('owner', 'POST', `/v1/imaging/objects/${second.objectRef}/read-grants`, {});
    const c = await s.inject('owner', 'GET', `/v1/imaging/objects/${second.objectRef}/content`, undefined, {
      'x-object-read-token': (g.json.data as { token: string }).token,
    });
    expect([c.status, sha256(c.raw)]).toStrictEqual([200, sha256(bytes)]);
  });
});

describe('SHOULD 4: an unscoped upload never deduplicates into an associated object', () => {
  it('the same bytes uploaded unscoped after an association become a separate unassociated object', async () => {
    const bytes = next();
    const a = await ingestVia(s, bytes);
    const c = await s.command('owner', `/v1/imaging/objects/${a.objectRef}/association`, {
      patientRef: pOne,
      basis: 'operatorSelected',
    });
    expect(c.status).toBe(201);
    const b = await ingestVia(s, bytes);
    expect(b.status).toBe(201);
    expect(b.objectRef).not.toBe(a.objectRef);
    const prov = await s.db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.imaging_object_provenance WHERE object_id = $1',
      [a.objectRef],
    );
    expect(prov.rows[0].n).toBe(1);
    const readB = await s.inject('owner', 'GET', `/v1/imaging/objects/${b.objectRef}`);
    expect((readB.json.data as { association?: unknown }).association).toStrictEqual({
      status: 'unassociated',
    });
    // Unscoped bytes that were never associated still deduplicate (I2 rule unchanged).
    const loose = next();
    const l1 = await ingestVia(s, loose);
    const l2 = await ingestVia(s, loose);
    expect(l2.objectRef).toBe(l1.objectRef);
  });
});

describe("SHOULD 5: a decision's patient changes only along a merge", () => {
  it('a direct relink to an unrelated patient is refused at commit under the runtime role', async () => {
    const { objectRef } = await ingestVia(s, next(), { intendedPatientRef: pOne });
    const c = await s.command('owner', `/v1/imaging/objects/${objectRef}/association`, {
      patientRef: pOne,
      basis: 'operatorSelected',
    });
    const decisionRef = (c.json.data as { decisionRef: string }).decisionRef;
    const tx = createTenantTransactionRunner(s.db.app);
    const code = await tx(ctxFor(T_ALPHA, USER_A1, 'human'), (t) =>
      t.query(
        `UPDATE cuspatlas.imaging_match_decisions SET subject_patient_id = $2, version = version + 1
         WHERE id = $1`,
        [decisionRef, pTwo],
      ),
    ).then(
      () => 'ok',
      (e: { code?: string }) => e.code,
    );
    expect(code).toBe('42501');
  });
});

describe('SHOULD 6: the consumer read names the patient it expects', () => {
  it('a reference read without expectedPatientRef is refused on REST and MCP', async () => {
    const { objectRef } = await ingestVia(s, next(), { intendedPatientRef: pOne });
    const c = await s.command('owner', `/v1/imaging/objects/${objectRef}/association`, {
      patientRef: pOne,
      basis: 'operatorSelected',
    });
    const imageRef = (c.json.data as { imageRef: string }).imageRef;
    const r = await s.inject('owner', 'GET', `/v1/imaging/image-refs/${imageRef}`);
    expect([r.status, r.json.code]).toStrictEqual([400, 'invalid_request']);
    const m = await s.mcp('owner', 'imaging_image_refs_resolve', { imageRef });
    expect(m.isError).toBe(true);
    const ok = await s.inject(
      'owner',
      'GET',
      `/v1/imaging/image-refs/${imageRef}?expectedPatientRef=${pOne}`,
    );
    expect((ok.json.data as { matchesExpected: boolean }).matchesExpected).toBe(true);
  });
});

describe('NIT: a corrupt content-addressed file is repaired by verified bytes', () => {
  it('the altered object stays quarantined; the same bytes ingested again are stored intact and served', async () => {
    const bytes = next();
    const a = await ingestVia(s, bytes);
    writeFileSync(blobPath(bytes), Buffer.from('altered synthetic bytes'));
    const g = await s.inject('owner', 'POST', `/v1/imaging/objects/${a.objectRef}/read-grants`, {});
    const bad = await s.inject('owner', 'GET', `/v1/imaging/objects/${a.objectRef}/content`, undefined, {
      'x-object-read-token': (g.json.data as { token: string }).token,
    });
    expect([bad.status, reason(bad)]).toStrictEqual([409, 'digest_mismatch']);
    const b = await ingestVia(s, bytes);
    expect(b.status).toBe(201);
    expect(b.objectRef).not.toBe(a.objectRef);
    expect(sha256(readFileSync(blobPath(bytes)))).toBe(sha256(bytes));
    const g2 = await s.inject('owner', 'POST', `/v1/imaging/objects/${b.objectRef}/read-grants`, {});
    const good = await s.inject('owner', 'GET', `/v1/imaging/objects/${b.objectRef}/content`, undefined, {
      'x-object-read-token': (g2.json.data as { token: string }).token,
    });
    expect([good.status, sha256(good.raw)]).toStrictEqual([200, sha256(bytes)]);
    expect(await stateOf(a.objectRef)).toBe('quarantined');
  });
});
