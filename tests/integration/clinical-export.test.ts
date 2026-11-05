import { randomUUID } from 'node:crypto';
import { CLINICAL_EXPORT_FORMAT, CLINICAL_EXPORT_TABLES, validateClinicalExport } from '@cuspatlas/contracts';
import {
  IMPORT_ORDER,
  importClinicalExport as importClinical,
  importExports,
  importSchedulingExport,
} from '@cuspatlas/db';
import { verifyImportedNoteDigests } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  USER_B1,
} from './support/appointment-fixtures';
import {
  CLINICAL_RW,
  seedClinicalScopes,
  seedPerioConfiguration,
  USER_A7,
} from './support/clinical-fixtures';
import { buildClinicalRecord } from './support/clinical-record-fixture';
import { openTestDatabase, type TestDatabase } from './support/db';
import { seedEngagementScopes } from './support/engagement-fixtures';
import { fakeImageResolver } from './support/image-ref-resolver';
import { seedNoteScopes } from './support/note-fixtures';

/**
 * C18 clinical export (synthetic; the full export contract, manifest and completeness validation are
 * M1's): a versioned JSON export of every workstream C record of the tenant, produced by the domain
 * under the runtime role (rows without a tenant field, foreign-key order, references preserved),
 * including correction chains, consent and withdrawal, and note versions with their digests. It is
 * re-imported, after the S17 scheduling export it depends on, into a fresh synthetic database with
 * every foreign key validated, exported again identically, and the signed digests verify there.
 * No licensed terminology appears: every code is a provisional SYN- code.
 */
let source: TestDatabase;
let target: TestDatabase;
let h: AppointmentHarness;
let t: AppointmentHarness;
const images = fakeImageResolver();
let rec: Awaited<ReturnType<typeof buildClinicalRecord>>;
const importClinicalExport = (pool: Parameters<typeof importClinical>[0], tenant: string, doc: never) =>
  importClinical(pool, tenant, doc, verifyImportedNoteDigests);
type Doc = { format: string; exportedAt: string; tables: Record<string, Record<string, unknown>[]> };

beforeAll(async () => {
  source = await openTestDatabase('clinical_export_source');
  h = await openAppointmentHarness(source, { mcp: true, imageRefResolver: images });
  await seedClinicalScopes(source.admin);
  await seedNoteScopes(source.admin);
  await seedEngagementScopes(source.admin);
  await seedPerioConfiguration(source.admin, T_ALPHA);
  await source.admin.query(
    `INSERT INTO cuspatlas.clinical_referral_policies (tenant_id, disclosure_consent_template_ref)
     VALUES ($1, 'synthetic-disclosure-consent')`,
    [T_ALPHA],
  );
  const loc = await seedLocation(h, 'loc-clinical-export');
  rec = await buildClinicalRecord(h, loc, images, 'Synthetic Export Record');
  target = await openTestDatabase('clinical_export_target');
  t = await openAppointmentHarness(target, { imageRefResolver: images });
  await seedEngagementScopes(target.admin);
});

afterAll(async () => {
  await t?.close();
  await h?.close();
  await target?.close();
  await source?.close();
});

const exportOf = async (harness: AppointmentHarness) => {
  const json = harness.ok<{ data: Doc }>(await harness.call('a1', 'GET', '/v1/clinical/export'));
  expect(validateClinicalExport(json)).toBe(true);
  return json.data;
};
const schedulingOf = async (harness: AppointmentHarness) =>
  harness.ok<{ data: Doc }>(await harness.call('a1', 'GET', '/v1/scheduling/export')).data;
/** E9: S intents reference E suppression decisions, so the S17 document never imports without it. */
const engagementOf = async (harness: AppointmentHarness) =>
  harness.ok<{ data: Doc }>(await harness.call('a1', 'GET', '/v1/communications/export')).data;
const codesIn = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) for (const x of v) codesIn(x, out);
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (/code_refs?$|^code_ref$|finding_ref$/.test(k))
        out.push(...(Array.isArray(x) ? x : [x]).filter((c) => c !== null));
      else codesIn(x, out);
    }
  }
  return out;
};

/** Principals and memberships are tenancy (A's records, exported by neither S nor C): the target
 * receives the same synthetic members as the source before the clinical import. */
async function copyTenancy(into: TestDatabase) {
  for (const p of (await source.admin.query('SELECT id, kind, handle FROM cuspatlas.principals')).rows) {
    await into.admin.query(
      'INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [p.id, p.kind, p.handle],
    );
  }
  for (const m of (
    await source.admin.query(
      'SELECT principal_id, scopes, location_refs, revoked_at FROM cuspatlas.memberships WHERE tenant_id = $1',
      [T_ALPHA],
    )
  ).rows) {
    await into.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes, location_refs, revoked_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, principal_id) DO UPDATE SET scopes = EXCLUDED.scopes`,
      [T_ALPHA, m.principal_id, m.scopes, m.location_refs, m.revoked_at],
    );
  }
}

describe('C18 clinical export round trip', () => {
  it('exports every C record class, versioned, with references, chains, consent history and digests; no tenant field', async () => {
    const doc = await exportOf(h);
    expect(doc.format).toBe(CLINICAL_EXPORT_FORMAT);
    expect(Object.keys(doc.tables)).toStrictEqual([...CLINICAL_EXPORT_TABLES]);
    expect(JSON.stringify(doc)).not.toContain('tenant_id');
    const ids = (table: string) => doc.tables[table]?.map((r) => r.id) ?? [];
    for (const ref of [rec.proc, rec.other]) expect(ids('clinical_rendered_procedures')).toContain(ref);
    const reversal = doc.tables.clinical_rendered_procedures?.find(
      (r) => r.reverses_procedure_id === rec.other,
    );
    const replacement = doc.tables.clinical_rendered_procedures?.find(
      (r) => r.replaces_procedure_id === rec.other,
    );
    expect([reversal?.kind, replacement?.kind]).toStrictEqual(['reversal', 'rendered']);
    expect(doc.tables.clinical_consent_withdrawals?.map((w) => w.consent_id)).toContain(rec.withdrawn);
    const versions = doc.tables.clinical_note_versions?.filter((v) => v.note_id === rec.note) ?? [];
    expect(versions.length).toBe(1);
    expect(String(versions[0]?.content_digest)).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const ref of [rec.imageLink]) expect(ids('clinical_encounter_image_links')).toContain(ref);
    expect(ids('clinical_lab_cases')).toContain(rec.lab);
    expect(ids('clinical_referrals')).toContain(rec.referral);
    // No licensed terminology: every code in the export is a provisional synthetic code.
    const codes = codesIn(doc.tables);
    expect(codes.length).toBeGreaterThan(3);
    expect(codes.filter((c) => !/^SYN-[A-Z0-9-]+$/.test(String(c)))).toStrictEqual([]);
    // REST and MCP agree.
    const m = await h.mcp('a1', 'clinical_export', {});
    const mDoc = (m.body as { data: Doc }).data;
    expect({ ...mDoc, exportedAt: null }).toStrictEqual({ ...doc, exportedAt: null });
  });

  it('re-imports into a fresh synthetic database with every foreign key validated and exports identically', async () => {
    const sched = await schedulingOf(h);
    const doc = await exportOf(h);
    await importSchedulingExport(target.admin, T_ALPHA, sched as never, [(await engagementOf(h)) as never]);
    await copyTenancy(target);
    const counts = await importClinicalExport(target.admin, T_ALPHA, doc as never);
    expect(counts.clinical_encounters).toBe(doc.tables.clinical_encounters?.length);
    const again = await exportOf(t);
    expect({ ...again, exportedAt: null }).toStrictEqual({ ...doc, exportedAt: null });
    // Signed content verifies in the target; references resolve through the domain there.
    const note = t.ok<{ data: { versions: { digestVerified: boolean }[] } }>(
      await t.call('a1', 'GET', `/v1/clinical/notes/${rec.note}`),
    ).data;
    expect(note.versions.map((v) => v.digestVerified)).toStrictEqual([true]);
    const lab = t.ok<{ data: { labCaseRef: string; patientRef: string } }>(
      await t.call('a1', 'GET', `/v1/clinical/lab-cases/${rec.lab}`),
    ).data;
    expect(lab).toMatchObject({ labCaseRef: rec.lab, patientRef: rec.patientRef });
  });

  it('an export with an orphan reference is refused whole; an unknown format or table is refused', {
    timeout: 180_000,
  }, async () => {
    const fresh = await openTestDatabase('clinical_export_orphan');
    try {
      const doc = await exportOf(h);
      const sched = await schedulingOf(h);
      const fh = await openAppointmentHarness(fresh);
      try {
        await importSchedulingExport(fresh.admin, T_ALPHA, sched as never, [
          (await engagementOf(h)) as never,
        ]);
        await copyTenancy(fresh);
        const tampered: Doc = {
          ...doc,
          tables: {
            ...doc.tables,
            clinical_lab_cases: (doc.tables.clinical_lab_cases ?? []).map((r, i) =>
              i === 0 ? { ...r, plan_detail_id: randomUUID() } : r,
            ),
          },
        };
        await expect(importClinicalExport(fresh.admin, T_ALPHA, tampered as never)).rejects.toThrow(
          /foreign key/,
        );
        const { rows } = await fresh.admin.query(
          'SELECT count(*)::int AS n FROM cuspatlas.clinical_encounters',
        );
        expect(rows[0].n).toBe(0);
        await expect(
          importClinicalExport(fresh.admin, T_ALPHA, {
            ...doc,
            format: 'cuspatlas-clinical-export/0',
          } as never),
        ).rejects.toThrow(/format/);
        await expect(
          importClinicalExport(fresh.admin, T_ALPHA, {
            ...doc,
            tables: { ...doc.tables, patients: [] },
          } as never),
        ).rejects.toThrow(/Unknown table/);
      } finally {
        await fh.close();
      }
    } finally {
      await fresh.close();
    }
  });

  it('a tampered digest, estimate sum or acceptance, or a foreign-tenant parent, rolls the whole import back', {
    timeout: 240_000,
  }, async () => {
    const fresh = await openTestDatabase('clinical_export_tampered');
    try {
      const doc = await exportOf(h);
      const sched = await schedulingOf(h);
      const fh = await openAppointmentHarness(fresh);
      try {
        await importSchedulingExport(fresh.admin, T_ALPHA, sched as never, [
          (await engagementOf(h)) as never,
        ]);
        await copyTenancy(fresh);
        const tamper = (
          table: string,
          change: (r: Record<string, unknown>) => Record<string, unknown>,
        ): Doc => ({
          ...doc,
          tables: {
            ...doc.tables,
            [table]: (doc.tables[table] ?? []).map((r, i) => (i === 0 ? change(r) : r)),
          },
        });
        const empty = async () =>
          (await fresh.admin.query('SELECT count(*)::int AS n FROM cuspatlas.clinical_encounters')).rows[0].n;
        const cases: [string, Doc, RegExp][] = [
          [
            'note version digest',
            tamper('clinical_note_versions', (r) => ({ ...r, content_digest: `sha256:${'0'.repeat(64)}` })),
            /verification failed: note_version_digest/,
          ],
          [
            'estimate gross',
            tamper('clinical_estimates', (r) => ({ ...r, gross_minor: Number(r.gross_minor) + 1 })),
            /verification failed: estimate_sum/,
          ],
          [
            'acceptance revision',
            tamper('clinical_plan_acceptances', (r) => ({ ...r, accepted_revision: 999 })),
            /verification failed: acceptance/,
          ],
          [
            'foreign-tenant author',
            tamper('clinical_lab_cases', (r) => ({ ...r, created_by: USER_B1 })),
            /tenant/,
          ],
        ];
        expect(cases.every(([, d]) => d.tables.clinical_note_versions?.length)).toBe(true);
        for (const [label, d, pattern] of cases) {
          await expect(importClinicalExport(fresh.admin, T_ALPHA, d as never), label).rejects.toThrow(
            pattern,
          );
          expect([label, await empty()]).toStrictEqual([label, 0]);
        }
        // The untampered export still imports into the same database (control).
        await importClinicalExport(fresh.admin, T_ALPHA, doc as never);
        expect(await empty()).toBe(doc.tables.clinical_encounters?.length);
      } finally {
        await fh.close();
      }
    } finally {
      await fresh.close();
    }
  });

  it('S17 + C18 + E9 import in one call (any document order) in the platform order and round-trip identically', {
    timeout: 240_000,
  }, async () => {
    expect(IMPORT_ORDER).toStrictEqual([
      'cuspatlas-scheduling-export/1',
      'cuspatlas-imaging-export/1',
      CLINICAL_EXPORT_FORMAT,
      'cuspatlas-engagement-export/1',
      'cuspatlas-billing-export/1',
    ]);
    const fresh = await openTestDatabase('integration_export_all');
    try {
      const s = await schedulingOf(h);
      const c = await exportOf(h);
      const e = await engagementOf(h);
      // The engagement document of a booked record is not empty: S intents point at E decisions.
      expect(e.tables.suppression_decisions?.length ?? 0).toBeGreaterThan(0);
      const fh = await openAppointmentHarness(fresh, { imageRefResolver: images });
      try {
        await seedEngagementScopes(fresh.admin);
        await copyTenancy(fresh);
        // A C18 document needs the domain's note digest verifier.
        await expect(importExports(fresh.admin, T_ALPHA, [s, c, e] as never)).rejects.toThrow(
          /digest verifier/,
        );
        // A cross-document orphan (a C row naming a patient absent from S) rolls back all three.
        const orphan: Doc = {
          ...c,
          tables: {
            ...c.tables,
            clinical_lab_cases: (c.tables.clinical_lab_cases ?? []).map((r, i) =>
              i === 0 ? { ...r, subject_patient_id: randomUUID() } : r,
            ),
          },
        };
        await expect(
          importExports(fresh.admin, T_ALPHA, [e, orphan, s] as never, {
            verifyNoteDigests: verifyImportedNoteDigests,
          }),
        ).rejects.toThrow(/foreign key/);
        for (const table of ['appointments', 'clinical_encounters', 'suppression_decisions']) {
          const n = (await fresh.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${table}`)).rows[0].n;
          expect([table, n]).toStrictEqual([table, 0]);
        }
        await expect(
          importExports(fresh.admin, T_ALPHA, [s, s] as never, {
            verifyNoteDigests: verifyImportedNoteDigests,
          }),
        ).rejects.toThrow(/Duplicate/);
        // Given in reverse order, loaded S, C, E: every cross-document reference resolves.
        const counts = await importExports(fresh.admin, T_ALPHA, [e, c, s] as never, {
          verifyNoteDigests: verifyImportedNoteDigests,
        });
        expect(counts.clinical_encounters).toBe(c.tables.clinical_encounters?.length);
        expect(counts.suppression_decisions).toBe(e.tables.suppression_decisions?.length);
        expect(counts.appointments).toBe(s.tables.appointments?.length);
        const same = (x: Doc, y: Doc) =>
          expect({ ...y, exportedAt: null }).toStrictEqual({ ...x, exportedAt: null });
        same(s, await schedulingOf(fh));
        same(c, await exportOf(fh));
        same(e, await engagementOf(fh));
      } finally {
        await fh.close();
      }
    } finally {
      await fresh.close();
    }
  });

  it('only a tenant-wide human administrator exports; the read is sensitive-read logged', async () => {
    expect((await h.call('a4', 'GET', '/v1/clinical/export')).statusCode).toBe(403);
    expect((await h.call('svcA1', 'GET', '/v1/clinical/export')).statusCode).toBe(403);
    expect((await h.call('a3', 'GET', '/v1/clinical/export')).statusCode).toBe(403);
    const res = await h.call('a1', 'GET', '/v1/clinical/export');
    const { rows } = await source.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.sensitive_read_events WHERE correlation_id = $1 AND operation = 'clinical.export'`,
      [res.headers['x-correlation-id']],
    );
    expect(rows[0].n).toBe(1);
  });
});
