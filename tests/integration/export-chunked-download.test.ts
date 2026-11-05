import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObjectStorePort } from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBillingScopes } from './support/billing-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { seedEngagementScopes } from './support/engagement-fixtures';
import { createAndBuild } from './support/export-jobs';
import { T_ALPHA, USER_A1, USER_B1 } from './support/fixtures';
import {
  type ImagingStack,
  ingestVia,
  pngBytes,
  startImagingStack,
  type Who,
} from './support/imaging-fixtures';
import { seedMigrationScopes } from './support/migration-fixtures';
import { patientBody } from './support/patient-fixtures';
import { seedSchedulingScopes } from './support/scheduling-fixtures';

/**
 * Closeout A8: chunked (HTTP Range) and streamed byte delivery of the two export download operations,
 * `practice.export.download` and `exports.download` (synthetic only). Bytes are the stored package
 * exactly as built; ETag and Repr-Digest carry the recorded package digest; every chunk passes the
 * whole policy layer (grant, tenant, role, membership) again and re-verifies the stored bytes.
 */
const CHUNK = 2048;
let s: ImagingStack;
let patientRef: string;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const b64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const OCTET = { accept: 'application/octet-stream' };

interface Target {
  readonly name: string;
  readonly url: string;
  /** Creates a package and returns its ref and the digest recorded at build time. */
  build(): Promise<{ exportRef: string; digest: string }>;
  grant(exportRef: string, who?: Who): Promise<{ token: string; grantRef: string }>;
  expireGrant(grantRef: string): Promise<void>;
  removeRole(): Promise<() => Promise<void>>;
}

async function setScopes(principal: string, add: string[], remove: string[] = []) {
  await s.db.admin.query(
    `UPDATE cuspatlas.memberships SET scopes = ARRAY(SELECT DISTINCT x FROM unnest(scopes || $2::text[]) x
       WHERE NOT x = ANY($3::text[])) WHERE principal_id = $1`,
    [principal, add, remove],
  );
}

const practice: Target = {
  name: 'practice.export.download',
  url: '/v1/practice/exports/package',
  async build() {
    const r = await s.command('owner', '/v1/practice/exports', { purpose: 'practiceExit' });
    expect([r.status, r.body.slice(0, 300)]).toStrictEqual([201, r.body.slice(0, 300)]);
    const d = data<{ exportRef: string; packageDigest: string }>(r);
    return { exportRef: d.exportRef, digest: d.packageDigest };
  },
  async grant(exportRef, who = 'owner') {
    const g = await s.command(who, '/v1/practice/exports/grants', { exportRef });
    expect(g.status).toBe(201);
    return data<{ token: string; grantRef: string }>(g);
  },
  async expireGrant(grantRef) {
    // Practice export grants are immutable (trigger); simulate the passage of time as the admin.
    const c = await s.db.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query(
        `UPDATE cuspatlas.practice_export_grants SET created_at = now() - interval '10 minutes',
           expires_at = now() - interval '9 minutes' WHERE id = $1`,
        [grantRef],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  },
  async removeRole() {
    await setScopes(USER_A1, [], ['admin.configure']);
    return () => setScopes(USER_A1, ['admin.configure']);
  },
};

const automation: Target = {
  name: 'exports.download',
  url: '/v1/exports/package',
  async build() {
    const r = await createAndBuild(s, 'owner', {
      formatVersion: 'cuspatlas-export/1',
      purpose: 'rightOfAccess',
      scope: 'patient',
      subjectRef: patientRef,
    });
    expect([r.status, r.body.slice(0, 300)]).toStrictEqual([201, r.body.slice(0, 300)]);
    const d = data<{ exportRef: string; packageDigest: string }>(r);
    return { exportRef: d.exportRef, digest: d.packageDigest };
  },
  async grant(exportRef, who = 'owner') {
    const g = await s.command(who, '/v1/exports/grants', { exportRef });
    expect([g.status, g.body.slice(0, 200)]).toStrictEqual([200, g.body.slice(0, 200)]);
    return data<{ token: string; grantRef: string }>(g);
  },
  async expireGrant(grantRef) {
    await s.db.admin.query(
      `UPDATE cuspatlas.export_grants SET created_at = now() - interval '10 minutes',
         expires_at = now() - interval '9 minutes' WHERE id = $1`,
      [grantRef],
    );
  },
  async removeRole() {
    await setScopes(USER_A1, [], ['exports.create']);
    return () => setScopes(USER_A1, ['exports.create']);
  },
};

const fetchBytes = (
  t: Target,
  body: { exportRef: string; token: string },
  headers: Record<string, string> = {},
  who: Who = 'owner',
) => s.inject(who, 'POST', t.url, body, { 'idempotency-key': randomUUID(), ...headers });

/** Where the local store keeps a package (content-addressed by its digest). */
const storedPath = (digest: string) => join(s.storeRoot, 't', T_ALPHA, 'sha256', digest.slice(0, 2), digest);

beforeAll(async () => {
  s = await startImagingStack('export_chunked_download', { extraDeps: { downloadChunkBytes: CHUNK } });
  await seedSchedulingScopes(s.db.admin);
  await seedClinicalScopes(s.db.admin);
  await seedEngagementScopes(s.db.admin);
  await seedBillingScopes(s.db.admin);
  await seedMigrationScopes(s.db.admin);
  await setScopes(USER_A1, ['exports.create', 'exports.read', 'admin.configure']);
  await setScopes(USER_B1, ['exports.create', 'exports.read', 'admin.configure']);
  patientRef = data<{ patientRef: string }>(
    await s.command('owner', '/v1/patients', patientBody('Chunked Download')),
  ).patientRef;
  const a = await ingestVia(s, pngBytes(9501, 8, 8), { intendedPatientRef: patientRef });
  expect(
    (
      await s.command('owner', `/v1/imaging/objects/${a.objectRef}/association`, {
        patientRef,
        basis: 'operatorSelected',
      })
    ).status,
  ).toBe(201);
}, 240_000);
afterAll(async () => {
  await s?.close();
});

describe.each([practice, automation])('A8 chunked download: $name', (t) => {
  let ref: { exportRef: string; digest: string };
  let full: Buffer;

  beforeAll(async () => {
    ref = await t.build();
  }, 120_000);

  it('a full byte download streams the stored package; its digest equals the recorded digest', async () => {
    const { token } = await t.grant(ref.exportRef);
    const r = await fetchBytes(t, { exportRef: ref.exportRef, token }, OCTET);
    expect([r.status, r.body.slice(0, 200)]).toStrictEqual([200, r.body.slice(0, 200)]);
    expect(String(r.headers['content-type'])).toMatch(/^application\/octet-stream/);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers.etag).toBe(`"sha256-${ref.digest}"`);
    expect(r.headers['repr-digest']).toBe(`sha-256=:${b64(ref.digest)}:`);
    full = r.raw;
    expect(sha(full)).toBe(ref.digest);
    expect(Number(r.headers['content-length'])).toBe(full.byteLength);
    expect(full.byteLength).toBeGreaterThan(2 * CHUNK);
    // The default JSON representation is unchanged and parses to the same package.
    const j = await fetchBytes(t, { exportRef: ref.exportRef, token });
    expect(j.status).toBe(200);
    expect(j.json.data).toStrictEqual(JSON.parse(full.toString('utf8')));
  });

  it('consecutive ranges on one live grant reassemble to identical bytes with the same sha-256', async () => {
    const { token } = await t.grant(ref.exportRef);
    const parts: Buffer[] = [];
    let etag = '';
    for (let at = 0; at < full.byteLength; at += CHUNK) {
      const end = Math.min(at + CHUNK, full.byteLength) - 1;
      const r = await fetchBytes(
        t,
        { exportRef: ref.exportRef, token },
        {
          range: `bytes=${at}-${end}`,
          ...(etag ? { 'if-range': etag } : {}),
        },
      );
      expect([r.status, r.body.slice(0, 200)]).toStrictEqual([206, r.body.slice(0, 200)]);
      expect(r.headers['content-range']).toBe(`bytes ${at}-${end}/${full.byteLength}`);
      expect(String(r.headers['content-type'])).toMatch(/^application\/octet-stream/);
      expect(r.headers['repr-digest']).toBe(`sha-256=:${b64(ref.digest)}:`);
      etag = String(r.headers.etag);
      parts.push(r.raw);
    }
    const joined = Buffer.concat(parts);
    expect(joined.equals(full)).toBe(true);
    expect(sha(joined)).toBe(ref.digest);
    // Each range was a sensitive read recorded with the range marker, never the content.
    const reads = await s.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cuspatlas.sensitive_read_events
        WHERE operation = $1 AND $2 = ANY(resource_refs) AND 'range' = ANY(query_fields)`,
      [t.name, ref.exportRef],
    );
    expect(reads.rows[0]?.n).toBeGreaterThanOrEqual(parts.length);
  });

  it('enforces the per-chunk cap by truncating with a correct Content-Range; suffix ranges work', async () => {
    const { token } = await t.grant(ref.exportRef);
    const body = { exportRef: ref.exportRef, token };
    const open = await fetchBytes(t, body, { range: 'bytes=0-' });
    expect(open.status).toBe(206);
    expect(open.raw.byteLength).toBe(CHUNK);
    expect(open.headers['content-range']).toBe(`bytes 0-${CHUNK - 1}/${full.byteLength}`);
    const wide = await fetchBytes(t, body, { range: `bytes=10-${10 + 3 * CHUNK}` });
    expect(wide.status).toBe(206);
    expect(wide.headers['content-range']).toBe(`bytes 10-${10 + CHUNK - 1}/${full.byteLength}`);
    expect(wide.raw.equals(full.subarray(10, 10 + CHUNK))).toBe(true);
    const tail = await fetchBytes(t, body, { range: 'bytes=-100' });
    expect(tail.status).toBe(206);
    expect(tail.raw.equals(full.subarray(full.byteLength - 100))).toBe(true);
    expect(tail.headers['content-range']).toBe(
      `bytes ${full.byteLength - 100}-${full.byteLength - 1}/${full.byteLength}`,
    );
  });

  it('refuses unsatisfiable and multiple ranges with 416 and the total size', async () => {
    const { token } = await t.grant(ref.exportRef);
    const body = { exportRef: ref.exportRef, token };
    for (const range of [
      `bytes=${full.byteLength}-`,
      `bytes=${full.byteLength + 5}-${full.byteLength + 9}`,
      'bytes=0-1,4-5',
      'bytes=-0',
    ]) {
      const r = await fetchBytes(t, body, { range });
      expect([range, r.status]).toStrictEqual([range, 416]);
      expect(r.headers['content-range']).toBe(`bytes */${full.byteLength}`);
      expect(r.json).toMatchObject({ code: 'invalid_request', detail: { reason: 'range_not_satisfiable' } });
    }
  });

  it('If-Range with a stale ETag returns the whole package with 200', async () => {
    const { token } = await t.grant(ref.exportRef);
    const r = await fetchBytes(
      t,
      { exportRef: ref.exportRef, token },
      {
        range: 'bytes=0-99',
        'if-range': `"sha256-${'0'.repeat(64)}"`,
      },
    );
    expect(r.status).toBe(200);
    expect(r.headers['content-range']).toBeUndefined();
    expect(r.raw.equals(full)).toBe(true);
  });

  it('refuses tampered stored bytes with a typed integrity refusal, full or ranged', async () => {
    const { token } = await t.grant(ref.exportRef);
    const body = { exportRef: ref.exportRef, token };
    const path = storedPath(ref.digest);
    const original = readFileSync(path);
    const altered = Buffer.from(original);
    altered[altered.byteLength - 2] = (altered[altered.byteLength - 2] ?? 0) ^ 0x01;
    writeFileSync(path, altered);
    try {
      for (const headers of [{ range: 'bytes=0-99' }, OCTET, {}]) {
        const r = await fetchBytes(t, body, headers);
        expect([JSON.stringify(headers), r.status]).toStrictEqual([JSON.stringify(headers), 409]);
        expect(r.json).toMatchObject({ code: 'conflict', detail: { reason: 'package_integrity_failed' } });
        expect(r.body).not.toContain('Chunked');
      }
    } finally {
      writeFileSync(path, original);
    }
    expect((await fetchBytes(t, body, { range: 'bytes=0-99' })).status).toBe(206);
  });

  it('ranged requests are refused cross-tenant, on an expired grant, a wrong role and a revoked membership', async () => {
    const g = await t.grant(ref.exportRef);
    const body = { exportRef: ref.exportRef, token: g.token };
    const range = { range: 'bytes=0-99' };
    expect((await fetchBytes(t, body, range, 'crossTenant')).status).toBe(404);
    expect((await fetchBytes(t, body, range, 'imagingReadOnly')).status).toBe(403);
    const restore = await t.removeRole();
    try {
      expect((await fetchBytes(t, body, range)).status).toBe(403);
    } finally {
      await restore();
    }
    await s.db.admin.query(
      'UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1 AND tenant_id = $2',
      [USER_A1, T_ALPHA],
    );
    try {
      expect([401, 403]).toContain((await fetchBytes(t, body, range)).status);
    } finally {
      await s.db.admin.query(
        'UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1 AND tenant_id = $2',
        [USER_A1, T_ALPHA],
      );
    }
    expect((await fetchBytes(t, body, range)).status).toBe(206);
    await t.expireGrant(g.grantRef);
    expect((await fetchBytes(t, body, range)).status).toBe(404);
  });
});

describe('A8 chunked download: exports.download specifics', () => {
  it('a revoked export grant no longer serves ranges', async () => {
    const ref = await automation.build();
    const g = await automation.grant(ref.exportRef);
    const body = { exportRef: ref.exportRef, token: g.token };
    expect((await fetchBytes(automation, body, { range: 'bytes=0-9' })).status).toBe(206);
    const rv = await s.command('owner', '/v1/exports/grants/revoke', { grantRef: g.grantRef });
    expect(rv.status).toBe(200);
    expect((await fetchBytes(automation, body, { range: 'bytes=0-9' })).status).toBe(404);
  });

  it('a practice-scope export delivers the M1 package bytes with the recorded digest', async () => {
    const r = await createAndBuild(s, 'owner', {
      formatVersion: 'cuspatlas-export/1',
      purpose: 'practiceExit',
      scope: 'practice',
    });
    expect([r.status, r.body.slice(0, 300)]).toStrictEqual([201, r.body.slice(0, 300)]);
    const d = data<{ exportRef: string; packageDigest: string }>(r);
    const g = await automation.grant(d.exportRef);
    const full = await fetchBytes(automation, { exportRef: d.exportRef, token: g.token }, OCTET);
    expect(full.status).toBe(200);
    expect(sha(full.raw)).toBe(d.packageDigest);
    expect(full.headers.etag).toBe(`"sha256-${d.packageDigest}"`);
    const part = await fetchBytes(
      automation,
      { exportRef: d.exportRef, token: g.token },
      { range: 'bytes=0-99' },
    );
    expect(part.status).toBe(206);
    expect(part.raw.equals(full.raw.subarray(0, 100))).toBe(true);
  });
});

/**
 * Closeout C: the MCP twin of a ranged download. `practice_export_download` and `exports_download`
 * accept `chunkOffset` (and an optional `chunkBytes`, at most 1 MiB) and answer one bounded base64
 * chunk with the total length and the digest recorded at build time. Each chunk runs the same domain
 * call as a REST range (grant, tenant, role, membership, re-verified stored bytes, a `range` audit).
 */
const TOOL: Record<string, string> = {
  'practice.export.download': 'practice_export_download',
  'exports.download': 'exports_download',
};
type Chunk = {
  offset: number;
  length: number;
  totalLength: number;
  digestSha256: string;
  encoding: string;
  chunk: string;
  nextOffset: number | null;
};
const mcpChunk = async (
  t: Target,
  body: { exportRef: string; token: string },
  chunkOffset: number,
  who: Who = 'owner',
  chunkBytes: number = CHUNK,
) => {
  try {
    return await s.mcp(who, TOOL[t.name] as string, {
      ...body,
      idempotencyKey: randomUUID(),
      chunkOffset,
      chunkBytes,
    });
  } catch {
    // A refused credential (revoked membership) is a protocol-level refusal.
    return { isError: true, body: { code: 'unauthenticated' } as Record<string, unknown>, raw: '' };
  }
};

describe.each([practice, automation])('Closeout C MCP chunked download: $name', (t) => {
  let ref: { exportRef: string; digest: string };

  beforeAll(async () => {
    ref = await t.build();
  }, 120_000);

  it('walks bounded base64 chunks that equal the REST ranges and reassemble to the recorded digest', async () => {
    const { token } = await t.grant(ref.exportRef);
    const body = { exportRef: ref.exportRef, token };
    const parts: Buffer[] = [];
    let at: number | null = 0;
    while (at !== null) {
      const r = await mcpChunk(t, body, at);
      expect([r.isError, r.raw.slice(0, 200)]).toStrictEqual([false, r.raw.slice(0, 200)]);
      const c = (r.body as { data: Chunk }).data;
      expect(c).toMatchObject({ offset: at, digestSha256: ref.digest, encoding: 'base64' });
      const bytes = Buffer.from(c.chunk, 'base64');
      expect(bytes.byteLength).toBe(c.length);
      expect(c.length).toBeLessThanOrEqual(CHUNK);
      // Parity: the same bytes as the REST range of the same span.
      const rest = await fetchBytes(t, body, { range: `bytes=${at}-${at + c.length - 1}` });
      expect(rest.status).toBe(206);
      expect(rest.headers['content-range']).toBe(`bytes ${at}-${at + c.length - 1}/${c.totalLength}`);
      expect(rest.raw.equals(bytes)).toBe(true);
      parts.push(bytes);
      at = c.nextOffset;
      expect(parts.length).toBeLessThan(500);
    }
    const joined = Buffer.concat(parts);
    expect(sha(joined)).toBe(ref.digest);
    expect(parts.length).toBeGreaterThan(2);
    // Each chunk was a sensitive read with the range marker.
    const reads = await s.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cuspatlas.sensitive_read_events
        WHERE operation = $1 AND $2 = ANY(resource_refs) AND 'range' = ANY(query_fields)`,
      [t.name, ref.exportRef],
    );
    expect(reads.rows[0]?.n).toBeGreaterThanOrEqual(2 * parts.length);
  });

  it('a chunk (MCP or REST range) reads only its range from the store, never the whole package', async () => {
    const { token } = await t.grant(ref.exportRef);
    const body = { exportRef: ref.exportRef, token };
    const store = s.store as ObjectStorePort;
    const original = { read: store.read, readRange: store.readRange };
    const calls = { read: 0, readRange: 0 };
    store.read = (...a) => {
      calls.read += 1;
      return original.read.apply(store, a);
    };
    store.readRange = (...a) => {
      calls.readRange += 1;
      return (original.readRange as NonNullable<ObjectStorePort['readRange']>).apply(store, a);
    };
    try {
      for (const at of [0, CHUNK, 2 * CHUNK]) expect((await mcpChunk(t, body, at)).isError).toBe(false);
      expect((await fetchBytes(t, body, { range: 'bytes=0-99' })).status).toBe(206);
    } finally {
      store.read = original.read;
      store.readRange = original.readRange;
    }
    expect(calls).toStrictEqual({ read: 0, readRange: 4 });
  });

  it('caps a chunk at 1 MiB and refuses an offset at or past the end', async () => {
    const { token } = await t.grant(ref.exportRef);
    const body = { exportRef: ref.exportRef, token };
    const big = await mcpChunk(t, body, 0, 'owner', 1024 * 1024 + 1);
    expect([big.isError, big.body.code]).toStrictEqual([true, 'invalid_request']);
    const first = (await mcpChunk(t, body, 0)).body as { data: Chunk };
    const past = await mcpChunk(t, body, first.data.totalLength);
    expect([past.isError, past.body.code, (past.body.detail as { reason?: string })?.reason]).toStrictEqual([
      true,
      'invalid_request',
      'range_not_satisfiable',
    ]);
  });

  it('refuses tampered stored bytes with the typed integrity refusal', async () => {
    const { token } = await t.grant(ref.exportRef);
    const body = { exportRef: ref.exportRef, token };
    const path = storedPath(ref.digest);
    const original = readFileSync(path);
    const altered = Buffer.from(original);
    altered[0] = (altered[0] ?? 0) ^ 0x01;
    writeFileSync(path, altered);
    try {
      const r = await mcpChunk(t, body, 0);
      expect([r.isError, r.body.code, (r.body.detail as { reason?: string })?.reason]).toStrictEqual([
        true,
        'conflict',
        'package_integrity_failed',
      ]);
    } finally {
      writeFileSync(path, original);
    }
    expect((await mcpChunk(t, body, 0)).isError).toBe(false);
  });

  it('each chunk is refused cross-tenant, for a wrong role, a revoked membership and an expired grant', async () => {
    const g = await t.grant(ref.exportRef);
    const body = { exportRef: ref.exportRef, token: g.token };
    expect((await mcpChunk(t, body, 0, 'crossTenant')).body.code).toBe('not_found');
    expect((await mcpChunk(t, body, 0, 'imagingReadOnly')).body.code).toBe('forbidden');
    const restore = await t.removeRole();
    try {
      expect((await mcpChunk(t, body, 0)).body.code).toBe('forbidden');
    } finally {
      await restore();
    }
    await s.db.admin.query(
      'UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1 AND tenant_id = $2',
      [USER_A1, T_ALPHA],
    );
    try {
      expect((await mcpChunk(t, body, 0)).isError).toBe(true);
    } finally {
      await s.db.admin.query(
        'UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1 AND tenant_id = $2',
        [USER_A1, T_ALPHA],
      );
    }
    expect((await mcpChunk(t, body, 0)).isError).toBe(false);
    await t.expireGrant(g.grantRef);
    expect((await mcpChunk(t, body, 0)).body.code).toBe('not_found');
  });
});
