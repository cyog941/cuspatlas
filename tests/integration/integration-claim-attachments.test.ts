import { randomUUID } from 'node:crypto';
import { RefusalError } from '@cuspatlas/contracts';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { createFakeClearinghouse, createImagingAttachmentSource } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA } from './support/appointment-fixtures';
import { BILLING_ALL } from './support/billing-fixtures';
import { openTestDatabase } from './support/db';
import { actorFor } from './support/domain-harness';
import { ctxFor, T_BETA, USER_A1, USER_B1 } from './support/fixtures';
import {
  IMG_ALL,
  type ImagingStack,
  ingestVia,
  pngBytes,
  startImagingStack,
} from './support/imaging-fixtures';
import { openRcmHarness, type RcmHarness, today } from './support/rcm-fixtures';

/**
 * Integration seam B CL-04 -> I3 (synthetic data only). A claim attachment names an I3 imageRef; its
 * digest is I3's, read in the package and submit transactions for the claim's patient. Another
 * patient's image, a digest changed between package and submit, and another tenant's image are refused.
 */
let stack: ImagingStack;
let r: RcmHarness;
let svc: ReturnType<RcmHarness['service']>;
const scopes = [...BILLING_ALL, 'patients.read', 'patients.write'];
const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human', scopes);
const env = (operation: string, payload: unknown) => ({ operation, idempotencyKey: randomUUID(), payload });
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof RefusalError
      ? `${err.code}:${(err.detail as { reason?: string } | undefined)?.reason ?? err.reasonCode ?? ''}`
      : `error:${String(err)}`;
  }
};

async function image(patientRef: string, seed: number) {
  const a = await ingestVia(stack, pngBytes(seed, 8, 8), { intendedPatientRef: patientRef });
  const c = await stack.command('owner', `/v1/imaging/objects/${a.objectRef}/association`, {
    patientRef,
    basis: 'operatorSelected',
  });
  expect(c.status).toBe(201);
  const imageRef = (c.json.data as { imageRef: string }).imageRef;
  const { rows } = await stack.db.admin.query<{ digest_sha256: string }>(
    'SELECT digest_sha256 FROM cuspatlas.imaging_objects WHERE id = $1',
    [a.objectRef],
  );
  return { objectRef: a.objectRef, imageRef, digest: rows[0]?.digest_sha256 as string };
}

async function claim(given: string) {
  const patient = await createPatient(r.h, given);
  const coverageRef = r.h.ok<{ data: { coverageRef: string } }>(
    await r.h.call('a1', 'POST', '/v1/rcm/coverages', {
      patientRef: patient,
      payerRef: 'syn-payer-i3-attach',
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: `syn-member-${randomUUID().slice(0, 8)}`,
      effectiveFrom: '2026-01-01',
    }),
    201,
  ).data.coverageRef;
  r.h.ok(
    await r.h.call('a1', 'POST', `/v1/rcm/coverages/${coverageRef}/eligibility`, {
      source: 'fake_adapter',
      serviceDate: today(),
    }),
    201,
  );
  const proc = await r.render(await r.encounter(patient), 'SYN-I3A-100');
  r.h.ok(await r.consume(proc));
  const claimRef = (
    await svc.prepareClaim(
      a1(),
      env('rcm.claims.prepare', { patientRef: patient, coverageRef, procedureRefs: [proc] }),
    )
  ).data.claimRef;
  return { patient, claimRef };
}

async function attach(claimRef: string, objectRef: string) {
  await svc.attachToClaim(
    a1(),
    claimRef,
    env('rcm.claims.attach', { expectedVersion: 1, objectRef, kind: 'radiograph' }),
  );
  await svc.validateClaim(a1(), claimRef, env('rcm.claims.validate', { expectedVersion: 2 }));
}
const pkg = (claimRef: string, items: { objectRef: string; digest: string }[]) =>
  svc.packageClaimAttachments(
    a1(),
    claimRef,
    env('rcm.claims.packageAttachments', { expectedVersion: 3, items }),
  );
const submit = (claimRef: string, expectedVersion: number) =>
  svc.submitClaim(
    a1(),
    claimRef,
    env('rcm.claims.submit', { expectedVersion, authorization: { mode: 'explicit' } }),
  );

beforeAll(async () => {
  // The RCM harness seeds tenancy; the imaging stack then runs over the same database unseeded.
  const db = await openTestDatabase('integration_claim_attachments');
  r = await openRcmHarness(db);
  // The owner (USER_A1) also ingests and associates images (the imaging scopes, appended).
  await db.admin.query(
    'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
    [USER_A1, IMG_ALL],
  );
  stack = await startImagingStack('integration_claim_attachments', { database: db, seed: false });
  svc = r.service({ claims: createFakeClearinghouse(), attachments: createImagingAttachmentSource() });
  await r.publishFee('syn-fee-i3-attach', [['SYN-I3A-100', 20000]]);
}, 180_000);

afterAll(async () => {
  await r?.h.close();
  await stack?.close();
});

describe('B CL-04 -> I3 claim attachments', () => {
  it('packages and submits a real I3 image of the claim patient with I3`s digest', async () => {
    const c = await claim('Synthetic I3 Attach Happy');
    const img = await image(c.patient, 9301);
    await attach(c.claimRef, img.imageRef);
    expect(await refusal(pkg(c.claimRef, [{ objectRef: img.imageRef, digest: 'a'.repeat(64) }]))).toBe(
      'validation_failed:attachment_digest_mismatch',
    );
    expect((await pkg(c.claimRef, [{ objectRef: img.imageRef, digest: img.digest }])).data.outcome).toBe(
      'packaged',
    );
    await svc.validateClaim(a1(), c.claimRef, env('rcm.claims.validate', { expectedVersion: 4 }));
    expect(await refusal(submit(c.claimRef, 5))).toBe('ok');
  });

  it('refuses another patient`s image even with its true digest', async () => {
    const c = await claim('Synthetic I3 Attach Wrong');
    const other = await createPatient(r.h, 'Synthetic I3 Attach Other');
    const img = await image(other, 9302);
    await attach(c.claimRef, img.imageRef);
    expect(await refusal(pkg(c.claimRef, [{ objectRef: img.imageRef, digest: img.digest }]))).toBe(
      'validation_failed:attachment_digest_mismatch',
    );
  });

  it('refuses dispatch when I3`s digest changed between package and submit', async () => {
    const c = await claim('Synthetic I3 Attach Tamper');
    const img = await image(c.patient, 9303);
    await attach(c.claimRef, img.imageRef);
    expect((await pkg(c.claimRef, [{ objectRef: img.imageRef, digest: img.digest }])).data.outcome).toBe(
      'packaged',
    );
    await svc.validateClaim(a1(), c.claimRef, env('rcm.claims.validate', { expectedVersion: 4 }));
    // The object I3 holds changes (synthetic tamper as the owner, triggers off): its digest moves.
    const admin = await stack.db.admin.connect();
    try {
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role = 'replica'");
      await admin.query(
        `UPDATE cuspatlas.imaging_objects SET digest_sha256 = $2,
           storage_key = 't/' || tenant_id::text || '/sha256/' || substr($2, 1, 2) || '/' || $2 WHERE id = $1`,
        [img.objectRef, 'b'.repeat(64)],
      );
      await admin.query('COMMIT');
    } catch (err) {
      await admin.query('ROLLBACK');
      throw err;
    } finally {
      admin.release();
    }
    expect(await refusal(submit(c.claimRef, 5))).toBe('conflict:attachment_package_stale');
    const { rows } = await stack.db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.rcm_claim_submissions WHERE claim_id = $1',
      [c.claimRef],
    );
    expect(rows[0].n).toBe(0);
  });

  it('another tenant reads no digest for the image (tenant transaction, RLS)', async () => {
    const p = await createPatient(r.h, 'Synthetic I3 Attach Tenancy');
    const img = await image(p, 9304);
    const source = createImagingAttachmentSource();
    const run = createTenantTransactionRunner(stack.db.app);
    const alpha = await actorFor(stack.db, USER_A1, T_ALPHA);
    const beta = await actorFor(stack.db, USER_B1, T_BETA);
    expect(await run(alpha, (tx) => source.digestOf(tx, img.imageRef, p))).toBe(img.digest);
    expect(await run(beta, (tx) => source.digestOf(tx, img.imageRef, p))).toBeNull();
    expect(await run(alpha, (tx) => source.digestOf(tx, randomUUID(), p))).toBeNull();
    expect(await run(alpha, (tx) => source.digestOf(tx, 'syn-img-not-i3', p))).toBeNull();
  });
});
