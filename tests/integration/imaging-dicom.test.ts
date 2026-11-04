import { DICOM_BOUNDARY } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { malformedDicom, misplacedMarker, syntheticDicom } from './support/dicom-fixtures';
import {
  type ImagingStack,
  imagingLeakSurface,
  ingestVia,
  pngBytes,
  sha256,
  startImagingStack,
} from './support/imaging-fixtures';
import { MARKER } from './support/marker';
import { patientBody } from './support/patient-fixtures';

/**
 * I5 DICOM boundary (synthetic containers only). I-S2 (conformance and parser licensing) is
 * blocked-on-discovery, so the boundary is: recognize the `DICM` marker by magic bytes, store the
 * original opaquely through the I2 ingress, and refuse to parse. No summary, identifier, transfer
 * syntax or element is ever extracted; no network DICOM service exists. These tests pin that refusal
 * so a parser cannot arrive silently.
 */
let s: ImagingStack;
let pOne: string;
let pTwo: string;
const reason = (r: { json: Record<string, unknown> }) =>
  (r.json.detail as { reason?: string } | undefined)?.reason;

const dicomIngest = (bytes: Uint8Array, extra: Record<string, unknown> = {}) =>
  ingestVia(s, bytes, { contentType: 'application/dicom', ...extra });
const inspect = (objectRef: string) => s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}/container`);
const download = async (objectRef: string) => {
  const g = await s.inject('owner', 'POST', `/v1/imaging/objects/${objectRef}/read-grants`, {});
  return s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}/content`, undefined, {
    'x-object-read-token': (g.json.data as { token: string }).token,
  });
};
const REFUSED = {
  container: 'dicom',
  markerRecognized: true,
  supported: false,
  parsing: 'refused',
  limitation: 'dicom_parser_not_qualified',
  blockedOn: 'I-S2',
  summary: null,
};

beforeAll(async () => {
  s = await startImagingStack('imaging_dicom');
  const mk = async (name: string) =>
    ((await s.command('owner', '/v1/patients', patientBody(name))).json.data as { patientRef: string })
      .patientRef;
  pOne = await mk('Dicom One');
  pTwo = await mk('Dicom Two');
});
afterAll(async () => {
  await s?.close();
});

describe('I5 the parsing refusal is pinned', () => {
  it('the boundary constant names the refusal, its blocking spike and no network services', () => {
    expect(DICOM_BOUNDARY).toStrictEqual({
      parsing: 'refused',
      limitation: 'dicom_parser_not_qualified',
      blockedOn: 'I-S2',
      networkServices: 'out_of_scope',
      recognition: 'dicm_marker_at_offset_128',
    });
    expect(Object.isFrozen(DICOM_BOUNDARY)).toBe(true);
  });
});

describe('I5 opaque storage of containers', () => {
  it('a synthetic container is stored opaquely; bytes round-trip unchanged; nothing is extracted', async () => {
    const bytes = syntheticDicom({ patientName: `SYNTHETIC^${MARKER}`, patientId: `ID-${MARKER}`, seed: 1 });
    const { objectRef, status } = await dicomIngest(bytes);
    expect(status).toBe(201);
    const read = await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}`);
    expect(read.json.data).toMatchObject({ contentType: 'application/dicom', digestSha256: sha256(bytes) });
    const d = await download(objectRef);
    expect([d.status, sha256(d.raw)]).toStrictEqual([200, sha256(bytes)]);
    const i = await inspect(objectRef);
    expect(i.status).toBe(200);
    expect(i.json.data).toStrictEqual({ objectRef, digestSha256: sha256(bytes), ...REFUSED });
    // No identifier from inside the container reaches a response, a record or a log line.
    expect(JSON.stringify([read.json, i.json])).not.toContain(MARKER);
    expect(await imagingLeakSurface(s.db.admin)).not.toContain(MARKER);
    expect(s.logLines.join('\n')).not.toContain(MARKER);
    // Inspection never alters the stored bytes.
    expect(sha256((await download(objectRef)).raw)).toBe(sha256(bytes));
  });

  it('a malformed container and one with an absurd element length store and inspect the same way', async () => {
    for (const bytes of [malformedDicom(3), syntheticDicom({ absurdLength: true, seed: 2 })]) {
      const { objectRef, status } = await dicomIngest(bytes);
      expect(status).toBe(201);
      const i = await inspect(objectRef);
      expect(i.json.data).toStrictEqual({ objectRef, digestSha256: sha256(bytes), ...REFUSED });
      expect(sha256((await download(objectRef)).raw)).toBe(sha256(bytes));
    }
  });

  it('an external file reference inside a container is never followed or echoed', async () => {
    const ref = `../../outside-${MARKER}/x`;
    const bytes = syntheticDicom({ externalReference: ref, seed: 3 });
    const { objectRef } = await dicomIngest(bytes);
    const i = await inspect(objectRef);
    expect(i.json.data).toStrictEqual({ objectRef, digestSha256: sha256(bytes), ...REFUSED });
    expect(i.body).not.toContain('outside-');
  });

  it('identifiers inside a container never propose or override an association', async () => {
    const bytes = syntheticDicom({ patientName: 'TWO^DICOM', patientId: 'SYN-TWO', seed: 4 });
    const { objectRef } = await dicomIngest(bytes);
    const c = await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}/match-candidates`);
    expect(c.json.data).toMatchObject({ limitations: ['no_patient_metadata'] });
    const a = await s.command('owner', `/v1/imaging/objects/${objectRef}/association`, {
      patientRef: pOne,
      basis: 'operatorSelected',
    });
    expect(a.status).toBe(201);
    const read = await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}`);
    expect((read.json.data as { association: { patientRef: string } }).association.patientRef).toBe(pOne);
    expect(JSON.stringify(read.json)).not.toContain(pTwo);
  });

  it('two containers with the same digest for one patient deduplicate under the I2 rule', async () => {
    const bytes = syntheticDicom({ seed: 5 });
    const a = await dicomIngest(bytes, { intendedPatientRef: pOne });
    const b = await dicomIngest(bytes, { intendedPatientRef: pOne });
    expect(b.objectRef).toBe(a.objectRef);
    const other = await dicomIngest(bytes, { intendedPatientRef: pTwo });
    expect(other.objectRef).not.toBe(a.objectRef);
  });

  it('the marker at the wrong offset is unrecognized and a PNG declared as DICOM is a mismatch', async () => {
    const wrong = await dicomIngest(misplacedMarker());
    expect(wrong.status).toBe(409);
    const png = pngBytes(77);
    const b = await s.command('owner', '/v1/imaging/ingress', {
      contentType: 'application/dicom',
      byteLength: png.byteLength,
      declaredDigest: sha256(png),
      provenance: { source: 'operatorUpload' },
    });
    const ref = (b.json.data as { ingressRef: string }).ingressRef;
    await s.command('owner', `/v1/imaging/ingress/${ref}/content`, png);
    const c = await s.command('owner', `/v1/imaging/ingress/${ref}/complete`, {
      observedDigest: sha256(png),
    });
    expect([c.status, reason(c)]).toStrictEqual([409, 'content_type_mismatch']);
    const w = await s.inject('owner', 'GET', `/v1/imaging/ingress/${wrong.ingressRef}`);
    expect((w.json.data as { quarantineReason: string }).quarantineReason).toBe('content_type_unrecognized');
  });

  it('a non-container object inspects as none; another tenant is hidden; MCP returns the same result', async () => {
    const png = await ingestVia(s, pngBytes(78));
    const i = await inspect(png.objectRef);
    expect(i.json.data).toMatchObject({ container: 'none', markerRecognized: false, parsing: 'refused' });
    const bytes = syntheticDicom({ seed: 6 });
    const { objectRef } = await dicomIngest(bytes);
    expect((await s.inject('crossTenant', 'GET', `/v1/imaging/objects/${objectRef}/container`)).status).toBe(
      404,
    );
    const m = await s.mcp('owner', 'imaging_containers_inspect', { objectRef });
    expect([m.isError, m.body.data]).toStrictEqual([
      false,
      { objectRef, digestSha256: sha256(bytes), ...REFUSED },
    ]);
  });
});
