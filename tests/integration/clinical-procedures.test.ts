import { randomUUID } from 'node:crypto';
import {
  validateProcedureCommandResult,
  validateProcedureCorrectionResult,
  validateProcedureList,
  validateProcedureRead,
} from '@cuspatlas/contracts';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { loadRenderedProcedureEvent } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  leakTables,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  USER_A1,
} from './support/appointment-fixtures';
import { seedClinicalScopes, seedDispositions } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * C14: rendered procedures and the billing boundary (synthetic engineering implementation;
 * provisional SYN- codes; no amount). Only a rendered procedure completes a plan item; corrections are
 * reversal plus replacement; each row publishes an outbox event whose identifier payload B reads.
 * Every denial runs under the runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let otherProvider: string;
const LOC = 'loc-proc';
const PLANS = '/v1/clinical/treatment-plans';
// Today in the seeded location's own time zone (the server compares there; a UTC date is tomorrow
// in New York for five hours a day).
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

beforeAll(async () => {
  db = await openTestDatabase('clinical_procedures');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
  await seedDispositions(db.admin, T_ALPHA, ['completed_as_planned']);
  loc = await seedLocation(h, LOC);
  otherProvider = h.ok<{ data: { resourceRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/resources', {
      locationRef: LOC,
      kind: 'provider',
      displayLabel: 'Synthetic second provider',
    }),
    201,
  ).data.resourceRef;
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type Proc = {
  procedureRef: string;
  kind: string;
  state: string;
  encounterRef: string;
  patientRef: string;
  sourcePatientRef: string;
  planItemRef: string | null;
  provenance: string;
  codeRef: string;
  tooth: { canonicalRef: string } | null;
  chartDiscrepancy: string;
  providerOverrideReason: string | null;
  reversesProcedureRef: string | null;
  reversedByRef: string | null;
  replacesProcedureRef: string | null;
  replacedByRef: string | null;
  billingEvent: Record<string, unknown>;
};

async function encounter(patientRef: string) {
  const e = h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
    await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef, locationRef: LOC }),
    201,
  ).data.encounter;
  h.ok(
    await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/assignments`, {
      expectedVersion: e.version,
      role: 'treating_provider',
      assignee: { kind: 'provider', resourceRef: loc.provider },
    }),
    201,
  );
  return e.encounterRef;
}
/** A plan of three accepted items (one with a tooth) on a whole-mouth and a tooth detail. */
async function plan(patientRef: string) {
  const p = h.ok<{ data: { plan: { planRef: string; headVersionRef: string } } }>(
    await h.call('a1', 'POST', PLANS, { patientRef }, randomUUID()),
    201,
  ).data.plan;
  const v = p.headVersionRef;
  const detail = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/versions/${v}/details`, {
      expectedRevision: 1,
      scope: 'whole_mouth',
    }),
    201,
  ).data.targetRef;
  const items: string[] = [];
  for (const [i, code] of ['SYN-PROC-501', 'SYN-PROC-502', 'SYN-PROC-503'].entries()) {
    items.push(
      h.ok<{ data: { targetRef: string } }>(
        await h.call('a1', 'POST', `${PLANS}/details/${detail}/items`, {
          expectedRevision: 2 + i,
          procedureCodeRef: code,
          sequence: i + 1,
        }),
        201,
      ).data.targetRef,
    );
  }
  let revision = 5;
  for (const item of items) {
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/items/${item}/state`, {
        expectedRevision: revision,
        state: 'accepted',
      }),
    );
    revision += 1;
  }
  return { planRef: p.planRef, versionRef: v, items };
}
const render = (encounterRef: string, body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', `/v1/clinical/encounters/${encounterRef}/procedures`, body, key);
const okP = (res: Awaited<ReturnType<AppointmentHarness['call']>>) => {
  const json = h.ok<{ data: Proc; replayed: boolean }>(res, 201);
  expect(validateProcedureCommandResult(json)).toBe(true);
  return json.data;
};
const base = (extra: Record<string, unknown> = {}) => ({
  sequence: 1,
  dateOfService: TODAY,
  renderingProviderRef: loc.provider,
  ...extra,
});
async function itemStates(planRef: string): Promise<Record<string, string>> {
  const p = h.ok<{ data: { versions: { details: { items: { itemRef: string; state: string }[] }[] }[] } }>(
    await h.call('a1', 'GET', `${PLANS}/${planRef}`),
  ).data;
  return Object.fromEntries(
    p.versions.flatMap((v) => v.details.flatMap((d) => d.items.map((i) => [i.itemRef, i.state]))),
  );
}
const reason = (res: Awaited<ReturnType<AppointmentHarness['call']>>) => [
  res.statusCode,
  res.json().detail?.reason ?? res.json().detail?.violations?.[0]?.rule ?? res.json().code,
];
async function list(encounterRef: string) {
  const json = h.ok<{ data: { procedures: Proc[]; netRefs: string[] } }>(
    await h.call('a1', 'GET', `/v1/clinical/encounters/${encounterRef}/procedures`),
  );
  expect(validateProcedureList(json)).toBe(true);
  return json.data;
}

describe('C14 acceptance cases', () => {
  it('1. closing an encounter changes no plan item; rendering one procedure changes only that item; booking does not complete', async () => {
    const p = await createPatient(h, 'Synthetic Procedure One');
    const pl = await plan(p);
    const e = await encounter(p);
    // Booking and scheduling an item never imply completion.
    const appt = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/appointments', {
        patientRef: p,
        locationRef: loc.locationRef,
        startsAt: '2030-03-04T14:00:00Z',
        endsAt: '2030-03-04T14:30:00Z',
        timeZone: 'America/New_York',
        provider: { kind: 'provider', resourceRef: loc.provider },
        operatory: { kind: 'operatory', resourceRef: loc.operatory },
      }),
      201,
    ).data.appointmentRef;
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/items/${pl.items[2]}/state`, {
        expectedRevision: 8,
        state: 'scheduled',
        appointmentRef: appt,
      }),
    );
    await h.call(
      'a1',
      'POST',
      `/v1/scheduling/appointments/${appt}/attendance`,
      { kind: 'arrived' },
      randomUUID(),
    );
    const done = okP(await render(e, base({ planItemRef: pl.items[0] })));
    expect([done.provenance, done.planItemRef, done.codeRef, done.kind, done.state]).toStrictEqual([
      'planned',
      pl.items[0],
      'SYN-PROC-501',
      'rendered',
      'active',
    ]);
    const closed = await h.call('a1', 'GET', `/v1/clinical/encounters/${e}`);
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/encounters/${e}/close`, {
        expectedVersion: closed.json().data.version,
        dispositionCode: 'completed_as_planned',
      }),
    );
    expect(await itemStates(pl.planRef)).toStrictEqual({
      [pl.items[0] as string]: 'completed',
      [pl.items[1] as string]: 'accepted',
      [pl.items[2] as string]: 'scheduled',
    });
    const read = h.ok<{ data: Proc }>(
      await h.call('a1', 'GET', `/v1/clinical/procedures/${done.procedureRef}`),
    );
    expect(validateProcedureRead(read)).toBe(true);
    // Rendering needs an open encounter; a closed one is refused with the supported alternative.
    const late = await render(e, base({ sequence: 2, planItemRef: pl.items[1] }));
    expect(reason(late)).toStrictEqual([409, 'encounter_closed']);
  });

  it('2. an unscheduled procedure is recorded with provenance and no plan item', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Unscheduled');
    const e = await encounter(p);
    const u = okP(
      await render(
        e,
        base({ codeRef: 'SYN-PROC-777', tooth: { system: 'universal', code: '14' }, surfaces: ['O'] }),
      ),
    );
    expect([u.provenance, u.planItemRef, u.tooth?.canonicalRef]).toStrictEqual([
      'unscheduled',
      null,
      'perm-ul-6',
    ]);
    const noCode = await render(e, base({ sequence: 2 }));
    expect(reason(noCode)).toStrictEqual([422, 'required']);
    const badSurface = await render(
      e,
      base({
        sequence: 3,
        codeRef: 'SYN-PROC-778',
        tooth: { system: 'universal', code: '8' },
        surfaces: ['O'],
      }),
    );
    expect(reason(badSurface)).toStrictEqual([422, 'surfaceNotForToothType']);
  });

  it('3. a correction is a linked reversal and replacement; the list shows the net set and the history', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Correction');
    const pl = await plan(p);
    const e = await encounter(p);
    const a = okP(await render(e, base({ planItemRef: pl.items[0] })));
    const b = okP(await render(e, base({ sequence: 2, codeRef: 'SYN-PROC-610' })));
    const res = await h.call('a1', 'POST', `/v1/clinical/procedures/${b.procedureRef}/corrections`, {
      reasonCode: 'wrong_code',
      replacement: { codeRef: 'SYN-PROC-611' },
    });
    const c = h.ok<{ data: { original: Proc; reversal: Proc; replacement: Proc } }>(res, 201);
    expect(validateProcedureCorrectionResult(c)).toBe(true);
    const { original, reversal, replacement } = c.data;
    expect([original.state, original.reversedByRef, original.replacedByRef]).toStrictEqual([
      'reversed',
      reversal.procedureRef,
      replacement.procedureRef,
    ]);
    expect([reversal.kind, reversal.state, reversal.reversesProcedureRef]).toStrictEqual([
      'reversal',
      'reversal',
      b.procedureRef,
    ]);
    expect([replacement.replacesProcedureRef, replacement.codeRef, replacement.provenance]).toStrictEqual([
      b.procedureRef,
      'SYN-PROC-611',
      'correction',
    ]);
    const l = await list(e);
    expect(l.netRefs.sort()).toStrictEqual([a.procedureRef, replacement.procedureRef].sort());
    expect(l.procedures).toHaveLength(4);
    const twice = await h.call('a1', 'POST', `/v1/clinical/procedures/${b.procedureRef}/corrections`, {
      reasonCode: 'wrong_code',
    });
    expect(reason(twice)).toStrictEqual([409, 'procedure_reversed']);
    // Reversing a planned procedure returns its item to accepted (explicit transition naming the reversal).
    const back = h.ok<{ data: { reversal: Proc } }>(
      await h.call('a1', 'POST', `/v1/clinical/procedures/${a.procedureRef}/corrections`, {
        reasonCode: 'recorded_in_error',
      }),
      201,
    ).data.reversal;
    expect((await itemStates(pl.planRef))[pl.items[0] as string]).toBe('accepted');
    const ev = await db.admin.query(
      `SELECT cause, rendered_procedure_id FROM cuspatlas.clinical_plan_item_events WHERE item_id = $1 ORDER BY sequence`,
      [pl.items[0]],
    );
    expect(ev.rows.map((r) => [r.cause, r.rendered_procedure_id])).toStrictEqual([
      ['created', null],
      ['direct', null],
      ['rendered', a.procedureRef],
      ['render_reversed', back.procedureRef],
    ]);
  });

  it('4. another tenant’s encounter, item or provider is refused; an unassigned provider needs an override with reason', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Tenancy');
    const other = await createPatient(h, 'Synthetic Procedure Other');
    const otherPlan = await plan(other);
    const e = await encounter(p);
    expect((await render(e, base({ codeRef: 'SYN-PROC-701' }), 'b1')).statusCode).toBe(404);
    expect(reason(await render(e, base({ planItemRef: otherPlan.items[0] })))).toStrictEqual([
      422,
      'planItemPatientMismatch',
    ]);
    expect(
      (await render(e, base({ codeRef: 'SYN-PROC-701', renderingProviderRef: randomUUID() }))).statusCode,
    ).toBe(404);
    const unassigned = await render(
      e,
      base({ codeRef: 'SYN-PROC-701', renderingProviderRef: otherProvider }),
    );
    expect(reason(unassigned)).toStrictEqual([409, 'provider_not_assigned']);
    const overridden = okP(
      await render(
        e,
        base({
          codeRef: 'SYN-PROC-701',
          renderingProviderRef: otherProvider,
          providerOverrideReason: 'covering_provider',
        }),
      ),
    );
    expect(overridden.providerOverrideReason).toBe('covering_provider');
    expect(
      (await render(e, { ...base({ sequence: 9, codeRef: 'SYN-PROC-702' }), tenantId: T_ALPHA })).statusCode,
    ).toBe(400);
    expect(
      (await render(e, base({ sequence: 9, codeRef: 'SYN-PROC-702', amount: { currency: 'USD', minor: 1 } })))
        .statusCode,
    ).toBe(400);
  });

  it('5. the same procedure twice without an explicit duplicate indicator is a conflict', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Duplicate');
    const e = await encounter(p);
    const first = okP(
      await render(e, base({ codeRef: 'SYN-PROC-801', tooth: { system: 'universal', code: '3' } })),
    );
    const dup = await render(
      e,
      base({ sequence: 2, codeRef: 'SYN-PROC-801', tooth: { system: 'universal', code: '3' } }),
    );
    expect([dup.statusCode, dup.json().detail]).toStrictEqual([
      409,
      {
        reason: 'duplicate_procedure',
        blockingRefs: [{ kind: 'renderedProcedure', ref: first.procedureRef }],
      },
    ]);
    okP(
      await render(
        e,
        base({
          sequence: 2,
          codeRef: 'SYN-PROC-801',
          tooth: { system: 'universal', code: '3' },
          duplicateIntent: 'repeat_in_visit',
        }),
      ),
    );
    const seq = await render(e, base({ sequence: 1, codeRef: 'SYN-PROC-802' }));
    expect(reason(seq)).toStrictEqual([409, 'sequence_in_use']);
  });

  it('6. the event carries identifiers only: no narrative, amount or demographic value', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Event');
    const pl = await plan(p);
    const e = await encounter(p);
    const r = okP(await render(e, base({ planItemRef: pl.items[1] })));
    expect(Object.keys(r.billingEvent).sort()).toStrictEqual(
      [
        'codeRef',
        'dateOfService',
        'encounterRef',
        'eventType',
        'patientRef',
        'planItemRef',
        'procedureRef',
        'renderingProviderRef',
        'replacesProcedureRef',
        'reversesProcedureRef',
        'toothSurface',
        'version',
      ].sort(),
    );
    expect(r.billingEvent).toMatchObject({
      eventType: 'procedure.rendered.v1',
      procedureRef: r.procedureRef,
      patientRef: p,
      encounterRef: e,
      renderingProviderRef: loc.provider,
      dateOfService: TODAY,
      codeRef: 'SYN-PROC-502',
      planItemRef: pl.items[1],
      version: 1,
    });
    const { rows } = await db.admin.query(
      `SELECT operation, aggregate_type, aggregate_id, aggregate_version, payload_class, payload::text AS payload
       FROM cuspatlas.outbox_events WHERE aggregate_id = $1`,
      [r.procedureRef],
    );
    expect(
      rows.map((x) => [x.operation, x.aggregate_type, x.aggregate_version, x.payload_class]),
    ).toStrictEqual([['clinical.procedures.render', 'clinicalRenderedProcedure', 1, 'field-names-only']]);
    const text = JSON.stringify(r.billingEvent) + rows[0].payload;
    for (const banned of ['amount', 'minor', 'currency', 'displayText', 'Synthetic', 'birth', 'legalName']) {
      expect([banned, text.includes(banned)]).toStrictEqual([banned, false]);
    }
    // B reads the same payload in its own transaction through the domain seam.
    const seam = await createTenantTransactionRunner(db.app)(ctxFor(T_ALPHA, USER_A1, 'human'), (tx) =>
      loadRenderedProcedureEvent(tx, r.procedureRef),
    );
    expect(seam).toStrictEqual(r.billingEvent);
  });
});

describe('C14 failure and recovery cases', () => {
  it('1. a failed render rolls back the procedure, the item state, audit and outbox together', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Rollback');
    const pl = await plan(p);
    const e = await encounter(p);
    const counts = async () =>
      (
        await db.admin.query(
          `SELECT (SELECT count(*) FROM cuspatlas.clinical_rendered_procedures)::int AS p,
             (SELECT count(*) FROM cuspatlas.clinical_plan_item_events)::int AS e,
             (SELECT count(*) FROM cuspatlas.audit_events)::int AS a`,
        )
      ).rows[0];
    const before = await counts();
    await db.admin.query('REVOKE INSERT ON cuspatlas.outbox_events FROM cuspatlas_app');
    try {
      const res = await render(e, base({ planItemRef: pl.items[0] }));
      expect(res.statusCode).toBe(500);
    } finally {
      await db.admin.query('GRANT INSERT ON cuspatlas.outbox_events TO cuspatlas_app');
    }
    expect(await counts()).toStrictEqual(before);
    expect((await itemStates(pl.planRef))[pl.items[0] as string]).toBe('accepted');
  });

  it('2. correcting after billing consumed the event emits correcting events and never mutates the earlier one', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Consumed');
    const e = await encounter(p);
    const r = okP(await render(e, base({ codeRef: 'SYN-PROC-901' })));
    await db.admin.query(`UPDATE cuspatlas.outbox_events SET state = 'delivered' WHERE aggregate_id = $1`, [
      r.procedureRef,
    ]);
    const snap = async () =>
      (
        await db.admin.query(
          'SELECT to_jsonb(o) AS j FROM cuspatlas.outbox_events o WHERE aggregate_id = $1',
          [r.procedureRef],
        )
      ).rows;
    const before = await snap();
    const c = h.ok<{ data: { reversal: Proc; replacement: Proc } }>(
      await h.call('a1', 'POST', `/v1/clinical/procedures/${r.procedureRef}/corrections`, {
        reasonCode: 'wrong_code',
        replacement: { codeRef: 'SYN-PROC-902' },
      }),
      201,
    ).data;
    expect(await snap()).toStrictEqual(before);
    const { rows } = await db.admin.query(
      `SELECT aggregate_id, operation FROM cuspatlas.outbox_events WHERE aggregate_id = ANY ($1::uuid[]) ORDER BY occurred_at`,
      [[c.reversal.procedureRef, c.replacement.procedureRef]],
    );
    expect(rows.map((x) => x.operation)).toStrictEqual([
      'clinical.procedures.correct',
      'clinical.procedures.correct',
    ]);
    expect(c.reversal.billingEvent).toMatchObject({
      eventType: 'procedure.reversed.v1',
      reversesProcedureRef: r.procedureRef,
    });
    expect(c.replacement.billingEvent).toMatchObject({
      eventType: 'procedure.rendered.v1',
      replacesProcedureRef: r.procedureRef,
    });
  });

  it('3. a plan item rendered across two visits needs distinct encounters, explicit sequences and the indicator', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Two Visits');
    const pl = await plan(p);
    const e1 = await encounter(p);
    const first = okP(await render(e1, base({ planItemRef: pl.items[0] })));
    const e2 = await encounter(p);
    expect(reason(await render(e2, base({ planItemRef: pl.items[0] })))).toStrictEqual([
      409,
      'plan_item_completed',
    ]);
    const second = okP(
      await render(e2, base({ planItemRef: pl.items[0], duplicateIntent: 'additional_visit' })),
    );
    expect([second.encounterRef, second.procedureRef === first.procedureRef]).toStrictEqual([e2, false]);
    expect(
      reason(
        await render(
          e1,
          base({ sequence: 2, planItemRef: pl.items[0], duplicateIntent: 'additional_visit' }),
        ),
      ),
    ).toStrictEqual([409, 'duplicate_procedure']);
    const events = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_item_events WHERE item_id = $1 AND cause = 'rendered'`,
      [pl.items[0]],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it('4. a chart entry superseded after rendering keeps the recorded tooth and flags the discrepancy', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Chart');
    const entry = h.ok<{ data: { entry: { entryRef: string } } }>(
      await h.call('a1', 'POST', '/v1/clinical/chart/entries', {
        patientRef: p,
        provenance: 'recorded',
        tooth: { system: 'universal', code: '19' },
        kind: 'condition',
        findingRef: 'SYN-COND-900',
      }),
      201,
    ).data.entry.entryRef;
    const e = await encounter(p);
    const r = okP(
      await render(
        e,
        base({ codeRef: 'SYN-PROC-950', tooth: { system: 'universal', code: '19' }, chartEntryRef: entry }),
      ),
    );
    expect(r.chartDiscrepancy).toBe('none');
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/chart/entries/${entry}/corrections`, {
        reasonCode: 'wrong_tooth',
        state: 'active',
        tooth: { system: 'universal', code: '18' },
      }),
      201,
    );
    const after = h.ok<{ data: Proc }>(
      await h.call('a1', 'GET', `/v1/clinical/procedures/${r.procedureRef}`),
    ).data;
    expect([after.tooth?.canonicalRef, after.chartDiscrepancy]).toStrictEqual([
      r.tooth?.canonicalRef,
      'chart_entry_superseded',
    ]);
  });
});

describe('C14 enforcement, privacy and parity', () => {
  it('procedures are append-only and only a rendered procedure completes an item, under the runtime role', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Enforcement');
    const pl = await plan(p);
    const e = await encounter(p);
    const r = okP(await render(e, base({ codeRef: 'SYN-PROC-990' })));
    const run = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    for (const sql of [
      `UPDATE cuspatlas.clinical_rendered_procedures SET code_ref = 'SYN-X' WHERE id = '${r.procedureRef}'`,
      `DELETE FROM cuspatlas.clinical_rendered_procedures WHERE id = '${r.procedureRef}'`,
      // Completing an item with a procedure of no item (or of another item) is refused.
      `INSERT INTO cuspatlas.clinical_plan_item_events (tenant_id, item_id, sequence, from_state, to_state, cause,
         rendered_procedure_id, recorded_by, recorded_by_role, recorded_by_credential_ref)
       VALUES (cuspatlas.current_tenant_id(), '${pl.items[0]}', 3, 'accepted', 'completed', 'rendered', '${r.procedureRef}',
         cuspatlas.current_actor_id(), 'dentist', 'SYN-CRED-A1')`,
    ]) {
      await expect(run(ctx, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('a read-only member and a service principal cannot render; the read-only member reads', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Roles');
    const e = await encounter(p);
    const r = okP(await render(e, base({ codeRef: 'SYN-PROC-991' })));
    expect((await render(e, base({ sequence: 2, codeRef: 'SYN-PROC-992' }), 'a4')).statusCode).toBe(403);
    expect((await render(e, base({ sequence: 2, codeRef: 'SYN-PROC-992' }), 'svcA1')).statusCode).toBe(403);
    expect((await h.call('a4', 'GET', `/v1/clinical/procedures/${r.procedureRef}`)).statusCode).toBe(200);
  });

  it('MCP render replays a REST key; reads match; nothing caller-controlled leaks', async () => {
    const p = await createPatient(h, 'Synthetic Procedure Parity');
    const e = await encounter(p);
    await render(e, { ...base({ codeRef: 'SYN-PROC-993' }), note: MARKER });
    const key = randomUUID();
    const rest = okP(await render(e, base({ codeRef: 'SYN-PROC-994' }), 'a1', key));
    const viaMcp = await h.mcp(
      'a1',
      'clinical_procedures_render',
      { encounterRef: e, ...base({ codeRef: 'SYN-PROC-994' }), idempotencyKey: key },
      201,
    );
    expect([viaMcp.code, (viaMcp.body as { replayed: boolean }).replayed]).toStrictEqual([null, true]);
    const mcpRead = await h.mcp('a1', 'clinical_procedures_get', { procedureRef: rest.procedureRef });
    const restRead = h.ok<{ data: Proc }>(
      await h.call('a1', 'GET', `/v1/clinical/procedures/${rest.procedureRef}`),
    );
    expect((mcpRead.body as { data: Proc }).data).toStrictEqual(restRead.data);
    const foreign = await h.mcp('b1', 'clinical_procedures_get', { procedureRef: rest.procedureRef });
    expect([foreign.status, foreign.code]).toStrictEqual([404, 'not_found']);
    expect(`${await leakTables(db)}${h.logLines.join('\n')}`).not.toContain(MARKER);
  });
});
