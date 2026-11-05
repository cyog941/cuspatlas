import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  USER_A1,
} from './support/appointment-fixtures';
import { seedClinicalScopes, seedDispositions } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { seedPracticeFees } from './support/fee-fixtures';
import { SVC_A1 } from './support/fixtures';

/**
 * Hardening of C12-C14 and of the S6 merge guards after the independent review of c-chart 1365bff
 * (synthetic data only). Every forged write runs under the runtime role `cuspatlas_app` with tenant
 * and actor context, exactly as the application does, and commits so deferred checks run.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
const LOC = 'loc-c12-hardening';
const PLANS = '/v1/clinical/treatment-plans';
const EST = '/v1/clinical/estimates';
// Today in the seeded location's own time zone (the server compares there; a UTC date is tomorrow
// in New York for five hours a day).
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const DIGEST = `sha256:${'c'.repeat(64)}`;
const USD = (minor: number) => ({ currency: 'USD', minor });
const tooth = (code: string) => ({ system: 'universal', code });

beforeAll(async () => {
  db = await openTestDatabase('clinical_review_hardening_c12');
  h = await openAppointmentHarness(db, { mcp: false });
  await seedClinicalScopes(db.admin);
  // C12 -> B9: the line fees these tests supply must equal the server practice fee.
  await seedPracticeFees(db, [
    ['SYN-PROC-701', 10_000],
    ['SYN-PROC-702', 10_000],
    ['SYN-PROC-799', 5_000],
  ]);
  await seedDispositions(db.admin, T_ALPHA, ['completed_as_planned']);
  await db.admin.query(
    `INSERT INTO cuspatlas.clinical_consent_method_policies (tenant_id, method, witness_required)
     VALUES ($1, 'verbal_attested', true) ON CONFLICT (tenant_id, method) DO UPDATE SET witness_required = true`,
    [T_ALPHA],
  );
  loc = await seedLocation(h, LOC);
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

/** Runs statements in one runtime-role transaction and commits; returns 'ok' or the SQLSTATE. */
async function commit(statements: readonly [string, unknown[]?][], actor = USER_A1): Promise<string> {
  const client = await db.app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
    await client.query(`SELECT set_config('cuspatlas.actor_id', $1, true)`, [actor]);
    for (const [sql, params] of statements) await client.query(sql, params ?? []);
    await client.query('COMMIT');
    return 'ok';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    return (e as { code?: string }).code ?? 'error';
  } finally {
    client.release();
  }
}
const reason = (res: Awaited<ReturnType<AppointmentHarness['call']>>) => [
  res.statusCode,
  res.json().detail?.reason ?? res.json().detail?.violations?.[0]?.rule ?? res.json().code,
];
const PLAN_EXCLUDE = ['subject_patient_id', 'head_version', 'version', 'updated_at'];
const digestOf = async (table: string, id: string, exclude: string[]) =>
  (
    await db.admin.query(
      `SELECT encode(sha256(convert_to((to_jsonb(r) ${exclude.map((c) => `- '${c}'`).join(' ')})::text, 'UTF8')), 'hex') AS d
       FROM cuspatlas.${table} r WHERE id = $1`,
      [id],
    )
  ).rows[0].d as string;
const subjectOf = async (planRef: string) =>
  (
    await db.admin.query('SELECT subject_patient_id FROM cuspatlas.clinical_treatment_plans WHERE id = $1', [
      planRef,
    ])
  ).rows[0].subject_patient_id as string;

async function newPlan(patientRef: string) {
  return h.ok<{ data: { plan: { planRef: string; headVersionRef: string } } }>(
    await h.call('a1', 'POST', PLANS, { patientRef }, randomUUID()),
    201,
  ).data.plan;
}
async function revision(planRef: string, versionRef: string): Promise<number> {
  const p = h.ok<{ data: { versions: { planVersionRef: string; revision: number }[] } }>(
    await h.call('a1', 'GET', `${PLANS}/${planRef}`),
  ).data;
  return p.versions.find((v) => v.planVersionRef === versionRef)?.revision as number;
}
async function itemState(planRef: string, itemRef: string): Promise<string> {
  const p = h.ok<{ data: { versions: { details: { items: { itemRef: string; state: string }[] }[] }[] } }>(
    await h.call('a1', 'GET', `${PLANS}/${planRef}`),
  ).data;
  return p.versions.flatMap((v) => v.details.flatMap((d) => d.items)).find((i) => i.itemRef === itemRef)
    ?.state as string;
}
async function charted(patientRef: string, code: string) {
  return h.ok<{ data: { entry: { entryRef: string } } }>(
    await h.call('a1', 'POST', '/v1/clinical/chart/entries', {
      patientRef,
      provenance: 'recorded',
      tooth: tooth(code),
      kind: 'condition',
      findingRef: 'SYN-COND-100',
    }),
    201,
  ).data.entry.entryRef;
}
/** A plan with one whole-mouth item and one tooth item (tooth 3, surfaces O), both accepted. */
async function acceptedPlan(patientRef: string, fees = true) {
  const plan = await newPlan(patientRef);
  const v = plan.headVersionRef;
  const entry = await charted(patientRef, '3');
  const mouth = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/versions/${v}/details`, {
      expectedRevision: 1,
      scope: 'whole_mouth',
    }),
    201,
  ).data.targetRef;
  const toothDetail = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/versions/${v}/details`, {
      expectedRevision: 2,
      scope: 'tooth',
      tooth: tooth('3'),
      chartEntryRef: entry,
    }),
    201,
  ).data.targetRef;
  const mouthItem = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/details/${mouth}/items`, {
      expectedRevision: 3,
      procedureCodeRef: 'SYN-PROC-701',
      sequence: 1,
      ...(fees ? { feeScheduleRef: 'synthetic-fee-701' } : {}),
    }),
    201,
  ).data.targetRef;
  const toothItem = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/details/${toothDetail}/items`, {
      expectedRevision: 4,
      procedureCodeRef: 'SYN-PROC-702',
      sequence: 2,
      tooth: tooth('3'),
      surfaces: ['O'],
      ...(fees ? { feeScheduleRef: 'synthetic-fee-702' } : {}),
    }),
    201,
  ).data.targetRef;
  for (const item of [mouthItem, toothItem]) {
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/items/${item}/state`, {
        expectedRevision: await revision(plan.planRef, v),
        state: 'accepted',
      }),
    );
  }
  return { planRef: plan.planRef, versionRef: v, mouthItem, toothItem, mouth };
}
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
const render = (encounterRef: string, body: Record<string, unknown>) =>
  h.call(
    'a1',
    'POST',
    `/v1/clinical/encounters/${encounterRef}/procedures`,
    { sequence: 1, dateOfService: TODAY, renderingProviderRef: loc.provider, ...body },
    randomUUID(),
  );
const correct = (procedureRef: string, body: Record<string, unknown>) =>
  h.call('a1', 'POST', `/v1/clinical/procedures/${procedureRef}/corrections`, body, randomUUID());
const generate = (versionRef: string, body: Record<string, unknown>) =>
  h.call('a1', 'POST', `${PLANS}/versions/${versionRef}/estimates`, body, randomUUID());
const present = (estimateRef: string) => h.call('a1', 'POST', `${EST}/${estimateRef}/presentation`, {});
const accept = (estimateRef: string, expectedRevision: number) =>
  h.call('a1', 'POST', `${EST}/${estimateRef}/acceptance`, { expectedRevision, scope: 'full' });
const consentBody = (patientRef: string, extra: Record<string, unknown> = {}) => ({
  patientRef,
  scope: 'general_treatment',
  method: 'in_person',
  templateRef: 'synthetic-consent-general',
  templateDigest: DIGEST,
  attestationCode: 'signed_in_person',
  signer: { kind: 'patient' },
  ...extra,
});
const capture = (b: Record<string, unknown>) =>
  h.call('a1', 'POST', '/v1/clinical/consents', b, randomUUID());

/** A hand-made merge transaction with real identity digests (exactly what a real merge writes). */
function mergeStatements(
  mergeId: string,
  survivor: string,
  merged: string,
  moves: { planRef: string; digest: string }[],
  relink: string[],
): [string, unknown[]][] {
  return [
    ...relink.map((planRef): [string, unknown[]] => [
      'UPDATE cuspatlas.clinical_treatment_plans SET subject_patient_id = $1, version = version + 1 WHERE id = $2',
      [survivor, planRef],
    ]),
    [
      `INSERT INTO cuspatlas.patient_merges (id, tenant_id, survivor_patient_id, merged_patient_id, survivor_version_before,
         merged_version_before, survivor_digest, merged_digest, reason_code, move_count, merged_by)
       VALUES ($1, cuspatlas.current_tenant_id(), $2, $3, 1, 1, cuspatlas.patient_identity_digest($2),
         cuspatlas.patient_identity_digest($3), 'duplicate_registration', $4, cuspatlas.current_actor_id())`,
      [mergeId, survivor, merged, moves.length],
    ],
    ...moves.map((m): [string, unknown[]] => [
      `INSERT INTO cuspatlas.patient_merge_moves (tenant_id, merge_id, record_class, record_ref, reference_column,
           prior_patient_id, new_patient_id, content_digest_before, content_digest_after)
         VALUES (cuspatlas.current_tenant_id(), $1, 'clinicalTreatmentPlan', $2, 'subject_patient_id', $3, $4, $5, $5)`,
      [mergeId, m.planRef, merged, survivor, m.digest],
    ]),
    [
      'UPDATE cuspatlas.patients SET merged_into = $1, version = version + 1 WHERE id = $2',
      [survivor, merged],
    ],
  ];
}

describe('MUST 1: a merge move proves the record belonged to the merged patient', () => {
  it('a well-formed merge with real digests cannot list the survivor’s own record as moved', async () => {
    const merged = await createPatient(h, 'Synthetic Move Source');
    const survivor = await createPatient(h, 'Synthetic Move Target');
    const moved = await newPlan(merged);
    const native = await newPlan(survivor);
    const dMoved = await digestOf('clinical_treatment_plans', moved.planRef, PLAN_EXCLUDE);
    const dNative = await digestOf('clinical_treatment_plans', native.planRef, PLAN_EXCLUDE);
    const forged = mergeStatements(
      randomUUID(),
      survivor,
      merged,
      [
        { planRef: moved.planRef, digest: dMoved },
        { planRef: native.planRef, digest: dNative },
      ],
      [moved.planRef],
    );
    expect(await commit(forged)).toBe('42501');
    expect([await subjectOf(moved.planRef), await subjectOf(native.planRef)]).toStrictEqual([
      merged,
      survivor,
    ]);
    // The same transaction without the forged move is a valid merge (control).
    const control = mergeStatements(
      randomUUID(),
      survivor,
      merged,
      [{ planRef: moved.planRef, digest: dMoved }],
      [moved.planRef],
    );
    expect(await commit(control)).toBe('ok');
    expect(await subjectOf(moved.planRef)).toBe(survivor);
  });
});

describe('MUST 2: a merge row describes a merge transition of its own transaction', () => {
  it('a second merge row for an already-merged pair is refused, even with real digests', async () => {
    const survivor = await createPatient(h, 'Synthetic Dup Merge');
    const merged = await createPatient(h, 'Synthetic Dup Merge');
    await mergePatients(h, survivor, merged);
    const dup: [string, unknown[]][] = [
      [
        `INSERT INTO cuspatlas.patient_merges (tenant_id, survivor_patient_id, merged_patient_id, survivor_version_before,
           merged_version_before, survivor_digest, merged_digest, reason_code, move_count, merged_by)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, 1, 1, cuspatlas.patient_identity_digest($1),
           cuspatlas.patient_identity_digest($2), 'duplicate_registration', 0, cuspatlas.current_actor_id())`,
        [survivor, merged],
      ],
    ];
    expect(await commit(dup)).toBe('42501');
    const n = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.patient_merges WHERE merged_patient_id = $1',
      [merged],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('a reversal is recorded only with the merged identity restored in its transaction', async () => {
    const survivor = await createPatient(h, 'Synthetic Reversal Target');
    const merged = await createPatient(h, 'Synthetic Reversal Target');
    const mergeRef = await mergePatients(h, survivor, merged);
    // A reversal row alone (merged_into untouched) is refused.
    expect(
      await commit([
        [
          `INSERT INTO cuspatlas.patient_merge_reversals (tenant_id, merge_id, reason_code, elevated, move_count, reversed_by)
           VALUES (cuspatlas.current_tenant_id(), $1, 'merged_in_error', false, 0, cuspatlas.current_actor_id())`,
          [mergeRef],
        ],
      ]),
    ).toBe('42501');
  });
});

describe('MUST 3: a replacement keeps its plan item only when it matches the item', () => {
  it('a replacement for another tooth does not complete the plan item (domain)', async () => {
    const p = await createPatient(h, 'Synthetic Replacement Tooth');
    const pl = await acceptedPlan(p);
    const e = await encounter(p);
    const done = h.ok<{ data: { procedureRef: string } }>(
      await render(e, { planItemRef: pl.toothItem }),
      201,
    ).data;
    expect(await itemState(pl.planRef, pl.toothItem)).toBe('completed');
    const res = await correct(done.procedureRef, {
      reasonCode: 'wrong_tooth',
      replacement: { tooth: tooth('14') },
    });
    const c = h.ok<{
      data: { replacement: { planItemRef: string | null; tooth: { canonicalRef: string } } };
    }>(res, 201).data;
    expect(c.replacement.planItemRef).toBeNull();
    expect(await itemState(pl.planRef, pl.toothItem)).toBe('accepted');
  });

  it('the database refuses a planned procedure whose tooth or surfaces differ from its item', async () => {
    const p = await createPatient(h, 'Synthetic Replacement Guard');
    const pl = await acceptedPlan(p);
    const e = await encounter(p);
    const done = h.ok<{ data: { procedureRef: string } }>(
      await render(e, { planItemRef: pl.toothItem }),
      201,
    ).data;
    const copy = (tooth: string | null, surfaces: string | null) =>
      [
        `INSERT INTO cuspatlas.clinical_rendered_procedures (tenant_id, kind, encounter_id, origin_patient_id, sequence,
         plan_item_id, provenance, code_ref, tooth_canonical_ref, tooth_vocabulary, surfaces, date_of_service,
         rendering_provider_id, duplicate_intent, recorded_by, recorded_by_role, recorded_by_credential_ref)
       SELECT tenant_id, kind, encounter_id, origin_patient_id, 9, plan_item_id, provenance, code_ref,
         coalesce($2, tooth_canonical_ref), tooth_vocabulary, coalesce($3::text[], surfaces), date_of_service, rendering_provider_id, 'repeat_in_visit', recorded_by, recorded_by_role,
         recorded_by_credential_ref
       FROM cuspatlas.clinical_rendered_procedures WHERE id = $1`,
        [done.procedureRef, tooth, surfaces],
      ] as [string, unknown[]];
    expect(await commit([copy(null, null)])).toBe('ok');
    expect(await commit([copy('perm-ul-6', null)])).toBe('42501');
    expect(await commit([copy(null, '{M}')])).toBe('42501');
  });

  it('a replacement sequence is checked against the active procedures', async () => {
    const p = await createPatient(h, 'Synthetic Replacement Sequence');
    const e = await encounter(p);
    const one = h.ok<{ data: { procedureRef: string } }>(
      await render(e, { codeRef: 'SYN-PROC-801' }),
      201,
    ).data;
    h.ok(await render(e, { sequence: 2, codeRef: 'SYN-PROC-802' }), 201);
    const res = await correct(one.procedureRef, { reasonCode: 'wrong_code', replacement: { sequence: 2 } });
    expect(reason(res)).toStrictEqual([409, 'sequence_in_use']);
  });

  it('reversing one procedure keeps an item completed while another active procedure covers it', async () => {
    const p = await createPatient(h, 'Synthetic Additional Visit');
    const pl = await acceptedPlan(p);
    const e = await encounter(p);
    const first = h.ok<{ data: { procedureRef: string } }>(
      await render(e, { planItemRef: pl.mouthItem }),
      201,
    ).data;
    const second = await encounter(p);
    h.ok(await render(second, { planItemRef: pl.mouthItem, duplicateIntent: 'additional_visit' }), 201);
    h.ok(await correct(first.procedureRef, { reasonCode: 'recorded_in_error' }), 201);
    expect(await itemState(pl.planRef, pl.mouthItem)).toBe('completed');
  });
});

describe('MUST 4: completion only by a rendered, non-reversed procedure of the item lineage', () => {
  it('a completion naming a reversed procedure is refused', async () => {
    const p = await createPatient(h, 'Synthetic Reversed Completion');
    const pl = await acceptedPlan(p);
    const e = await encounter(p);
    const done = h.ok<{ data: { procedureRef: string } }>(
      await render(e, { planItemRef: pl.mouthItem }),
      201,
    ).data;
    h.ok(await correct(done.procedureRef, { reasonCode: 'recorded_in_error' }), 201);
    expect(await itemState(pl.planRef, pl.mouthItem)).toBe('accepted');
    const forged: [string, unknown[]] = [
      `INSERT INTO cuspatlas.clinical_plan_item_events (tenant_id, item_id, sequence, from_state, to_state, cause,
         rendered_procedure_id, recorded_by, recorded_by_role, recorded_by_credential_ref)
       SELECT e.tenant_id, e.item_id, e.sequence + 1, 'accepted', 'completed', 'rendered', $2, e.recorded_by,
         e.recorded_by_role, e.recorded_by_credential_ref
       FROM cuspatlas.clinical_plan_item_events e WHERE e.item_id = $1 ORDER BY e.sequence DESC LIMIT 1`,
      [pl.mouthItem, done.procedureRef],
    ];
    expect(await commit([forged])).toBe('42501');
  });

  it('a carried-forward item derives only from the prior version of its own plan', async () => {
    const p = await createPatient(h, 'Synthetic Carry Lineage');
    const other = await createPatient(h, 'Synthetic Carry Other');
    const pl = await acceptedPlan(p);
    const foreign = await acceptedPlan(other);
    const fe = await encounter(other);
    h.ok(await render(fe, { planItemRef: foreign.mouthItem }), 201);
    expect(await itemState(foreign.planRef, foreign.mouthItem)).toBe('completed');
    // An item of this (head, draft) version claiming to carry forward the other patient's completed item.
    const id = randomUUID();
    const forged: [string, unknown[]][] = [
      [
        `INSERT INTO cuspatlas.clinical_plan_items (id, tenant_id, detail_id, plan_version_id, sequence, procedure_code_ref,
           derived_from_item_id, created_by, created_by_role, created_by_credential_ref)
         SELECT $1, tenant_id, detail_id, plan_version_id, 50, procedure_code_ref, $3, created_by, created_by_role,
           created_by_credential_ref
         FROM cuspatlas.clinical_plan_items WHERE id = $2`,
        [id, pl.mouthItem, foreign.mouthItem],
      ],
      [
        `INSERT INTO cuspatlas.clinical_plan_item_events (tenant_id, item_id, sequence, from_state, to_state, cause,
           recorded_by, recorded_by_role, recorded_by_credential_ref)
         SELECT tenant_id, $1, 1, NULL, 'completed', 'carried_forward', recorded_by, recorded_by_role,
           recorded_by_credential_ref
         FROM cuspatlas.clinical_plan_item_events WHERE item_id = $2 ORDER BY sequence LIMIT 1`,
        [id, pl.mouthItem],
      ],
    ];
    expect(await commit(forged)).toBe('42501');
  });

  it('a real supersede still carries a completed item, naming its rendered procedure', async () => {
    const p = await createPatient(h, 'Synthetic Carry Completed');
    const pl = await acceptedPlan(p);
    const e = await encounter(p);
    const done = h.ok<{ data: { procedureRef: string } }>(
      await render(e, { planItemRef: pl.mouthItem }),
      201,
    ).data;
    const res = await h.call('a1', 'POST', `${PLANS}/versions/${pl.versionRef}/supersede`, {
      expectedRevision: await revision(pl.planRef, pl.versionRef),
      reasonCode: 'treatment_changed',
    });
    expect(res.statusCode).toBe(201);
    const carried = await db.admin.query(
      `SELECT e.to_state, e.rendered_procedure_id FROM cuspatlas.clinical_plan_items i
       JOIN cuspatlas.clinical_plan_item_events e ON e.item_id = i.id WHERE i.derived_from_item_id = $1`,
      [pl.mouthItem],
    );
    expect(carried.rows).toStrictEqual([{ to_state: 'completed', rendered_procedure_id: done.procedureRef }]);
  });
});

describe('MUST 5: acceptance needs a presented, still-complete estimate', () => {
  it('an estimate that was never presented cannot be accepted', async () => {
    const p = await createPatient(h, 'Synthetic Unpresented');
    const pl = await acceptedPlan(p);
    const est = h.ok<{ data: { estimateRef: string } }>(
      await generate(pl.versionRef, {
        lines: [pl.mouthItem, pl.toothItem].map((planItemRef) => ({ planItemRef, fee: USD(10_000) })),
      }),
      201,
    ).data;
    const res = await accept(est.estimateRef, await revision(pl.planRef, pl.versionRef));
    expect(reason(res)).toStrictEqual([409, 'estimate_not_presented']);
  });

  it('an estimate made incomplete after presentation cannot be accepted; an accepted revision is recorded', async () => {
    const p = await createPatient(h, 'Synthetic Incomplete Accept');
    const pl = await acceptedPlan(p);
    const est = h.ok<{ data: { estimateRef: string } }>(
      await generate(pl.versionRef, {
        lines: [pl.mouthItem, pl.toothItem].map((planItemRef) => ({ planItemRef, fee: USD(10_000) })),
      }),
      201,
    ).data;
    h.ok(await present(est.estimateRef));
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/details/${pl.mouth}/items`, {
        expectedRevision: await revision(pl.planRef, pl.versionRef),
        procedureCodeRef: 'SYN-PROC-799',
        sequence: 9,
        feeScheduleRef: 'synthetic-fee-799',
      }),
      201,
    );
    const res = await accept(est.estimateRef, await revision(pl.planRef, pl.versionRef));
    expect(reason(res)).toStrictEqual([409, 'estimate_incomplete']);
    // A fresh, presented estimate is accepted and records the revision it was accepted at.
    const items = (
      await db.admin.query('SELECT id FROM cuspatlas.clinical_plan_items WHERE plan_version_id = $1', [
        pl.versionRef,
      ])
    ).rows.map((r) => r.id as string);
    const fresh = h.ok<{ data: { estimateRef: string } }>(
      await generate(pl.versionRef, {
        // C12 -> B9: each item is priced at its own server fee (701/702 at 10_000, 799 at 5_000).
        lines: items.map((planItemRef) => ({ planItemRef })),
      }),
      201,
    ).data;
    h.ok(await present(fresh.estimateRef));
    const rev = await revision(pl.planRef, pl.versionRef);
    h.ok(await accept(fresh.estimateRef, rev), 201);
    const row = await db.admin.query(
      'SELECT accepted_revision FROM cuspatlas.clinical_plan_acceptances WHERE estimate_id = $1',
      [fresh.estimateRef],
    );
    expect(row.rows[0].accepted_revision).toBe(rev);
  });

  it('the database refuses an acceptance row for an unpresented estimate', async () => {
    const p = await createPatient(h, 'Synthetic Forged Acceptance');
    const pl = await acceptedPlan(p);
    const est = h.ok<{ data: { estimateRef: string } }>(
      await generate(pl.versionRef, {
        lines: [pl.mouthItem, pl.toothItem].map((planItemRef) => ({ planItemRef, fee: USD(10_000) })),
      }),
      201,
    ).data;
    expect(
      await commit([
        [
          `INSERT INTO cuspatlas.clinical_plan_acceptances (tenant_id, plan_version_id, estimate_id, scope, accepted_by,
             accepted_revision)
           VALUES (cuspatlas.current_tenant_id(), $1, $2, 'full', cuspatlas.current_actor_id(), 1)`,
          [pl.versionRef, est.estimateRef],
        ],
      ]),
    ).toBe('42501');
  });

  it('coverage that turned stale after presentation is shown stale on read and blocks acceptance', async () => {
    const p = await createPatient(h, 'Synthetic Stale Coverage');
    const pl = await acceptedPlan(p);
    const asOf = new Date(Date.now() - 30 * 86_400_000 + 2_500).toISOString();
    const est = h.ok<{ data: { estimateRef: string; coverageStatus: string } }>(
      await generate(pl.versionRef, {
        lines: [pl.mouthItem, pl.toothItem].map((planItemRef) => ({ planItemRef, fee: USD(10_000) })),
        assumptions: [{ kind: 'coverage', sourceRef: 'synthetic-coverage-1', sourceAsOf: asOf }],
      }),
      201,
    ).data;
    expect(est.coverageStatus).toBe('entered');
    h.ok(await present(est.estimateRef));
    await new Promise((r) => setTimeout(r, 3_000));
    const read = h.ok<{ data: { coverageStatus: string } }>(
      await h.call('a1', 'GET', `${EST}/${est.estimateRef}`),
    );
    expect(read.data.coverageStatus).toBe('stale');
    const res = await accept(est.estimateRef, await revision(pl.planRef, pl.versionRef));
    expect(reason(res)).toStrictEqual([409, 'estimate_coverage_stale']);
  });

  it('an estimate line for a declined item is refused', async () => {
    const p = await createPatient(h, 'Synthetic Declined Line');
    const pl = await acceptedPlan(p);
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/items/${pl.toothItem}/state`, {
        expectedRevision: await revision(pl.planRef, pl.versionRef),
        state: 'declined',
        reasonCode: 'patient_declined',
      }),
    );
    const res = await generate(pl.versionRef, {
      lines: [pl.mouthItem, pl.toothItem].map((planItemRef) => ({ planItemRef, fee: USD(10_000) })),
    });
    expect(reason(res)).toStrictEqual([422, 'itemNotOpen']);
  });
});

describe('SHOULD: estimate, acceptance and consent integrity', () => {
  it('an estimate whose gross is not the sum of its lines is refused at commit', async () => {
    const p = await createPatient(h, 'Synthetic Gross Sum');
    const pl = await acceptedPlan(p);
    const id = randomUUID();
    expect(
      await commit([
        [
          `INSERT INTO cuspatlas.clinical_estimates (id, tenant_id, plan_version_id, number, currency, gross_minor, complete,
             coverage_status, created_by)
           VALUES ($1, cuspatlas.current_tenant_id(), $2, 1, 'USD', 1, true, 'unknown', cuspatlas.current_actor_id())`,
          [id, pl.versionRef],
        ],
        [
          `INSERT INTO cuspatlas.clinical_estimate_lines (tenant_id, estimate_id, plan_version_id, item_id, fee_schedule_ref,
             fee_currency, fee_minor)
           VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, 'synthetic-fee-701', 'USD', 10000)`,
          [id, pl.versionRef, pl.mouthItem],
        ],
      ]),
    ).toBe('42501');
  });

  it('a service principal cannot author an estimate row directly', async () => {
    const p = await createPatient(h, 'Synthetic Service Estimate');
    const pl = await acceptedPlan(p, false);
    expect(
      await commit(
        [
          [
            `INSERT INTO cuspatlas.clinical_estimates (tenant_id, plan_version_id, number, complete, coverage_status,
               created_by)
             VALUES (cuspatlas.current_tenant_id(), $1, 1, false, 'unknown', cuspatlas.current_actor_id())`,
            [pl.versionRef],
          ],
        ],
        SVC_A1,
      ),
    ).toBe('42501');
  });

  it('a procedure consent for one item does not bind the whole plan version', async () => {
    const p = await createPatient(h, 'Synthetic Item Consent');
    const pl = await acceptedPlan(p);
    h.ok(
      await capture(
        consentBody(p, { scope: 'procedure', planVersionRef: pl.versionRef, planItemRef: pl.toothItem }),
      ),
      201,
    );
    const est = h.ok<{ data: { estimateRef: string } }>(
      await generate(pl.versionRef, {
        lines: [pl.mouthItem, pl.toothItem].map((planItemRef) => ({ planItemRef, fee: USD(10_000) })),
      }),
      201,
    ).data;
    h.ok(await present(est.estimateRef));
    const accepted = h.ok<{ data: { acceptance: { consent: { status: string } } } }>(
      await accept(est.estimateRef, await revision(pl.planRef, pl.versionRef)),
      201,
    ).data;
    expect(accepted.acceptance.consent.status).toBe('outstanding');
  });

  it('a consent row naming another patient’s plan version is refused by the database', async () => {
    const p = await createPatient(h, 'Synthetic Consent Subject');
    const other = await createPatient(h, 'Synthetic Consent Other');
    const pl = await acceptedPlan(p);
    const otherPlan = await newPlan(other);
    const c = h.ok<{ data: { consentRef: string } }>(
      await capture(consentBody(p, { scope: 'treatment_plan', planVersionRef: pl.versionRef })),
      201,
    ).data;
    expect(
      await commit([
        [
          `INSERT INTO cuspatlas.clinical_consents (tenant_id, subject_patient_id, origin_patient_id, scope, plan_version_id,
             method, template_ref, template_digest, attestation_code, signer_kind, signer_patient_id, signer_basis,
             authority_evaluated_at, recorded_by)
           SELECT tenant_id, subject_patient_id, origin_patient_id, scope, $2, method, template_ref, template_digest,
             attestation_code, signer_kind, signer_patient_id, signer_basis, authority_evaluated_at, recorded_by
           FROM cuspatlas.clinical_consents WHERE id = $1`,
          [c.consentRef, otherPlan.headVersionRef],
        ],
      ]),
    ).toBe('42501');
  });

  it('a withdrawal signed as the patient names the consent’s own patient', async () => {
    const p = await createPatient(h, 'Synthetic Withdrawal Signer');
    const other = await createPatient(h, 'Synthetic Withdrawal Other');
    const c = h.ok<{ data: { consentRef: string } }>(await capture(consentBody(p)), 201).data;
    expect(
      await commit([
        [
          `INSERT INTO cuspatlas.clinical_consent_withdrawals (tenant_id, consent_id, reason_code, signer_kind,
             signer_patient_id, signer_basis, recorded_by)
           VALUES (cuspatlas.current_tenant_id(), $1, 'patient_request', 'patient', $2, 'self_adult',
             cuspatlas.current_actor_id())`,
          [c.consentRef, other],
        ],
      ]),
    ).toBe('42501');
  });

  it('a witness is a human member of the practice', async () => {
    const p = await createPatient(h, 'Synthetic Witness');
    const viaService = await capture(
      consentBody(p, { method: 'verbal_attested', attestationCode: 'verbal_attested', witnessRef: SVC_A1 }),
    );
    expect(reason(viaService)).toStrictEqual([422, 'witnessNotHumanMember']);
    const c = h.ok<{ data: { consentRef: string } }>(
      await capture(
        consentBody(p, {
          method: 'verbal_attested',
          attestationCode: 'verbal_attested',
          witnessRef: USER_A1,
        }),
      ),
      201,
    ).data;
    expect(
      await commit([
        [
          `INSERT INTO cuspatlas.clinical_consents (tenant_id, subject_patient_id, origin_patient_id, scope, method,
             template_ref, template_digest, attestation_code, signer_kind, signer_patient_id, signer_basis,
             authority_evaluated_at, witness_ref, recorded_by)
           SELECT tenant_id, subject_patient_id, origin_patient_id, scope, method, template_ref, template_digest,
             attestation_code, signer_kind, signer_patient_id, signer_basis, authority_evaluated_at, $2, recorded_by
           FROM cuspatlas.clinical_consents WHERE id = $1`,
          [c.consentRef, SVC_A1],
        ],
      ]),
    ).toBe('42501');
  });

  it('a method without a configured witness policy fails closed (witness required)', async () => {
    const p = await createPatient(h, 'Synthetic Unconfigured Method');
    const res = await capture(
      consentBody(p, {
        method: 'portal',
        attestationCode: 'signed_portal',
        evidence: { artifactRef: 'synthetic-evidence-1', digest: DIGEST },
      }),
    );
    expect(reason(res)).toStrictEqual([409, 'witness_required']);
  });

  it('C13 failure 2: a consent against a plan version superseded before presentation names the current version', async () => {
    const p = await createPatient(h, 'Synthetic Superseded Consent');
    const pl = await acceptedPlan(p);
    const sup = h.ok<{ data: { plan: { headVersionRef: string } } }>(
      await h.call('a1', 'POST', `${PLANS}/versions/${pl.versionRef}/supersede`, {
        expectedRevision: await revision(pl.planRef, pl.versionRef),
        reasonCode: 'treatment_changed',
      }),
      201,
    ).data;
    const res = await capture(consentBody(p, { scope: 'treatment_plan', planVersionRef: pl.versionRef }));
    expect(reason(res)).toStrictEqual([409, 'plan_version_superseded']);
    expect(res.json().detail.blockingRefs).toStrictEqual([
      { kind: 'planVersion', ref: sup.plan.headVersionRef },
    ]);
  });
});
