/** The parts of the I9 export this scenario reads (the contract type lives in @cuspatlas/contracts). */
interface ImagingExport {
  readonly blobs: readonly { readonly digestSha256: string }[];
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYNTHETIC_MALWARE_SIGNATURE } from '../integration/support/fake-scanner';
import {
  type ImagingStack,
  ingestVia,
  pngBytes,
  sha256,
  startImagingStack,
} from '../integration/support/imaging-fixtures';
import { patientBody } from '../integration/support/patient-fixtures';
import { SyntheticBridge } from '../integration/support/synthetic-bridge';

/**
 * I9 "ordinary imaging day" (synthetic): the front desk pairs a bridge, an assistant requests an
 * import for the scheduled patient, the bridge claims a signed job, uploads and reports a signed
 * result, the upload passes the quarantine gates (a second, infected-looking upload does not), the
 * staff confirm the patient match, mount and annotate the image, correct a mis-filed image, a legal
 * hold blocks a deletion request, and the administrator exports the day's imaging records with their
 * digests. No device, scanner or DICOM library is real; nothing here is clinically validated.
 */
let s: ImagingStack;
let patient: string;
let other: string;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
const reason = (r: { json: Record<string, unknown> }) =>
  (r.json.detail as { reason?: string } | undefined)?.reason;

beforeAll(async () => {
  s = await startImagingStack('ordinary_imaging_day');
  patient = data<{ patientRef: string }>(
    await s.command('owner', '/v1/patients', patientBody('Imaging Day')),
  ).patientRef;
  other = data<{ patientRef: string }>(
    await s.command('owner', '/v1/patients', patientBody('Imaging Other')),
  ).patientRef;
});
afterAll(async () => {
  await s?.close();
});

describe('an ordinary imaging day', () => {
  it('runs from bridge pairing to export with every step recorded and nothing silently skipped', async () => {
    // 08:00 the administrator registers and pairs the operatory bridge; it starts sending heartbeats.
    const reg = await s.command('owner', '/v1/imaging/devices', {
      label: 'Operatory 2 Bridge',
      allowedJobKinds: ['import'],
      allowedPathPrefixes: ['exports/today'],
    });
    const deviceRef = data<{ deviceRef: string }>(reg).deviceRef;
    const code = data<{ pairingCode: string }>(
      await s.inject('owner', 'POST', `/v1/imaging/devices/${deviceRef}/pairing-codes`, {}),
    ).pairingCode;
    const bridge = new SyntheticBridge(s.app);
    expect((await bridge.pair(code)).status).toBe(201);
    expect((await bridge.heartbeat()).status).toBe(200);

    // 09:10 the assistant asks for the capture to be imported for the scheduled patient.
    const acq = await s.command('writer', '/v1/imaging/acquisitions', {
      deviceRef,
      kind: 'import',
      importPath: 'exports/today/bw-1.png',
      intendedPatientRef: patient,
    });
    expect(acq.json.data).toMatchObject({ state: 'queued' });
    const jobRef = data<{ jobRef: string }>(acq).jobRef;

    // The bridge claims the signed job, verifies it, uploads and reports a signed result.
    const { job } = await bridge.claim();
    expect(job).toMatchObject({ jobRef, scopePath: 'exports/today/bw-1.png', kind: 'import' });
    const bytes = pngBytes(9901, 8, 8);
    expect((await bridge.upload(jobRef, bytes)).status).toBe(200);
    const result = await bridge.report(
      jobRef,
      bridge.resultToken(job as NonNullable<typeof job>, { outcome: 'completed', bytes }),
    );
    expect(result.json.data).toMatchObject({ state: 'completed', deduplicated: false });
    const objectRef = data<{ objectRef: string }>(result).objectRef;

    // Quarantine pass: the bridge import passed every gate; a suspicious manual upload does not.
    const bad = await ingestVia(s, new TextEncoder().encode(`${SYNTHETIC_MALWARE_SIGNATURE}-synthetic`), {
      contentType: 'image/png',
    });
    expect(bad.status).toBe(409);
    const failures = data<{ items: { kind: string }[] }>(
      await s.inject('owner', 'GET', '/v1/imaging/ingress/failures'),
    );
    expect(failures.items.some((i) => i.kind === 'ingress_quarantined')).toBe(true);

    // Patient match: the named patient is a candidate; the dentist confirms it (never automatic).
    const cand = data<{ candidates: { patientRef: string }[] }>(
      await s.inject('owner', 'GET', `/v1/imaging/objects/${objectRef}/match-candidates`),
    );
    expect(cand.candidates.map((c) => c.patientRef)).toContain(patient);
    const conf = await s.command('associator', `/v1/imaging/objects/${objectRef}/association`, {
      patientRef: patient,
      basis: 'operatorSelected',
    });
    expect(conf.status).toBe(201);
    const imageRef = data<{ imageRef: string }>(conf).imageRef;

    // Mount and annotate; the original's digest never changes.
    const mount = await s.command('writer', '/v1/imaging/mounts', {
      template: 'pa-1',
      slots: [{ slot: 1, objectRef }],
    });
    expect(mount.status).toBe(201);
    const ann = await s.command('writer', `/v1/imaging/objects/${objectRef}/annotations`, {
      kind: 'marker',
      geometry: { kind: 'point', x: 0.3, y: 0.6 },
    });
    expect(ann.status).toBe(201);

    // A second capture was filed under the wrong patient; it is corrected with a reason (history kept).
    const misfiled = await ingestVia(s, pngBytes(9902, 8, 8), { intendedPatientRef: other });
    const wrong = await s.command('associator', `/v1/imaging/objects/${misfiled.objectRef}/association`, {
      patientRef: other,
      basis: 'operatorSelected',
    });
    const fix = await s.command(
      'associator',
      `/v1/imaging/associations/${data<{ decisionRef: string }>(wrong).decisionRef}/correct`,
      {
        patientRef: patient,
        reasonCode: 'wrong_patient',
      },
    );
    expect(fix.status).toBe(201);
    const history = data<unknown[]>(
      await s.inject('owner', 'GET', `/v1/imaging/objects/${misfiled.objectRef}/associations`),
    );
    expect((history as unknown as { decisions: unknown[] }).decisions).toHaveLength(2);

    // A records request places a legal hold; a deletion request is refused with the hold as the reason.
    await s.command('owner', '/v1/imaging/retention/policies', {
      recordClass: 'associated_original',
      minimumRetentionMonths: 0,
      basisCode: 'synthetic_test_policy',
      jurisdictionCode: 'us-synthetic',
    });
    const hold = await s.command('owner', '/v1/imaging/legal-holds', {
      subject: { kind: 'patient', ref: patient },
      reasonCode: 'records_request',
    });
    expect(hold.status).toBe(201);
    const del = await s.command('owner', `/v1/imaging/objects/${objectRef}/deletion-requests`, {
      reasonCode: 'requested_by_practice',
    });
    expect([del.status, reason(del)]).toStrictEqual([409, 'legal_hold_active']);

    // The consumer read (C15/CL-04 seam) matches the patient; the bytes are the bytes the bridge sent.
    const ref = await s.inject(
      'owner',
      'GET',
      `/v1/imaging/image-refs/${imageRef}?expectedPatientRef=${patient}`,
    );
    expect(ref.json.data).toMatchObject({ matchesExpected: true, digestSha256: sha256(bytes) });

    // 17:30 the administrator exports the day's imaging records with their digests.
    const exp = data<ImagingExport>(await s.inject('owner', 'GET', '/v1/imaging/export'));
    expect(exp.blobs.map((b) => b.digestSha256)).toContain(sha256(bytes));
    expect((exp.tables.imaging_object_provenance ?? []).some((p) => p.source === 'bridgeImport')).toBe(true);
    expect((exp.tables.imaging_match_decisions ?? []).length).toBeGreaterThanOrEqual(3);

    // End of day: nothing waits silently. The bridge worklist has no failure; nothing is unmatched.
    const w = data<{ items: { kind: string }[] }>(
      await s.inject('owner', 'GET', '/v1/imaging/worklists/bridge'),
    );
    expect(w.items.filter((i) => i.kind !== 'device_unavailable')).toStrictEqual([]);
    const um = data<{ items: { objectRef: string }[] }>(
      await s.inject('owner', 'GET', '/v1/imaging/worklists/unmatched'),
    );
    expect(JSON.stringify(um)).not.toContain(objectRef);
  });
});
