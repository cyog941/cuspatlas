import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYNTHETIC_MALWARE_SIGNATURE } from './support/fake-scanner';
import { T_ALPHA, T_BETA } from './support/fixtures';
import {
  attemptReasons,
  type ImagingStack,
  imagingLeakSurface,
  pngBytes,
  sha256,
  startImagingStack,
  type Who,
} from './support/imaging-fixtures';
import { MARKER } from './support/marker';
import { patientBody } from './support/patient-fixtures';

/**
 * I2 ingress pipeline (synthetic bytes only): staging -> integrity (declared vs observed digest and
 * length) -> malware gate (fake scanner: clean / infected / unknown, unknown is never clean) -> media
 * sniffing by magic bytes (never by extension) -> patient-scoped dedupe -> available object. Rejected
 * bytes stay in quarantine with a reason and are never served; an interrupted upload never becomes an
 * object; completion is idempotent by key.
 */
let s: ImagingStack;
let patientA: string;
let patientA2: string;
let patientB: string;
const MAX = 64 * 1024;

const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
]);
const PDF = new TextEncoder().encode('%PDF-1.4\n% synthetic test document, not a clinical record\n%%EOF\n');

beforeAll(async () => {
  s = await startImagingStack('imaging_ingress', { limits: { maxObjectBytes: MAX } });
  const mk = async (who: Who, given: string) =>
    ((await s.command(who, '/v1/patients', patientBody(given))).json.data as { patientRef: string })
      .patientRef;
  patientA = await mk('owner', 'Synthetic Imaging One');
  patientA2 = await mk('owner', 'Synthetic Imaging Two');
  patientB = await mk('crossTenant', 'Synthetic Imaging Beta');
});
afterAll(async () => {
  await s?.close();
});

interface Begin {
  contentType?: string;
  byteLength?: number;
  declaredDigest?: string;
  provenance?: Record<string, unknown>;
  intendedPatientRef?: string;
}

const beginBody = (bytes: Uint8Array, o: Begin = {}) => ({
  contentType: o.contentType ?? 'image/png',
  byteLength: o.byteLength ?? bytes.byteLength,
  declaredDigest: o.declaredDigest ?? sha256(bytes),
  provenance: o.provenance ?? { source: 'operatorUpload', originalFilename: 'synthetic.png' },
  ...(o.intendedPatientRef ? { intendedPatientRef: o.intendedPatientRef } : {}),
});

async function begin(bytes: Uint8Array, o: Begin = {}, who: Who = 'owner') {
  const r = await s.command(who, '/v1/imaging/ingress', beginBody(bytes, o));
  return { r, ref: (r.json.data as { ingressRef?: string } | undefined)?.ingressRef ?? '' };
}
const upload = (ref: string, bytes: Uint8Array, who: Who = 'owner', key?: string) =>
  s.command(who, `/v1/imaging/ingress/${ref}/content`, bytes, key);
const complete = (ref: string, digest: string, who: Who = 'owner', key?: string) =>
  s.command(who, `/v1/imaging/ingress/${ref}/complete`, { observedDigest: digest }, key);

async function ingest(bytes: Uint8Array, o: Begin = {}) {
  const b = await begin(bytes, o);
  expect(b.r.status).toBe(201);
  expect((await upload(b.ref, bytes)).status).toBe(200);
  const c = await complete(b.ref, o.declaredDigest ?? sha256(bytes));
  return { ingressRef: b.ref, c };
}
const objectCount = async () =>
  (await s.db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.imaging_objects')).rows[0].n as number;

describe('I2 accepted path', () => {
  it('stages, gates, verifies and makes one available object with its provenance', async () => {
    const bytes = pngBytes(21);
    const b = await begin(bytes, {
      provenance: {
        source: 'operatorUpload',
        originalFilename: `bitewing-${MARKER}.png`,
        deviceRef: 'synthetic-device-1',
        captureSoftware: 'synthetic-capture',
        acquiredAt: '2026-11-10T14:05:00-05:00',
        acquiredTimeZone: 'America/New_York',
      },
    });
    expect(b.r.status).toBe(201);
    expect(b.r.json.data).toMatchObject({ ingressRef: b.ref, state: 'awaiting_bytes', maxBytes: MAX });
    const u = await upload(b.ref, bytes);
    expect([u.status, (u.json.data as { state: string }).state]).toStrictEqual([200, 'staged']);
    // Staged bytes are not an object yet.
    const before = await objectCount();
    const c = await complete(b.ref, sha256(bytes));
    expect(c.status).toBe(201);
    const d = c.json.data as { objectRef: string; state: string; deduplicated: boolean };
    expect([d.state, d.deduplicated]).toStrictEqual(['available', false]);
    expect(await objectCount()).toBe(before + 1);
    const read = await s.inject('owner', 'GET', `/v1/imaging/objects/${d.objectRef}`);
    expect(read.json.data).toMatchObject({
      state: 'available',
      digestSha256: sha256(bytes),
      byteLength: bytes.byteLength,
    });
    expect((read.json.data as { provenance: unknown[] }).provenance).toStrictEqual([
      expect.objectContaining({
        source: 'operatorUpload',
        deviceRef: 'synthetic-device-1',
        captureSoftware: 'synthetic-capture',
        acquiredAt: '2026-11-10T19:05:00.000Z',
        acquiredTimeZone: 'America/New_York',
        ingressRef: b.ref,
      }),
    ]);
    const g = await s.inject('owner', 'POST', `/v1/imaging/objects/${d.objectRef}/read-grants`, {});
    const bytesBack = await s.inject(
      'owner',
      'GET',
      `/v1/imaging/objects/${d.objectRef}/content`,
      undefined,
      {
        'x-object-read-token': (g.json.data as { token: string }).token,
      },
    );
    expect(sha256(bytesBack.raw)).toBe(sha256(bytes));
    const ing = await s.inject('owner', 'GET', `/v1/imaging/ingress/${b.ref}`);
    expect(ing.json.data).toMatchObject({
      state: 'accepted',
      objectRef: d.objectRef,
      quarantineReason: null,
    });
  });

  it('accepts media by magic bytes, not by extension', async () => {
    const pdf = await ingest(PDF, {
      contentType: 'application/pdf',
      provenance: { source: 'migrationArchive', originalFilename: 'looks-like-an-image.png' },
    });
    expect([pdf.c.status, (pdf.c.json.data as { state: string }).state]).toStrictEqual([201, 'available']);
  });

  it('an interrupted upload never becomes an object or a study reference', async () => {
    const before = await objectCount();
    const b = await begin(pngBytes(22));
    const c = await complete(b.ref, sha256(pngBytes(22)));
    expect([c.status, (c.json.detail as { reason: string }).reason]).toStrictEqual([
      409,
      'bytes_not_received',
    ]);
    expect(await objectCount()).toBe(before);
  });
});

describe('I2 gating and quarantine', () => {
  const quarantineFiles = () => {
    const dir = join(s.storeRoot, 'quarantine', T_ALPHA);
    return existsSync(dir) ? readdirSync(dir).length : 0;
  };

  async function expectQuarantined(
    ingressRef: string,
    c: Awaited<ReturnType<typeof complete>>,
    reason: string,
  ) {
    expect([c.status, c.json.code, (c.json.detail as { reason: string }).reason]).toStrictEqual([
      409,
      'conflict',
      reason,
    ]);
    expect((c.json.detail as { blockingRefs: unknown[] }).blockingRefs).toStrictEqual([
      { kind: 'imagingIngress', ref: ingressRef },
    ]);
    const ing = await s.inject('owner', 'GET', `/v1/imaging/ingress/${ingressRef}`);
    expect(ing.json.data).toMatchObject({ state: 'quarantined', quarantineReason: reason, objectRef: null });
    expect(await attemptReasons(s.db.admin, c.json.correlationId)).toStrictEqual(['upload_gated']);
  }

  it('a declared media type that disagrees with the sniffed bytes is quarantined (MIME spoofing)', async () => {
    const before = [await objectCount(), quarantineFiles()];
    const { ingressRef, c } = await ingest(JPEG, { contentType: 'image/png' });
    await expectQuarantined(ingressRef, c, 'content_type_mismatch');
    expect([await objectCount(), quarantineFiles()]).toStrictEqual([before[0], (before[1] ?? 0) + 1]);
    const text = await ingest(new TextEncoder().encode('plain synthetic text, no known magic'), {});
    await expectQuarantined(text.ingressRef, text.c, 'content_type_unrecognized');
  });

  it('malware-gated bytes are quarantined, never associated and never served', async () => {
    const bad = new Uint8Array([...pngBytes(23), ...new TextEncoder().encode(SYNTHETIC_MALWARE_SIGNATURE)]);
    const before = await objectCount();
    const { ingressRef, c } = await ingest(bad);
    await expectQuarantined(ingressRef, c, 'malware_gated');
    expect(await objectCount()).toBe(before);
    const failures = await s.inject('owner', 'GET', '/v1/imaging/ingress/failures');
    const items = (failures.json.data as { items: { evidenceRefs: { ref: string }[]; reasonCode: string }[] })
      .items;
    expect(items.find((i) => i.evidenceRefs.some((e) => e.ref === ingressRef))?.reasonCode).toBe(
      'malware_gated',
    );
  });

  it('an unknown scan verdict is never clean: held staged and visible, then accepted once decided', async () => {
    const bytes = pngBytes(24);
    s.scanner.outage = true;
    let ingressRef = '';
    try {
      const b = await begin(bytes);
      ingressRef = b.ref;
      await upload(b.ref, bytes);
      const c = await complete(b.ref, sha256(bytes));
      expect([c.status, (c.json.detail as { reason: string }).reason, c.json.retryable]).toStrictEqual([
        409,
        'scan_pending',
        true,
      ]);
      const ing = await s.inject('owner', 'GET', `/v1/imaging/ingress/${b.ref}`);
      expect(ing.json.data).toMatchObject({
        state: 'staged',
        quarantineReason: null,
        objectRef: null,
        scan: 'unknown',
      });
      const failures = await s.inject('owner', 'GET', '/v1/imaging/ingress/failures');
      const items = (
        failures.json.data as { items: { evidenceRefs: { ref: string }[]; reasonCode: string }[] }
      ).items;
      expect(items.find((i) => i.evidenceRefs.some((e) => e.ref === b.ref))?.reasonCode).toBe('scan_pending');
    } finally {
      s.scanner.outage = false;
    }
    const retry = await complete(ingressRef, sha256(bytes));
    expect([retry.status, (retry.json.data as { state: string }).state]).toStrictEqual([201, 'available']);
  });

  it('a digest that does not match the bytes, or a truncated upload, never yields an available object', async () => {
    const bytes = pngBytes(25);
    const wrong = await ingest(bytes, { declaredDigest: sha256(pngBytes(26)) });
    await expectQuarantined(wrong.ingressRef, wrong.c, 'digest_mismatch');
    // Completion naming a digest other than the declared one is a mismatch too.
    const b = await begin(bytes);
    await upload(b.ref, bytes);
    await expectQuarantined(b.ref, await complete(b.ref, sha256(pngBytes(27))), 'digest_mismatch');
    // A truncated upload (interrupted transfer) is quarantined, never completed.
    const t = await begin(bytes);
    await upload(t.ref, bytes.subarray(0, 20));
    await expectQuarantined(t.ref, await complete(t.ref, sha256(bytes)), 'size_mismatch');
  });

  it('oversize is refused at begin and at upload; nothing is staged', async () => {
    const big = await s.command(
      'owner',
      '/v1/imaging/ingress',
      beginBody(pngBytes(28), { byteLength: MAX + 1 }),
    );
    expect([big.status, (big.json.detail as { reason: string }).reason]).toStrictEqual([
      422,
      'oversize_object',
    ]);
    expect((big.json.detail as { limit: unknown }).limit).toStrictEqual({
      name: 'maxObjectBytes',
      value: MAX,
    });
    const bytes = pngBytes(29);
    const b = await begin(bytes, { byteLength: 10 });
    const u = await upload(b.ref, bytes);
    expect([u.status, (u.json.detail as { reason: string }).reason]).toStrictEqual([422, 'oversize_object']);
    const ing = await s.inject('owner', 'GET', `/v1/imaging/ingress/${b.ref}`);
    expect((ing.json.data as { state: string }).state).toBe('awaiting_bytes');
    // Beyond the transport limit the body is refused before it reaches the domain.
    const huge = await upload(b.ref, new Uint8Array(MAX + 10));
    expect(huge.status).toBeGreaterThanOrEqual(400);
    expect(huge.status).toBeLessThan(500);
  });

  it('path traversal and unsafe names are refused; unknown or missing zones are refused', async () => {
    for (const [name, status] of [
      ['../../etc/passwd', 400],
      ['dir\\file.png', 400],
      ['..', 422],
      ['line\nbreak.png', 400],
    ] as const) {
      const r = await s.command(
        'owner',
        '/v1/imaging/ingress',
        beginBody(pngBytes(30), { provenance: { source: 'operatorUpload', originalFilename: name } }),
      );
      expect([name, r.status]).toStrictEqual([name, status]);
    }
    const noZone = await s.command(
      'owner',
      '/v1/imaging/ingress',
      beginBody(pngBytes(30), {
        provenance: { source: 'operatorUpload', acquiredAt: '2026-11-10T10:00:00Z' },
      }),
    );
    expect([noZone.status, (noZone.json.detail as { reason: string }).reason]).toStrictEqual([
      422,
      'acquired_time_zone_required',
    ]);
    const badZone = await s.command(
      'owner',
      '/v1/imaging/ingress',
      beginBody(pngBytes(30), {
        provenance: {
          source: 'operatorUpload',
          acquiredAt: '2026-11-10T10:00:00Z',
          acquiredTimeZone: 'Mars/Base_One',
        },
      }),
    );
    expect([badZone.status, (badZone.json.detail as { reason: string }).reason]).toStrictEqual([
      422,
      'unknown_time_zone',
    ]);
  });
});

describe('I2 idempotency and patient-scoped dedupe', () => {
  it('completion is idempotent by key; a second key on a completed ingress is a duplicate completion', async () => {
    const bytes = pngBytes(31);
    const key = randomUUID();
    const b = await begin(bytes);
    const u1 = await upload(b.ref, bytes, 'owner', 'upload-key-31');
    const u2 = await upload(b.ref, bytes, 'owner', 'upload-key-31');
    expect([u1.status, u2.status, u2.json.replayed]).toStrictEqual([200, 200, true]);
    const c1 = await complete(b.ref, sha256(bytes), 'owner', key);
    const c2 = await complete(b.ref, sha256(bytes), 'owner', key);
    expect([c1.status, c2.status, c2.json.replayed]).toStrictEqual([201, 201, true]);
    expect((c2.json.data as { objectRef: string }).objectRef).toBe(
      (c1.json.data as { objectRef: string }).objectRef,
    );
    const c3 = await complete(b.ref, sha256(bytes));
    expect([c3.status, (c3.json.detail as { reason: string }).reason]).toStrictEqual([
      409,
      'duplicate_completion',
    ]);
    // Re-uploading other bytes to a staged or completed ingress is refused.
    expect((await upload(b.ref, pngBytes(32))).status).toBe(409);
  });

  it('the same bytes for one patient dedupe to one object with two provenances; two patients get two objects', async () => {
    const bytes = pngBytes(33);
    const one = await ingest(bytes, { intendedPatientRef: patientA });
    const two = await ingest(bytes, { intendedPatientRef: patientA });
    const ref1 = (one.c.json.data as { objectRef: string }).objectRef;
    expect(two.c.json.data).toMatchObject({ objectRef: ref1, deduplicated: true, state: 'available' });
    const read = await s.inject('owner', 'GET', `/v1/imaging/objects/${ref1}`);
    expect(
      (read.json.data as { provenance: { ingressRef: string }[] }).provenance.map((p) => p.ingressRef),
    ).toStrictEqual([one.ingressRef, two.ingressRef]);
    const other = await ingest(bytes, { intendedPatientRef: patientA2 });
    const ref2 = (other.c.json.data as { objectRef: string }).objectRef;
    expect(ref2).not.toBe(ref1);
    const rows = await s.db.admin.query(
      'SELECT storage_key FROM cuspatlas.imaging_objects WHERE id = ANY ($1::uuid[])',
      [[ref1, ref2]],
    );
    // Two objects, one content-addressed blob inside the tenant.
    expect(new Set(rows.rows.map((r) => r.storage_key)).size).toBe(1);
  });
});

describe('I2 tenancy, MCP and privacy', () => {
  it('another tenant cannot upload to, complete or read an ingress, nor name another tenant patient', async () => {
    const bytes = pngBytes(34);
    const b = await begin(bytes);
    await upload(b.ref, bytes);
    for (const r of [
      await upload(b.ref, bytes, 'crossTenant'),
      await complete(b.ref, sha256(bytes), 'crossTenant'),
      await s.inject('crossTenant', 'GET', `/v1/imaging/ingress/${b.ref}`),
    ]) {
      expect([r.status, r.json.code]).toStrictEqual([404, 'not_found']);
    }
    const foreign = await s.command(
      'owner',
      '/v1/imaging/ingress',
      beginBody(bytes, { intendedPatientRef: patientB }),
    );
    expect(foreign.status).toBe(404);
    const ing = await s.inject('owner', 'GET', `/v1/imaging/ingress/${b.ref}`);
    expect((ing.json.data as { state: string }).state).toBe('staged');
    // Beta's failure list never shows alpha's ingress.
    const failures = await s.inject('crossTenant', 'GET', '/v1/imaging/ingress/failures');
    expect(JSON.stringify(failures.json)).not.toContain(b.ref);
    void T_BETA;
  });

  it('MCP begins and completes an ingress (bytes only over REST) with the same outcome', async () => {
    const bytes = pngBytes(35);
    const m = await s.mcp('owner', 'imaging_ingress_begin', {
      ...beginBody(bytes),
      idempotencyKey: randomUUID(),
    });
    expect(m.isError).toBe(false);
    const ref = (m.body.data as { ingressRef: string }).ingressRef;
    await upload(ref, bytes);
    const c = await s.mcp('owner', 'imaging_ingress_complete', {
      ingressRef: ref,
      observedDigest: sha256(bytes),
      idempotencyKey: randomUUID(),
    });
    expect([c.isError, (c.body.data as { state: string }).state]).toStrictEqual([false, 'available']);
    const names = await s.mcpToolNames('owner');
    expect(names.filter((n) => n.startsWith('imaging_ingress')).sort()).toStrictEqual([
      'imaging_ingress_begin',
      'imaging_ingress_complete',
      'imaging_ingress_failures',
      'imaging_ingress_get',
    ]);
    const bad = await s.mcp('owner', 'imaging_ingress_complete', {
      ingressRef: ref,
      observedDigest: sha256(bytes),
      idempotencyKey: randomUUID(),
    });
    expect([bad.isError, bad.body.code, (bad.body.detail as { reason: string }).reason]).toStrictEqual([
      true,
      'conflict',
      'duplicate_completion',
    ]);
  });

  it('abandoned ingress is swept: staged bytes discarded, the session marked abandoned, never an object', async () => {
    const bytes = pngBytes(36);
    const b = await begin(bytes);
    await upload(b.ref, bytes);
    // Test-only fixture path: age the session (the guard trigger rightly refuses this to every role).
    await s.db.admin.query(
      `BEGIN; SET LOCAL session_replication_role = replica;
       UPDATE cuspatlas.imaging_ingress_sessions SET created_at = now() - interval '2 days' WHERE id = '${b.ref}';
       COMMIT;`,
    );
    const before = await objectCount();
    const r = await s.command('owner', '/v1/imaging/storage/reconcile', {});
    expect((r.json.data as { abandonedIngress: number }).abandonedIngress).toBeGreaterThanOrEqual(1);
    const ing = await s.inject('owner', 'GET', `/v1/imaging/ingress/${b.ref}`);
    expect(ing.json.data).toMatchObject({ state: 'abandoned', objectRef: null });
    expect(await objectCount()).toBe(before);
    const c = await complete(b.ref, sha256(bytes));
    expect([c.status, (c.json.detail as { reason: string }).reason]).toStrictEqual([409, 'ingress_not_open']);
  });

  it('caller text never reaches logs, audit, outbox, attempts or idempotency; bytes are never logged', async () => {
    expect(await imagingLeakSurface(s.db.admin)).not.toContain(MARKER);
    const logs = s.logLines.join('\n');
    expect(logs).not.toContain(MARKER);
    expect(logs).not.toContain(SYNTHETIC_MALWARE_SIGNATURE);
    expect(logs).not.toContain('IHDR');
    expect(logs).not.toContain('%PDF');
  });
});
