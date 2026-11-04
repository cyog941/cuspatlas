import { randomUUID } from 'node:crypto';
import type { AppointmentHarness } from './appointment-fixtures';
import { createPatient, T_ALPHA } from './appointment-fixtures';
import type { FakeImageResolver } from './image-ref-resolver';

const DIGEST = `sha256:${'f'.repeat(64)}`;
const PLANS = '/v1/clinical/treatment-plans';
let slot = 0;

/**
 * One synthetic patient with a record of every clinical class (C5-C17): encounter on a booked visit,
 * history (two versions), chart entry and its correction, perio exam, an accepted plan with a rendered
 * procedure, a reversal and a replacement (a correction chain), a signed and amended note, consent
 * and its withdrawal, an image link, a lab case with transitions and an attachment, and an outgoing
 * referral (package, share, sent). Built through the deployed REST commands only.
 */
export async function buildClinicalRecord(
  h: AppointmentHarness,
  loc: { locationRef: string; provider: string; operatory: string },
  images: FakeImageResolver,
  name = 'Synthetic Clinical Record',
  patientRef?: string,
) {
  const p = patientRef ?? (await createPatient(h, name));
  const post = async <T = Record<string, unknown>>(url: string, body: unknown, status = 201) =>
    h.ok<{ data: T }>(await h.call('a1', 'POST', url, body, randomUUID()), status).data;
  // Distinct weekday slots per call (Monday-Wednesday, 13:00-19:00 UTC) so fixtures never collide.
  const n = slot++;
  const day = 8 + (Math.floor(n / 6) % 3);
  const hour = 13 + (n % 6);
  const appt = (
    await post<{ appointmentRef: string }>('/v1/scheduling/appointments', {
      patientRef: p,
      locationRef: loc.locationRef,
      startsAt: new Date(Date.UTC(2030, 6, day, hour)).toISOString(),
      endsAt: new Date(Date.UTC(2030, 6, day, hour + 1)).toISOString(),
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    })
  ).appointmentRef;
  const enc = (
    await post<{ encounter: { encounterRef: string; version: number } }>('/v1/clinical/encounters', {
      patientRef: p,
      appointmentRef: appt,
    })
  ).encounter;
  await post(`/v1/clinical/encounters/${enc.encounterRef}/assignments`, {
    expectedVersion: enc.version,
    role: 'treating_provider',
    assignee: { kind: 'provider', resourceRef: loc.provider },
  });
  const e = enc.encounterRef;
  for (const text of ['Synthetic allergen one', 'Synthetic allergen two']) {
    await post('/v1/clinical/history/changes', {
      patientRef: p,
      provenance: 'staff',
      reportedBy: 'clinician',
      changes: [{ kind: 'allergy', state: 'active', displayText: text }],
    });
  }
  const tooth = { system: 'universal', code: '3' };
  const entry = (
    await post<{ entry: { entryRef: string; version: number } }>('/v1/clinical/chart/entries', {
      patientRef: p,
      provenance: 'recorded',
      tooth,
      kind: 'condition',
      findingRef: 'SYN-COND-300',
    })
  ).entry;
  await post(`/v1/clinical/chart/entries/${entry.entryRef}/corrections`, {
    reasonCode: 'wrong_surface',
    state: 'active',
    detailText: 'Synthetic corrected detail',
  });
  const perio = (
    await post<{ examRef: string }>('/v1/clinical/perio/exams', {
      patientRef: p,
      siteScheme: 'six_site_provisional',
      teeth: [
        {
          tooth: { system: 'universal', code: '14' },
          mobility: 'not_measured',
          furcation: 'not_measured',
          probingDepth: [3, 3, 3, 3, 3, 3],
          recession: [1, 1, 1, 1, 1, 1],
          bleeding: ['not_measured', false, false, false, false, false],
        },
      ],
    })
  ).examRef;
  const plan = (await post<{ plan: { planRef: string; headVersionRef: string } }>(PLANS, { patientRef: p }))
    .plan;
  const v = plan.headVersionRef;
  const detail = (
    await post<{ targetRef: string }>(`${PLANS}/versions/${v}/details`, {
      expectedRevision: 1,
      scope: 'whole_mouth',
    })
  ).targetRef;
  const item = (
    await post<{ targetRef: string }>(`${PLANS}/details/${detail}/items`, {
      expectedRevision: 2,
      procedureCodeRef: 'SYN-PROC-X01',
      sequence: 1,
      feeScheduleRef: 'synthetic-fee-x01',
    })
  ).targetRef;
  await post(`${PLANS}/items/${item}/state`, { expectedRevision: 3, state: 'accepted' }, 200);
  const est = (
    await post<{ estimateRef: string }>(`${PLANS}/versions/${v}/estimates`, {
      lines: [{ planItemRef: item, fee: { currency: 'USD', minor: 12_000 } }],
    })
  ).estimateRef;
  await post(`/v1/clinical/estimates/${est}/presentation`, {}, 200);
  await post(`/v1/clinical/estimates/${est}/acceptance`, { expectedRevision: 4, scope: 'full' });
  const proc = (
    await post<{ procedureRef: string }>(`/v1/clinical/encounters/${e}/procedures`, {
      sequence: 1,
      dateOfService: '2026-10-01',
      renderingProviderRef: loc.provider,
      planItemRef: item,
    })
  ).procedureRef;
  const other = (
    await post<{ procedureRef: string }>(`/v1/clinical/encounters/${e}/procedures`, {
      sequence: 2,
      dateOfService: '2026-10-01',
      renderingProviderRef: loc.provider,
      codeRef: 'SYN-PROC-X02',
    })
  ).procedureRef;
  await post(`/v1/clinical/procedures/${other}/corrections`, {
    reasonCode: 'wrong_code',
    replacement: { codeRef: 'SYN-PROC-X03' },
  });
  const note = (
    await post<{ noteRef: string }>(`/v1/clinical/encounters/${e}/notes`, {
      noteType: 'progress',
      content: {
        sections: [{ sectionKey: 'subjective', text: 'Synthetic record note' }],
        procedureCodeRefs: [],
      },
    })
  ).noteRef;
  await post(`/v1/clinical/notes/${note}/sign`, { expectedVersion: 1 }, 200);
  const consent = (
    await post<{ consentRef: string }>('/v1/clinical/consents', {
      patientRef: p,
      scope: 'general_treatment',
      method: 'in_person',
      templateRef: 'synthetic-disclosure-consent',
      templateDigest: DIGEST,
      attestationCode: 'signed_in_person',
      signer: { kind: 'patient' },
    })
  ).consentRef;
  const withdrawn = (
    await post<{ consentRef: string }>('/v1/clinical/consents', {
      patientRef: p,
      scope: 'general_treatment',
      method: 'in_person',
      templateRef: 'synthetic-consent-general',
      templateDigest: DIGEST,
      attestationCode: 'signed_in_person',
      signer: { kind: 'patient' },
    })
  ).consentRef;
  await post(`/v1/clinical/consents/${withdrawn}/withdrawal`, {
    expectedVersion: 1,
    reasonCode: 'patient_request',
    signer: { kind: 'patient' },
  });
  const imageRef = `syn-img-${randomUUID()}`;
  images.put(T_ALPHA, imageRef, { status: 'current', patientRef: p, associationRef: 'syn-assoc-r' });
  const imageLink = (
    await post<{ imageLinkRef: string }>(`/v1/clinical/encounters/${e}/image-links`, { imageRef })
  ).imageLinkRef;
  const lab = (
    await post<{ labCaseRef: string }>('/v1/clinical/lab-cases', {
      patientRef: p,
      counterpartyRef: 'syn-lab-record',
      caseRef: `SYN-REC-${randomUUID().slice(0, 8)}`,
      planDetailRef: detail,
      appointmentRef: appt,
      attachmentRefs: ['syn-obj-rec-1'],
    })
  ).labCaseRef;
  await post(`/v1/clinical/lab-cases/${lab}/state`, { expectedVersion: 1, state: 'sent' }, 200);
  const referral = (
    await post<{ referralRef: string }>('/v1/clinical/referrals', {
      patientRef: p,
      direction: 'outgoing',
      counterpartyRef: 'syn-practice-record',
      reasonCode: 'endodontic_evaluation',
      requestedScope: 'consult',
      consentRef: consent,
    })
  ).referralRef;
  await post(
    `/v1/clinical/referrals/${referral}/package`,
    { expectedVersion: 1, selections: [{ kind: 'renderedProcedure', ref: proc }] },
    200,
  );
  await post(`/v1/clinical/referrals/${referral}/shares`, {
    purposeCode: 'continuity_of_care',
    scope: ['renderedProcedure'],
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  await post(`/v1/clinical/referrals/${referral}/sent`, { expectedVersion: 3, channel: 'print' }, 200);
  return {
    perio,
    patientRef: p,
    appointmentRef: appt,
    encounterRef: e,
    entry: entry.entryRef,
    plan,
    item,
    proc,
    other,
    note,
    consent,
    withdrawn,
    imageLink,
    lab,
    referral,
  };
}
