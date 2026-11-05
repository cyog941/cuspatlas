import { randomUUID } from 'node:crypto';
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA, T_BETA, USER_A1 } from './support/fixtures';
import {
  type ImagingStack,
  pngBytes,
  putFixtureObject,
  sha256,
  startImagingStack,
  type Who,
} from './support/imaging-fixtures';

/**
 * Closeout A5: orphan-bytes removal. Content-addressed files under the caller's tenant prefix that no
 * imaging object row (live, quarantined or tombstoned), no export package and no legal hold references
 * are candidates once older than the grace period; a dry run (the default) only reports them; a real
 * run removes them under the content lock with an audit record. Human practice administration only.
 */
let s: ImagingStack;
let seed = 9100;
const next = () => {
  seed += 1;
  return pngBytes(seed, 5, 5);
};
const PATH = '/v1/imaging/storage/orphan-bytes/sweep';
const TOOL = 'imaging_storage_sweep_orphan_bytes';
const AGED = () => new Date(Date.now() - 48 * 3600 * 1000);
const blobPath = (tenant: string, digest: string) =>
  join(s.storeRoot, 't', tenant, 'sha256', digest.slice(0, 2), digest);

interface SweepData {
  sweepRef: string;
  dryRun: boolean;
  graceHours: number;
  scanned: number;
  orphans: string[];
  removed: string[];
  kept: Record<
    'withinGrace' | 'liveObject' | 'tombstoneRetained' | 'legalHold' | 'exportPackage' | 'contentLocked',
    number
  >;
  more: boolean;
}
const sweep = (body: Record<string, unknown> = {}, who: Who = 'owner', key?: string) =>
  s.command(who, PATH, body, key);
const data = (r: { json: Record<string, unknown> }) => r.json.data as SweepData;

/** An unreferenced content file (as left by a promotion whose transaction rolled back). */
async function orphan(tenant = T_ALPHA, aged = true) {
  const { digestSha256 } = await s.store.putContent(tenant, next());
  if (aged) utimesSync(blobPath(tenant, digestSha256), AGED(), AGED());
  return digestSha256;
}
async function referenced() {
  const bytes = next();
  const objectRef = await putFixtureObject(s.db.admin, s.store, {
    tenantId: T_ALPHA,
    createdBy: USER_A1,
    bytes,
  });
  const digest = sha256(bytes);
  utimesSync(blobPath(T_ALPHA, digest), AGED(), AGED());
  return { objectRef, digest };
}

beforeAll(async () => {
  s = await startImagingStack('imaging_orphan_bytes');
});
afterAll(async () => {
  await s?.close();
});

describe('A5 orphan-bytes sweep', () => {
  it('dry run is the default: an orphan older than the grace period is reported and kept', async () => {
    const d = await orphan();
    const r = await sweep();
    expect(r.status).toBe(200);
    const out = data(r);
    expect(out.dryRun).toBe(true);
    expect(out.graceHours).toBe(24);
    expect(out.orphans).toContain(d);
    expect(out.removed).toStrictEqual([]);
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(true);
    const rec = await s.db.admin.query(
      'SELECT dry_run, removed_digests FROM cuspatlas.imaging_orphan_sweeps WHERE id = $1',
      [out.sweepRef],
    );
    expect(rec.rows[0]).toStrictEqual({ dry_run: true, removed_digests: [] });
  });

  it('a real run removes the orphan and records the actor, counts and removed digests', async () => {
    const d = await orphan();
    const r = await sweep({ dryRun: false });
    expect(r.status).toBe(200);
    const out = data(r);
    expect(out.dryRun).toBe(false);
    expect(out.removed).toContain(d);
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(false);
    const rec = await s.db.admin.query(
      `SELECT tenant_id, actor_id, dry_run, removed_digests, orphan_count, scanned_count
       FROM cuspatlas.imaging_orphan_sweeps WHERE id = $1`,
      [out.sweepRef],
    );
    expect(rec.rows[0].tenant_id).toBe(T_ALPHA);
    expect(rec.rows[0].actor_id).toBe(USER_A1);
    expect(rec.rows[0].dry_run).toBe(false);
    expect(rec.rows[0].removed_digests).toContain(d);
    expect(rec.rows[0].scanned_count).toBe(out.scanned);
    const audit = await s.db.admin.query(
      `SELECT actor_id, resource_type FROM cuspatlas.audit_events
       WHERE operation = 'imaging.storage.sweepOrphanBytes' AND resource_ref = $1`,
      [out.sweepRef],
    );
    expect(audit.rows).toStrictEqual([{ actor_id: USER_A1, resource_type: 'imagingOrphanSweep' }]);
    // Idempotent in effect: a new run has nothing more to remove for that digest.
    expect(data(await sweep({ dryRun: false })).removed).not.toContain(d);
  });

  it('a same-key retry replays the recorded outcome', async () => {
    await orphan();
    const key = randomUUID();
    const a = await sweep({ dryRun: false }, 'owner', key);
    const b = await sweep({ dryRun: false }, 'owner', key);
    expect(b.status).toBe(200);
    expect(b.json.replayed).toBe(true);
    expect(data(b).sweepRef).toBe(data(a).sweepRef);
  });

  it('a file younger than the grace period is kept', async () => {
    const d = await orphan(T_ALPHA, false);
    const r = await sweep({ dryRun: false });
    expect(data(r).orphans).not.toContain(d);
    expect(data(r).kept.withinGrace).toBeGreaterThanOrEqual(1);
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(true);
  });

  it('bytes of a live object are kept', async () => {
    const { digest } = await referenced();
    const r = await sweep({ dryRun: false });
    expect(data(r).orphans).not.toContain(digest);
    expect(data(r).kept.liveObject).toBeGreaterThanOrEqual(1);
    expect(existsSync(blobPath(T_ALPHA, digest))).toBe(true);
  });

  it('bytes still referenced by a tombstoned object row are kept', async () => {
    const { objectRef, digest } = await referenced();
    await s.db.admin.query(
      `UPDATE cuspatlas.imaging_objects SET state = 'deleted', deleted_at = now(), version = version + 1
       WHERE id = $1`,
      [objectRef],
    );
    const r = await sweep({ dryRun: false });
    expect(data(r).orphans).not.toContain(digest);
    expect(data(r).kept.tombstoneRetained).toBeGreaterThanOrEqual(1);
    expect(existsSync(blobPath(T_ALPHA, digest))).toBe(true);
  });

  it('bytes of an object under legal hold are kept', async () => {
    const { objectRef, digest } = await referenced();
    const h = await s.command('owner', '/v1/imaging/legal-holds', {
      subject: { kind: 'object', ref: objectRef },
      reasonCode: 'litigation_hold',
    });
    expect(h.status).toBe(201);
    const r = await sweep({ dryRun: false });
    expect(data(r).orphans).not.toContain(digest);
    expect(data(r).kept.legalHold).toBeGreaterThanOrEqual(1);
    expect(existsSync(blobPath(T_ALPHA, digest))).toBe(true);
  });

  it('an orphan whose content lock is held (an ingest of the same bytes in flight) is kept', async () => {
    const d = await orphan();
    const c = await s.db.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT cuspatlas.imaging_lock_content($1, $2)', [T_ALPHA, d]);
      const r = await sweep({ dryRun: false });
      expect(r.status).toBe(200);
      expect(data(r).removed).not.toContain(d);
      expect(data(r).kept.contentLocked).toBeGreaterThanOrEqual(1);
      expect(existsSync(blobPath(T_ALPHA, d))).toBe(true);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('a grace period outside 1..720 hours is refused', async () => {
    expect((await sweep({ graceHours: 0 })).status).toBe(400);
    expect((await sweep({ graceHours: 721 })).status).toBe(400);
  });

  it('only the caller tenant prefix is swept: another tenant never sees or removes alpha bytes', async () => {
    const alpha = await orphan(T_ALPHA);
    const beta = await orphan(T_BETA);
    const r = await sweep({ dryRun: false }, 'crossTenant');
    expect(r.status).toBe(200);
    expect(data(r).removed).toContain(beta);
    expect(data(r).orphans).not.toContain(alpha);
    expect(existsSync(blobPath(T_ALPHA, alpha))).toBe(true);
    expect(existsSync(blobPath(T_BETA, beta))).toBe(false);
  });

  it('non-administrators, service principals and revoked members are refused; nothing is removed', async () => {
    const d = await orphan();
    for (const who of ['deleter', 'writer', 'imagingReadOnly', 'noImagingScopes', 'service'] as const) {
      expect([who, (await sweep({ dryRun: false }, who)).status]).toStrictEqual([who, 403]);
    }
    expect([401, 403]).toContain((await sweep({ dryRun: false }, 'revoked')).status);
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(true);
  });

  it('an administrator without imaging.delete may dry-run but not remove bytes', async () => {
    const d = await orphan();
    const id = randomUUID();
    await s.db.admin.query(
      `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', 'user-orphan-admin')`,
      [id],
    );
    await s.db.admin.query(
      'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)',
      [T_ALPHA, id, ['admin.configure', 'imaging.read']],
    );
    const token = await s.issue(id, T_ALPHA);
    const call = (body: unknown) =>
      s.app.inject({
        method: 'POST',
        url: PATH,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        payload: JSON.stringify(body),
      });
    expect((await call({})).statusCode).toBe(200);
    expect((await call({ dryRun: false })).statusCode).toBe(403);
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(true);
  });

  it('MCP runs the same operation (dry run) and refuses a service principal', async () => {
    const d = await orphan();
    const ok = await s.mcp('owner', TOOL, { idempotencyKey: randomUUID() });
    expect(ok.isError).toBe(false);
    expect(JSON.stringify(ok.body)).toContain(d);
    const svc = await s.mcp('service', TOOL, { idempotencyKey: randomUUID() });
    expect(svc.isError).toBe(true);
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(true);
  });
});
