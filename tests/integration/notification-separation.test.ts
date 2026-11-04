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
 * No channel is verified (S-S2 / S-D5 pending), so every intent has channel `none`; the suppression
 * decision belongs to E6 (not built) and is a typed placeholder (`undecided`, owner E6, no
 * reference). Scheduling reads no consent state. Staff see intents without a channel as work items.
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
  suppressionDecision: { ref: null; owner: string; state: string; statement: string };
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

describe('S14 acceptance (no verified channel; E6 not built)', () => {
  it('a booking records exactly one intent with channel none and an E6-owned placeholder decision, and sends nothing', async () => {
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
      suppressionDecision: { ref: null, owner: 'E6', state: 'undecided' },
    });
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

  it('5. structurally, scheduling reads no consent state: no consent table exists or is touched, no consent field is stored', async () => {
    const statements: string[] = [];
    const runner = createTenantTransactionRunner(db.app);
    const capturing: WithTenantTransaction = (ctx, work) =>
      runner(ctx, (tx) => {
        const proxy: TenantTransaction = {
          ctx: tx.ctx,
          query: (text, values) => {
            statements.push(text);
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
    for (const s of statements) expect(s).not.toMatch(/consent|opt_?out|suppression_decision|quiet_hours/i);
    const tables = await db.admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'cuspatlas'
       AND table_name ~ '(consent|opt_?out|suppression)'`,
    );
    expect(tables.rows).toStrictEqual([]);
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

  it('2. an intent without a decision is recorded undecided and listed for reconciliation, never sent', async () => {
    const { ref } = await book();
    const [row] = await intentsFor(ref);
    const items = (await worklist()).items;
    expect(items.some((i) => i.workItemRef === row?.id)).toBe(true);
    const { rows } = await db.admin.query(
      'SELECT suppression_decision_ref, channel FROM cuspatlas.notification_intents WHERE id = $1',
      [row?.id],
    );
    expect(rows[0]).toStrictEqual({ suppression_decision_ref: null, channel: 'none' });
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

describe('S14 cases owned by E (open until E6/E7 exist)', () => {
  it.todo('E6: booking with a suppressed decision stores E6 decision reference and reason, enqueues nothing');
  it.todo(
    'E7: an allowed decision yields exactly one delivery through the fake provider; a retry after timeout none',
  );
  it.todo('E6/E7: an opt-out recorded between intent and delivery blocks delivery at execution');
  it.todo(
    'E6: missing contact data and quiet hours are distinguished by E6 vocabulary in the appointment history',
  );
  it.todo(
    'E6: E suppresses intents derived from a cancelled appointment; a delivered message stays as history',
  );
  it.todo(
    'E7: a withdrawn template is suppressed at E7 execution; a crash after provider acceptance is reconciled',
  );
});
