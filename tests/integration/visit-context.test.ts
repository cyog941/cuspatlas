import { randomUUID } from 'node:crypto';
import type { TenantTransaction } from '@cuspatlas/contracts';
import type { VisitContextProducer, VisitContextProducers, VisitProducerRecord } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  T_BETA,
  USER_A1,
  USER_B1,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { actorFor, domainAppointments, envelope } from './support/domain-harness';

/**
 * S12: the visit context is a container of references. No clinical producer (C8 medical history,
 * C10 notes, C13 consent/forms, C11 treatment plan, C16 lab) exists yet, so through the deployed
 * transports every producer-bound item is an explicit `unavailable` with its owner and reason, never
 * an empty success, and nothing unavailable counts toward completion. Container mechanics (pin,
 * idempotent assignment, relink history, voided resolution) are exercised against a synthetic
 * producer stub injected at the domain port only; the producer-bound acceptance cases stay open
 * (it.todo) until the named C task exists.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let slot = 0;
const APPT = '/v1/scheduling/appointments';
const ctxUrl = (ref: string) => `${APPT}/${ref}/visit-context`;

beforeAll(async () => {
  db = await openTestDatabase('visit_context');
  h = await openAppointmentHarness(db, { mcp: true });
  loc = await seedLocation(h, 'loc-visit-ctx');
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

async function appointment(): Promise<{ ref: string; patient: string }> {
  const patient = await createPatient(h, 'Synthetic Context');
  const day = 1 + Math.floor(slot / 8) * 7;
  const hour = 13 + (slot % 8);
  slot += 1;
  const at = (hh: number) => new Date(Date.UTC(2030, 3, day, hh)).toISOString();
  const res = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', APPT, {
      patientRef: patient,
      locationRef: loc.locationRef,
      startsAt: at(hour),
      endsAt: at(hour + 1),
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  );
  return { ref: res.data.appointmentRef, patient };
}

const PRODUCERS = ['medicalHistory', 'forms', 'noteDrafts', 'labCases', 'treatmentPlanItems'] as const;
const OWNERS = {
  medicalHistory: 'C8',
  forms: 'C13',
  noteDrafts: 'C10',
  labCases: 'C16',
  treatmentPlanItems: 'C11',
};

describe('S12 container through the deployed transports (no clinical producer deployed)', () => {
  it('5. every producer-bound item is an explicit unavailable with owner and reason; none counts toward completion', async () => {
    const { ref, patient } = await appointment();
    const rest = h.ok<{ data: Record<string, unknown> }>(await h.call('a1', 'GET', ctxUrl(ref)));
    const m = await h.mcp('a1', 'scheduling_visit_context_get', { appointmentRef: ref });
    expect(m.code).toBeNull();
    const data = rest.data as {
      appointmentRef: string;
      appointment: { status: string; acceptsChanges: boolean };
      patient: { status: string; patientRef: string };
      attendance: { status: string; state: string };
      items: Record<string, { status: string; owner: string; reason?: string; entries?: unknown[] }>;
      readiness: { resolved: number; unavailable: string[]; complete: boolean };
    };
    expect(data.appointmentRef).toBe(ref);
    expect(data.patient).toMatchObject({ status: 'resolved', patientRef: patient });
    expect(data.attendance).toStrictEqual({ status: 'resolved', state: 'scheduled' });
    expect(data.appointment).toMatchObject({ status: 'booked', acceptsChanges: true });
    for (const p of PRODUCERS) {
      expect(data.items[p]).toStrictEqual({
        status: 'unavailable',
        owner: OWNERS[p],
        reason: 'producer_not_deployed',
      });
    }
    expect(data.readiness).toStrictEqual({ resolved: 0, unavailable: [...PRODUCERS], complete: false });
    // REST and MCP return the same container (asOf differs per call).
    const mData = (m.body as { data: Record<string, unknown> }).data;
    expect({ ...mData, asOf: null }).toStrictEqual({ ...data, asOf: null });
  });

  it('commands bound to an absent producer are typed refusals that write nothing and leave an attempt row', async () => {
    const { ref } = await appointment();
    const before = [await count(db, 'visit_context_items'), await count(db, 'audit_events')];
    const calls: [string, unknown][] = [
      [`${ctxUrl(ref)}/medical-history-pin`, {}],
      [`${ctxUrl(ref)}/forms`, { formRef: randomUUID() }],
      [`${ctxUrl(ref)}/lab-cases`, { labCaseRef: randomUUID() }],
      [`${ctxUrl(ref)}/lab-cases/relink`, { labCaseRef: randomUUID(), reasonCode: 'wrong_visit' }],
    ];
    for (const [url, body] of calls) {
      const res = await h.call('a1', 'POST', url, body);
      expect([url, res.statusCode, res.json().code, res.json().detail?.reason]).toStrictEqual([
        url,
        409,
        'conflict',
        'producer_unavailable',
      ]);
      const attempts = await db.admin.query(
        'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
        [res.headers['x-correlation-id']],
      );
      expect(attempts.rows.length).toBe(1);
    }
    const m = await h.mcp('a1', 'scheduling_visit_context_assign_form', {
      appointmentRef: ref,
      formRef: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    expect([m.status, (m.body.detail as { reason?: string })?.reason]).toStrictEqual([
      409,
      'producer_unavailable',
    ]);
    expect([await count(db, 'visit_context_items'), await count(db, 'audit_events')]).toStrictEqual(before);
  });

  it('4. another tenant, or a caller restricted to another location, cannot open the context (404, identical to missing)', async () => {
    const { ref } = await appointment();
    const foreign = await h.call('b1', 'GET', ctxUrl(ref));
    const missing = await h.call('b1', 'GET', ctxUrl(randomUUID()));
    expect([foreign.statusCode, foreign.json().code]).toStrictEqual([404, 'not_found']);
    expect(Object.keys(foreign.json()).sort()).toStrictEqual(Object.keys(missing.json()).sort());
    const restricted = await h.call('a3', 'GET', ctxUrl(ref));
    expect(restricted.statusCode).toBe(404);
    const malformed = await h.call('a1', 'GET', ctxUrl('not-a-ref'));
    expect(malformed.statusCode).toBe(404);
  });

  it('6. a cancelled appointment context is readable and marked', async () => {
    const { ref } = await appointment();
    h.ok(
      await h.call('a1', 'POST', `${APPT}/${ref}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    const ctx = h.ok<{ data: { appointment: { status: string; acceptsChanges: boolean } } }>(
      await h.call('a1', 'GET', ctxUrl(ref)),
    );
    expect(ctx.data.appointment).toMatchObject({ status: 'cancelled', acceptsChanges: false });
  });

  it('a read-only member reads the context but cannot assign (403 before any lookup)', async () => {
    const { ref } = await appointment();
    expect((await h.call('a4', 'GET', ctxUrl(ref))).statusCode).toBe(200);
    const res = await h.call('a4', 'POST', `${ctxUrl(ref)}/forms`, { formRef: randomUUID() });
    expect([res.statusCode, res.json().code]).toStrictEqual([403, 'forbidden']);
  });

  it('structurally, scheduling stores references only: the item table has no content column', async () => {
    const { rows } = await db.admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'cuspatlas'
       AND table_name = 'visit_context_items' ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toStrictEqual(
      [
        'actor_id',
        'appointment_id',
        'created_at',
        'end_kind',
        'end_reason',
        'ended_at',
        'ended_by',
        'id',
        'item_kind',
        'item_ref',
        'item_version',
        'producer',
        'provenance_ref',
        'relinked_from_id',
        'relinked_to_id',
        'state',
        'tenant_id',
        'updated_at',
        'version',
      ].sort(),
    );
    const grants = await db.admin.query(
      `SELECT privilege_type FROM information_schema.table_privileges WHERE grantee = 'cuspatlas_app'
       AND table_schema = 'cuspatlas' AND table_name = 'visit_context_items' ORDER BY privilege_type`,
    );
    // UPDATE is column-level only (end of an assignment); no DELETE.
    expect(grants.rows.map((r) => r.privilege_type)).toStrictEqual(['INSERT', 'SELECT']);
  });
});

/** Synthetic producer stub: records keyed by tenant so another tenant's reference is "not found". */
function stubProducer(): VisitContextProducer & {
  put(tenant: string, ref: string, rec: Partial<VisitProducerRecord>): void;
  currentFor: Map<string, string>;
} {
  const records = new Map<string, VisitProducerRecord>();
  const currentFor = new Map<string, string>();
  const tenantOf = async (tx: TenantTransaction) =>
    (await tx.query<{ t: string }>('SELECT cuspatlas.current_tenant_id()::text AS t')).rows[0]?.t ?? '';
  return {
    currentFor,
    put(tenant, ref, rec) {
      records.set(`${tenant}:${ref}`, {
        ref,
        version: 1,
        provenanceRef: 'synthetic-stub.1',
        status: 'resolved',
        ...rec,
      });
    },
    async resolve(tx, ref) {
      return records.get(`${await tenantOf(tx)}:${ref}`) ?? null;
    },
    async current(tx, patientRef) {
      const ref = currentFor.get(patientRef);
      return ref === undefined ? null : (records.get(`${await tenantOf(tx)}:${ref}`) ?? null);
    },
  };
}

describe('S12 container mechanics against a synthetic producer stub (domain port; not a C producer)', () => {
  const history = stubProducer();
  const forms = stubProducer();
  const labs = stubProducer();
  const producers: VisitContextProducers = { medicalHistory: history, forms, labCases: labs };
  const svc = () => domainAppointments(db, { visitContextProducers: producers });
  const op = (name: string) => `scheduling.visitContext.${name}`;

  it('pin: the context names the captured version; a later producer version leaves the pin intact', async () => {
    const { ref, patient } = await appointment();
    const mh = randomUUID();
    history.put(T_ALPHA, mh, { version: 3 });
    history.currentFor.set(patient, mh);
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    const pinned = await svc().pinMedicalHistorySnapshot(a1, ref, envelope(op('pinMedicalHistory'), {}));
    expect(pinned.data).toMatchObject({ itemKind: 'medical_history_pin', producerRef: mh, itemVersion: 3 });
    history.put(T_ALPHA, mh, { version: 4 });
    const ctx = await svc().getVisitContext(a1, ref);
    expect(ctx.items.medicalHistory).toMatchObject({
      status: 'available',
      entries: [{ producerRef: mh, version: 3, currentVersion: 4, resolution: 'resolved' }],
    });
    // A second pin is refused; the first stays as recorded for audit.
    await expect(
      svc().pinMedicalHistorySnapshot(a1, ref, envelope(op('pinMedicalHistory'), {})),
    ).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'already_pinned' } });
  });

  it('2. assigning the same form twice returns the recorded assignment once; unassign is explicit with a reason', async () => {
    const { ref } = await appointment();
    const form = randomUUID();
    forms.put(T_ALPHA, form, {});
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    const first = await svc().assignForm(a1, ref, envelope(op('assignForm'), { formRef: form }));
    const second = await svc().assignForm(a1, ref, envelope(op('assignForm'), { formRef: form }));
    expect(first.data.itemRef).toBe(second.data.itemRef);
    expect([first.data.created, second.data.created]).toStrictEqual([true, false]);
    const rows = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.visit_context_items WHERE appointment_id = $1 AND item_ref = $2',
      [ref, form],
    );
    expect(rows.rows[0].n).toBe(1);
    await expect(
      svc().unassignForm(a1, ref, first.data.itemRef, envelope(op('unassignForm'), { expectedVersion: 1 })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const un = await svc().unassignForm(
      a1,
      ref,
      first.data.itemRef,
      envelope(op('unassignForm'), { expectedVersion: 1, reasonCode: 'assigned_in_error' }),
    );
    expect(un.data).toMatchObject({ state: 'ended', endKind: 'unassigned' });
    const items = await svc().listVisitContextItems(a1, ref);
    expect(items.map((i) => [i.itemKind, i.state, i.endKind])).toStrictEqual([
      ['form_assignment', 'ended', 'unassigned'],
    ]);
  });

  it('3. a lab case bound to another appointment is refused unless relinked; the relink preserves both references', async () => {
    const one = await appointment();
    const two = await appointment();
    const lab = randomUUID();
    labs.put(T_ALPHA, lab, {});
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    const linked = await svc().linkLabCase(a1, one.ref, envelope(op('linkLabCase'), { labCaseRef: lab }));
    await expect(
      svc().linkLabCase(a1, two.ref, envelope(op('linkLabCase'), { labCaseRef: lab })),
    ).rejects.toMatchObject({
      code: 'conflict',
      detail: { reason: 'lab_case_bound_elsewhere', blockingRefs: [{ kind: 'appointment', ref: one.ref }] },
    });
    const relinked = await svc().relinkLabCase(
      a1,
      two.ref,
      envelope(op('relinkLabCase'), { labCaseRef: lab, reasonCode: 'wrong_visit' }),
    );
    const { rows } = await db.admin.query(
      `SELECT appointment_id, state, end_kind, relinked_to_id, relinked_from_id FROM cuspatlas.visit_context_items
       WHERE item_ref = $1 ORDER BY created_at, state DESC`,
      [lab],
    );
    expect(rows).toStrictEqual([
      {
        appointment_id: one.ref,
        state: 'ended',
        end_kind: 'relinked',
        relinked_to_id: relinked.data.itemRef,
        relinked_from_id: null,
      },
      {
        appointment_id: two.ref,
        state: 'active',
        end_kind: null,
        relinked_to_id: null,
        relinked_from_id: linked.data.itemRef,
      },
    ]);
  });

  it('4. a producer record of another tenant cannot be linked (indistinguishable from missing)', async () => {
    const { ref } = await appointment();
    const foreign = randomUUID();
    labs.put(T_BETA, foreign, {});
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    await expect(
      svc().linkLabCase(a1, ref, envelope(op('linkLabCase'), { labCaseRef: foreign })),
    ).rejects.toMatchObject({ code: 'not_found' });
    const b1 = await actorFor(db, USER_B1, T_BETA);
    await expect(svc().getVisitContext(b1, ref)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('failure 1. a producer record voided after linking resolves to an explicit voided status, never omitted', async () => {
    const { ref } = await appointment();
    const lab = randomUUID();
    labs.put(T_ALPHA, lab, {});
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    await svc().linkLabCase(a1, ref, envelope(op('linkLabCase'), { labCaseRef: lab }));
    labs.put(T_ALPHA, lab, { status: 'voided' });
    const ctx = await svc().getVisitContext(a1, ref);
    expect(ctx.items.labCases).toMatchObject({
      status: 'available',
      entries: [{ producerRef: lab, resolution: 'voided' }],
    });
    expect(ctx.readiness.complete).toBe(false);
  });

  it('failure 2. a failed link rolls back its assignment, audit and outbox together', async () => {
    const { ref } = await appointment();
    const lab = randomUUID();
    labs.put(T_ALPHA, lab, {});
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    const tables = ['visit_context_items', 'audit_events', 'outbox_events'];
    const before = await Promise.all(tables.map((t) => count(db, t)));
    const faulty = domainAppointments(db, {
      visitContextProducers: producers,
      execute: async (_ctx, _env, _tx, handler) => {
        await handler();
        throw new Error('synthetic fault after the write');
      },
    });
    await expect(
      faulty.linkLabCase(a1, ref, envelope(op('linkLabCase'), { labCaseRef: lab })),
    ).rejects.toThrow();
    expect(await Promise.all(tables.map((t) => count(db, t)))).toStrictEqual(before);
  });

  it('failure 3. a cancelled appointment keeps its pending forms for review', async () => {
    const { ref } = await appointment();
    const form = randomUUID();
    forms.put(T_ALPHA, form, {});
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    await svc().assignForm(a1, ref, envelope(op('assignForm'), { formRef: form }));
    h.ok(
      await h.call('a1', 'POST', `${APPT}/${ref}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    const ctx = await svc().getVisitContext(a1, ref);
    expect(ctx.items.forms).toMatchObject({
      status: 'available',
      entries: [{ producerRef: form, state: 'active' }],
    });
    expect(ctx.appointment.acceptsChanges).toBe(false);
    // 6. No new assignment on a cancelled appointment, even with the producer present.
    const other = randomUUID();
    forms.put(T_ALPHA, other, {});
    await expect(
      svc().assignForm(a1, ref, envelope(op('assignForm'), { formRef: other })),
    ).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'appointment_not_open' } });
  });
});

describe('S12 producer-bound cases (open until the clinical producer exists)', () => {
  it.todo(
    'C8: a context pins a real C8 medical-history version with provenance; a later C8 change leaves the pin',
  );
  it.todo('C8: a change made in the visit calls the C8 command and produces a new version (pin unchanged)');
  it.todo('C13: assigning a real consent or intake form twice returns the recorded assignment once');
  it.todo('C10: note drafts for the visit resolve to C10 references, never copied content');
  it.todo(
    'C16: a real lab case bound elsewhere requires the relink command; a foreign-tenant C16 case is refused',
  );
  it.todo('C11: treatment-plan items proposed for the visit resolve to C11 references');
});
