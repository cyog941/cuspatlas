import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RefusalError } from '@cuspatlas/contracts';
import {
  type BackupManifest,
  createBackup,
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
  MANIFEST_DIGEST_FILE,
  MANIFEST_FILE,
  migrate,
  type RestoreConnection,
  RestoreRefusedError,
  RestoreVerificationError,
  restoreBackup,
  sha256,
} from '@cuspatlas/db';
import { createAuthorize, createProposalService, createSyntheticTaskService } from '@cuspatlas/domain';
import { createWorker } from '@cuspatlas/worker';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { FakeProvider } from './support/fake-provider';
import { ctxFor, seedTenancy, T_ALPHA, T_BETA, TASK_A, TASK_B, USER_A1, USER_B1 } from './support/fixtures';
import { pgCtlBinary, startWithPgCtl, stopWithPgCtl } from './support/pg-ctl';

/**
 * F Task 8 restore proof. A source database is driven through the real domain, proposal and worker
 * paths into every protected state, backed up, and restored into a NEW disposable database on the
 * same embedded cluster (and, for the missing-role case, into a second throwaway cluster). Every
 * denial assertion runs as the runtime role.
 */

const MIGRATIONS = resolve(import.meta.dirname, '../../supabase/migrations');
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SVC_W = '30000000-0000-4000-8000-0000000000d1'; // worker: outbox.deliver + read/write, both tenants
const RW = ['syntheticTasks.read', 'syntheticTasks.write'];

let db: TestDatabase;
let backupDir: string;
let manifest: BackupManifest;
let restoredName: string;
let restored: { admin: pg.Pool; app: pg.Pool; sink: pg.Pool };
let before: Snapshot;
const scratch: string[] = [];
const createdTargets: string[] = [];
const ids = {} as Record<
  'prepared' | 'approvedStale' | 'approvedExpireLater' | 'committed' | 'expired' | 'rejected',
  { ref: string; payload: Record<string, unknown> }
> & { leased: string[]; reconciliation: string[]; staleTask: string };

const port = () => Number(process.env.CUSPATLAS_TEST_PG_PORT);
const adminConn = (over: Partial<RestoreConnection> = {}): RestoreConnection => ({
  host: '127.0.0.1',
  port: port(),
  user: 'postgres',
  password: process.env.CUSPATLAS_TEST_PG_ADMIN_PASSWORD ?? '',
  database: 'postgres',
  ...over,
});
const tmp = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `cuspatlas-backup-${label}-`));
  scratch.push(d);
  return d;
};
const targetName = (label: string) => {
  const n = `cuspatlas_synthetic_restore_${label}_${randomBytes(3).toString('hex')}`;
  createdTargets.push(n);
  return n;
};

function services(pool: pg.Pool, sinkPool: pg.Pool) {
  const membership = createMembershipSource(pool);
  const deps = {
    authorize: createAuthorize(membership),
    withTenantTransaction: createTenantTransactionRunner(pool),
    recording: { sink: createSecurityAttemptSink(sinkPool), alert: () => undefined },
  };
  return {
    tasks: createSyntheticTaskService(deps),
    proposals: createProposalService({ ...deps, memberships: membership }),
    worker: (over: Partial<Parameters<typeof createWorker>[0]> = {}) =>
      createWorker({
        workerPrincipalId: SVC_W,
        withTenantTransaction: deps.withTenantTransaction,
        authorize: deps.authorize,
        memberships: membership,
        attempts: deps.recording.sink,
        backoffSeconds: () => 0,
        deliverTimeoutSeconds: 0.1,
        ...over,
      }),
  };
}

interface Snapshot {
  readonly counts: Record<string, number>;
  readonly tasks: unknown[];
  readonly outbox: unknown[];
  readonly receipts: unknown[];
  readonly reservations: unknown[];
  readonly proposals: unknown[];
  readonly provenance: unknown[];
}

async function snapshot(admin: pg.Pool): Promise<Snapshot> {
  const q = async (sql: string) => (await admin.query(sql)).rows;
  const counts: Record<string, number> = {};
  for (const t of [
    'tenants',
    'principals',
    'memberships',
    'synthetic_tasks',
    'audit_events',
    'outbox_events',
    'delivery_receipts',
    'security_attempt_events',
    'command_idempotency',
    'action_proposals',
    'action_proposal_provenance',
  ]) {
    counts[t] = (await q(`SELECT count(*)::int AS n FROM cuspatlas.${t}`))[0].n;
  }
  return {
    counts,
    tasks: await q('SELECT id, tenant_id, version FROM cuspatlas.synthetic_tasks ORDER BY id'),
    outbox: await q(
      `SELECT id, tenant_id, state, attempt, dead_letter_reason, last_outcome, leased_until, next_attempt_at
       FROM cuspatlas.outbox_events ORDER BY id`,
    ),
    receipts: await q(
      'SELECT event_id, provider_receipt_id, outcome, attempt FROM cuspatlas.delivery_receipts ORDER BY 1, 2',
    ),
    reservations: await q(
      `SELECT tenant_id, principal_id, operation, key_digest, payload_digest, state, aggregate_version, expires_at
       FROM cuspatlas.command_idempotency ORDER BY key_digest, operation, principal_id`,
    ),
    proposals: await q(
      `SELECT id, state, version, disposition_reason, approver_id, approval_digest, payload_digest,
         policy_version, expires_at, committed_by, result_ref, result_version
       FROM cuspatlas.action_proposals ORDER BY id`,
    ),
    provenance: await q(
      `SELECT proposal_id, step, actor_id, actor_kind, policy_version, payload_digest, reason
       FROM cuspatlas.action_proposal_provenance ORDER BY proposal_id, step`,
    ),
  };
}

function pools(name: string) {
  const base = { host: '127.0.0.1', port: port(), database: name };
  const mk = (cfg: pg.PoolConfig) => {
    const p = new pg.Pool({ ...base, ...cfg });
    p.on('error', () => undefined);
    return p;
  };
  const app = { user: 'cuspatlas_app', password: process.env.CUSPATLAS_TEST_PG_APP_PASSWORD ?? '' };
  return {
    admin: mk({ user: 'postgres', password: process.env.CUSPATLAS_TEST_PG_ADMIN_PASSWORD ?? '', max: 2 }),
    app: mk({ ...app, max: 6 }),
    sink: mk({ ...app, max: 2 }),
  };
}

async function dropDatabase(name: string): Promise<void> {
  const c = new pg.Client(adminConn());
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await c.end();
  }
}

async function databaseExists(name: string): Promise<boolean> {
  const c = new pg.Client(adminConn());
  await c.connect();
  try {
    return ((await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount ?? 0) > 0;
  } finally {
    await c.end();
  }
}

/** Privileged tamper with triggers bypassed (superuser fixture path only). */
async function tamper(pool: pg.Pool, sql: string, params: unknown[]): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(sql, params);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RefusalError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

async function restoreRefusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RestoreRefusedError) return err.code;
    throw err;
  }
  throw new Error('expected the restore to be refused');
}

/** Copies the good backup so a case can damage its copy. */
function copyBackup(label: string): string {
  const d = tmp(label);
  cpSync(backupDir, d, { recursive: true });
  return d;
}
function rewriteManifest(dir: string, edit: (m: BackupManifest) => BackupManifest): void {
  const text = `${JSON.stringify(edit(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))), null, 2)}\n`;
  writeFileSync(join(dir, MANIFEST_FILE), text);
  writeFileSync(join(dir, MANIFEST_DIGEST_FILE), `${sha256(text)}\n`);
}

beforeAll(async () => {
  db = await openTestDatabase('restore_source');
  await seedTenancy(db.admin);
  await db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-w')`,
    [SVC_W],
  );
  await db.admin.query(
    `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $3, $4), ($2, $3, $4)`,
    [T_ALPHA, T_BETA, SVC_W, ['outbox.deliver', ...RW]],
  );
  const pool = db.appPool(8);
  const s = services(pool, db.sink);
  const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human');
  const b1 = () => ctxFor(T_BETA, USER_B1, 'human', RW);

  // Tasks with versions > 1 in both tenants, plus committed and failed reservations.
  for (const [ctx, taskRef] of [
    [a1, TASK_A],
    [b1, TASK_B],
  ] as const) {
    await s.tasks.relabelSyntheticTask(ctx(), taskRef, {
      operation: 'syntheticTasks.relabel',
      idempotencyKey: randomUUID(),
      payload: { label: 'relabelled once', expectedVersion: 1 },
    });
    const created = await s.tasks.createSyntheticTask(ctx(), {
      operation: 'syntheticTasks.create',
      idempotencyKey: randomUUID(),
      payload: { label: 'created for restore' },
    });
    await s.tasks.relabelSyntheticTask(ctx(), created.data.taskRef, {
      operation: 'syntheticTasks.relabel',
      idempotencyKey: randomUUID(),
      payload: { label: 'relabelled again', expectedVersion: 1 },
    });
    // Terminal refusal recorded as a `failed` reservation.
    expect(
      await refusal(
        s.tasks.relabelSyntheticTask(ctx(), taskRef, {
          operation: 'syntheticTasks.relabel',
          idempotencyKey: randomUUID(),
          payload: { label: 'stale', expectedVersion: 1 },
        }),
      ),
    ).toBe('stale_version');
  }
  // A denial recorded in the attempt sink (beta member reading alpha's task).
  expect(await refusal(s.tasks.getSyntheticTask(b1(), TASK_A))).toBe('not_found');

  // Proposals in every state (alpha), each on its own task.
  const freshTask = async () =>
    (
      await db.admin.query(
        'INSERT INTO cuspatlas.synthetic_tasks (tenant_id, label, created_by) VALUES ($1, $2, $3) RETURNING id',
        [T_ALPHA, 'proposal target', USER_A1],
      )
    ).rows[0].id as string;
  const prepare = async () => {
    const payload = { taskRef: await freshTask(), label: 'proposed label', expectedVersion: 1 };
    const r = await s.proposals.prepareProposal(a1(), {
      operation: 'syntheticTasks.proposals.prepare',
      idempotencyKey: randomUUID(),
      payload: { operation: 'syntheticTasks.relabel', payload },
    });
    return { ref: r.data.proposalRef, digest: r.data.payloadDigest, payload };
  };
  const approve = async () => {
    const p = await prepare();
    await s.proposals.approveProposal(a1(), p.ref, { payloadDigest: p.digest, execution: 'manual' });
    return p;
  };
  ids.prepared = await prepare();
  ids.approvedStale = await approve();
  ids.staleTask = ids.approvedStale.payload.taskRef as string;
  ids.approvedExpireLater = await approve();
  ids.committed = await approve();
  await s.proposals.commitProposal(a1(), ids.committed.ref, { payload: ids.committed.payload });
  ids.expired = await approve();
  await tamper(
    db.admin,
    `UPDATE cuspatlas.action_proposals SET created_at = now() - interval '30 minutes',
       expires_at = now() - interval '1 minute' WHERE id = $1`,
    [ids.expired.ref],
  );
  expect(
    await refusal(s.proposals.commitProposal(a1(), ids.expired.ref, { payload: ids.expired.payload })),
  ).toBe('proposal_expired');
  ids.rejected = await approve();
  expect(
    await refusal(
      s.proposals.commitProposal(a1(), ids.rejected.ref, {
        payload: { ...ids.rejected.payload, label: 'altered' },
      }),
    ),
  ).toBe('payload_mismatch');

  // Outbox: everything so far is delivered with receipts, then one dead letter, one unknown outcome
  // (reconciliation, next attempt in an hour) and a batch left leased with a lease in the future.
  const ok = new FakeProvider();
  await s.worker().runOnce(T_ALPHA, ok);
  await s.worker().runOnce(T_BETA, ok);
  const enqueue = async () =>
    s.tasks.createSyntheticTask(a1(), {
      operation: 'syntheticTasks.create',
      idempotencyKey: randomUUID(),
      payload: { label: 'queued' },
    });
  await enqueue();
  const dl = await s.worker().runOnce(T_ALPHA, new FakeProvider({}, { fail: () => ({ retryable: false }) }));
  expect(dl.map((r) => r.result)).toEqual(['dead-letter']);
  await enqueue();
  const unknown = await s
    .worker({ backoffSeconds: () => 3600 })
    .runOnce(T_ALPHA, new FakeProvider({}, { afterAccept: () => 'timeout' }));
  expect(unknown.map((r) => r.result)).toEqual(['reconciliation']);
  ids.reconciliation = unknown.map((r) => r.eventId);
  await enqueue();
  await enqueue();
  const leased = await s.worker({ leaseSeconds: 3600 }).leaseBatch(T_ALPHA);
  expect(leased.length).toBe(2);
  ids.leased = leased.map((e) => e.id);
  await pool.end();

  before = await snapshot(db.admin);
  const c = await db.admin.connect();
  try {
    backupDir = tmp('good');
    manifest = await createBackup(c, { outDir: backupDir, repoRoot: REPO_ROOT });
  } finally {
    c.release();
  }
  restoredName = targetName('main');
  await restoreBackup(adminConn(), {
    backupDir,
    target: restoredName,
    confirmTarget: restoredName,
    migrationsDir: MIGRATIONS,
  });
  restored = pools(restoredName);
}, 120_000);

afterAll(async () => {
  await Promise.all(
    [restored?.admin, restored?.app, restored?.sink].map((p) => p?.end().catch(() => undefined)),
  );
  for (const n of createdTargets) await dropDatabase(n).catch(() => undefined);
  // Windows can hold a just-stopped cluster's files briefly (EBUSY): retry with backoff.
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await db?.close();
});

describe('restore preserves the synthetic foundation state', () => {
  it('fixture covers every protected state', () => {
    const states = new Set((before.outbox as { state: string }[]).map((r) => r.state));
    expect([...states].sort()).toEqual(['dead_letter', 'delivered', 'leased', 'reconciliation']);
    const p = new Set((before.proposals as { state: string }[]).map((r) => r.state));
    expect([...p].sort()).toEqual(['approved', 'committed', 'expired', 'prepared', 'rejected']);
    const r = new Set((before.reservations as { state: string }[]).map((x) => x.state));
    expect([...r].sort()).toEqual(['committed', 'failed']);
    expect((before.tasks as { version: number }[]).some((t) => t.version > 1)).toBe(true);
    expect(before.counts.delivery_receipts).toBeGreaterThan(0);
    expect(before.counts.security_attempt_events).toBeGreaterThan(0);
    expect((before.outbox as { dead_letter_reason: string | null }[]).some((o) => o.dead_letter_reason)).toBe(
      true,
    );
  });

  it('every count, version, state, receipt, reservation and provenance row is identical after restore', async () => {
    const after = await snapshot(restored.admin);
    expect(after).toEqual(before);
    // Preservation table for the ledger (counts only, no row values).
    process.stdout.write(
      `restore-preservation ${JSON.stringify(Object.entries(before.counts).map(([t, n]) => [t, n, after.counts[t]]))}\n`,
    );
  });

  it('the manifest names tables, counts and digests only, and covers every schema table', () => {
    expect(manifest.format).toBe('cuspatlas-logical-backup/1');
    expect(manifest.tables.map((t) => t.name)).toContain('delivery_receipts');
    expect(Object.keys(manifest.catalog).sort()).toEqual(
      [
        'columnGrants',
        'columns',
        'constraints',
        'functions',
        'indexes',
        'policies',
        'schema',
        'tableGrants',
        'tables',
        'triggers',
      ].sort(),
    );
    const text = readFileSync(join(backupDir, MANIFEST_FILE), 'utf8');
    expect(text).not.toMatch(/password|postgres:\/\/|127\.0\.0\.1/i);
  });

  it('cross-tenant access is still denied under the runtime role in the restored database', async () => {
    const s = services(restored.app, restored.sink);
    expect(await refusal(s.tasks.getSyntheticTask(ctxFor(T_BETA, USER_B1, 'human', RW), TASK_A))).toBe(
      'not_found',
    );
    const ok = await s.tasks.getSyntheticTask(ctxFor(T_ALPHA, USER_A1, 'human'), TASK_A);
    expect(ok.version).toBe(2);
    const c = await restored.app.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        "SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)",
        [T_BETA, USER_B1],
      );
      const { rows } = await c.query(
        'SELECT count(*)::int AS n FROM cuspatlas.synthetic_tasks WHERE tenant_id = $1',
        [T_ALPHA],
      );
      expect(rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('restored leased and reconciliation events are never sent before a lookup completes; attempt stays monotonic', async () => {
    const s = services(restored.app, restored.sink);
    const pending = [...ids.leased, ...ids.reconciliation];
    const attempts = async () =>
      Object.fromEntries(
        (
          await restored.admin.query(
            'SELECT id, attempt, state FROM cuspatlas.outbox_events WHERE id = ANY($1)',
            [pending],
          )
        ).rows.map((r) => [r.id, r]),
      );
    const start = await attempts();

    // 1. Lease still in the future, reconciliation not due: the worker leases nothing.
    const provider = new FakeProvider({ idempotent: false }, { lookupUnavailable: () => true });
    expect(await s.worker().runOnce(T_ALPHA, provider)).toEqual([]);
    expect(provider.deliverCalls.length).toBe(0);

    // 2. Lease expired and reconciliation due, provider lookup unavailable: lookups only, no send.
    await restored.admin.query(
      `UPDATE cuspatlas.outbox_events SET leased_until = now() - interval '1 hour' WHERE id = ANY($1)`,
      [ids.leased],
    );
    await restored.admin.query(
      `UPDATE cuspatlas.outbox_events SET next_attempt_at = now() - interval '1 minute' WHERE id = ANY($1)`,
      [ids.reconciliation],
    );
    const r2 = await s.worker().runOnce(T_ALPHA, provider);
    expect(r2.map((r) => r.result).sort()).toEqual(['reconciliation', 'reconciliation', 'reconciliation']);
    expect(provider.deliverCalls.length).toBe(0);
    expect(provider.lookupCalls).toBe(3);
    const mid = await attempts();
    for (const id of pending) expect(mid[id].attempt).toBe(start[id].attempt + 1);

    // 3. The provider had performed them before the backup: lookup finds them, still no send.
    for (const id of pending) provider.preAccept(id);
    provider.hooks = {};
    await restored.admin.query(
      `UPDATE cuspatlas.outbox_events SET next_attempt_at = now() - interval '1 minute' WHERE id = ANY($1)`,
      [pending],
    );
    const r3 = await s.worker().runOnce(T_ALPHA, provider);
    expect(r3.map((r) => r.result)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(provider.deliverCalls.length).toBe(0);
    for (const id of pending) expect(provider.effectsFor(id)).toBe(1);
    const end = await attempts();
    for (const id of pending) {
      expect(end[id].attempt).toBe(start[id].attempt + 2);
      expect(end[id].state).toBe('delivered');
    }
  });

  it('a restored committed proposal replays and does not execute again', async () => {
    const s = services(restored.app, restored.sink);
    const audits = async () =>
      (await restored.admin.query('SELECT count(*)::int AS n FROM cuspatlas.audit_events')).rows[0].n;
    const a = await audits();
    const r = await s.proposals.commitProposal(ctxFor(T_ALPHA, USER_A1, 'human'), ids.committed.ref, {
      payload: ids.committed.payload,
    });
    expect(r.replayed).toBe(true);
    expect(r.version).toBe(2);
    expect(await audits()).toBe(a);
  });

  it('a restored expired proposal, and an approved one that expires after restore, fail closed', async () => {
    const s = services(restored.app, restored.sink);
    const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human');
    expect(
      await refusal(s.proposals.commitProposal(a1(), ids.expired.ref, { payload: ids.expired.payload })),
    ).toBe('proposal_expired');
    await tamper(
      restored.admin,
      `UPDATE cuspatlas.action_proposals SET created_at = now() - interval '30 minutes',
         expires_at = now() - interval '1 minute' WHERE id = $1`,
      [ids.approvedExpireLater.ref],
    );
    expect(
      await refusal(
        s.proposals.commitProposal(a1(), ids.approvedExpireLater.ref, {
          payload: ids.approvedExpireLater.payload,
        }),
      ),
    ).toBe('proposal_expired');
  });

  it('a restored approved proposal whose task version moved fails stale_version', async () => {
    const s = services(restored.app, restored.sink);
    const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human');
    await s.tasks.relabelSyntheticTask(a1(), ids.staleTask, {
      operation: 'syntheticTasks.relabel',
      idempotencyKey: randomUUID(),
      payload: { label: 'moved after restore', expectedVersion: 1 },
    });
    expect(
      await refusal(
        s.proposals.commitProposal(a1(), ids.approvedStale.ref, { payload: ids.approvedStale.payload }),
      ),
    ).toBe('stale_version');
    const { rows } = await restored.admin.query(
      'SELECT state, disposition_reason FROM cuspatlas.action_proposals WHERE id = $1',
      [ids.approvedStale.ref],
    );
    expect(rows[0]).toEqual({ state: 'rejected', disposition_reason: 'stale_version' });
  });

  it('the migrator refuses the restored database once an applied migration digest is tampered', async () => {
    const c = await restored.admin.connect();
    try {
      await expect(migrate(c, { dir: MIGRATIONS })).resolves.toEqual({ applied: [] });
      await c.query(
        `UPDATE public.schema_migrations SET checksum = repeat('0', 64)
         WHERE version = (SELECT min(version) FROM public.schema_migrations)`,
      );
      await expect(migrate(c, { dir: MIGRATIONS })).rejects.toThrow(/has changed on disk/);
    } finally {
      c.release();
    }
  });
});

describe('deliberately incomplete or unsafe restores are detected', () => {
  it('(a1) a backup that omitted the receipts table, with a consistent manifest, fails verification', async () => {
    const dir = copyBackup('no-receipts');
    rmSync(join(dir, 'tables', 'delivery_receipts.ndjson'));
    rewriteManifest(dir, (m) => ({ ...m, tables: m.tables.filter((t) => t.name !== 'delivery_receipts') }));
    const target = targetName('a1');
    const err = await restoreBackup(adminConn(), {
      backupDir: dir,
      target,
      confirmTarget: target,
      migrationsDir: MIGRATIONS,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreVerificationError);
    expect((err as RestoreVerificationError).failures).toContain(
      'table delivery_receipts exists in the schema but is missing from the backup',
    );
  });

  it('(a2) receipts rows dropped from the data file, file digest recomputed, fails on the row count', async () => {
    const dir = copyBackup('short-receipts');
    const file = join(dir, 'tables', 'delivery_receipts.ndjson');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    const body = `${lines.slice(1).join('\n')}\n`;
    writeFileSync(file, body);
    rewriteManifest(dir, (m) => ({
      ...m,
      tables: m.tables.map((t) => (t.name === 'delivery_receipts' ? { ...t, fileSha256: sha256(body) } : t)),
    }));
    const target = targetName('a2');
    const err = await restoreBackup(adminConn(), {
      backupDir: dir,
      target,
      confirmTarget: target,
      migrationsDir: MIGRATIONS,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreVerificationError);
    expect((err as RestoreVerificationError).failures).toContain(
      `table delivery_receipts: ${lines.length - 1} rows restored, ${lines.length} backed up`,
    );
  });

  it('(b) one byte changed in a data file is refused before any database is created', async () => {
    const dir = copyBackup('flip');
    const file = join(dir, 'tables', 'synthetic_tasks.ndjson');
    const buf = readFileSync(file);
    buf[10] = (buf[10] ?? 0) ^ 0x01;
    writeFileSync(file, buf);
    const target = targetName('b');
    expect(
      await restoreRefusal(
        restoreBackup(adminConn(), {
          backupDir: dir,
          target,
          confirmTarget: target,
          migrationsDir: MIGRATIONS,
        }),
      ),
    ).toBe('backup_digest_mismatch');
    expect(await databaseExists(target)).toBe(false);

    const dir2 = copyBackup('manifest-edit');
    const m = readFileSync(join(dir2, MANIFEST_FILE), 'utf8').replace('"createdAt": "', '"createdAt": "1');
    writeFileSync(join(dir2, MANIFEST_FILE), m);
    expect(
      await restoreRefusal(
        restoreBackup(adminConn(), {
          backupDir: dir2,
          target,
          confirmTarget: target,
          migrationsDir: MIGRATIONS,
        }),
      ),
    ).toBe('manifest_digest_mismatch');
  });

  it('(c) restoring onto the source database, or onto any existing database, is refused', async () => {
    const opts = { backupDir, migrationsDir: MIGRATIONS };
    expect(
      await restoreRefusal(restoreBackup(adminConn(), { ...opts, target: db.name, confirmTarget: db.name })),
    ).toBe('target_is_source');
    expect(
      await restoreRefusal(
        restoreBackup(adminConn(), { ...opts, target: restoredName, confirmTarget: restoredName }),
      ),
    ).toBe('target_exists');
    const conn = adminConn({ database: restoredName });
    expect(
      await restoreRefusal(
        restoreBackup(conn, { ...opts, target: restoredName, confirmTarget: restoredName }),
      ),
    ).toBe('target_is_connection_database');
    const other = targetName('conn');
    expect(
      await restoreRefusal(restoreBackup(conn, { ...opts, target: other, confirmTarget: `${other}x` })),
    ).toBe('target_unconfirmed');
  });

  it('(d) target names without the synthetic marker, unconfirmed targets and non-loopback hosts are refused', async () => {
    const opts = { backupDir, migrationsDir: MIGRATIONS };
    expect(
      await restoreRefusal(
        restoreBackup(adminConn(), { ...opts, target: 'restore_copy', confirmTarget: 'restore_copy' }),
      ),
    ).toBe('target_not_synthetic');
    const t = targetName('d');
    expect(
      await restoreRefusal(restoreBackup(adminConn(), { ...opts, target: t, confirmTarget: undefined })),
    ).toBe('target_unconfirmed');
    expect(
      await restoreRefusal(
        restoreBackup(adminConn(), { ...opts, target: undefined, confirmTarget: undefined }),
      ),
    ).toBe('target_unconfirmed');
    expect(
      await restoreRefusal(
        restoreBackup(adminConn({ host: '10.0.0.5' }), { ...opts, target: t, confirmTarget: t }),
      ),
    ).toBe('host_not_allowed');
    expect(await databaseExists(t)).toBe(false);
  });

  it('a backup is refused for a role filtered by RLS and for a directory inside the repository', async () => {
    const c = await db.admin.connect();
    try {
      await expect(
        createBackup(c, { outDir: join(REPO_ROOT, 'artifacts', 'dump'), repoRoot: REPO_ROOT }),
      ).rejects.toThrow(/inside the repository/);
      await c.query('SET ROLE cuspatlas_app');
      await expect(createBackup(c, { outDir: tmp('rls'), repoRoot: REPO_ROOT })).rejects.toThrow(
        /bypasses row level security/,
      );
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  });

  it('(e) a target cluster without the runtime role is refused; after the operator creates it the restore verifies', async () => {
    const dataDir = tmp('cluster2');
    const password = randomBytes(18).toString('base64url');
    const srv = await import('node:net').then(
      (net) =>
        new Promise<number>((ok, fail) => {
          const s = net.createServer();
          s.once('error', fail);
          s.listen(0, '127.0.0.1', () => {
            const a = s.address();
            s.close(() => (typeof a === 'object' && a ? ok(a.port) : fail(new Error('no port'))));
          });
        }),
    );
    const cluster = new EmbeddedPostgres({
      databaseDir: join(dataDir, 'data'),
      user: 'postgres',
      password,
      port: srv,
      // Removal is ours (after the cluster has fully stopped), with retries, not the library's.
      persistent: true,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'log_min_error_statement=panic'],
      onLog: () => undefined,
      onError: () => undefined,
    });
    // Windows: start through pg_ctl, as the global setup does (postgres.exe refuses an administrator
    // account, and embedded-postgres then rejects start() with no error at all).
    const pgCtl = process.platform === 'win32' ? await pgCtlBinary() : '';
    await cluster.initialise();
    if (pgCtl) startWithPgCtl(pgCtl, join(dataDir, 'data'), srv, join(dataDir, 'cluster2.log'));
    else await cluster.start();
    try {
      const conn: RestoreConnection = {
        host: '127.0.0.1',
        port: srv,
        user: 'postgres',
        password,
        database: 'postgres',
      };
      const target = 'cuspatlas_synthetic_cluster2_restore';
      expect(
        await restoreRefusal(
          restoreBackup(conn, { backupDir, target, confirmTarget: target, migrationsDir: MIGRATIONS }),
        ),
      ).toBe('runtime_role_missing');
      const c = new pg.Client(conn);
      await c.connect();
      try {
        expect((await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [target])).rowCount).toBe(0);
        await c.query('CREATE ROLE cuspatlas_app NOLOGIN');
      } finally {
        await c.end();
      }
      const report = await restoreBackup(conn, {
        backupDir,
        target,
        confirmTarget: target,
        migrationsDir: MIGRATIONS,
      });
      expect(report.verified).toBe(true);
      const t = new pg.Client({ ...conn, database: target });
      await t.connect();
      try {
        await t.query('BEGIN');
        await t.query('SET LOCAL ROLE cuspatlas_app');
        expect((await t.query('SELECT count(*)::int AS n FROM cuspatlas.synthetic_tasks')).rows[0].n).toBe(0);
        await t.query('ROLLBACK');
        expect((await t.query('SELECT count(*)::int AS n FROM cuspatlas.synthetic_tasks')).rows[0].n).toBe(
          before.counts.synthetic_tasks,
        );
      } finally {
        await t.end();
      }
    } finally {
      if (pgCtl) stopWithPgCtl(pgCtl, join(dataDir, 'data'));
      else await cluster.stop();
      // stop() resolves when the process tree exited (taskkill /t on Windows); file handles can linger
      // briefly (EBUSY), so removal retries with backoff and a leftover is retried again in afterAll.
      await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(
        () => undefined,
      );
    }
    // Starts and stops a second embedded cluster; allow for a loaded host.
  }, 240_000);
});
