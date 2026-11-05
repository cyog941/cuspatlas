import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  backupObjectStore,
  createBackup,
  findStaleRestoredDevices,
  type RestoreConnection,
  restoreBackup,
  restoreObjectStore,
} from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachTestDatabase } from './support/db';
import { T_ALPHA } from './support/fixtures';
import {
  type ImagingStack,
  ingestVia,
  pngBytes,
  sha256,
  startImagingStack,
} from './support/imaging-fixtures';
import { patientBody } from './support/patient-fixtures';
import { SyntheticBridge } from './support/synthetic-bridge';

/**
 * I9 imaging restore drill (replaces the simulated restore of the I8 suite). A real F8 logical backup
 * of the source database (every schema table, imaging and bridge tables included) plus a storage-layer
 * backup of the synthetic object store; then, after the backup, an executed deletion and a new upload;
 * then a restore into a fresh synthetic database and an empty store with the live store's tombstones
 * carried forward (runbook rule), and `imaging.storage.reconcile` before serving. Outcome: every
 * imaging row is back, the image deleted after the backup is deleted again (never served), the other
 * images are served with verified digests, imageRefs resolve, and the upload made after the backup is
 * not resurrected (its bytes are not in the restored store).
 */
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const MIGRATIONS = join(REPO_ROOT, 'supabase', 'migrations');
let src: ImagingStack;
let restored: ImagingStack | undefined;
const scratch: string[] = [];
const tmp = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `cuspatlas-imaging-drill-${label}-`));
  scratch.push(d);
  return d;
};
const adminConn = (): RestoreConnection => ({
  host: '127.0.0.1',
  port: Number(process.env.CUSPATLAS_TEST_PG_PORT),
  user: 'postgres',
  password: process.env.CUSPATLAS_TEST_PG_ADMIN_PASSWORD ?? '',
  database: 'postgres',
});
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
const IMAGING_TABLES = [
  'imaging_objects',
  'imaging_object_provenance',
  'imaging_match_decisions',
  'imaging_image_refs',
  'imaging_mounts',
  'imaging_mount_slots',
  'imaging_annotations',
  'imaging_derivations',
  'imaging_legal_holds',
  'imaging_retention_policies',
  'imaging_deletion_requests',
  'imaging_devices',
  'imaging_bridge_jobs',
];
const counts = async (s: ImagingStack) => {
  const out: Record<string, number> = {};
  for (const t of IMAGING_TABLES)
    out[t] = (await s.db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${t}`)).rows[0].n as number;
  return out;
};
const read = async (s: ImagingStack, objectRef: string) => {
  const g = await s.inject('owner', 'POST', `/v1/imaging/objects/${objectRef}/read-grants`, {});
  if (g.status !== 201)
    return {
      status: g.status,
      digest: null as string | null,
      reason: (g.json.detail as { reason?: string })?.reason,
    };
  const c = await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}/content`, undefined, {
    'x-object-read-token': data<{ token: string }>(g).token,
  });
  return { status: c.status, digest: c.status === 200 ? sha256(c.raw) : null, reason: undefined };
};

let kept: { objectRef: string; imageRef: string; bytes: Uint8Array; patient: string };
let doomed: { objectRef: string; bytes: Uint8Array };
let late: { objectRef: string; bytes: Uint8Array };
let atBackup: Record<string, number>;
let backupDir: string;
let objectsDir: string;
let rotated: SyntheticBridge;
let revokedLater: SyntheticBridge;

beforeAll(async () => {
  src = await startImagingStack('imaging_drill_src');
  const patient = data<{ patientRef: string }>(
    await src.command('owner', '/v1/patients', patientBody('Drill One')),
  ).patientRef;
  const kb = pngBytes(6601, 8, 8);
  const k = await ingestVia(src, kb, { intendedPatientRef: patient });
  const c = await src.command('owner', `/v1/imaging/objects/${k.objectRef}/association`, {
    patientRef: patient,
    basis: 'operatorSelected',
  });
  kept = { objectRef: k.objectRef, imageRef: data<{ imageRef: string }>(c).imageRef, bytes: kb, patient };
  await src.command('owner', '/v1/imaging/mounts', {
    template: 'pa-1',
    slots: [{ slot: 1, objectRef: k.objectRef }],
  });
  await src.command('owner', `/v1/imaging/objects/${k.objectRef}/annotations`, {
    kind: 'marker',
    geometry: { kind: 'point', x: 0.1, y: 0.1 },
  });
  const db = pngBytes(6602, 8, 8);
  doomed = { objectRef: (await ingestVia(src, db)).objectRef, bytes: db };
  await src.command('owner', '/v1/imaging/retention/policies', {
    recordClass: 'unassociated_original',
    minimumRetentionMonths: 0,
    basisCode: 'synthetic_test_policy',
    jurisdictionCode: 'us-synthetic',
  });
  // A paired bridge device and a queued job are part of the backed-up state too.
  const reg = await src.command('owner', '/v1/imaging/devices', {
    label: 'Drill Bridge',
    allowedJobKinds: ['import'],
    allowedPathPrefixes: ['exports'],
  });
  expect(reg.status).toBe(201);
  const pairNew = async (label: string) => {
    const r = await src.command('owner', '/v1/imaging/devices', {
      label,
      allowedJobKinds: ['import'],
      allowedPathPrefixes: ['exports'],
    });
    const ref = data<{ deviceRef: string }>(r).deviceRef;
    const code = data<{ pairingCode: string }>(
      await src.inject('owner', 'POST', `/v1/imaging/devices/${ref}/pairing-codes`, {}),
    ).pairingCode;
    const b = new SyntheticBridge(src.app);
    expect((await b.pair(code)).status).toBe(201);
    return b;
  };
  rotated = await pairNew('Rotated After Backup');
  revokedLater = await pairNew('Revoked After Backup');
  const untouched = await pairNew('Untouched');
  expect(untouched.deviceRef).not.toBe('');

  // The backups: logical database backup (F8) and the object-store backup.
  backupDir = tmp('db');
  objectsDir = tmp('objects');
  const client = await src.db.admin.connect();
  try {
    await createBackup(client, { outDir: backupDir, repoRoot: REPO_ROOT });
  } finally {
    client.release();
  }
  await backupObjectStore(src.storeRoot, objectsDir);
  atBackup = await counts(src);

  // After the backup: a device key rotates and another device is revoked (neither is in the backup),
  // a deletion executes (tombstone, bytes removed) and a new image arrives.
  expect((await rotated.rotate()).reply.status).toBe(200);
  expect(
    (
      await src.command('owner', `/v1/imaging/devices/${revokedLater.deviceRef}/revoke`, {
        reasonCode: 'device_replaced',
      })
    ).status,
  ).toBe(200);
  const req = await src.command('owner', `/v1/imaging/objects/${doomed.objectRef}/deletion-requests`, {
    reasonCode: 'requested_by_practice',
  });
  const x = await src.command(
    'owner',
    `/v1/imaging/deletion-requests/${data<{ deletionRef: string }>(req).deletionRef}/execute`,
    {},
  );
  expect(x.json.data).toMatchObject({ state: 'executed', bytes: 'removed' });
  const lb = pngBytes(6603, 8, 8);
  late = { objectRef: (await ingestVia(src, lb)).objectRef, bytes: lb };
}, 180_000);
afterAll(async () => {
  await restored?.close();
  await src?.close();
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe('I9 imaging restore drill', () => {
  it('restores database and store, reconciles before serving, and never resurrects a deletion', async () => {
    const target = `cuspatlas_synthetic_imaging_drill_${Date.now().toString(36)}`;
    const report = await restoreBackup(adminConn(), {
      backupDir,
      target,
      confirmTarget: target,
      migrationsDir: MIGRATIONS,
    });
    expect(report.verified).toBe(true);
    const storeRoot = tmp('restored-store');
    const r = await restoreObjectStore(objectsDir, storeRoot, { tombstonesFrom: src.storeRoot });
    expect(r.carriedTombstones).toBeGreaterThanOrEqual(1);
    restored = await startImagingStack('unused', {
      database: attachTestDatabase(target),
      storeRoot,
      seed: false,
    });

    // The deleted image's bytes are not in the restored store at all (not merely marked deleted).
    expect(
      existsSync(
        join(storeRoot, 't', T_ALPHA, 'sha256', sha256(doomed.bytes).slice(0, 2), sha256(doomed.bytes)),
      ),
    ).toBe(false);

    // Devices whose restored state is behind the live one are flagged: the rotated-away key is active
    // again, and the later revocation is lost. The untouched device is not flagged.
    const stale = await findStaleRestoredDevices(restored.db.admin, src.db.admin);
    expect(stale.map((d) => [d.deviceRef, d.reason]).sort()).toStrictEqual(
      [
        [rotated.deviceRef, 'rotated_after_backup'],
        [revokedLater.deviceRef, 'revoked_after_backup'],
      ].sort(),
    );

    // Every imaging row of the backup is back, imaging and bridge tables included.
    expect(await counts(restored)).toStrictEqual(atBackup);
    const before = await restored.db.admin.query(
      'SELECT state FROM cuspatlas.imaging_objects WHERE id = $1',
      [doomed.objectRef],
    );
    expect(before.rows[0].state).toBe('available');

    // Reconcile first (runbook): the tombstone turns the restored row back into deleted.
    const rec = await restored.command('owner', '/v1/imaging/storage/reconcile', {});
    expect(rec.status).toBe(200);
    expect((rec.json.data as { tombstoned: number }).tombstoned).toBeGreaterThanOrEqual(1);
    const d = await read(restored, doomed.objectRef);
    expect([d.status, d.reason]).toStrictEqual([409, 'object_not_available']);

    // The kept image is served with its verified digest; its imageRef resolves to the same patient.
    expect(await read(restored, kept.objectRef)).toMatchObject({ status: 200, digest: sha256(kept.bytes) });
    const ref = await restored.inject(
      'owner',
      'GET',
      `/v1/imaging/image-refs/${kept.imageRef}?expectedPatientRef=${kept.patient}`,
    );
    expect(ref.json.data).toMatchObject({ matchesExpected: true, objectState: 'available' });
    const mounts = await restored.db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.imaging_mounts');
    expect(mounts.rows[0].n).toBe(1);

    // The upload made after the backup is not in the restored database and its bytes are not in the store.
    const lateRow = await restored.db.admin.query('SELECT 1 FROM cuspatlas.imaging_objects WHERE id = $1', [
      late.objectRef,
    ]);
    expect(lateRow.rowCount).toBe(0);
    expect(
      existsSync(join(storeRoot, 't', T_ALPHA, 'sha256', sha256(late.bytes).slice(0, 2), sha256(late.bytes))),
    ).toBe(false);
  }, 180_000);

  it('refuses an object-store backup whose file was altered, before writing anything', async () => {
    const { writeFileSync, readdirSync } = await import('node:fs');
    const altered = tmp('altered');
    await backupObjectStore(src.storeRoot, altered);
    const dir = join(altered, 'objects', 't', T_ALPHA, 'sha256');
    const sub = readdirSync(dir)[0] as string;
    const file = readdirSync(join(dir, sub))[0] as string;
    writeFileSync(join(dir, sub, file), Buffer.from('altered'));
    const target = tmp('altered-target');
    await expect(restoreObjectStore(altered, target)).rejects.toThrow(/manifest/);
    expect(existsSync(join(target, 't'))).toBe(false);
  });
});
