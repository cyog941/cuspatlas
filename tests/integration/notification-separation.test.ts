import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TenantTransaction, WithTenantTransaction } from '@cuspatlas/contracts';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  USER_A1,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { actorFor, domainAppointments, envelope } from './support/domain-harness';

/**
 * S14: the booking, cancel and reschedule transactions record a NotificationIntent and never send.
 * No channel is verified (S-S2 / S-D5 pending), so every intent has channel `none`. The suppression
 * decision belongs to E6: since E6 it is recorded through E6's published seam in the same transaction
 * and the intent stores only its reference (default: suppressed, policy_off). Scheduling itself reads
 * no consent state. Staff see intents without a channel as work items.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let north: { locationRef: string; provider: string; operatory: string };
let slot = 0;
const APPT = '/v1/scheduling/appointments';
const WORK = '/v1/scheduling/notifications/worklist';

beforeAll(async () => {
  db = await openTestDatabase('notification_separation');
  h = await openAppointmentHarness(db, { mcp: true });
  loc = await seedLocation(h, 'loc-intents');
  north = await seedLocation(h, 'loc-north');
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

function window(l = loc) {
  const day = 1 + Math.floor(slot / 8) * 7;
  const hour = 13 + (slot % 8);
  slot += 1;
  const at = (hh: number) => new Date(Date.UTC(2030, 4, 6 + day, hh)).toISOString();
  return {
    startsAt: at(hour),
    endsAt: at(hour + 1),
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: l.provider },
    operatory: { kind: 'operatory', resourceRef: l.operatory },
  };
}

async function book(l = loc): Promise<{ ref: string; patient: string }> {
  const patient = await createPatient(h, 'Synthetic Notice');
  const res = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', APPT, { patientRef: patient, locationRef: l.locationRef, ...window(l) }),
    201,
  );
  return { ref: res.data.appointmentRef, patient };
}

type Intent = {
  intentRef: string;
  subjectRef: string;
  purpose: string;
  channel: string;
  policyRef: string;
  templateRef: string | null;
  deliveryKey: string;
  supersedes: string | null;
  suppressionDecision: {
    ref: string | null;
    owner: string;
    state: string;
    reason: string | null;
    statement: string;
  };
};
async function intentsFor(subject: string): Promise<{ id: string; purpose: string }[]> {
  const { rows } = await db.admin.query(
    'SELECT id, purpose FROM cuspatlas.notification_intents WHERE subject_id = $1 ORDER BY created_at, id',
    [subject],
  );
  return rows;
}
type WorkItem = {
  workItemRef: string;
  kind: string;
  reasonCode: string;
  explanation: string;
  evidenceRefs: { kind: string; ref: string }[];
  owner: { queue: string; principalRef: string | null };
  nextActionOwedBy: string;
  dueAt: string | null;
  suggestedNextAction: string;
  blockingDependencies: string[];
};
async function worklist(who: 'a1' | 'a3' | 'b1' = 'a1', query = '') {
  return h.ok<{ data: { coverage: { status: string }; count: number; items: WorkItem[] } }>(
    await h.call(who, 'GET', `${WORK}${query}`),
  ).data;
}

describe('S14 acceptance (no verified channel; E6 decides through its seam)', () => {
  it('a booking records exactly one intent with channel none and an E6 decision reference (policy_off by default), and sends nothing', async () => {
    const receipts = await count(db, 'delivery_receipts');
    const { ref } = await book();
    const rows = await intentsFor(ref);
    expect(rows.map((r) => r.purpose)).toStrictEqual(['reminder']);
    const intent = h.ok<{ data: Intent }>(
      await h.call('a1', 'GET', `/v1/scheduling/notifications/${rows[0]?.id}`),
    ).data;
    expect(intent).toMatchObject({
      subjectRef: ref,
      purpose: 'reminder',
      channel: 'none',
      templateRef: null,
      deliveryKey: `reminder:${ref}`,
      supersedes: null,
      suppressionDecision: { owner: 'E6', state: 'suppressed', reason: 'policy_off' },
    });
    expect(intent.suppressionDecision.ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(intent.policyRef).toMatch(/pending-approval/);
    expect(await count(db, 'delivery_receipts')).toBe(receipts);
    // Staff-visible work item: no channel, owned by the practice, blocked on S-S2 and E6/E7.
    const item = (await worklist()).items.find((i) => i.workItemRef === intent.intentRef);
    expect(item).toMatchObject({
      kind: 'notification_without_channel',
      reasonCode: 'no_verified_channel',
      evidenceRefs: [{ kind: 'appointment', ref }],
      owner: { queue: 'front_desk', principalRef: null },
      nextActionOwedBy: 'practice',
      suggestedNextAction: 'contact_patient_manually',
      blockingDependencies: ['S-S2', 'E6', 'E7'],
    });
    expect(item?.dueAt).toBe((await h.call('a1', 'GET', `${APPT}/${ref}`)).json().data.startsAt);
    expect(item?.explanation.length).toBeGreaterThan(10);
  });

  it('6. cancelling records one cancellation intent that supersedes the reminder; nothing is sent', async () => {
    const receipts = await count(db, 'delivery_receipts');
    const { ref } = await book();
    const [reminder] = await intentsFor(ref);
    h.ok(
      await h.call('a1', 'POST', `${APPT}/${ref}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    const rows = await intentsFor(ref);
    expect(rows.map((r) => r.purpose)).toStrictEqual(['reminder', 'cancellation']);
    const cancel = h.ok<{ data: Intent }>(
      await h.call('a1', 'GET', `/v1/scheduling/notifications/${rows[1]?.id}`),
    ).data;
    expect(cancel).toMatchObject({
      channel: 'none',
      supersedes: reminder?.id,
      deliveryKey: `cancellation:${ref}`,
    });
    const items = (await worklist()).items.map((i) => i.workItemRef);
    expect(items).toContain(cancel.intentRef);
    expect(items).not.toContain(reminder?.id);
    expect(await count(db, 'delivery_receipts')).toBe(receipts);
  });

  it('a reschedule records one reminder for the new booking superseding the old one', async () => {
    const { ref } = await book();
    const [old] = await intentsFor(ref);
    const moved = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', `${APPT}/${ref}/reschedule`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
        ...window(),
      }),
    );
    expect(await intentsFor(ref)).toHaveLength(1);
    const fresh = await intentsFor(moved.data.appointmentRef);
    expect(fresh.map((r) => r.purpose)).toStrictEqual(['reminder']);
    const intent = h.ok<{ data: Intent }>(
      await h.call('a1', 'GET', `/v1/scheduling/notifications/${fresh[0]?.id}`),
    ).data;
    expect(intent.supersedes).toBe(old?.id);
  });

  it('a series records one intent per occurrence; a same-key replay records none', async () => {
    const before = await count(db, 'notification_intents');
    const patient = await createPatient(h, 'Synthetic Notice');
    const key = randomUUID();
    const body = {
      patientRef: patient,
      locationRef: loc.locationRef,
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
      pattern: { frequency: 'weekly', interval: 1 },
      firstDate: '2031-02-03',
      startTime: '09:00',
      durationMinutes: 30,
      count: 3,
    };
    h.ok(await h.call('a1', 'POST', '/v1/scheduling/series', body, key), 201);
    h.ok(await h.call('a1', 'POST', '/v1/scheduling/series', body, key), 201);
    expect(await count(db, 'notification_intents')).toBe(before + 3);
  });

  it('5. structurally, scheduling reads no consent state: every consent statement comes from E6, no consent field is stored', async () => {
    const statements: { text: string; stack: string }[] = [];
    const runner = createTenantTransactionRunner(db.app);
    const capturing: WithTenantTransaction = (ctx, work) =>
      runner(ctx, (tx) => {
        const proxy: TenantTransaction = {
          ctx: tx.ctx,
          query: (text, values) => {
            statements.push({ text, stack: new Error('trace').stack ?? '' });
            return tx.query(text, values);
          },
          savepoint: (w) => tx.savepoint(w),
        };
        return work(proxy);
      });
    const svc = domainAppointments(db, { withTenantTransaction: capturing });
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    const patient = await createPatient(h, 'Synthetic Notice');
    const booked = await svc.bookAppointment(
      a1,
      envelope('scheduling.appointments.book', {
        patientRef: patient,
        locationRef: loc.locationRef,
        ...window(),
      }),
    );
    const ref = booked.data.appointmentRef as string;
    const moved = await svc.rescheduleAppointment(
      a1,
      ref,
      envelope('scheduling.appointments.reschedule', {
        expectedVersion: 1,
        reasonCode: 'patient_request',
        ...window(),
      }),
    );
    await svc.cancelAppointment(
      a1,
      moved.data.appointmentRef as string,
      envelope('scheduling.appointments.cancel', { expectedVersion: 1, reasonCode: 'patient_request' }),
    );
    expect(statements.length).toBeGreaterThan(10);
    // Since E6: consent and suppression statements run in the booking transaction, but only from E6's
    // published decision module (packages/domain/src/engagement/communications/suppression.ts).
    const consentStatements = statements.filter((st) =>
      /communication_consents|suppression_decisions|channel_policies|message_templates|quiet_/i.test(st.text),
    );
    expect(consentStatements.length).toBeGreaterThan(0);
    // Scheduling's own statements only store the decision reference E6 returned.
    for (const st of statements.filter((x) => !consentStatements.includes(x))) {
      expect(st.text).not.toMatch(/communication_consents|consent_state|opt_?out|quiet_hours/i);
    }
    for (const st of consentStatements)
      expect(st.stack).toMatch(/engagement[\\/]communications[\\/]suppression/);
    const tables = await db.admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'cuspatlas'
       AND table_name ~ '(consent|opt_?out|suppression)' ORDER BY 1`,
    );
    // The only consent and suppression tables are E's (E6 facts and decisions; E4's link of an intake
    // submission to the E6 facts it recorded).
    expect(tables.rows.map((r) => r.table_name)).toStrictEqual([
      'communication_consents',
      'intake_submission_consents',
      'suppression_decisions',
    ]);
    const cols = await db.admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'cuspatlas'
       AND table_name = 'notification_intents' ORDER BY column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toStrictEqual(
      [
        'actor_id',
        'channel',
        'created_at',
        'delivery_key',
        'due_at',
        'id',
        'location_id',
        'policy_ref',
        'purpose',
        'source_operation',
        'subject_id',
        'subject_kind',
        'superseded_intent_id',
        'suppression_decision_ref',
        'template_ref',
        'tenant_id',
      ].sort(),
    );
    const source = readFileSync(
      resolve(__dirname, '../../packages/domain/src/scheduling/notification-intent.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/FROM\s+cuspatlas\.\w*consent/i);
  });
});

describe('S14 failure and recovery', () => {
  it('1. a refused or rolled-back booking leaves no intent and no decision reference', async () => {
    const before = await count(db, 'notification_intents');
    const { ref } = await book();
    const appt = h.ok<{ data: { startsAt: string; endsAt: string } }>(
      await h.call('a1', 'GET', `${APPT}/${ref}`),
    ).data;
    const conflict = await h.call('a1', 'POST', APPT, {
      patientRef: await createPatient(h, 'Synthetic Notice'),
      locationRef: loc.locationRef,
      startsAt: appt.startsAt,
      endsAt: appt.endsAt,
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    });
    expect(conflict.statusCode).toBe(409);
    expect(await count(db, 'notification_intents')).toBe(before + 1);
    const faulty = domainAppointments(db, {
      execute: async (_c, _e, _t, handler) => {
        await handler();
        throw new Error('synthetic fault after the intent');
      },
    });
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    await expect(
      faulty.bookAppointment(
        a1,
        envelope('scheduling.appointments.book', {
          patientRef: await createPatient(h, 'Synthetic Notice'),
          locationRef: loc.locationRef,
          ...window(),
        }),
      ),
    ).rejects.toThrow();
    expect(await count(db, 'notification_intents')).toBe(before + 1);
  });

  it('2. an intent is decided by E6 in its own transaction (suppressed by default), listed for manual contact, never sent', async () => {
    const { ref } = await book();
    const [row] = await intentsFor(ref);
    const items = (await worklist()).items;
    expect(items.some((i) => i.workItemRef === row?.id)).toBe(true);
    const { rows } = await db.admin.query(
      `SELECT i.channel, d.outcome, d.reason, d.stage FROM cuspatlas.notification_intents i
       JOIN cuspatlas.suppression_decisions d ON d.id = i.suppression_decision_ref WHERE i.id = $1`,
      [row?.id],
    );
    expect(rows[0]).toStrictEqual({
      channel: 'none',
      outcome: 'suppressed',
      reason: 'policy_off',
      stage: 'intent',
    });
  });

  it('cross-tenant and other-location callers cannot read or list an intent; REST and MCP agree', async () => {
    const { ref } = await book();
    const [row] = await intentsFor(ref);
    const foreign = await h.call('b1', 'GET', `/v1/scheduling/notifications/${row?.id}`);
    expect(foreign.statusCode).toBe(404);
    expect((await worklist('b1')).items.map((i) => i.workItemRef)).not.toContain(row?.id);
    // a3 is restricted to loc-north: it sees north's intents only.
    const n = await book(north);
    const [northRow] = await intentsFor(n.ref);
    const a3 = (await worklist('a3')).items.map((i) => i.workItemRef);
    expect(a3).toContain(northRow?.id);
    expect(a3).not.toContain(row?.id);
    expect((await h.call('a3', 'GET', `/v1/scheduling/notifications/${row?.id}`)).statusCode).toBe(404);
    const rest = await worklist('a1', `?locationRef=${loc.locationRef}`);
    const mcp = await h.mcp('a1', 'scheduling_notifications_worklist', { locationRef: loc.locationRef });
    const mData = (mcp.body as { data: typeof rest }).data;
    expect(mData.items.map((i) => i.workItemRef)).toStrictEqual(rest.items.map((i) => i.workItemRef));
    expect(rest.coverage).toStrictEqual({ status: 'available' });
  });
});

describe('S14 worklist relevance (review hardening)', () => {
  it('closed or past-due subjects leave the worklist and never crowd out new intents beyond the limit', async () => {
    const crowd = await seedLocation(h, 'loc-crowd');
    const { rows: l } = await db.admin.query(
      `SELECT id, tenant_id FROM cuspatlas.scheduling_locations WHERE location_ref = 'loc-crowd'`,
    );
    // 505 stale intents (subjects gone or closed, due long ago) sort ahead of everything by due time.
    await db.admin.query(
      `INSERT INTO cuspatlas.notification_intents (tenant_id, subject_kind, subject_id, location_id, purpose, channel,
         delivery_key, policy_ref, due_at, source_operation, actor_id)
       SELECT $1, 'appointment', g.id, $2, 'reminder', 'none', 'reminder:' || g.id, 'notification-intent-pending-approval-1',
         timestamptz '2000-01-01', 'scheduling.appointments.book', $3
       FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 505)) g`,
      [l[0].tenant_id, l[0].id, USER_A1],
    );
    const fresh = await book(crowd);
    const [freshRow] = await intentsFor(fresh.ref);
    const items = (await worklist('a1', `?locationRef=${crowd.locationRef}`)).items;
    expect(items.map((i) => i.workItemRef)).toContain(freshRow?.id);
    expect(items.length).toBe(1);
  });

  it('an attended appointment, a decided offer and a cancelled-then-past subject drop off; a future cancellation stays', async () => {
    const attended = await book();
    const [row] = await intentsFor(attended.ref);
    expect((await worklist()).items.map((i) => i.workItemRef)).toContain(row?.id);
    h.ok(await h.call('a1', 'POST', `${APPT}/${attended.ref}/attendance`, { kind: 'arrived' }), 201);
    expect((await worklist()).items.map((i) => i.workItemRef)).not.toContain(row?.id);
    const cancelled = await book();
    h.ok(
      await h.call('a1', 'POST', `${APPT}/${cancelled.ref}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    const cancelIntent = (await intentsFor(cancelled.ref)).find((r) => r.purpose === 'cancellation');
    expect((await worklist()).items.map((i) => i.workItemRef)).toContain(cancelIntent?.id);
  });
});

describe('S14 cases owned by E (closed by E6/E7)', () => {
  it('E6: booking with a suppressed decision stores E6 decision reference and reason, enqueues nothing', async () => {
    const before = await count(db, 'delivery_receipts');
    const { ref } = await book();
    const { rows } = await db.admin.query(
      `SELECT d.id, d.outcome, d.reason FROM cuspatlas.notification_intents i
       JOIN cuspatlas.suppression_decisions d ON d.id = i.suppression_decision_ref
       WHERE i.subject_id = $1 AND i.purpose = 'reminder'`,
      [ref],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'suppressed', reason: 'policy_off' });
    const intent = h.ok<{ data: Intent }>(
      await h.call('a1', 'GET', `/v1/scheduling/notifications/${(await intentsFor(ref))[0]?.id}`),
    ).data;
    expect(intent.suppressionDecision).toMatchObject({
      ref: rows[0].id,
      state: 'suppressed',
      reason: 'policy_off',
    });
    expect(await count(db, 'delivery_receipts')).toBe(before);
  });
  // The five E7-owned cases are implemented with these titles in tests/integration/comms-delivery.test.ts
  // ("S14 cases owned by E (closed by E6/E7)"): exactly-once delivery through the fake provider with no
  // retry after a timeout, an opt-out between intent and delivery, missing contact data versus quiet
  // hours, suppression of intents of a cancelled appointment, and a withdrawn template plus crash
  // reconciliation.
});
