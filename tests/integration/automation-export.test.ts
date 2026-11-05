import { randomUUID } from 'node:crypto';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  ACTION_POLICIES,
  createAuthorize,
  createAutomationService,
  documentDigest,
  EXPORT_FORMAT,
  executeOnce,
  filterPatientDocuments,
  PATIENT_EXPORT_LINKAGE,
  PRACTICE_EXPORT_FORMAT,
  type PracticeExporters,
  validateScopedExport,
} from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBillingScopes } from './support/billing-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { actorFor } from './support/domain-harness';
import { seedEngagementScopes } from './support/engagement-fixtures';
import { createAndBuild, EXPORT_WORKER, exportWorker } from './support/export-jobs';
import { T_ALPHA, USER_A1, USER_A4, USER_B1 } from './support/fixtures';
import { type ImagingStack, ingestVia, pngBytes, startImagingStack } from './support/imaging-fixtures';
import { seedMigrationScopes } from './support/migration-fixtures';
import { patientBody } from './support/patient-fixtures';
import { seedSchedulingScopes } from './support/scheduling-fixtures';

/**
 * A15 export surface (synthetic only; A-D8 recommended-pending-approval). `exports.*` sits over the M1
 * practice export for the whole tenant and adds patient (right of access across S, I, C, E and B) and
 * single-domain scopes, all in one versioned machine-readable format with a completeness validator,
 * human-only elevated creation under the ordinary `exports.create` scope (no licence, plan or feature
 * key), private short-lived delivery through I1-style grants, and a job audit.
 */
type Doc = { format: string; tables: Record<string, Record<string, unknown>[]>; blobs?: unknown[] };
type Pkg = {
  manifest: Record<string, unknown> & { documents: { format: string; digestSha256: string }[] };
  documents: Doc[];
};
let s: ImagingStack;
let p1: string;
let p2: string;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
type Req = {
  exportRef: string;
  state: string;
  scope: string;
  artifactFormat: string | null;
  diagnostic: string | null;
};

async function createExport(
  body: Record<string, unknown>,
  who: Parameters<ImagingStack['command']>[0] = 'owner',
) {
  // Closeout C: the build is a worker job; the helper runs it and returns the polled request.
  return createAndBuild(s, who, {
    formatVersion: 'cuspatlas-export/1',
    purpose: 'rightOfAccess',
    ...body,
  });
}
async function download(exportRef: string): Promise<Pkg> {
  const g = await s.command('owner', '/v1/exports/grants', { exportRef });
  expect([g.status, g.body.slice(0, 200)]).toStrictEqual([200, g.body.slice(0, 200)]);
  const d = await s.command('owner', '/v1/exports/package', {
    exportRef,
    token: data<{ token: string }>(g).token,
  });
  expect([d.status, d.body.slice(0, 200)]).toStrictEqual([200, d.body.slice(0, 200)]);
  return data<Pkg>(d);
}
async function setScopes(principal: string, add: string[], remove: string[] = []) {
  await s.db.admin.query(
    `UPDATE cuspatlas.memberships SET scopes = ARRAY(SELECT DISTINCT x FROM unnest(scopes || $2::text[]) x
       WHERE NOT x = ANY($3::text[])) WHERE principal_id = $1`,
    [principal, add, remove],
  );
}

beforeAll(async () => {
  s = await startImagingStack('automation_export');
  await seedSchedulingScopes(s.db.admin);
  await seedClinicalScopes(s.db.admin);
  await seedEngagementScopes(s.db.admin);
  await seedBillingScopes(s.db.admin);
  await seedMigrationScopes(s.db.admin);
  await setScopes(USER_A1, ['exports.create', 'exports.read', 'admin.configure']);
  await setScopes(USER_B1, ['exports.create', 'exports.read', 'admin.configure']);
  await exportWorker(s);
  for (const [name, seed] of [
    ['Export Subjectone', 9401],
    ['Export Othertwo', 9402],
  ] as const) {
    const ref = data<{ patientRef: string }>(
      await s.command('owner', '/v1/patients', patientBody(name)),
    ).patientRef;
    const a = await ingestVia(s, pngBytes(seed, 8, 8), { intendedPatientRef: ref });
    expect(
      (
        await s.command('owner', `/v1/imaging/objects/${a.objectRef}/association`, {
          patientRef: ref,
          basis: 'operatorSelected',
        })
      ).status,
    ).toBe(201);
    if (seed === 9401) p1 = ref;
    else p2 = ref;
  }
}, 240_000);
afterAll(async () => {
  await s?.close();
});

describe('A15 export surface', () => {
  it('a patient export round-trips: complete, verifiable from its digests, only that patient', async () => {
    const r = await createExport({ scope: 'patient', subjectRef: p1 });
    expect([r.status, r.body.slice(0, 300)]).toStrictEqual([201, r.body.slice(0, 300)]);
    const req = data<Req>(r);
    expect(req).toMatchObject({
      state: 'ready',
      scope: 'patient',
      artifactFormat: EXPORT_FORMAT,
      diagnostic: null,
    });
    const pkg = await download(req.exportRef);
    expect(pkg.manifest).toMatchObject({
      format: EXPORT_FORMAT,
      exportRef: req.exportRef,
      scope: { kind: 'patient', subjectRef: p1 },
      licenceGate: 'none',
    });
    expect(validateScopedExport(pkg, { subjectRef: p1 })).toStrictEqual({ accepted: true, warnings: [] });
    for (const [i, d] of pkg.documents.entries())
      expect(documentDigest(d as never)).toBe(pkg.manifest.documents[i]?.digestSha256);
    expect(pkg.documents.map((d) => d.format)).toHaveLength(5);
    const patients = pkg.documents[0]?.tables.patients ?? [];
    expect(patients.map((p) => p.id)).toStrictEqual([p1]);
    const objects = pkg.documents[1]?.tables.imaging_objects ?? [];
    expect(objects.length).toBe(1);
    expect(objects.every((o) => Object.entries(o).some(([k, v]) => /patient_id$/.test(k) && v === p1))).toBe(
      true,
    );
    const text = JSON.stringify(pkg);
    expect(text).not.toContain(p2);
    expect(text).not.toContain('Othertwo');
    expect(text).not.toContain(T_ALPHA);
    // Job audit: requested and completed transitions, and a sensitive read.
    const audit = await s.db.admin.query(
      `SELECT resource_version FROM cuspatlas.audit_events WHERE resource_ref = $1 AND operation = 'exports.create'
       ORDER BY resource_version`,
      [req.exportRef],
    );
    expect(audit.rows.map((x) => x.resource_version)).toStrictEqual([1, 2]);
  });

  it('a truncated or foreign-patient package fails its own completeness check', async () => {
    const r = await createExport({ scope: 'patient', subjectRef: p1 });
    const pkg = await download(data<Req>(r).exportRef);
    const [first, ...rest] = pkg.documents as [Doc, ...Doc[]];
    const { patients: _drop, ...without } = first.tables;
    expect(
      validateScopedExport(
        { ...pkg, documents: [{ ...first, tables: without }, ...rest] },
        { subjectRef: p1 },
      ),
    ).toMatchObject({ accepted: false, reason: 'missing_entity' });
    const shorter = { ...first, tables: { ...first.tables, patients: [] } };
    expect(validateScopedExport({ ...pkg, documents: [shorter, ...rest] }, { subjectRef: p1 })).toMatchObject(
      {
        accepted: false,
        reason: 'count_mismatch',
      },
    );
    expect(validateScopedExport(pkg, { subjectRef: p2 })).toMatchObject({
      accepted: false,
      reason: 'foreign_patient',
    });
    expect(
      validateScopedExport({ ...pkg, manifest: { ...pkg.manifest, format: 'cuspatlas-export/9' } }),
    ).toMatchObject({
      accepted: false,
      reason: 'unknown_version',
    });
  });

  it('a build whose module export drops a table fails with a diagnostic and is never delivered', async () => {
    const real = (await import('@cuspatlas/domain')).createAutomationService;
    expect(real).toBe(createAutomationService);
    const owner = await actorFor(s.db, USER_A1, T_ALPHA);
    const drop: PracticeExporters['scheduling'] = async () => ({
      format: 'cuspatlas-scheduling-export/1',
      exportedAt: new Date().toISOString(),
      tables: {},
    });
    const svc = createAutomationService({
      env: 'synthetic-test',
      authorize: createAuthorize(createMembershipSource(s.db.app)),
      withTenantTransaction: createTenantTransactionRunner(s.db.app),
      recording: { sink: createSecurityAttemptSink(s.db.sink), alert: () => undefined },
      execute: executeOnce,
      exports: {
        exporters: { scheduling: drop, imaging: drop, clinical: drop, engagement: drop, billing: drop },
        objectStore: s.store,
        tokenSecret: new Uint8Array(32).fill(5),
        memberships: createMembershipSource(s.db.app),
      },
    });
    const created = await svc.createExport(owner, {
      operation: 'exports.create',
      idempotencyKey: randomUUID(),
      payload: {
        scope: 'domain',
        domain: 'scheduling',
        formatVersion: 'cuspatlas-export/1',
        purpose: 'integration',
      },
    });
    expect(created.data.state).toBe('building');
    // Closeout C: the build job (as the worker) builds it as the requester and fails it.
    await svc.runExportBuilds(await actorFor(s.db, EXPORT_WORKER, T_ALPHA), {
      operation: 'exports.build',
      idempotencyKey: randomUUID(),
      payload: {},
    });
    const r = await svc.readExport(owner, { exportRef: created.data.exportRef });
    expect(r.data).toMatchObject({ state: 'failed', diagnostic: 'missing_entity', packageDigest: null });
    const g = await s.command('owner', '/v1/exports/grants', { exportRef: r.data.exportRef });
    expect([g.status, (g.json.detail as { reason?: string })?.reason]).toStrictEqual([
      409,
      'export_not_ready',
    ]);
  });

  it('a domain export carries exactly that domain document; a practice export is the M1 package', async () => {
    const d = await createExport({ scope: 'domain', domain: 'imaging', purpose: 'integration' });
    expect(d.status).toBe(201);
    const pkg = await download(data<Req>(d).exportRef);
    expect(pkg.documents.map((x) => x.format)).toStrictEqual(['cuspatlas-imaging-export/1']);
    expect(validateScopedExport(pkg)).toStrictEqual({ accepted: true, warnings: [] });
    const p = await createExport({ scope: 'practice', purpose: 'practiceExit' });
    expect([p.status, p.body.slice(0, 300)]).toStrictEqual([201, p.body.slice(0, 300)]);
    expect(data<Req>(p)).toMatchObject({ state: 'ready', artifactFormat: PRACTICE_EXPORT_FORMAT });
    const whole = await download(data<Req>(p).exportRef);
    expect(whole.manifest.format).toBe(PRACTICE_EXPORT_FORMAT);
    expect(whole.documents).toHaveLength(5);
  });

  it('refuses another tenant patient exactly like a missing one, and hides requests across tenants', async () => {
    const other = await createExport({ scope: 'patient', subjectRef: p1 }, 'crossTenant');
    const missing = await createExport({ scope: 'patient', subjectRef: randomUUID() }, 'crossTenant');
    expect([other.status, missing.status]).toStrictEqual([404, 404]);
    expect(other.json.code).toBe(missing.json.code);
    const mine = data<Req>(
      await createExport({ scope: 'domain', domain: 'clinical', purpose: 'integration' }),
    );
    const read = await s.inject('crossTenant', 'GET', `/v1/exports/request?exportRef=${mine.exportRef}`);
    expect(read.status).toBe(404);
    const list = await s.inject('crossTenant', 'GET', '/v1/exports');
    expect(list.status).toBe(200);
    expect(list.body).not.toContain(mine.exportRef);
    const own = await s.inject('owner', 'GET', `/v1/exports/request?exportRef=${mine.exportRef}`);
    expect(own.status).toBe(200);
    expect(data<{ manifest: { format: string } }>(own).manifest.format).toBe(EXPORT_FORMAT);
  });

  it('delivery is private and short-lived: bound to the caller, expired grants refused, access revoked refused', async () => {
    const req = data<Req>(await createExport({ scope: 'patient', subjectRef: p2 }));
    const g = await s.command('owner', '/v1/exports/grants', { exportRef: req.exportRef });
    const token = data<{ token: string; grantRef: string }>(g);
    const foreign = await s.command('crossTenant', '/v1/exports/package', {
      exportRef: req.exportRef,
      token: token.token,
    });
    expect(foreign.status).toBe(404);
    await s.db.admin.query(
      `UPDATE cuspatlas.export_grants SET created_at = now() - interval '10 minutes',
         expires_at = now() - interval '9 minutes' WHERE id = $1`,
      [token.grantRef],
    );
    const expired = await s.command('owner', '/v1/exports/package', {
      exportRef: req.exportRef,
      token: token.token,
    });
    expect(expired.status).toBe(404);
    const g2 = data<{ token: string }>(
      await s.command('owner', '/v1/exports/grants', { exportRef: req.exportRef }),
    );
    await setScopes(USER_A1, [], ['exports.create']);
    const revoked = await s.command('owner', '/v1/exports/package', {
      exportRef: req.exportRef,
      token: g2.token,
    });
    expect(revoked.status).toBe(403);
    await setScopes(USER_A1, ['exports.create']);
  });

  it('an unknown format version or inconsistent scope is refused; the path has no licence gate', async () => {
    expect(
      (await createExport({ scope: 'domain', domain: 'billing', formatVersion: 'cuspatlas-export/2' }))
        .status,
    ).toBe(400);
    expect((await createExport({ scope: 'patient' })).status).toBe(422);
    expect((await createExport({ scope: 'practice', purpose: 'rightOfAccess' })).status).toBe(422);
    expect(ACTION_POLICIES['exports.create']).toStrictEqual({
      scope: 'exports.create',
      principals: ['human'],
    });
    const svc = await s.command('service', '/v1/exports', {
      scope: 'domain',
      domain: 'billing',
      formatVersion: 'cuspatlas-export/1',
      purpose: 'integration',
    });
    expect(svc.status).toBe(403);
  });
});

describe('A15 hardening: requester-bound delivery, re-authorization, linkage map, job state', () => {
  const grantFor = async (who: Parameters<ImagingStack['command']>[0], exportRef: string) =>
    s.command(who, '/v1/exports/grants', { exportRef });
  const readAs = (who: Parameters<ImagingStack['inject']>[0], exportRef: string) =>
    s.inject(who, 'GET', `/v1/exports/request?exportRef=${exportRef}`);

  it('the patient filter follows the declared linkage map: a shared thread of another patient stays out', () => {
    const [P1, P2, REL, T2, LOC] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const docs = [
      {
        format: 'x',
        exportedAt: '2026-11-05T00:00:00.000Z',
        tables: {
          patients: [{ id: P1 }, { id: P2 }],
          patient_relationships: [{ id: REL, subject_patient_id: P1, counterparty_patient_id: P2 }],
          message_threads: [{ id: T2, patient_id: P2 }],
          thread_messages: [{ id: randomUUID(), thread_id: T2, via_relationship_id: REL }],
          scheduling_locations: [{ id: LOC, default_relationship_id: REL }],
          unlisted_table: [{ id: randomUUID(), owner_id: P1 }],
        },
      },
    ];
    const [out] = filterPatientDocuments(docs as never, P1) as unknown as Doc[];
    expect(out?.tables.patients).toStrictEqual([{ id: P1 }]);
    expect(out?.tables.patient_relationships?.length).toBe(1);
    expect(out?.tables.message_threads).toStrictEqual([]);
    expect(out?.tables.thread_messages).toStrictEqual([]);
    expect(out?.tables.scheduling_locations).toStrictEqual([]);
    expect(out?.tables.unlisted_table).toStrictEqual([]);
    expect(PATIENT_EXPORT_LINKAGE.thread_messages).toBeDefined();
  });

  it('a patient export records patient-scoped reads naming the subject, not tenant-wide module reads', async () => {
    const moduleRows = async () =>
      Number(
        (
          await s.db.admin.query<{ n: string }>(
            `SELECT count(*) AS n FROM cuspatlas.sensitive_read_events WHERE resource_type IN
               ('schedulingExport', 'imagingExport', 'clinicalExport', 'engagementExport', 'billingExport')`,
          )
        ).rows[0]?.n,
      );
    const before = await moduleRows();
    const req = data<Req>(await createExport({ scope: 'patient', subjectRef: p1 }));
    expect(req.state).toBe('ready');
    expect(await moduleRows()).toBe(before);
    const { rows } = await s.db.admin.query<{ resource_type: string; resource_refs: string[] }>(
      `SELECT resource_type, resource_refs FROM cuspatlas.sensitive_read_events WHERE $1 = ANY (resource_refs)`,
      [req.exportRef],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.resource_refs).toContain(p1);
  });

  it('only the requester reads, grants and downloads; an export administrator is recorded', async () => {
    await setScopes(USER_A4, ['exports.create', 'exports.read', 'admin.configure']);
    try {
      const req = data<Req>(
        await createExport({ scope: 'domain', domain: 'scheduling', purpose: 'integration' }),
      );
      expect(req.state).toBe('ready');
      expect((await readAs('imagingReadOnly', req.exportRef)).status).toBe(404);
      expect((await grantFor('imagingReadOnly', req.exportRef)).status).toBe(404);
      const list = await s.inject('imagingReadOnly', 'GET', '/v1/exports');
      expect(list.status).toBe(200);
      expect((list.json.data as Req[]).some((x) => x.exportRef === req.exportRef)).toBe(false);
      await setScopes(USER_A4, ['exports.admin']);
      const g = await grantFor('imagingReadOnly', req.exportRef);
      expect([g.status, g.body.slice(0, 200)]).toStrictEqual([200, g.body.slice(0, 200)]);
      const d = await s.command('imagingReadOnly', '/v1/exports/package', {
        exportRef: req.exportRef,
        token: data<{ token: string }>(g).token,
      });
      expect(d.status).toBe(200);
      const { rows } = await s.db.admin.query(
        `SELECT 1 FROM cuspatlas.sensitive_read_events WHERE resource_type = 'exportAdminAccess'
           AND actor_id = $1 AND $2 = ANY (resource_refs)`,
        [USER_A4, req.exportRef],
      );
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await setScopes(USER_A4, [], ['exports.create', 'exports.read', 'exports.admin', 'admin.configure']);
    }
  });

  it('narrowed module access blocks grant and download; a revoked grant no longer downloads', async () => {
    const req = data<Req>(await createExport({ scope: 'patient', subjectRef: p1 }));
    const g = data<{ token: string; grantRef: string }>(await grantFor('owner', req.exportRef));
    await setScopes(USER_A1, [], ['admin.configure']);
    try {
      expect((await grantFor('owner', req.exportRef)).status).toBe(403);
      const d = await s.command('owner', '/v1/exports/package', { exportRef: req.exportRef, token: g.token });
      expect(d.status).toBe(403);
    } finally {
      await setScopes(USER_A1, ['admin.configure']);
    }
    const rv = await s.command('owner', '/v1/exports/grants/revoke', { grantRef: g.grantRef });
    expect([rv.status, rv.body.slice(0, 200)]).toStrictEqual([200, rv.body.slice(0, 200)]);
    const after = await s.command('owner', '/v1/exports/package', {
      exportRef: req.exportRef,
      token: g.token,
    });
    expect(after.status).toBe(404);
  });

  it('a replay returns the current state; a stale build fails instead of staying stuck; inline size is capped', async () => {
    const key = randomUUID();
    const body = {
      scope: 'domain',
      domain: 'imaging',
      formatVersion: 'cuspatlas-export/1',
      purpose: 'integration',
    };
    const first = await createAndBuild(s, 'owner', body, key);
    expect(data<Req>(first).state).toBe('ready');
    const replay = await s.command('owner', '/v1/exports', body, key);
    expect(data<Req>(replay)).toMatchObject({ exportRef: data<Req>(first).exportRef, state: 'ready' });
    // A crashed build (still building past the deadline) is failed, never stuck.
    const stuck = data<Req>(
      await createExport({ scope: 'domain', domain: 'billing', purpose: 'integration' }),
    );
    await s.db.admin.query(
      `UPDATE cuspatlas.export_requests SET state = 'building', artifact_format = NULL, package_digest = NULL,
         build_attempt = 1, build_leased_until = now() - interval '2 hours' WHERE id = $1`,
      [stuck.exportRef],
    );
    const seen = await readAs('owner', stuck.exportRef);
    expect(data<Req>(seen)).toMatchObject({ state: 'failed', diagnostic: 'build_interrupted' });
    // Inline delivery is capped: a package over the limit is refused with a typed reason.
    const big = data<Req>(
      await createExport({ scope: 'domain', domain: 'clinical', purpose: 'integration' }),
    );
    await s.db.admin.query('UPDATE cuspatlas.export_requests SET byte_length = $2 WHERE id = $1', [
      big.exportRef,
      10 ** 12,
    ]);
    const g = data<{ token: string }>(await grantFor('owner', big.exportRef));
    const d = await s.command('owner', '/v1/exports/package', { exportRef: big.exportRef, token: g.token });
    expect([d.status, (d.json.detail as { reason?: string })?.reason]).toStrictEqual([
      409,
      'package_exceeds_inline_limit',
    ]);
  });
});
