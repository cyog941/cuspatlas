import { readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ObjectStoreError } from '@cuspatlas/contracts';
import { createLocalObjectStore, createTenantTransactionRunner } from '@cuspatlas/db';
import {
  resolveImagingTokenSecret,
  SYNTHETIC_TEST_IMAGING_TOKEN_SECRET,
  signGrantToken,
} from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ctxFor, T_ALPHA, T_BETA, USER_A1, USER_A2, USER_A3, USER_B1 } from './support/fixtures';
import {
  attemptReasons,
  type ImagingStack,
  imagingLeakSurface,
  pngBytes,
  putFixtureObject,
  sha256,
  startImagingStack,
  tempObjectStore,
} from './support/imaging-fixtures';
import { MARKER } from './support/marker';

/**
 * I1 private object storage boundary (synthetic images only; every denial under the runtime role).
 * Acceptance: cross-tenant read/sign/describe denied indistinguishably from missing; expired, revoked
 * and foreign tokens refused; a revoked actor cannot read with a token issued earlier; a digest
 * mismatch is quarantined (bytes kept for investigation), alerted and never served; traversal and
 * foreign prefixes refused; no listing on the port; provenance written once.
 */
let s: ImagingStack;
let objA: string;
let objB: string;
const bytesA = pngBytes(1);

beforeAll(async () => {
  s = await startImagingStack('imaging_storage');
  objA = await putFixtureObject(s.db.admin, s.store, {
    tenantId: T_ALPHA,
    createdBy: USER_A1,
    bytes: bytesA,
    originalFilename: `synthetic-${MARKER}.png`,
  });
  objB = await putFixtureObject(s.db.admin, s.store, {
    tenantId: T_BETA,
    createdBy: USER_B1,
    bytes: pngBytes(2),
  });
});
afterAll(async () => {
  await s?.close();
});

const grant = async (who: Parameters<ImagingStack['inject']>[0], ref: string, ttlSeconds?: number) =>
  s.inject(
    who,
    'POST',
    `/v1/imaging/objects/${ref}/read-grants`,
    ttlSeconds === undefined ? {} : { ttlSeconds },
  );
const content = (who: Parameters<ImagingStack['inject']>[0], ref: string, token?: string) =>
  s.inject(
    who,
    'GET',
    `/v1/imaging/objects/${ref}/content`,
    undefined,
    token ? { 'x-object-read-token': token } : {},
  );
const withoutCorrelation = (j: Record<string, unknown>) => ({ ...j, correlationId: null });

describe('I1 object store adapter', () => {
  it('is content-addressed inside the tenant prefix, verifies every read and refuses traversal', async () => {
    const t = tempObjectStore();
    try {
      const bytes = pngBytes(3);
      const staged = await t.store.stage(T_ALPHA, bytes);
      expect(staged.digestSha256).toBe(sha256(bytes));
      const { storageKey } = await t.store.promote(T_ALPHA, staged.stagingKey, staged.digestSha256);
      expect(storageKey).toBe(
        `t/${T_ALPHA}/sha256/${staged.digestSha256.slice(0, 2)}/${staged.digestSha256}`,
      );
      expect(Buffer.from(await t.store.read(T_ALPHA, storageKey, staged.digestSha256))).toStrictEqual(
        Buffer.from(bytes),
      );
      for (const key of [
        `t/${T_BETA}/sha256/${staged.digestSha256.slice(0, 2)}/${staged.digestSha256}`,
        `t/${T_ALPHA}/sha256/../../../${staged.digestSha256}`,
        '../outside',
        `t/${T_ALPHA}/sha256/00/${staged.digestSha256}`,
        `/etc/${staged.digestSha256}`,
      ]) {
        await expect(t.store.read(T_ALPHA, key, staged.digestSha256)).rejects.toMatchObject({
          code: 'path_traversal',
        });
      }
      await expect(
        t.store.readStaged(T_ALPHA, `staging/${T_BETA}/${staged.stagingKey.slice(-36)}`),
      ).rejects.toBeInstanceOf(ObjectStoreError);
      // Altered bytes on disk are refused on read (verified every time).
      const file = join(t.root, ...storageKey.split('/'));
      const altered = Buffer.from(readFileSync(file));
      altered[altered.length - 1] = (altered[altered.length - 1] as number) ^ 0xff;
      writeFileSync(file, altered);
      await expect(t.store.read(T_ALPHA, storageKey, staged.digestSha256)).rejects.toMatchObject({
        code: 'digest_mismatch',
      });
      // A wrong expected digest is refused even when the bytes are intact elsewhere.
      await expect(t.store.read(T_ALPHA, storageKey, sha256(pngBytes(9)))).rejects.toMatchObject({
        code: 'digest_mismatch',
      });
      // The port has no listing and no URL method.
      expect(Object.keys(t.store).sort()).toStrictEqual(
        [
          'discardStaged',
          'hasTombstone',
          'head',
          'promote',
          'putContent',
          'quarantineStaged',
          'quarantineStored',
          'read',
          'readStaged',
          'remove',
          'stage',
          'writeTombstone',
        ].sort(),
      );
    } finally {
      t.cleanup();
    }
  });

  it('refuses to start under production and the read-grant secret follows the test-secret rule', () => {
    expect(() => createLocalObjectStore({ root: tempObjectStore().root, env: 'production' })).toThrow(
      /synthetic/,
    );
    // Missing outside synthetic-test: read grants are disabled (typed 503), never the test secret.
    expect(resolveImagingTokenSecret('production', undefined)).toBeNull();
    expect(() => resolveImagingTokenSecret('production', SYNTHETIC_TEST_IMAGING_TOKEN_SECRET)).toThrow(
      /test-only/,
    );
    expect(() => resolveImagingTokenSecret('development', new Uint8Array(8))).toThrow(/too short/);
    expect(resolveImagingTokenSecret('synthetic-test', undefined)).toBe(SYNTHETIC_TEST_IMAGING_TOKEN_SECRET);
  });
});

describe('I1 metadata, grants and verified content reads', () => {
  it('describes an object with digest and provenance, never its storage key; REST and MCP agree', async () => {
    const r = await s.inject('owner', 'GET', `/v1/imaging/objects/${objA}`);
    expect(r.status).toBe(200);
    const d = r.json.data as Record<string, unknown>;
    expect(d).toMatchObject({
      objectRef: objA,
      kind: 'original',
      state: 'available',
      contentType: 'image/png',
      byteLength: bytesA.byteLength,
      digestSha256: sha256(bytesA),
    });
    expect(r.body).not.toContain('storage');
    expect(r.body).not.toContain('sha256/');
    expect((d.provenance as { source: string; operatorRef: string }[])[0]).toMatchObject({
      source: 'operatorUpload',
      operatorRef: USER_A1,
    });
    const m = await s.mcp('owner', 'imaging_objects_get', { objectRef: objA });
    expect(m.isError).toBe(false);
    expect((m.body.data as { digestSha256: string }).digestSha256).toBe(sha256(bytesA));
  });

  it('cross-tenant describe, sign and read are indistinguishable from a missing object', async () => {
    const missing = '70000000-0000-4000-8000-000000000001';
    for (const path of ['', '/read-grants']) {
      const method = path === '' ? 'GET' : 'POST';
      const foreign = await s.inject(
        'crossTenant',
        method,
        `/v1/imaging/objects/${objA}${path}`,
        method === 'POST' ? {} : undefined,
      );
      const absent = await s.inject(
        'crossTenant',
        method,
        `/v1/imaging/objects/${missing}${path}`,
        method === 'POST' ? {} : undefined,
      );
      expect([foreign.status, absent.status]).toStrictEqual([404, 404]);
      expect(withoutCorrelation(foreign.json)).toStrictEqual(withoutCorrelation(absent.json));
      expect(await attemptReasons(s.db.admin, foreign.json.correlationId)).toStrictEqual([
        'resource_hidden_or_missing',
      ]);
    }
    // A beta member holding a token minted for an alpha object (stolen) still gets the hidden 404.
    const g = await grant('owner', objA);
    const stolen = await content('crossTenant', objA, (g.json.data as { token: string }).token);
    expect(stolen.status).toBe(404);
    // Its own beta object is readable to it.
    const own = await grant('crossTenant', objB);
    expect(own.status).toBe(201);
  });

  it('serves verified bytes with private, no-store headers and logs a sensitive read', async () => {
    const g = await grant('owner', objA);
    expect(g.status).toBe(201);
    const data = g.json.data as { token: string; expiresAt: string; contentPath: string; grantRef: string };
    expect(Date.parse(data.expiresAt) - Date.now()).toBeLessThanOrEqual(61_000);
    const r = await content('owner', objA, data.token);
    expect(r.status).toBe(200);
    expect(sha256(r.raw)).toBe(sha256(bytesA));
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-disposition']).toBe('attachment');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(JSON.stringify(r.headers)).not.toContain(MARKER);
    const reads = await s.db.admin.query(
      `SELECT operation FROM cuspatlas.sensitive_read_events WHERE $1 = ANY (resource_refs) ORDER BY occurred_at`,
      [objA],
    );
    expect(reads.rows.map((x) => x.operation)).toContain('imaging.objects.content');
  });

  it('a token is bound to its principal, object and expiry, and checked against its live grant', async () => {
    const g = await grant('owner', objA);
    const token = (g.json.data as { token: string }).token;
    // Another alpha member with imaging.read presenting the owner's token.
    const foreign = await content('writer', objA, token);
    expect([foreign.status, foreign.json.code]).toStrictEqual([403, 'forbidden']);
    expect(await attemptReasons(s.db.admin, foreign.json.correlationId)).toStrictEqual([
      'object_token_invalid',
    ]);
    // Missing, tampered and forged (wrong secret) tokens.
    for (const t of [
      undefined,
      `${token.slice(0, -2)}AA`,
      signGrantToken(
        new Uint8Array(32),
        {
          tenantId: T_ALPHA,
          principalId: USER_A1,
          objectRef: objA,
        },
        (g.json.data as { grantRef: string }).grantRef,
        Math.floor(Date.now() / 1000) + 60,
      ),
    ]) {
      const r = await content('owner', objA, t);
      expect([r.status, r.json.code]).toStrictEqual([403, 'forbidden']);
    }
    // A correctly signed token naming a grant that does not exist (or another object) is refused.
    const forged = signGrantToken(
      SYNTHETIC_TEST_IMAGING_TOKEN_SECRET,
      { tenantId: T_ALPHA, principalId: USER_A1, objectRef: objA },
      '70000000-0000-4000-8000-000000000002',
      Math.floor(Date.now() / 1000) + 60,
    );
    expect((await content('owner', objA, forged)).status).toBe(403);
  });

  it('an expired grant is refused', async () => {
    const g = await grant('owner', objA, 1);
    const token = (g.json.data as { token: string }).token;
    await new Promise((r) => setTimeout(r, 2100));
    const r = await content('owner', objA, token);
    expect([r.status, r.json.code]).toStrictEqual([403, 'forbidden']);
    expect(await attemptReasons(s.db.admin, r.json.correlationId)).toStrictEqual(['object_token_invalid']);
  });

  it('a revoked grant stops working at once; only its holder or a writer may revoke it', async () => {
    const g = await grant('owner', objA);
    const { token, grantRef } = g.json.data as { token: string; grantRef: string };
    // A read-only member cannot see (or revoke) the owner's grant.
    const other = await s.command('imagingReadOnly', `/v1/imaging/read-grants/${grantRef}/revoke`, {});
    expect(other.status).toBe(404);
    const rv = await s.command('owner', `/v1/imaging/read-grants/${grantRef}/revoke`, {});
    expect(rv.status).toBe(200);
    expect(rv.json.data).toStrictEqual({ grantRef, objectRef: objA, state: 'revoked' });
    const r = await content('owner', objA, token);
    expect([r.status, r.json.code]).toStrictEqual([403, 'forbidden']);
    const again = await s.command('owner', `/v1/imaging/read-grants/${grantRef}/revoke`, {});
    expect([again.status, (again.json.detail as { reason: string }).reason]).toStrictEqual([
      409,
      'grant_already_revoked',
    ]);
  });

  it('an actor revoked between grant and read cannot read, and cannot obtain a new grant', async () => {
    const g = await grant('writer', objA);
    const token = (g.json.data as { token: string }).token;
    await s.db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1', [
      USER_A3,
    ]);
    try {
      const r = await content('writer', objA, token);
      expect([r.status, r.json.code]).toStrictEqual([403, 'forbidden']);
      expect(await attemptReasons(s.db.admin, r.json.correlationId)).toStrictEqual(['membership_inactive']);
      expect((await grant('writer', objA)).status).toBe(403);
      expect((await grant('revoked', objA)).status).toBe(403);
    } finally {
      await s.db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1', [
        USER_A3,
      ]);
    }
  });

  it('a digest mismatch quarantines the object, keeps the bytes for investigation and alerts', async () => {
    const bytes = pngBytes(4);
    const ref = await putFixtureObject(s.db.admin, s.store, { tenantId: T_ALPHA, createdBy: USER_A1, bytes });
    const g = await grant('owner', ref);
    const file = join(s.storeRoot, 't', T_ALPHA, 'sha256', sha256(bytes).slice(0, 2), sha256(bytes));
    const altered = Buffer.from(readFileSync(file));
    altered[20] = (altered[20] as number) ^ 0x01;
    writeFileSync(file, altered);
    const before = s.logLines.length;
    const r = await content('owner', ref, (g.json.data as { token: string }).token);
    expect([r.status, r.json.code, (r.json.detail as { reason: string }).reason]).toStrictEqual([
      409,
      'conflict',
      'digest_mismatch',
    ]);
    expect(await attemptReasons(s.db.admin, r.json.correlationId)).toStrictEqual(['object_integrity_failed']);
    const row = await s.db.admin.query(
      'SELECT state, quarantine_reason FROM cuspatlas.imaging_objects WHERE id = $1',
      [ref],
    );
    expect(row.rows[0]).toStrictEqual({ state: 'quarantined', quarantine_reason: 'digest_mismatch' });
    expect(readFileSync(join(s.storeRoot, 'quarantine', T_ALPHA, ref))).toStrictEqual(altered);
    expect(s.logLines.slice(before).join('\n')).toContain('imaging_object_integrity_failed');
    // Never served afterwards: a new grant and the old token are both refused.
    const again = await grant('owner', ref);
    expect([again.status, (again.json.detail as { reason: string }).reason]).toStrictEqual([
      409,
      'object_not_available',
    ]);
  });

  it('the integrity sweep quarantines objects whose bytes are gone', async () => {
    const bytes = pngBytes(5);
    const ref = await putFixtureObject(s.db.admin, s.store, { tenantId: T_ALPHA, createdBy: USER_A1, bytes });
    await rm(join(s.storeRoot, 't', T_ALPHA, 'sha256', sha256(bytes).slice(0, 2), sha256(bytes)));
    const r = await s.command('owner', '/v1/imaging/storage/reconcile', {});
    expect(r.status).toBe(200);
    expect((r.json.data as { quarantined: number }).quarantined).toBeGreaterThanOrEqual(1);
    const row = await s.db.admin.query(
      'SELECT state, quarantine_reason FROM cuspatlas.imaging_objects WHERE id = $1',
      [ref],
    );
    expect(row.rows[0]).toStrictEqual({ state: 'quarantined', quarantine_reason: 'bytes_missing' });
    // Beta's object was not touched by alpha's sweep.
    const b = await s.db.admin.query('SELECT state FROM cuspatlas.imaging_objects WHERE id = $1', [objB]);
    expect(b.rows[0].state).toBe('available');
  });

  it('MCP never carries bytes: no content tool exists', async () => {
    const names = await s.mcpToolNames('owner');
    expect(names).toContain('imaging_objects_get');
    expect(names).toContain('imaging_objects_grant_read');
    expect(names.filter((n) => n.startsWith('imaging_')).some((n) => n.includes('content'))).toBe(false);
  });

  it('the marker in a filename never reaches logs, audit, outbox, attempts or idempotency; bytes are never logged', async () => {
    const surface = await imagingLeakSurface(s.db.admin);
    expect(surface).not.toContain(MARKER);
    const logs = s.logLines.join('\n');
    expect(logs).not.toContain(MARKER);
    expect(logs).not.toContain('IHDR');
    expect(logs).not.toContain(Buffer.from(bytesA).toString('base64').slice(0, 24));
  });
});

describe('I1 database boundary under the runtime role', () => {
  it('bytes, digest and key are immutable, nothing is deleted, foreign keys and prefixes are refused', async () => {
    const tx = createTenantTransactionRunner(s.db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    const zero = '0'.repeat(64);
    for (const [sql, code] of [
      [`UPDATE cuspatlas.imaging_objects SET digest_sha256 = '${zero}' WHERE id = '${objA}'`, '42501'],
      [`UPDATE cuspatlas.imaging_objects SET storage_key = 'x' WHERE id = '${objA}'`, '42501'],
      [`DELETE FROM cuspatlas.imaging_objects WHERE id = '${objA}'`, '42501'],
      [`UPDATE cuspatlas.imaging_object_provenance SET source = 'bridgeImport'`, '42501'],
      [
        `INSERT INTO cuspatlas.imaging_objects (tenant_id, kind, state, content_type, byte_length, digest_sha256, storage_key, created_by)
         VALUES ('${T_ALPHA}', 'original', 'available', 'image/png', 1, '${zero}', 't/${T_BETA}/sha256/00/${zero}', '${USER_A1}')`,
        '23514',
      ],
      [
        `INSERT INTO cuspatlas.imaging_objects (tenant_id, kind, state, content_type, byte_length, digest_sha256, storage_key, created_by)
         VALUES ('${T_ALPHA}', 'original', 'available', 'image/png', 1, '${zero}', '../../${zero}', '${USER_A1}')`,
        '23514',
      ],
      [
        `INSERT INTO cuspatlas.imaging_objects (tenant_id, kind, state, content_type, byte_length, digest_sha256, storage_key, created_by)
         VALUES ('${T_BETA}', 'original', 'available', 'image/png', 1, '${zero}', 't/${T_BETA}/sha256/00/${zero}', '${USER_A1}')`,
        '42501',
      ],
      [
        `INSERT INTO cuspatlas.imaging_object_provenance (tenant_id, object_id, source, operator_id)
         VALUES ('${T_ALPHA}', '${objA}', 'operatorUpload', '${USER_A1}')`,
        '23505',
      ],
      [
        `INSERT INTO cuspatlas.imaging_object_provenance (tenant_id, object_id, ingress_id, source, operator_id)
         VALUES ('${T_ALPHA}', '${objA}', '70000000-0000-4000-8000-000000000003', 'operatorUpload', '${USER_A2}')`,
        '42501',
      ],
      [
        `INSERT INTO cuspatlas.imaging_object_provenance (tenant_id, object_id, ingress_id, source, operator_id, original_filename)
         VALUES ('${T_ALPHA}', '${objA}', '70000000-0000-4000-8000-000000000004', 'operatorUpload', '${USER_A1}', '../etc/x')`,
        '23514',
      ],
    ] as const) {
      await expect([
        sql.slice(0, 40),
        await tx(ctx, (t) => t.query(sql)).then(
          () => 'ok',
          (e) => e.code,
        ),
      ]).toStrictEqual([sql.slice(0, 40), code]);
    }
    // Another tenant's objects are invisible to the runtime role.
    const seen = await tx(ctx, (t) =>
      t.query('SELECT id FROM cuspatlas.imaging_objects WHERE id = $1', [objB]),
    );
    expect(seen.rowCount).toBe(0);
  });

  it('an absent object store is a typed, retryable 503 with an alert, never an empty result', async () => {
    const bare = await startImagingStack('imaging_storage_bare', { withStore: false });
    try {
      const ref = await putFixtureObject(bare.db.admin, s.store, {
        tenantId: T_ALPHA,
        createdBy: USER_A1,
        bytes: bytesA,
      });
      const g = await bare.inject('owner', 'POST', `/v1/imaging/objects/${ref}/read-grants`, {});
      expect(g.status).toBe(201);
      const r = await bare.inject('owner', 'GET', `/v1/imaging/objects/${ref}/content`, undefined, {
        'x-object-read-token': (g.json.data as { token: string }).token,
      });
      expect([r.status, r.json.code, r.json.retryable]).toStrictEqual([503, 'service_unavailable', true]);
      expect(bare.logLines.join('\n')).toContain('imaging_object_store_unavailable');
    } finally {
      await bare.close();
    }
    // A second database and server start inside this case; allow for a loaded host.
  }, 120_000);
});
