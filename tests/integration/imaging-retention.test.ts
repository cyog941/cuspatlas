import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA } from './support/fixtures';
import {
  attemptReasons,
  type ImagingStack,
  ingestVia,
  pngBytes,
  sha256,
  startImagingStack,
  type Who,
} from './support/imaging-fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * I8 retention, deletion and legal hold (mechanism only; every retention value is
 * recommended-pending-approval and no universal default ships). A deletion under a hold or before the
 * minimum retention is refused with the reason (and the computed earliest date); an executed deletion
 * is a tombstone plus byte removal with audit and provenance retained; derived objects go with the
 * original; a mount keeps a visible missing slot; a restored backup cannot resurrect a deleted object.
 */
let s: ImagingStack;
let pOne: string;
let seed = 500;
const next = () => {
  seed += 1;
  return pngBytes(seed, 6, 6);
};
const reason = (r: { json: Record<string, unknown> }) =>
  (r.json.detail as { reason?: string } | undefined)?.reason;
const blobPath = (bytes: Uint8Array) =>
  join(s.storeRoot, 't', T_ALPHA, 'sha256', sha256(bytes).slice(0, 2), sha256(bytes));

async function associated(bytes = next()) {
  // Named patient at upload: identical bytes for another scope are a separate object (patient-scoped dedupe).
  const { objectRef } = await ingestVia(s, bytes, { intendedPatientRef: pOne });
  const c = await s.command('owner', `/v1/imaging/objects/${objectRef}/association`, {
    patientRef: pOne,
    basis: 'operatorSelected',
  });
  expect(c.status).toBe(201);
  return { objectRef, bytes };
}
const setPolicy = (recordClass: string, months: number) =>
  s.command('owner', '/v1/imaging/retention/policies', {
    recordClass,
    minimumRetentionMonths: months,
    basisCode: 'synthetic_test_policy',
    jurisdictionCode: 'us-synthetic',
  });
const request = (objectRef: string, who: Who = 'owner') =>
  s.command(who, `/v1/imaging/objects/${objectRef}/deletion-requests`, {
    reasonCode: 'requested_by_practice',
  });
const execute = (deletionRef: string, who: Who = 'deleter', key?: string) =>
  s.command(who, `/v1/imaging/deletion-requests/${deletionRef}/execute`, {}, key);

beforeAll(async () => {
  s = await startImagingStack('imaging_retention');
  pOne = (
    (await s.command('owner', '/v1/patients', patientBody('Imaging Retention One'))).json.data as {
      patientRef: string;
    }
  ).patientRef;
});
afterAll(async () => {
  await s?.close();
});

describe('I8 retention policy', () => {
  it('no universal default: without a policy for the record class a deletion is refused', async () => {
    const { objectRef } = await associated();
    const r = await request(objectRef);
    expect([r.status, reason(r)]).toStrictEqual([409, 'retention_policy_missing']);
    expect(await attemptReasons(s.db.admin, r.json.correlationId)).toStrictEqual(['imaging_refused']);
  });

  it('a request before the minimum retention is refused with the computed earliest date; a policy change deletes nothing', async () => {
    const { objectRef } = await associated();
    const count = async () =>
      (
        await s.db.admin.query(
          `SELECT count(*)::int AS n FROM cuspatlas.imaging_objects WHERE state <> 'deleted'`,
        )
      ).rows[0].n;
    const before = await count();
    const p = await setPolicy('associated_original', 120);
    expect([p.status, (p.json.data as { approvalStatus: string }).approvalStatus]).toStrictEqual([
      201,
      'recommended_pending_approval',
    ]);
    expect(await count()).toBe(before);
    const r = await request(objectRef);
    expect([r.status, reason(r)]).toStrictEqual([409, 'minimum_retention_not_met']);
    const earliest = (r.json.detail as { earliestAllowedAt: string }).earliestAllowedAt;
    const received = await s.db.admin.query(
      `SELECT (received_at + interval '120 months') AS e FROM cuspatlas.imaging_objects WHERE id = $1`,
      [objectRef],
    );
    expect(Date.parse(earliest)).toBe((received.rows[0].e as Date).getTime());
    const list = await s.inject('owner', 'GET', '/v1/imaging/retention/policies');
    expect(
      (list.json.data as { recordClass: string; version: number }[]).filter(
        (x) => x.recordClass === 'associated_original',
      ),
    ).toHaveLength(1);
    // A service principal or a non-admin cannot set retention.
    expect(
      (
        await s.command('writer', '/v1/imaging/retention/policies', {
          recordClass: 'derived',
          minimumRetentionMonths: 0,
          basisCode: 'x',
          jurisdictionCode: 'us-synthetic',
        })
      ).status,
    ).toBe(403);
  });
});

describe('I8 legal hold, dual approval and execution', () => {
  it('a hold blocks deletion with the hold as the reason, overrides retention, and its release allows it', async () => {
    await setPolicy('associated_original', 0);
    const { objectRef } = await associated();
    const h = await s.command('owner', '/v1/imaging/legal-holds', {
      subject: { kind: 'patient', ref: pOne },
      reasonCode: 'litigation_hold',
    });
    expect(h.status).toBe(201);
    const holdRef = (h.json.data as { legalHoldRef: string }).legalHoldRef;
    const r = await request(objectRef);
    expect([r.status, reason(r)]).toStrictEqual([409, 'legal_hold_active']);
    expect((r.json.detail as { blockingRefs: unknown[] }).blockingRefs).toStrictEqual([
      { kind: 'imagingLegalHold', ref: holdRef },
    ]);
    // A request made before the hold is refused at execution too, and nothing is half-deleted.
    const rel = await s.command('owner', `/v1/imaging/legal-holds/${holdRef}/release`, {
      reasonCode: 'matter_closed',
    });
    expect(rel.status).toBe(200);
    const ok = await request(objectRef);
    expect(ok.status).toBe(201);
    const deletionRef = (ok.json.data as { deletionRef: string }).deletionRef;
    const objHold = await s.command('owner', '/v1/imaging/legal-holds', {
      subject: { kind: 'object', ref: objectRef },
      reasonCode: 'records_request',
    });
    const blocked = await execute(deletionRef);
    expect([blocked.status, reason(blocked)]).toStrictEqual([409, 'legal_hold_active']);
    const state = await s.db.admin.query('SELECT state FROM cuspatlas.imaging_objects WHERE id = $1', [
      objectRef,
    ]);
    expect(state.rows[0].state).toBe('available');
    const ev = await s.inject('owner', 'GET', `/v1/imaging/deletion-requests/${deletionRef}`);
    expect(ev.json.data).toMatchObject({ state: 'pending', blocked: true, rule: 'legal_hold_active' });
    await s.command(
      'owner',
      `/v1/imaging/legal-holds/${(objHold.json.data as { legalHoldRef: string }).legalHoldRef}/release`,
      {
        reasonCode: 'matter_closed',
      },
    );
    expect((await execute(deletionRef)).status).toBe(200);
  });

  it('an associated image needs a second person to execute; tombstone, bytes removed, audit and provenance kept', async () => {
    const { objectRef, bytes } = await associated();
    const d = await s.command('owner', `/v1/imaging/objects/${objectRef}/derived`, {
      transform: { kind: 'invert' },
    });
    const derivedRef = (d.json.data as { objectRef: string }).objectRef;
    const m = await s.command('owner', '/v1/imaging/mounts', {
      template: 'pa-1',
      slots: [{ slot: 1, objectRef }],
    });
    const mountRef = (m.json.data as { mountRef: string }).mountRef;
    const g = await s.inject('owner', 'POST', `/v1/imaging/objects/${objectRef}/read-grants`, {});
    const token = (g.json.data as { token: string }).token;
    const r = await request(objectRef);
    expect([r.status, (r.json.data as { requiresSecondActor: boolean }).requiresSecondActor]).toStrictEqual([
      201,
      true,
    ]);
    const deletionRef = (r.json.data as { deletionRef: string }).deletionRef;
    const same = await execute(deletionRef, 'owner');
    expect([same.status, reason(same)]).toStrictEqual([409, 'second_approver_required']);
    const key = 'execute-key-1';
    const x = await execute(deletionRef, 'deleter', key);
    expect(x.status).toBe(200);
    expect(x.json.data).toMatchObject({
      deletionRef,
      objectRef,
      state: 'executed',
      deletedObjects: 2,
      bytes: 'removed',
    });
    // The tombstone keeps metadata and provenance; bytes are gone; grants stop working.
    const read = await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}`);
    expect(read.json.data).toMatchObject({ state: 'deleted', digestSha256: sha256(bytes) });
    expect((read.json.data as { provenance: unknown[] }).provenance).toHaveLength(1);
    expect(existsSync(blobPath(bytes))).toBe(false);
    const c = await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}/content`, undefined, {
      'x-object-read-token': token,
    });
    expect(c.status).toBe(403);
    const derived = await s.inject('owner', 'GET', `/v1/imaging/objects/${derivedRef}`);
    expect((derived.json.data as { state: string }).state).toBe('deleted');
    const mount = await s.inject('owner', 'GET', `/v1/imaging/mounts/${mountRef}`);
    expect((mount.json.data as { slots: { state: string }[] }).slots.map((sl) => sl.state)).toStrictEqual([
      'missing',
    ]);
    const audit = await s.db.admin.query(
      `SELECT operation FROM cuspatlas.audit_events WHERE resource_ref = $1 ORDER BY occurred_at`,
      [objectRef],
    );
    expect(audit.rows.map((a) => a.operation)).toContain('imaging.deletions.execute');
    // Replaying, or executing again with another key, reports the same outcome and changes nothing.
    const again = await execute(deletionRef, 'deleter', key);
    expect([again.status, again.json.replayed]).toStrictEqual([200, true]);
    const other = await execute(deletionRef, 'deleter');
    expect(other.json.data).toMatchObject({ state: 'executed', bytes: 'removed' });
  });

  it('a never-associated image may be deleted by its requester; shared bytes of another object are retained', async () => {
    await setPolicy('unassociated_original', 0);
    const bytes = next();
    const loose = await ingestVia(s, bytes);
    const kept = await associated(bytes);
    expect(kept.objectRef).not.toBe(loose.objectRef);
    const r = await request(loose.objectRef);
    expect((r.json.data as { requiresSecondActor: boolean }).requiresSecondActor).toBe(false);
    const x = await execute((r.json.data as { deletionRef: string }).deletionRef, 'owner');
    expect(x.json.data).toMatchObject({ state: 'executed', bytes: 'retained_shared' });
    expect(existsSync(blobPath(bytes))).toBe(true);
    const g = await s.inject('owner', 'POST', `/v1/imaging/objects/${kept.objectRef}/read-grants`, {});
    const c = await s.inject('owner', 'GET', `/v1/imaging/objects/${kept.objectRef}/content`, undefined, {
      'x-object-read-token': (g.json.data as { token: string }).token,
    });
    expect(sha256(c.raw)).toBe(sha256(bytes));
  });

  it('only people with imaging.delete request or execute; another tenant is hidden', async () => {
    const { objectRef } = await associated();
    expect((await request(objectRef, 'writer')).status).toBe(403);
    expect((await request(objectRef, 'service')).status).toBe(403);
    expect((await request(objectRef, 'crossTenant')).status).toBe(404);
    const r = await request(objectRef);
    const ref = (r.json.data as { deletionRef: string }).deletionRef;
    expect((await execute(ref, 'crossTenant')).status).toBe(404);
    expect((await s.inject('crossTenant', 'GET', `/v1/imaging/deletion-requests/${ref}`)).status).toBe(404);
  });
});

describe('I8 MCP parity', () => {
  // The restore interaction is a real drill now: tests/integration/imaging-restore-drill.test.ts (I9).
  it('MCP places and releases holds and evaluates deletions with the same outcomes', async () => {
    const { objectRef } = await associated();
    const h = await s.mcp('owner', 'imaging_legal_holds_place', {
      subject: { kind: 'object', ref: objectRef },
      reasonCode: 'records_request',
      idempotencyKey: 'mcp-hold-1',
    });
    expect(h.isError).toBe(false);
    const r = await s.mcp('owner', 'imaging_deletions_request', {
      objectRef,
      reasonCode: 'requested_by_practice',
      idempotencyKey: 'mcp-del-1',
    });
    expect([r.isError, (r.body.detail as { reason: string }).reason]).toStrictEqual([
      true,
      'legal_hold_active',
    ]);
    const list = await s.mcp('owner', 'imaging_legal_holds_list', {});
    expect(JSON.stringify(list.body)).toContain(objectRef);
  });
});
