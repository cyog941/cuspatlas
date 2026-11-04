import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  type EngagementHarness,
  email,
  openEngagementHarness,
  synthPhone,
} from './support/engagement-fixtures';
import { MARKER } from './support/marker';

/**
 * E6: consent and opt-out records per channel and purpose with provenance, the single suppression
 * decision that S14 intents now reference (replacing S's `undecided` placeholder), quiet hours as
 * policy data, and recall enrollment that consumes S16's due list without re-deriving it. Defaults
 * stay off: with no channel policy every intent is decided `suppressed` / `policy_off` and nothing is
 * ever queued. Every rule is recommended-pending-approval.
 */
let db: TestDatabase;
let h: EngagementHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let slot = 0;
const REASONS = [
  'no_consent',
  'opt_out',
  'quiet_hours',
  'missing_contact',
  'policy_off',
  'appointment_cancelled',
  'appointment_missing',
  'template_withdrawn',
  'recall_not_due',
  'grant_expired',
  'offer_closed',
  'subject_past',
  'no_verified_channel',
];

beforeAll(async () => {
  db = await openTestDatabase('comms_consent');
  h = await openEngagementHarness(db);
  loc = await seedLocation(h, 'loc-consent');
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

function window() {
  const day = 3 + Math.floor(slot / 8) * 7;
  const hour = 13 + (slot % 8);
  slot += 1;
  const at = (hh: number) => new Date(Date.UTC(2030, 6, day, hh)).toISOString();
  return {
    startsAt: at(hour),
    endsAt: at(hour + 1),
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: loc.provider },
    operatory: { kind: 'operatory', resourceRef: loc.operatory },
  };
}
async function book(patientRef: string): Promise<string> {
  return h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/appointments', {
      patientRef,
      locationRef: loc.locationRef,
      ...window(),
    }),
    201,
  ).data.appointmentRef;
}
type Decision = { ref: string | null; owner: string; state: string; reason: string | null };
async function decisionOf(appointmentRef: string, purpose = 'reminder'): Promise<Decision> {
  const { rows } = await db.admin.query(
    'SELECT id FROM cuspatlas.notification_intents WHERE subject_id = $1 AND purpose = $2',
    [appointmentRef, purpose],
  );
  const intent = h.ok<{ data: { suppressionDecision: Decision } }>(
    await h.call('a1', 'GET', `/v1/scheduling/notifications/${rows[0]?.id}`),
  ).data;
  return intent.suppressionDecision;
}
const consent = (patientRef: string, b: Record<string, unknown>) =>
  h.call('a1', 'POST', `/v1/patients/${patientRef}/consents`, {
    channel: 'email',
    purpose: 'reminders',
    state: 'granted',
    source: 'staff_recorded',
    consentVersion: 'synthetic-consent-1',
    ...b,
  });
async function enableEmailReminders(templateRef = 'reminder-notice') {
  h.ok(
    await h.call('a1', 'POST', '/v1/communications/templates', {
      templateRef,
      purpose: 'reminder',
      channel: 'email',
      body: 'You have an upcoming visit. Sign in to the patient portal for details.',
    }),
    201,
  );
  h.ok(
    await h.call('a1', 'POST', '/v1/communications/channel-policies', {
      purpose: 'reminder',
      channel: 'email',
      templateRef,
      quietHours: { start: '21:00', end: '08:00' },
      reminderLeadMinutes: 1440,
    }),
    201,
  );
}

describe('E6 defaults and the S14 seam', () => {
  it('with no channel policy a booking intent carries a real E6 decision: suppressed, policy_off; nothing queued', async () => {
    const p = await h.person('Synthetic Default', [email('e6.default')]);
    const receipts = await count(db, 'delivery_receipts');
    const appt = await book(p);
    const d = await decisionOf(appt);
    expect(d).toMatchObject({ owner: 'E6', state: 'suppressed', reason: 'policy_off' });
    expect(d.ref).toMatch(/^[0-9a-f-]{36}$/);
    const row = await db.admin.query(
      'SELECT outcome, reason, stage, channel, subject_patient_id FROM cuspatlas.suppression_decisions WHERE id = $1',
      [d.ref],
    );
    expect(row.rows[0]).toStrictEqual({
      outcome: 'suppressed',
      reason: 'policy_off',
      stage: 'intent',
      channel: 'none',
      subject_patient_id: p,
    });
    expect(await count(db, 'delivery_receipts')).toBe(receipts);
    const decision = h.ok<{ data: { decisionRef: string; outcome: string; reason: string } }>(
      await h.call('a1', 'GET', `/v1/communications/decisions/${d.ref}`),
    ).data;
    expect(decision).toMatchObject({ decisionRef: d.ref, outcome: 'suppressed', reason: 'policy_off' });
  });

  it('every stored decision reason is one of the single SuppressionReason vocabulary', async () => {
    const bad = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.suppression_decisions
       WHERE (outcome = 'suppressed') <> (reason IS NOT NULL) OR (reason IS NOT NULL AND NOT (reason = ANY ($1::text[])))`,
      [REASONS],
    );
    expect(bad.rows[0].n).toBe(0);
    let code = 'none';
    try {
      await db.admin.query(
        `INSERT INTO cuspatlas.suppression_decisions (tenant_id, subject_patient_id, stage, purpose, channel, outcome,
           reason, policy_version, actor_id)
         SELECT tenant_id, id, 'intent', 'reminder', 'email', 'suppressed', 'invented_reason', 'x', created_by
         FROM cuspatlas.patients LIMIT 1`,
      );
    } catch (err) {
      code = (err as { code?: string }).code ?? 'unknown';
    }
    expect(code).toBe('23514');
  });
});

describe('E6 consent, opt-out and the decision', () => {
  it('a granted consent allows; a later opt-out suppresses (opt_out); a later grant allows again', async () => {
    await enableEmailReminders();
    const p = await h.person(`Synthetic Consenting ${MARKER}`, [email('e6.consenting')]);
    expect((await decisionOf(await book(p))).reason).toBe('no_consent');
    h.ok(await consent(p, {}), 201);
    expect(await decisionOf(await book(p))).toMatchObject({ state: 'allowed', reason: null });
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${p}/opt-outs`, {
        channel: 'email',
        source: 'patient_reported',
      }),
      201,
    );
    expect((await decisionOf(await book(p))).reason).toBe('opt_out');
    h.ok(await consent(p, { consentVersion: 'synthetic-consent-2' }), 201);
    expect((await decisionOf(await book(p))).state).toBe('allowed');
    const list = h.ok<{
      data: { records: { state: string; source: string; version: string }[]; effective: unknown[] };
    }>(await h.call('a1', 'GET', `/v1/patients/${p}/consents`)).data;
    expect(list.records.map((r) => r.state)).toStrictEqual(['granted', 'opted_out', 'granted']);
    expect(list.records[1]?.source).toBe('patient_reported');
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });

  it('missing contact data, a denied consent and a withdrawn template are each decided with their own reason', async () => {
    const noContact = await h.person('Synthetic No Email', [synthPhone('21')]);
    h.ok(await consent(noContact, {}), 201);
    expect((await decisionOf(await book(noContact))).reason).toBe('missing_contact');
    const denied = await h.person('Synthetic Denied', [email('e6.denied')]);
    h.ok(await consent(denied, { state: 'denied' }), 201);
    expect((await decisionOf(await book(denied))).reason).toBe('no_consent');
    const avoid = await h.person('Synthetic Avoid', [email('e6.avoid', 'avoid')]);
    h.ok(await consent(avoid, {}), 201);
    expect((await decisionOf(await book(avoid))).reason).toBe('missing_contact');
    const ok = await h.person('Synthetic Template', [email('e6.template')]);
    h.ok(await consent(ok, {}), 201);
    expect((await decisionOf(await book(ok))).state).toBe('allowed');
    h.ok(
      await h.call('a1', 'POST', '/v1/communications/templates/reminder-notice/withdraw', {
        expectedVersion: 1,
      }),
    );
    try {
      expect((await decisionOf(await book(ok))).reason).toBe('template_withdrawn');
    } finally {
      await enableEmailReminders('reminder-notice-2');
    }
  });

  it('quiet hours are policy data: the preview suppresses inside the window with the deferral, allows outside', async () => {
    const p = await h.person('Synthetic Quiet', [email('e6.quiet')]);
    h.ok(await consent(p, {}), 201);
    // Send-time decisions (and previews of them) address only a verified contact point.
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${p}/contact-verifications`, {
        channel: 'email',
        value: 'e6.quiet@example.invalid',
        method: 'synthetic_attested',
      }),
      201,
    );
    const preview = async (at: string) =>
      h.ok<{
        data: { outcome: string; reason: string | null; deferredUntil: string | null; recorded: boolean };
      }>(
        await h.call(
          'a1',
          'GET',
          `/v1/patients/${p}/suppression-preview?purpose=reminder&channel=email&at=${encodeURIComponent(at)}&locationRef=${loc.locationRef}`,
        ),
      ).data;
    // 23:30 in New York (03:30Z next day, EDT) is inside 21:00-08:00; 12:00 local is outside.
    const night = await preview('2030-07-04T03:30:00Z');
    expect(night).toMatchObject({ outcome: 'suppressed', reason: 'quiet_hours', recorded: false });
    expect(night.deferredUntil).toBe('2030-07-04T12:00:00.000Z');
    expect(await preview('2030-07-04T16:00:00Z')).toMatchObject({ outcome: 'allowed', reason: null });
    const policies = h.ok<{ data: { purpose: string; quietHours: { start: string; end: string } | null }[] }>(
      await h.call('a1', 'GET', '/v1/communications/channel-policies'),
    ).data;
    expect(policies.find((x) => x.purpose === 'reminder')?.quietHours).toStrictEqual({
      start: '21:00',
      end: '08:00',
    });
  });

  it('a channel policy without quiet hours or template is refused: there is no shipped default send window', async () => {
    for (const body of [
      { purpose: 'recall', channel: 'email', templateRef: 'reminder-notice-2' },
      { purpose: 'recall', channel: 'email', quietHours: { start: '21:00', end: '08:00' } },
    ]) {
      expect((await h.call('a1', 'POST', '/v1/communications/channel-policies', body)).statusCode).toBe(422);
    }
    // Templates are notice-only: no placeholders that could carry clinical content.
    const placeholder = await h.call('a1', 'POST', '/v1/communications/templates', {
      templateRef: 'bad-template',
      purpose: 'reminder',
      channel: 'email',
      body: 'Your {procedure} is tomorrow',
    });
    expect(placeholder.statusCode).toBe(400);
    // Template approval and channel policy are practice administration by a person.
    expect(
      (
        await h.call('svcA1', 'POST', '/v1/communications/channel-policies', {
          purpose: 'recall',
          channel: 'none',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('a guardian consents through the portal with the consent scope; it stops counting once the relationship ends', async () => {
    const parent = await h.person('Synthetic Consent Parent', [email('e6.parent')]);
    const kid = await h.person('Synthetic Consent Kid', [email('e6.kid')], {
      birthDate: { known: true, value: '2016-05-05', precision: 'day' },
    });
    const rel = h.ok<{ data: { relationshipRef: string } }>(
      await h.call('a1', 'POST', `/v1/patients/${kid}/relationships`, {
        counterpartyRef: parent,
        kind: 'guardian',
        scopes: ['scheduling', 'consent'],
      }),
      201,
    ).data.relationshipRef;
    const pp = await h.enroll(parent, { channel: 'email', value: 'e6.parent@example.invalid' });
    const rec = h.ok<{ data: { consentRef: string; source: string } }>(
      await h.portal(pp, 'POST', `/portal/v1/patients/${kid}/consents`, {
        channel: 'email',
        purpose: 'reminders',
        state: 'granted',
        consentVersion: 'synthetic-consent-1',
      }),
      201,
    ).data;
    expect(rec.source).toBe('guardian_portal');
    const via = await db.admin.query(
      'SELECT via_relationship_id FROM cuspatlas.communication_consents WHERE id = $1',
      [rec.consentRef],
    );
    expect(via.rows[0].via_relationship_id).toBe(rel);
    expect((await decisionOf(await book(kid))).state).toBe('allowed');
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${kid}/relationships/${rel}/revoke`, {
        expectedVersion: 1,
        reasonCode: 'guardian_request',
      }),
    );
    expect((await decisionOf(await book(kid))).reason).toBe('grant_expired');
    // A guardian without the consent scope cannot record one.
    const other = await h.person('Synthetic Consentless Parent', [email('e6.consentless')]);
    const kid2 = await h.person('Synthetic Consentless Kid', [], {
      birthDate: { known: true, value: '2016-05-05', precision: 'day' },
    });
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${kid2}/relationships`, {
        counterpartyRef: other,
        kind: 'guardian',
        scopes: ['scheduling'],
      }),
      201,
    );
    const op = await h.enroll(other, { channel: 'email', value: 'e6.consentless@example.invalid' });
    const res = await h.portal(op, 'POST', `/portal/v1/patients/${kid2}/consents`, {
      channel: 'email',
      purpose: 'reminders',
      state: 'granted',
      consentVersion: 'synthetic-consent-1',
    });
    expect([res.statusCode, res.json().detail?.reason]).toStrictEqual([403, 'relationship_scope_missing']);
  });

  it('a patient opts out through the portal for themselves; another tenant cannot record or read consent', async () => {
    const p = await h.person('Synthetic Self Opt Out', [email('e6.self')]);
    const pp = await h.enroll(p, { channel: 'email', value: 'e6.self@example.invalid' });
    const rec = h.ok<{ data: { state: string; source: string } }>(
      await h.portal(pp, 'POST', `/portal/v1/patients/${p}/consents`, {
        channel: 'email',
        purpose: 'reminders',
        state: 'opted_out',
        consentVersion: 'synthetic-consent-1',
      }),
      201,
    ).data;
    expect(rec).toMatchObject({ state: 'opted_out', source: 'patient_portal' });
    const foreign = await h.call('b1', 'POST', `/v1/patients/${p}/consents`, {
      channel: 'email',
      purpose: 'reminders',
      state: 'granted',
      source: 'staff_recorded',
      consentVersion: 'synthetic-consent-1',
    });
    const random = await h.call('b1', 'POST', `/v1/patients/${randomUUID()}/consents`, {
      channel: 'email',
      purpose: 'reminders',
      state: 'granted',
      source: 'staff_recorded',
      consentVersion: 'synthetic-consent-1',
    });
    expect([foreign.statusCode, random.statusCode]).toStrictEqual([404, 404]);
    expect((await h.call('b1', 'GET', `/v1/patients/${p}/consents`)).statusCode).toBe(404);
    // Consent records are append-only facts.
    let code = 'none';
    try {
      await db.app.query(`UPDATE cuspatlas.communication_consents SET state = 'granted'`);
    } catch (err) {
      code = (err as { code?: string }).code ?? 'unknown';
    }
    expect(code).toBe('42501');
  });
});

describe('E6 recall enrollment from S16 due items', () => {
  it('enrolls only S16-due patients, reports S16 exclusions and not-due patients, and never enrolls twice', async () => {
    h.ok(
      await h.call('a1', 'POST', '/v1/scheduling/recall/policies', {
        category: 'e6-hygiene',
        intervalMonths: 6,
        basis: 'attended_visit',
      }),
      201,
    );
    const visit = async (p: string, startsAt: string) => {
      const ref = h.ok<{ data: { appointmentRef: string } }>(
        await h.call('a1', 'POST', '/v1/scheduling/appointments', {
          patientRef: p,
          locationRef: loc.locationRef,
          startsAt,
          endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
          timeZone: 'America/New_York',
          provider: { kind: 'provider', resourceRef: loc.provider },
          operatory: { kind: 'operatory', resourceRef: loc.operatory },
        }),
        201,
      ).data.appointmentRef;
      return ref;
    };
    const due = await h.person('Synthetic Recall Due', [email('e6.recall.due')]);
    const booked = await h.person('Synthetic Recall Booked', [email('e6.recall.booked')]);
    const fresh = await h.person('Synthetic Recall New', []);
    for (const p of [due, booked]) {
      const ref = await visit(p, p === due ? '2030-08-05T14:00:00Z' : '2030-08-05T16:00:00Z');
      h.ok(
        await h.call('a1', 'POST', `/v1/scheduling/appointments/${ref}/attendance`, { kind: 'arrived' }),
        201,
      );
    }
    await visit(booked, '2031-06-02T14:00:00Z');
    const outbound = await db.admin.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'cuspatlas' AND table_name = 'outbound_messages'`,
    );
    const enroll = () =>
      h.call('a1', 'POST', '/v1/communications/recall-enrollments', {
        category: 'e6-hygiene',
        asOf: '2031-03-01T12:00:00Z',
        patientRefs: [due, booked, fresh],
      });
    const first = h.ok<{
      data: {
        enrolled: number;
        skipped: { ref: string; reason: string; exclusion?: string }[];
        alreadyEnrolled: string[];
      };
    }>(await enroll(), 201).data;
    expect(first.enrolled).toBe(1);
    expect(first.skipped).toStrictEqual([
      { ref: booked, reason: 'recall_not_due', exclusion: 'already_booked' },
      { ref: fresh, reason: 'recall_not_due', exclusion: 'no_baseline' },
    ]);
    const second = h.ok<{ data: { enrolled: number; alreadyEnrolled: string[] } }>(await enroll(), 201).data;
    expect(second).toMatchObject({ enrolled: 0, alreadyEnrolled: [due] });
    const list = h.ok<{ data: { patientRef: string; dueDate: string; policyVersion: number }[] }>(
      await h.call('a1', 'GET', '/v1/communications/recall-enrollments?category=e6-hygiene'),
    ).data;
    expect(list.map((e) => e.patientRef)).toStrictEqual([due]);
    expect(list[0]?.dueDate).toBe('2031-02-05');
    // Enrollment sends nothing by itself: no outbound message, no receipt, no intent.
    expect(outbound.rows[0].n === 0 || (await count(db, 'outbound_messages')) === 0).toBe(true);
    // Another tenant's member never sees or enrolls alpha patients.
    const beta = await h.call('b1', 'POST', '/v1/communications/recall-enrollments', {
      category: 'e6-hygiene',
      asOf: '2031-03-01T12:00:00Z',
      patientRefs: [due],
    });
    expect(beta.statusCode).toBe(404);
    const betaList = await h.call('b1', 'GET', '/v1/communications/recall-enrollments?category=e6-hygiene');
    expect(betaList.statusCode).toBe(404);
  });
});
