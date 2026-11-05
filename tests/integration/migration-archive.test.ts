import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA, USER_A1 } from './support/fixtures';
import { type ImagingStack, startImagingStack } from './support/imaging-fixtures';
import {
  intakeBody,
  legacyPackage,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './support/migration-fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * M7 historical archive packages (synthetic only; the real archive arrangement is blocked on M-S2).
 * Source history that does not import as live facts (historical appointments and procedures applied
 * as archive references by M3) is registered as a read-only archive package with per-entry digests,
 * read only through a patient-scoped, sensitive-read-logged read, verified (verified / partial /
 * failed), retained under a recommended-pending-approval policy and never deleted while held.
 */
let s: ImagingStack;
let packageRef: string;
let p1: string;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
type Ref = { entryRef: string; archiveRef: string; entity: string; sourceId: string; state: string };

beforeAll(async () => {
  s = await startImagingStack('migration_archive');
  await seedMigrationScopes(s.db.admin);
  const profileRef = data<{ profileRef: string }>(
    await s.command('owner', '/v1/migration/source-profiles', {
      sourceSystem: SOURCE_SYSTEM,
      format: 'cuspatlas-synthetic-legacy/1',
      practiceRef: PRACTICE,
    }),
  ).profileRef;
  packageRef = data<{ packageRef: string }>(
    await s.command(
      'owner',
      '/v1/migration/packages',
      intakeBody(
        profileRef,
        legacyPackage({
          patients:
            'patient_id,last_name,first_name,birth_date,phone,guarantor_id\nH001,Archive,Avery,1980-04-02,5550200001,G1\nH002,Archive,Blake,1985-06-15,5550200002,G2\n',
          appointments:
            'appt_id,patient_id,start_local,time_zone,duration_min,status\nHA1,H001,2025-03-02 09:00,America/New_York,60,completed\nHA2,H002,2025-04-10 14:30,America/New_York,30,broken\n',
          procedures:
            'proc_id,patient_id,legacy_code,service_date,fee_minor\nHX1,H001,L-PROPHY,2025-03-02,9500\n',
        }),
      ),
    ),
  ).packageRef;
  const items = data<{ itemRef: string; category: string }[]>(
    await s.inject('owner', 'GET', `/v1/migration/review-items?packageRef=${packageRef}`),
  );
  for (const i of items.filter((x) => x.category === 'terminology')) {
    const r = await s.command('owner', '/v1/migration/review-items/resolve', {
      packageRef,
      itemRef: i.itemRef,
      decision: 'archiveOnly',
      reasonCode: 'reviewed',
    });
    expect(r.status).toBe(200);
  }
  const planDigest = data<{ planDigest: string }>(
    await s.inject('owner', 'GET', `/v1/migration/imports/plan?packageRef=${packageRef}`),
  ).planDigest;
  const applied = await s.command('owner', '/v1/migration/imports/apply', {
    packageRef,
    expectedPlanDigest: planDigest,
    batchSize: 50,
  });
  expect(data<{ state: string }>(applied).state).toBe('complete');
  const { rows } = await s.db.admin.query(
    `SELECT a.patient_id FROM cuspatlas.migration_applied_records a
       JOIN cuspatlas.migration_staged_records r ON r.id = a.staged_record_id
     WHERE a.package_id = $1 AND r.entity = 'patients' AND r.source_id = 'H001'`,
    [packageRef],
  );
  p1 = rows[0].patient_id;
}, 240_000);

afterAll(async () => {
  await s?.close();
});

const live = async () =>
  (
    await s.db.admin.query(
      `SELECT (SELECT count(*) FROM cuspatlas.appointments)::int AS a,
              (SELECT count(*) FROM cuspatlas.clinical_rendered_procedures)::int AS c,
              (SELECT count(*) FROM cuspatlas.billing_journal_entries)::int AS j`,
    )
  ).rows[0];

describe('M7 historical archive packages', () => {
  let archiveRef: string;
  let refs: Ref[];

  it('registers the archive references of a package as a verified read-only package; nothing enters live tables', async () => {
    const before = await live();
    const r = await s.command('owner', '/v1/migration/archives', { packageRef });
    expect([r.status, r.body.slice(0, 200)]).toStrictEqual([201, r.body.slice(0, 200)]);
    const a = data<{ archiveRef: string; state: string; entryCount: number; archiveVersion: number }>(r);
    expect(a).toMatchObject({ state: 'verified', entryCount: 3, archiveVersion: 1 });
    archiveRef = a.archiveRef;
    expect(await live()).toStrictEqual(before);
    refs = data<Ref[]>(await s.inject('owner', 'GET', `/v1/migration/archives/references?patientRef=${p1}`));
    expect(refs.map((x) => [x.entity, x.sourceId, x.state]).sort()).toStrictEqual([
      ['appointments', 'HA1', 'verified'],
      ['procedures', 'HX1', 'verified'],
    ]);
  });

  it('a patient with no archive references resolves to an explicit empty list', async () => {
    const other = data<{ patientRef: string }>(
      await s.command('owner', '/v1/patients', patientBody('Archive Nobody')),
    ).patientRef;
    const r = await s.inject('owner', 'GET', `/v1/migration/archives/references?patientRef=${other}`);
    expect([r.status, data(r)]).toStrictEqual([200, []]);
  });

  it('an entry is readable only for its linked patient, by a human, and every read is logged', async () => {
    const e = refs.find((x) => x.sourceId === 'HA1') as Ref;
    const r = await s.inject(
      'owner',
      'GET',
      `/v1/migration/archives/entries?entryRef=${e.entryRef}&patientRef=${p1}`,
    );
    expect(r.status).toBe(200);
    expect(data<{ readOnly: boolean; content: Record<string, string> }>(r)).toMatchObject({
      readOnly: true,
      content: { appt_id: 'HA1', status: 'completed' },
    });
    const other = data<{ patientRef: string }>(
      await s.command('owner', '/v1/patients', patientBody('Archive Other')),
    ).patientRef;
    const wrong = await s.inject(
      'owner',
      'GET',
      `/v1/migration/archives/entries?entryRef=${e.entryRef}&patientRef=${other}`,
    );
    expect(wrong.status).toBe(404);
    const svc = await s.inject(
      'service',
      'GET',
      `/v1/migration/archives/entries?entryRef=${e.entryRef}&patientRef=${p1}`,
    );
    expect(svc.status).toBe(403);
    const mcp = await s.mcp('owner', 'migration_archive_references', { patientRef: p1 });
    expect(mcp.isError).toBe(false);
    expect(mcp.raw).toContain(e.entryRef);
    const audit = await s.db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.sensitive_read_events WHERE operation LIKE 'migration.archive.%'`,
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it('verification labels a damaged package partial, enumerates the unreadable entry and refuses to serve it', async () => {
    const bad = refs.find((x) => x.sourceId === 'HX1') as Ref;
    await s.db.admin.query(
      `BEGIN; SET LOCAL session_replication_role = replica;
       UPDATE cuspatlas.migration_archive_entries SET content = content || '{"legacy_code":"L-EDITED"}' WHERE id = '${bad.entryRef}';
       COMMIT;`,
    );
    const v = await s.command('owner', '/v1/migration/archives/verify', { archiveRef });
    expect(data<{ state: string; unreadableEntries: string[] }>(v)).toMatchObject({
      state: 'partial',
      unreadableEntries: [bad.entryRef],
    });
    const r = await s.inject(
      'owner',
      'GET',
      `/v1/migration/archives/entries?entryRef=${bad.entryRef}&patientRef=${p1}`,
    );
    expect([r.status, (r.json.detail as { reason?: string } | undefined)?.reason]).toStrictEqual([
      409,
      'archive_entry_unreadable',
    ]);
    const good = refs.find((x) => x.sourceId === 'HA1') as Ref;
    const ok = await s.inject(
      'owner',
      'GET',
      `/v1/migration/archives/entries?entryRef=${good.entryRef}&patientRef=${p1}`,
    );
    expect(ok.status).toBe(200);
  });

  it('a re-registration supersedes without overwriting: the prior package stays readable under its own identity', async () => {
    const r = await s.command('owner', '/v1/migration/archives', { packageRef });
    const a = data<{ archiveRef: string; archiveVersion: number; state: string }>(r);
    expect(a.archiveVersion).toBe(2);
    expect(a.archiveRef).not.toBe(archiveRef);
    const good = refs.find((x) => x.sourceId === 'HA1') as Ref;
    const ok = await s.inject(
      'owner',
      'GET',
      `/v1/migration/archives/entries?entryRef=${good.entryRef}&patientRef=${p1}`,
    );
    expect(ok.status).toBe(200);
  });

  it('retention: no deletion while held or inside the retention period; an I8 patient hold also holds the archive', async () => {
    const placed = await s.command('owner', '/v1/migration/archives/holds', {
      archiveRef,
      action: 'place',
      reasonCode: 'litigation',
    });
    expect(placed.status).toBe(201);
    const holdRef = data<{ holdRef: string }>(placed).holdRef;
    const ev = async () =>
      data<{ eligible: boolean; reasons: string[]; retainUntil: string; policyVersion: string }>(
        await s.inject('owner', 'GET', `/v1/migration/archives/retention?archiveRef=${archiveRef}`),
      );
    expect(await ev()).toMatchObject({ eligible: false, reasons: ['legal_hold', 'retention_period'] });
    await expect(
      s.db.admin.query('DELETE FROM cuspatlas.migration_archive_entries WHERE archive_id = $1', [archiveRef]),
    ).rejects.toThrow(/legal hold/);
    const released = await s.command('owner', '/v1/migration/archives/holds', {
      archiveRef,
      action: 'release',
      holdRef,
      reasonCode: 'resolved',
    });
    expect(released.status).toBe(201);
    expect((await ev()).reasons).toStrictEqual(['retention_period']);
    await expect(
      s.db.admin.query('DELETE FROM cuspatlas.migration_archive_entries WHERE archive_id = $1', [archiveRef]),
    ).rejects.toThrow(/retention/);
    await s.db.admin.query(
      `INSERT INTO cuspatlas.imaging_legal_holds (tenant_id, subject_kind, subject_ref, reason_code, placed_by)
       VALUES ($1, 'patient', $2, 'litigation', $3)`,
      [T_ALPHA, p1, USER_A1],
    );
    expect((await ev()).reasons).toStrictEqual(['legal_hold', 'retention_period']);
    const twice = await s.command('owner', '/v1/migration/archives/holds', {
      archiveRef,
      action: 'release',
      holdRef,
      reasonCode: 'resolved',
    });
    expect(twice.status).toBe(409);
  });
});
