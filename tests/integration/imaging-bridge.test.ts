import { generateKeyPairSync } from 'node:crypto';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { signUpdateManifestForTest, verifyUpdateManifest } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ctxFor, T_ALPHA, USER_A1 } from './support/fixtures';
import {
  attemptReasons,
  type ImagingStack,
  imagingLeakSurface,
  pngBytes,
  sha256,
  startImagingStack,
  type Who,
} from './support/imaging-fixtures';
import { patientBody } from './support/patient-fixtures';
import { BRIDGE_AUDIENCE, jws, newKeyPair, SyntheticBridge } from './support/synthetic-bridge';

/**
 * I6 device bridge pairing, signed jobs and capability allowlist (SERVER side only; synthetic). The
 * native bridge is not built and no device is qualified (I-S1, I-S3 blocked-on-discovery): a test-only
 * synthetic bridge client exercises the contract. A device is its own principal kind on its own
 * audience; it pairs with a one-time code and a per-device Ed25519 key, claims server-signed job
 * envelopes, uploads bytes and reports signed results; replay, revocation, rotation, allowlist and
 * path rules are enforced server-side at execution, not only at enqueue.
 */
let s: ImagingStack;
let pOne: string;
let seed = 3000;
const next = () => {
  seed += 1;
  return pngBytes(seed, 5, 5);
};
const reason = (r: { json: Record<string, unknown> }) =>
  (r.json.detail as { reason?: string } | undefined)?.reason;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;

async function register(
  o: { kinds?: string[]; prefixes?: string[]; who?: Who } = {},
): Promise<{ deviceRef: string; status: number }> {
  const r = await s.command(o.who ?? 'owner', '/v1/imaging/devices', {
    label: 'Synthetic Bridge',
    allowedJobKinds: o.kinds ?? ['import', 'probe'],
    allowedPathPrefixes: o.prefixes ?? ['exports'],
  });
  return {
    deviceRef: (r.json.data as { deviceRef?: string } | undefined)?.deviceRef ?? '',
    status: r.status,
  };
}
const issueCode = async (deviceRef: string) =>
  data<{ pairingCode: string; expiresAt: string }>(
    await s.inject('owner', 'POST', `/v1/imaging/devices/${deviceRef}/pairing-codes`, {}),
  ).pairingCode;
async function paired(o: { kinds?: string[]; prefixes?: string[] } = {}) {
  const { deviceRef } = await register(o);
  const b = new SyntheticBridge(s.app);
  const r = await b.pair(await issueCode(deviceRef));
  expect(r.status).toBe(201);
  return b;
}
const enqueue = (body: Record<string, unknown>, who: Who = 'owner') =>
  s.command(who, '/v1/imaging/bridge-jobs', { kind: 'import', importPath: 'exports/2026/a.png', ...body });
const job = async (jobRef: string) =>
  data<Record<string, unknown>>(await s.inject('owner', 'GET', `/v1/imaging/bridge-jobs/${jobRef}`));
const objectCount = async () =>
  (await s.db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.imaging_objects')).rows[0].n as number;

/** Claims, uploads and reports one import job end to end; returns the result reply. */
async function importOnce(b: SyntheticBridge, bytes: Uint8Array) {
  const e = await enqueue({ deviceRef: b.deviceRef });
  expect(e.status).toBe(201);
  const { job: env } = await b.claim();
  expect(env).not.toBeNull();
  const j = env as NonNullable<typeof env>;
  expect((await b.upload(j.jobRef, bytes)).status).toBe(200);
  const token = b.resultToken(j, { outcome: 'completed', bytes });
  return { j, token, res: await b.report(j.jobRef, token) };
}

beforeAll(async () => {
  s = await startImagingStack('imaging_bridge');
  pOne = data<{ patientRef: string }>(
    await s.command('owner', '/v1/patients', patientBody('Bridge One')),
  ).patientRef;
});
afterAll(async () => {
  await s?.close();
});

describe('I6 pairing with one-time codes and per-device keys', () => {
  it('registration is a human admin act; pairing activates the device with its own key', async () => {
    expect((await register({ who: 'writer' })).status).toBe(403);
    expect((await register({ who: 'service' })).status).toBe(403);
    const { deviceRef, status } = await register();
    expect(status).toBe(201);
    const before = data<{ state: string }>(
      await s.inject('owner', 'GET', `/v1/imaging/devices/${deviceRef}`),
    );
    expect(before.state).toBe('pending');
    const code = await issueCode(deviceRef);
    const b = new SyntheticBridge(s.app);
    const r = await b.pair(code);
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ deviceRef, keyVersion: 1, audience: BRIDGE_AUDIENCE });
    const after = data<{ state: string; keyVersion: number }>(
      await s.inject('owner', 'GET', `/v1/imaging/devices/${deviceRef}`),
    );
    expect(after).toMatchObject({ state: 'active', keyVersion: 1 });
    // The code and the public key never reach a record table or a log line; no private key exists server-side.
    const secret = code.split('.')[4] as string;
    expect(await imagingLeakSurface(s.db.admin)).not.toContain(secret);
    expect(s.logLines.join('\n')).not.toContain(secret);
    const stored = await s.db.admin.query('SELECT secret_sha256 FROM cuspatlas.imaging_device_pairings');
    expect(JSON.stringify(stored.rows)).not.toContain(secret);
  });

  it('a reused, expired, forged or superseded code is the same 401 with the reason recorded', async () => {
    const { deviceRef } = await register();
    const code = await issueCode(deviceRef);
    const b = new SyntheticBridge(s.app);
    // Proof by a key other than the one registered.
    const forged = await b.pair(code, { proofKey: newKeyPair() });
    expect(forged.status).toBe(401);
    expect(await attemptReasons(s.db.admin, forged.json.correlationId)).toStrictEqual([
      'device_pairing_invalid',
    ]);
    // A wrong secret.
    const wrong = await new SyntheticBridge(s.app).pair(`${code.slice(0, -4)}AAAA`);
    expect(wrong.status).toBe(401);
    // A tenant swapped in the code.
    const parts = code.split('.');
    parts[1] = '10000000-0000-4000-8000-00000000000b';
    expect((await new SyntheticBridge(s.app).pair(parts.join('.'))).status).toBe(401);
    expect((await b.pair(code)).status).toBe(201);
    const reused = await new SyntheticBridge(s.app).pair(code);
    expect(reused.status).toBe(401);
    expect(await attemptReasons(s.db.admin, reused.json.correlationId)).toStrictEqual([
      'device_pairing_used',
    ]);
    // Expired.
    const late = await register();
    const lateCode = await issueCode(late.deviceRef);
    // Test-only fixture path: the code was issued an hour ago with a ten-minute life (trigger bypassed).
    await s.db.admin.query(
      `BEGIN; SET LOCAL session_replication_role = replica;
       UPDATE cuspatlas.imaging_device_pairings SET created_at = now() - interval '1 hour',
         expires_at = now() - interval '50 minutes' WHERE device_id = '${late.deviceRef}';
       COMMIT;`,
    );
    const exp = await new SyntheticBridge(s.app).pair(lateCode);
    expect(exp.status).toBe(401);
    expect(await attemptReasons(s.db.admin, exp.json.correlationId)).toStrictEqual([
      'device_pairing_expired',
    ]);
    // A new code supersedes an open one.
    const sup = await register();
    const first = await issueCode(sup.deviceRef);
    await issueCode(sup.deviceRef);
    expect((await new SyntheticBridge(s.app).pair(first)).status).toBe(401);
    // An active device cannot be issued another code.
    const again = await s.inject('owner', 'POST', `/v1/imaging/devices/${deviceRef}/pairing-codes`, {});
    expect([again.status, reason(again)]).toStrictEqual([409, 'device_already_paired']);
  });

  it('an unpaired device has no jobs and no credential', async () => {
    const { deviceRef } = await register();
    const e = await enqueue({ deviceRef });
    expect([e.status, reason(e)]).toStrictEqual([409, 'device_unpaired']);
    const ghost = new SyntheticBridge(s.app);
    ghost.deviceRef = deviceRef;
    ghost.tenantRef = T_ALPHA;
    ghost.keyVersion = 1;
    const c = await ghost.claim();
    expect(c.reply.status).toBe(401);
  });
});

describe('I6 signed job envelopes and signed results', () => {
  it('a claimed job is a server-signed envelope; the bridge refuses a forged or tampered one', async () => {
    const b = await paired();
    const e = await enqueue({ deviceRef: b.deviceRef, intendedPatientRef: pOne });
    const { reply, job: env } = await b.claim();
    expect(reply.status).toBe(200);
    expect(env).toMatchObject({
      jobRef: (e.json.data as { jobRef: string }).jobRef,
      deviceRef: b.deviceRef,
      tenantRef: T_ALPHA,
      kind: 'import',
      scopePath: 'exports/2026/a.png',
      attempt: 1,
    });
    const token = (reply.json.data as { envelope: string }).envelope;
    const other = generateKeyPairSync('ed25519').privateKey;
    const [h, p] = token.split('.') as [string, string];
    expect(
      b.verifyEnvelope(
        jws(
          JSON.parse(Buffer.from(h, 'base64url').toString()),
          JSON.parse(Buffer.from(p, 'base64url').toString()),
          other,
        ),
      ),
    ).toBeNull();
    const tampered = JSON.parse(Buffer.from(p, 'base64url').toString());
    tampered.scopePath = '../../etc';
    expect(
      b.verifyEnvelope(
        `${h}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${token.split('.')[2]}`,
      ),
    ).toBeNull();
    // Nothing else is ready: the next claim is an explicit empty envelope.
    expect((await b.claim()).reply.json.data).toStrictEqual({ envelope: null, jobRef: null });
  });

  it('an import completes with bridgeImport provenance; a replayed result is a recorded duplicate', async () => {
    const b = await paired();
    const bytes = next();
    const { j, token, res } = await importOnce(b, bytes);
    expect(res.status).toBe(200);
    const objectRef = (res.json.data as { objectRef: string }).objectRef;
    expect(res.json.data).toMatchObject({ jobRef: j.jobRef, state: 'completed', deduplicated: false });
    const o = data<{ digestSha256: string; provenance: { source: string; deviceRef: string }[] }>(
      await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}`),
    );
    expect(o.digestSha256).toBe(sha256(bytes));
    expect(o.provenance[0]).toMatchObject({ source: 'bridgeImport', deviceRef: b.deviceRef });
    const count = await objectCount();
    const replay = await b.report(j.jobRef, token);
    expect([replay.status, reason(replay)]).toStrictEqual([409, 'replayed_result']);
    expect(await objectCount()).toBe(count);
    expect((await job(j.jobRef)).duplicateReports).toBe(1);
  });

  it('a forged result signature, a result for another job and a stale nonce are refused with no object', async () => {
    const b = await paired();
    await enqueue({ deviceRef: b.deviceRef });
    const { job: env } = await b.claim();
    const j = env as NonNullable<typeof env>;
    const bytes = next();
    await b.upload(j.jobRef, bytes);
    const count = await objectCount();
    const forged = await b.report(
      j.jobRef,
      b.resultToken(j, { outcome: 'completed', bytes }, { key: newKeyPair() }),
    );
    expect(forged.status).toBe(401);
    expect(await attemptReasons(s.db.admin, forged.json.correlationId)).toStrictEqual([
      'device_signature_invalid',
    ]);
    const stale = await b.report(
      j.jobRef,
      b.resultToken({ ...j, nonce: crypto.randomUUID() }, { outcome: 'completed', bytes }),
    );
    expect([stale.status, reason(stale)]).toStrictEqual([409, 'stale_attempt']);
    const mismatch = await b.report(j.jobRef, b.resultToken(j, { outcome: 'completed', bytes: next() }));
    expect([mismatch.status, reason(mismatch)]).toStrictEqual([409, 'artifact_digest_mismatch']);
    expect(await objectCount()).toBe(count);
  });

  it('assertions are single use, short lived, bound to the request and to the bridge audience', async () => {
    const b = await paired();
    const path = '/v1/bridge/heartbeat';
    const a = b.assertion('POST', path);
    expect((await b.raw('POST', path, {}, a)).status).toBe(200);
    const replay = await b.raw('POST', path, {}, a);
    expect(replay.status).toBe(401);
    expect(await attemptReasons(s.db.admin, replay.json.correlationId)).toStrictEqual([
      'device_assertion_replayed',
    ]);
    for (const bad of [
      b.assertion('POST', path, { iatOffsetSeconds: -600 }),
      b.assertion('POST', path, { ttlSeconds: 3600 }),
      b.assertion('POST', path, { audience: 'urn:cuspatlas:mcp:synthetic' }),
      b.assertion('POST', path, { htu: '/v1/bridge/jobs/claim' }),
      b.assertion('POST', path, { tenantRef: '10000000-0000-4000-8000-00000000000b' }),
      b.assertion('POST', path, { key: newKeyPair() }),
    ]) {
      expect((await b.raw('POST', path, {}, bad)).status).toBe(401);
    }
  });
});

describe('I6 revocation, rotation, allowlist and paths', () => {
  it('a revoked device cannot claim or report; a job it already claimed is denied', async () => {
    const b = await paired();
    await enqueue({ deviceRef: b.deviceRef });
    await enqueue({ deviceRef: b.deviceRef, importPath: 'exports/b.png' });
    const { job: env } = await b.claim();
    const j = env as NonNullable<typeof env>;
    const bytes = next();
    await b.upload(j.jobRef, bytes);
    const r = await s.command('owner', `/v1/imaging/devices/${b.deviceRef}/revoke`, {
      reasonCode: 'device_lost',
    });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ state: 'revoked', deniedJobs: 2 });
    const rep = await b.report(j.jobRef, b.resultToken(j, { outcome: 'completed', bytes }));
    expect(rep.status).toBe(403);
    expect(await attemptReasons(s.db.admin, rep.json.correlationId)).toStrictEqual(['device_revoked']);
    expect((await b.claim()).reply.status).toBe(403);
    expect((await job(j.jobRef)).state).toBe('denied');
    const again = await s.command('owner', `/v1/imaging/devices/${b.deviceRef}/revoke`, {
      reasonCode: 'device_lost',
    });
    expect([again.status, reason(again)]).toStrictEqual([409, 'device_revoked']);
    expect(
      (await s.command('writer', `/v1/imaging/devices/${b.deviceRef}/revoke`, { reasonCode: 'x' })).status,
    ).toBe(403);
  });

  it('after key rotation the old key is refused for assertions and results', async () => {
    const b = await paired();
    await enqueue({ deviceRef: b.deviceRef });
    const { job: env } = await b.claim();
    const j = env as NonNullable<typeof env>;
    const bytes = next();
    await b.upload(j.jobRef, bytes);
    const { reply, old } = await b.rotate();
    expect([reply.status, (reply.json.data as { keyVersion: number }).keyVersion]).toStrictEqual([200, 2]);
    const oldAssert = await b.call('/v1/bridge/heartbeat', {}, { key: old, keyVersion: 1 });
    expect(oldAssert.status).toBe(401);
    const oldResult = await b.report(
      j.jobRef,
      b.resultToken(j, { outcome: 'completed', bytes }, { key: old }),
    );
    expect(oldResult.status).toBe(401);
    const ok = await b.report(j.jobRef, b.resultToken(j, { outcome: 'completed', bytes }));
    expect(ok.status).toBe(200);
  });

  it('a job kind outside the allowlist is refused at enqueue; an allowlist edit denies a queued job at claim', async () => {
    const b = await paired({ kinds: ['import', 'probe'] });
    const acq = await enqueue({ deviceRef: b.deviceRef, kind: 'acquire', importPath: undefined });
    expect([acq.status, reason(acq)]).toStrictEqual([409, 'capability_not_allowlisted']);
    const e = await enqueue({ deviceRef: b.deviceRef });
    const jobRef = (e.json.data as { jobRef: string }).jobRef;
    const dev = data<{ version: number }>(
      await s.inject('owner', 'GET', `/v1/imaging/devices/${b.deviceRef}`),
    );
    const cap = await s.command('owner', `/v1/imaging/devices/${b.deviceRef}/capabilities`, {
      expectedVersion: dev.version,
      allowedJobKinds: ['probe'],
      allowedPathPrefixes: ['exports'],
    });
    expect(cap.status).toBe(200);
    const stale = await s.command('owner', `/v1/imaging/devices/${b.deviceRef}/capabilities`, {
      expectedVersion: dev.version,
      allowedJobKinds: ['probe'],
      allowedPathPrefixes: ['exports'],
    });
    expect(stale.status).toBe(409);
    expect((await b.claim()).job).toBeNull();
    expect(await job(jobRef)).toMatchObject({ state: 'denied', failureReason: 'capability_not_allowlisted' });
    // A probe has no content and completes without an artifact.
    await s.command('owner', '/v1/imaging/bridge-jobs', { deviceRef: b.deviceRef, kind: 'probe' });
    const { job: probe } = await b.claim();
    const p = probe as NonNullable<typeof probe>;
    expect((await b.upload(p.jobRef, next())).status).toBe(409);
    expect((await b.report(p.jobRef, b.resultToken(p, { outcome: 'completed' }))).json.data).toMatchObject({
      state: 'completed',
      objectRef: null,
    });
  });

  it('traversal, absolute, drive and backslash paths are refused; a path outside the prefixes is refused', async () => {
    const b = await paired({ prefixes: ['exports/today'] });
    for (const importPath of [
      '../x.png',
      '/etc/x.png',
      'C:/x.png',
      'exports\\x.png',
      'exports/today/../../x.png',
      'exports//x',
      './x',
      'exports/to\u0000day',
    ]) {
      const r = await enqueue({ deviceRef: b.deviceRef, importPath });
      expect([importPath, r.status, reason(r)]).toStrictEqual([importPath, 422, 'path_traversal']);
    }
    for (const importPath of ['exports/todayx/a.png', 'exports/a.png', 'other/a.png']) {
      const r = await enqueue({ deviceRef: b.deviceRef, importPath });
      expect([importPath, r.status, reason(r)]).toStrictEqual([importPath, 409, 'path_outside_import_root']);
    }
    expect((await enqueue({ deviceRef: b.deviceRef, importPath: 'exports/today/sub/a.png' })).status).toBe(
      201,
    );
    const dev = data<{ version: number }>(
      await s.inject('owner', 'GET', `/v1/imaging/devices/${b.deviceRef}`),
    );
    const cap = await s.command('owner', `/v1/imaging/devices/${b.deviceRef}/capabilities`, {
      expectedVersion: dev.version,
      allowedJobKinds: ['import'],
      allowedPathPrefixes: ['../escape'],
    });
    expect([cap.status, reason(cap)]).toStrictEqual([422, 'path_traversal']);
    // The bridge side resolves a signed path inside its own root and refuses an escape too.
    expect(SyntheticBridge.resolveInsideRoot('/import-root', 'exports/today/a.png')).toBe(
      '/import-root/exports/today/a.png',
    );
    expect(SyntheticBridge.resolveInsideRoot('/import-root', '../../etc/passwd')).toBeNull();
  });
});

describe('I6 device principals are never staff and staff are never devices', () => {
  it('a device assertion at staff REST and MCP routes is 401; a staff token at bridge routes is 401', async () => {
    const b = await paired();
    for (const path of [
      '/v1/session',
      '/v1/imaging/objects',
      '/v1/patients/search',
      '/v1/imaging/bridge-jobs/00000000-0000-4000-8000-000000000000',
    ]) {
      const r = await b.raw('GET', path, undefined, b.assertion('GET', path));
      expect([path, r.status]).toStrictEqual([path, 401]);
    }
    const post = await b.raw(
      'POST',
      '/v1/imaging/bridge-jobs',
      { deviceRef: b.deviceRef, kind: 'probe' },
      b.assertion('POST', '/v1/imaging/bridge-jobs'),
    );
    expect(post.status).toBe(401);
    for (const path of ['/v1/bridge/jobs/claim', '/v1/bridge/heartbeat', '/v1/bridge/keys/rotate']) {
      const r = await b.raw('POST', path, {}, s.rest.owner);
      expect([path, r.status]).toStrictEqual([path, 401]);
      const none = await b.raw('POST', path, {}, null);
      expect([path, none.status]).toStrictEqual([path, 401]);
    }
    // The device principal holds no membership and the database refuses one.
    const m = await s.db.admin
      .query('INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)', [
        T_ALPHA,
        b.deviceRef,
        ['imaging.read'],
      ])
      .then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      );
    expect(m).toBe('42501');
  });

  it("another tenant's device or job is invisible; a job for another tenant's device is 404", async () => {
    const b = await paired();
    const e = await enqueue({ deviceRef: b.deviceRef });
    const jobRef = (e.json.data as { jobRef: string }).jobRef;
    expect((await s.inject('crossTenant', 'GET', `/v1/imaging/bridge-jobs/${jobRef}`)).status).toBe(404);
    expect((await s.inject('crossTenant', 'GET', `/v1/imaging/devices/${b.deviceRef}`)).status).toBe(404);
    expect((await enqueue({ deviceRef: b.deviceRef }, 'crossTenant')).status).toBe(404);
  });

  it('the database refuses a claim by a staff actor, a disallowed claim and a staff-written key (runtime role)', async () => {
    const b = await paired({ kinds: ['import'] });
    const e = await enqueue({ deviceRef: b.deviceRef });
    const jobRef = (e.json.data as { jobRef: string }).jobRef;
    const tx = createTenantTransactionRunner(s.db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    const code = (sql: string, v: unknown[]) =>
      tx(ctx, (t) => t.query(sql, v)).then(
        () => 'ok',
        (err: { code?: string }) => err.code,
      );
    expect(
      await code(
        `UPDATE cuspatlas.imaging_bridge_jobs SET state = 'claimed', attempts = 1, claim_nonce = gen_random_uuid(),
           lease_expires_at = now() + interval '1 minute', version = version + 1 WHERE id = $1`,
        [jobRef],
      ),
    ).toBe('42501');
    expect(
      await code(
        `INSERT INTO cuspatlas.imaging_device_keys (tenant_id, device_id, key_version, public_key, state)
         VALUES (cuspatlas.current_tenant_id(), $1, 9, $2, 'active')`,
        [b.deviceRef, newKeyPair().raw],
      ),
    ).toBe('42501');
    expect(
      await code(
        `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES (gen_random_uuid(), 'human', 'sneaky')`,
        [],
      ),
    ).toBe('42501');
  });
});

describe('I6 update-integrity placeholder (signed manifest verification contract only)', () => {
  const release = generateKeyPairSync('ed25519');
  const trusted = { 'release-2026': release.publicKey };
  const artifact = new TextEncoder().encode('synthetic bridge build');
  const manifest = (o: Record<string, unknown> = {}) => ({
    v: 1,
    channel: 'synthetic',
    version: '1.2.0',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    artifacts: [{ name: 'cuspatlas-bridge.bin', sha256: sha256(artifact), byteLength: artifact.byteLength }],
    ...o,
  });

  it('accepts a manifest signed by a trusted key whose artifact digest matches; refuses everything else', () => {
    const good = signUpdateManifestForTest(manifest(), release.privateKey, 'release-2026');
    expect(
      verifyUpdateManifest(good, trusted, {
        currentVersion: '1.1.9',
        artifact: { name: 'cuspatlas-bridge.bin', bytes: artifact },
      }),
    ).toMatchObject({ ok: true });
    const cases: [string, string, Parameters<typeof verifyUpdateManifest>[2]][] = [
      [
        'untrusted_key',
        signUpdateManifestForTest(manifest(), generateKeyPairSync('ed25519').privateKey, 'release-2026'),
        { currentVersion: '1.0.0' },
      ],
      [
        'untrusted_key',
        signUpdateManifestForTest(manifest(), release.privateKey, 'unknown-kid'),
        { currentVersion: '1.0.0' },
      ],
      ['downgrade', good, { currentVersion: '1.2.0' }],
      [
        'expired',
        signUpdateManifestForTest(
          manifest({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
          release.privateKey,
          'release-2026',
        ),
        { currentVersion: '1.0.0' },
      ],
      [
        'artifact_digest_mismatch',
        good,
        {
          currentVersion: '1.0.0',
          artifact: { name: 'cuspatlas-bridge.bin', bytes: new TextEncoder().encode('tampered') },
        },
      ],
      ['malformed', 'not-a-jws', { currentVersion: '1.0.0' }],
      [
        'unsigned',
        `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'cuspatlas-bridge-update+jws', kid: 'release-2026' })).toString('base64url')}.${Buffer.from(JSON.stringify(manifest())).toString('base64url')}.`,
        { currentVersion: '1.0.0' },
      ],
    ];
    for (const [want, token, ctxv] of cases) {
      expect([want, verifyUpdateManifest(token, trusted, ctxv)]).toMatchObject([
        want,
        { ok: false, reason: want },
      ]);
    }
  });
});
