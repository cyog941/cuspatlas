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
import { seedClinicalScopes } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { actorFor, domainAppointments, envelope } from './support/domain-harness';
import { SCHED_READ, SCHED_WRITE } from './support/scheduling-fixtures';

/**
 * S12: the visit context is a container of references. The deployed transports carry the C producers
 * (C8 medical history, C10 notes, C13 consent/forms, C11 treatment plan) through S12's domain port; a
 * producer not yet built (C16 lab until it exists) is an explicit `unavailable` with its owner and
 * reason, never an empty success, and a caller without `clinical.read` sees every C slot unavailable
 * (`producer_access_denied`). Nothing unavailable counts toward completion. Container mechanics (pin,
 * idempotent assignment, relink history, voided resolution) are also exercised against a synthetic
 * producer stub injected at the domain port.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let slot = 0;
let frontDesk: string;
const USER_FRONT_DESK = '20000000-0000-4000-8000-0000000000c6';
const C_PRODUCERS = ['medicalHistory', 'forms', 'noteDrafts', 'treatmentPlanItems'] as const;
const APPT = '/v1/scheduling/appointments';
const ctxUrl = (ref: string) => `${APPT}/${ref}/visit-context`;

beforeAll(async () => {
  db = await openTestDatabase('visit_context');
  h = await openAppointmentHarness(db, { mcp: true });
  loc = await seedLocation(h, 'loc-visit-ctx');
  await seedClinicalScopes(db.admin);
  // A front-desk member: scheduling read and write, no clinical scope.
  await db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', 'user-front-desk')`,
    [USER_FRONT_DESK],
  );
  await db.admin.query(
    'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)',
    [T_ALPHA, USER_FRONT_DESK, [SCHED_READ, SCHED_WRITE]],
  );
  frontDesk = await h.issuer.issue({ sub: USER_FRONT_DESK, tid: T_ALPHA });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

async function appointment(existing?: string): Promise<{ ref: string; patient: string }> {
  const patient = existing ?? (await createPatient(h, 'Synthetic Context'));
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

describe('S12 container through the deployed transports (every C producer deployed)', () => {
  it('5. every deployed producer slot is available with owner and entries; an empty context counts as complete', async () => {
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
      expect(data.items[p]).toStrictEqual({ status: 'available', owner: OWNERS[p], entries: [] });
    }
    expect(data.readiness).toStrictEqual({ resolved: 0, unavailable: [], complete: true });
    // REST and MCP return the same container (asOf differs per call).
    const mData = (m.body as { data: Record<string, unknown> }).data;
    expect({ ...mData, asOf: null }).toStrictEqual({ ...data, asOf: null });
  });

  it('commands bound to an absent producer (a deployment without it) are typed refusals that write nothing and leave an attempt row', async () => {
    const { ref } = await appointment();
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    const none = domainAppointments(db, { visitContextProducers: {} });
    const before = [await count(db, 'visit_context_items'), await count(db, 'audit_events')];
    const attemptsBefore = await count(db, 'security_attempt_events');
    const calls = [
      () =>
        none.pinMedicalHistorySnapshot(a1, ref, envelope('scheduling.visitContext.pinMedicalHistory', {})),
      () =>
        none.assignForm(a1, ref, envelope('scheduling.visitContext.assignForm', { formRef: randomUUID() })),
      () =>
        none.linkLabCase(
          a1,
          ref,
          envelope('scheduling.visitContext.linkLabCase', { labCaseRef: randomUUID() }),
        ),
      () =>
        none.relinkLabCase(
          a1,
          ref,
          envelope('scheduling.visitContext.relinkLabCase', {
            labCaseRef: randomUUID(),
            reasonCode: 'wrong_visit',
          }),
        ),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: 'conflict',
        detail: { reason: 'producer_unavailable' },
      });
    }
    expect(await count(db, 'security_attempt_events')).toBe(attemptsBefore + calls.length);
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

describe('S12 producer-bound cases (C producers through the S12 domain port)', () => {
  const DIGEST = `sha256:${'d'.repeat(64)}`;
  const historyChange = (patientRef: string, text: string, encounterRef?: string) =>
    h.call('a1', 'POST', '/v1/clinical/history/changes', {
      patientRef,
      provenance: 'staff',
      reportedBy: 'clinician',
      ...(encounterRef ? { encounterRef } : {}),
      changes: [{ kind: 'allergy', state: 'active', displayText: text }],
    });
  const consent = async (patientRef: string, who = 'a1') =>
    h.ok<{ data: { consentRef: string } }>(
      await h.call(
        who,
        'POST',
        '/v1/clinical/consents',
        {
          patientRef,
          scope: 'general_treatment',
          method: 'in_person',
          templateRef: 'synthetic-visit-consent',
          templateDigest: DIGEST,
          attestationCode: 'signed_in_person',
          signer: { kind: 'patient' },
        },
        randomUUID(),
      ),
      201,
    ).data.consentRef;
  const encounterFor = async (patientRef: string, appointmentRef: string) =>
    h.ok<{ data: { encounter: { encounterRef: string } } }>(
      await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef, appointmentRef }),
      201,
    ).data.encounter.encounterRef;
  type Slot = { status: string; reason?: string; entries?: Record<string, unknown>[] };
  const context = async (ref: string, who = 'a1') =>
    h.ok<{ data: { items: Record<string, Slot> } }>(await h.call(who, 'GET', ctxUrl(ref))).data;

  it('C8: a context pins a real C8 medical-history version with provenance; a later C8 change leaves the pin', async () => {
    const { ref, patient } = await appointment();
    h.ok(await historyChange(patient, 'Synthetic visit allergen'), 201);
    const versionRef = (
      await db.admin.query(
        `SELECT v.id FROM cuspatlas.clinical_history_versions v JOIN cuspatlas.clinical_history_streams s
         ON s.id = v.stream_id WHERE s.subject_patient_id = $1 AND v.sequence = 1`,
        [patient],
      )
    ).rows[0].id as string;
    const pinned = h.ok<{ data: Record<string, unknown> }>(
      await h.call('a1', 'POST', `${ctxUrl(ref)}/medical-history-pin`, {}),
      201,
    ).data;
    expect(pinned).toMatchObject({
      itemKind: 'medical_history_pin',
      producerRef: versionRef,
      itemVersion: 1,
    });
    const row = await db.admin.query(
      'SELECT producer, provenance_ref FROM cuspatlas.visit_context_items WHERE item_ref = $1',
      [versionRef],
    );
    expect(row.rows).toStrictEqual([{ producer: 'C8', provenance_ref: 'C8:staff' }]);
    h.ok(await historyChange(patient, 'Synthetic later allergen'), 201);
    const ctx = await context(ref);
    expect(ctx.items.medicalHistory?.entries).toMatchObject([
      {
        producerRef: versionRef,
        version: 1,
        currentVersion: 2,
        provenanceRef: 'C8:staff',
        resolution: 'resolved',
        state: 'active',
      },
    ]);
    expect(JSON.stringify(ctx)).not.toContain('Synthetic');
  });

  it('C8: a change made in the visit calls the C8 command and produces a new version (pin unchanged)', async () => {
    const { ref, patient } = await appointment();
    h.ok(await historyChange(patient, 'Synthetic first allergen'), 201);
    const pin = h.ok<{ data: { producerRef: string } }>(
      await h.call('a1', 'POST', `${ctxUrl(ref)}/medical-history-pin`, {}),
      201,
    ).data;
    const encounterRef = await encounterFor(patient, ref);
    const changed = h.ok<{ data: { header: { historyVersionRef: string; sequence: number } } }>(
      await historyChange(patient, 'Synthetic in-visit allergen', encounterRef),
      201,
    ).data;
    expect(changed.header.historyVersionRef).not.toBe(pin.producerRef);
    const again = await h.call('a1', 'POST', `${ctxUrl(ref)}/medical-history-pin`, {});
    expect([again.statusCode, again.json().detail?.reason]).toStrictEqual([409, 'already_pinned']);
    const ctx = await context(ref);
    expect(ctx.items.medicalHistory?.entries).toMatchObject([
      { producerRef: pin.producerRef, version: 1, currentVersion: 2 },
    ]);
  });

  it('C13: assigning a real consent or intake form twice returns the recorded assignment once', async () => {
    const { ref, patient } = await appointment();
    const consentRef = await consent(patient);
    const first = h.ok<{ data: { itemRef: string; created: boolean } }>(
      await h.call('a1', 'POST', `${ctxUrl(ref)}/forms`, { formRef: consentRef }),
      201,
    ).data;
    const second = h.ok<{ data: { itemRef: string; created: boolean } }>(
      await h.call('a1', 'POST', `${ctxUrl(ref)}/forms`, { formRef: consentRef }),
      201,
    ).data;
    expect([first.created, second.created, second.itemRef]).toStrictEqual([true, false, first.itemRef]);
    expect((await context(ref)).items.forms?.entries).toMatchObject([
      {
        itemRef: first.itemRef,
        producerRef: consentRef,
        provenanceRef: 'C13:in_person',
        resolution: 'resolved',
      },
    ]);
    // Another patient's consent is refused; another tenant's is indistinguishable from missing.
    const other = await createPatient(h, 'Synthetic Context Other');
    const otherConsent = await consent(other);
    const wrong = await h.call('a1', 'POST', `${ctxUrl(ref)}/forms`, { formRef: otherConsent });
    expect([wrong.statusCode, wrong.json().detail?.reason]).toStrictEqual([
      409,
      'producer_record_other_patient',
    ]);
    const betaPatient = await createPatient(h, 'Synthetic Context Beta', 'b1');
    const betaConsent = await consent(betaPatient, 'b1');
    const foreign = await h.call('a1', 'POST', `${ctxUrl(ref)}/forms`, { formRef: betaConsent });
    const missing = await h.call('a1', 'POST', `${ctxUrl(ref)}/forms`, { formRef: randomUUID() });
    expect([foreign.statusCode, missing.statusCode]).toStrictEqual([404, 404]);
    // A withdrawn consent resolves as voided in the context; nothing is copied.
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/consents/${consentRef}/withdrawal`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
        signer: { kind: 'patient' },
      }),
      201,
    );
    const ctx = await context(ref);
    expect(ctx.items.forms?.entries).toMatchObject([{ producerRef: consentRef, resolution: 'voided' }]);
  });

  it('C10: note drafts for the visit resolve to C10 references, never copied content', async () => {
    const { ref, patient } = await appointment();
    const encounterRef = await encounterFor(patient, ref);
    const note = h.ok<{ data: { noteRef: string } }>(
      await h.call('a1', 'POST', `/v1/clinical/encounters/${encounterRef}/notes`, {
        noteType: 'progress',
        content: {
          sections: [{ sectionKey: 'subjective', text: 'Synthetic visit note text' }],
          procedureCodeRefs: [],
        },
      }),
      201,
    ).data;
    const ctx = await context(ref);
    expect(ctx.items.noteDrafts?.entries).toStrictEqual([
      {
        itemRef: null,
        producerRef: note.noteRef,
        version: 1,
        currentVersion: 1,
        provenanceRef: 'C10:draft',
        resolution: 'resolved',
        state: 'active',
      },
    ]);
    expect(JSON.stringify(ctx)).not.toContain('Synthetic visit note text');
  });

  it('C11: treatment-plan items proposed for the visit resolve to C11 references', async () => {
    const { ref, patient } = await appointment();
    const PLANS = '/v1/clinical/treatment-plans';
    const plan = h.ok<{ data: { plan: { planRef: string; headVersionRef: string } } }>(
      await h.call('a1', 'POST', PLANS, { patientRef: patient }, randomUUID()),
      201,
    ).data.plan;
    const detail = h.ok<{ data: { targetRef: string } }>(
      await h.call('a1', 'POST', `${PLANS}/versions/${plan.headVersionRef}/details`, {
        expectedRevision: 1,
        scope: 'whole_mouth',
      }),
      201,
    ).data.targetRef;
    const item = h.ok<{ data: { targetRef: string } }>(
      await h.call('a1', 'POST', `${PLANS}/details/${detail}/items`, {
        expectedRevision: 2,
        procedureCodeRef: 'SYN-PROC-901',
        sequence: 1,
      }),
      201,
    ).data.targetRef;
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/items/${item}/state`, { expectedRevision: 3, state: 'accepted' }),
    );
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/items/${item}/state`, {
        expectedRevision: 4,
        state: 'scheduled',
        appointmentRef: ref,
      }),
    );
    const ctx = await context(ref);
    expect(ctx.items.treatmentPlanItems?.entries).toMatchObject([
      { itemRef: null, producerRef: item, provenanceRef: 'C11:scheduled', resolution: 'resolved' },
    ]);
  });

  it('a caller without clinical.read sees every C slot unavailable and cannot pin or assign (403, nothing written)', async () => {
    const { ref, patient } = await appointment();
    h.ok(await historyChange(patient, 'Synthetic hidden allergen'), 201);
    const consentRef = await consent(patient);
    const ctx = await context(ref, frontDesk);
    for (const p of C_PRODUCERS) {
      expect(ctx.items[p]).toStrictEqual({
        status: 'unavailable',
        owner: OWNERS[p],
        reason: 'producer_access_denied',
      });
    }
    const before = await count(db, 'visit_context_items');
    for (const [url, body] of [
      [`${ctxUrl(ref)}/medical-history-pin`, {}],
      [`${ctxUrl(ref)}/forms`, { formRef: consentRef }],
    ] as const) {
      const res = await h.call(frontDesk, 'POST', url, body);
      expect([res.statusCode, res.json().code]).toStrictEqual([403, 'forbidden']);
      const attempts = await db.admin.query(
        'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
        [res.headers['x-correlation-id']],
      );
      expect(attempts.rows.map((r) => r.reason_code)).toStrictEqual(['scope_missing']);
    }
    expect(await count(db, 'visit_context_items')).toBe(before);
  });

  it('C16: a real lab case bound elsewhere requires the relink command; a foreign-tenant C16 case is refused', async () => {
    const first = await appointment();
    const second = await appointment();
    const p = first.patient;
    const labCase = async (patientRef: string, who = 'a1') =>
      h.ok<{ data: { labCaseRef: string } }>(
        await h.call(
          who,
          'POST',
          '/v1/clinical/lab-cases',
          { patientRef, counterpartyRef: 'syn-lab-visit', caseRef: `SYN-VC-${randomUUID().slice(0, 8)}` },
          randomUUID(),
        ),
        201,
      ).data.labCaseRef;
    const lc = await labCase(p);
    h.ok(await h.call('a1', 'POST', `${ctxUrl(first.ref)}/lab-cases`, { labCaseRef: lc }), 201);
    // The second appointment belongs to another patient; a case of this patient is refused there.
    const otherPatient = await h.call('a1', 'POST', `${ctxUrl(second.ref)}/lab-cases`, { labCaseRef: lc });
    expect([otherPatient.statusCode, otherPatient.json().detail?.reason]).toStrictEqual([
      409,
      'producer_record_other_patient',
    ]);
    // A second visit of the same patient: the case is bound elsewhere, so the plain link is refused.
    const visit2 = (await appointment(p)).ref;
    const elsewhere = await h.call('a1', 'POST', `${ctxUrl(visit2)}/lab-cases`, { labCaseRef: lc });
    expect([elsewhere.statusCode, elsewhere.json().detail?.reason]).toStrictEqual([
      409,
      'lab_case_bound_elsewhere',
    ]);
    h.ok(
      await h.call('a1', 'POST', `${ctxUrl(visit2)}/lab-cases/relink`, {
        labCaseRef: lc,
        reasonCode: 'wrong_visit',
      }),
      201,
    );
    const ctx = await context(visit2);
    expect(ctx.items.labCases?.entries).toMatchObject([
      { producerRef: lc, provenanceRef: 'C16:draft', resolution: 'resolved', state: 'active' },
    ]);
    // Another tenant's case is indistinguishable from a missing one.
    const beta = await createPatient(h, 'Synthetic Context Beta Lab', 'b1');
    const betaCase = await labCase(beta, 'b1');
    const foreign = await h.call('a1', 'POST', `${ctxUrl(visit2)}/lab-cases`, { labCaseRef: betaCase });
    expect(foreign.statusCode).toBe(404);
  });
});
