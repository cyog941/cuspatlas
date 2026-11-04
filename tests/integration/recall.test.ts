import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  openAppointmentHarness,
  seedLocation,
  setPatientStatus,
  T_ALPHA,
  USER_A1,
} from './support/appointment-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { actorFor, domainAppointments, envelope } from './support/domain-harness';
import { SCHED_READ } from './support/scheduling-fixtures';

/**
 * S16: recall policy (interval per practice and category, already-booked exclusion default on,
 * versioned) and a read-only due computation stating its policy version and freshness. The
 * bases are an attended visit (S11 attendance) and, since C14, a completed procedure read through the
 * C14 seam (that due list is also a clinical read). Producing the list creates no outreach; a contact task is a separate audited command that
 * records an intent with channel none. Synthetic visits are dated in 2030 because bookings refuse a
 * past start; every computation names an explicit as-of instant.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let north: { locationRef: string; provider: string; operatory: string };
const APPT = '/v1/scheduling/appointments';
const RECALL = '/v1/scheduling/recall';
const used = new Map<number, number>();

beforeAll(async () => {
  db = await openTestDatabase('recall');
  h = await openAppointmentHarness(db, { mcp: true });
  loc = await seedLocation(h, 'loc-recall');
  north = await seedLocation(h, 'loc-north');
  await seedClinicalScopes(db.admin);
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

/** Books a 2030 weekday visit in the month (0-based; default March), optionally recording arrival. */
async function visit(patient: string, o: { arrive?: boolean; month?: number; l?: typeof loc } = {}) {
  const month = o.month ?? 2;
  const n = used.get(month) ?? 0;
  used.set(month, n + 1);
  let date = Date.UTC(2030, month, 4);
  for (let k = Math.floor(n / 8); ; date += 86_400_000) {
    const wd = new Date(date).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    if (k === 0) break;
    k -= 1;
  }
  const hour = 13 + (n % 8);
  const at = (hh: number) => new Date(date + hh * 3_600_000).toISOString();
  const l = o.l ?? loc;
  const ref = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', APPT, {
      patientRef: patient,
      locationRef: l.locationRef,
      startsAt: at(hour),
      endsAt: at(hour + 1),
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: l.provider },
      operatory: { kind: 'operatory', resourceRef: l.operatory },
    }),
    201,
  ).data.appointmentRef;
  if (o.arrive !== false)
    h.ok(await h.call('a1', 'POST', `${APPT}/${ref}/attendance`, { kind: 'arrived' }), 201);
  return ref;
}

async function policy(category: string, body: Record<string, unknown> = {}) {
  return h.ok<{ data: { policyRef: string; version: number } }>(
    await h.call('a1', 'POST', `${RECALL}/policies`, {
      category,
      intervalMonths: 6,
      basis: 'attended_visit',
      ...body,
    }),
    201,
  ).data;
}

type Due = {
  asOf: string;
  policy: {
    policyRef: string;
    category: string;
    version: number;
    intervalMonths: number;
    excludeBooked: boolean;
  };
  freshness: { computedAt: string; basis: string; sourceAgeSeconds: number };
  due: { patientRef: string; dueDate: string; lastEventRef: string; exclusionNotApplied: string | null }[];
  excluded: { patientRef: string; reason: string }[];
  noBaseline: { patientRef: string }[];
  counts: { due: number; excluded: number; noBaseline: number };
};
async function due(category: string, asOf = '2030-10-01T12:00:00Z', who = 'a1', extra = '') {
  return h.call(who, 'GET', `${RECALL}/due?category=${category}&asOf=${encodeURIComponent(asOf)}${extra}`);
}
const dueData = async (category: string, asOf?: string) =>
  h.ok<{ data: Due }>(await due(category, asOf)).data;

describe('S16 acceptance', () => {
  it('1. an eligible patient is due; a patient with a future booking is excluded when the rule is on and reported when off', async () => {
    const a = await createPatient(h, 'Synthetic Recall Due');
    const b = await createPatient(h, 'Synthetic Recall Booked');
    const aVisit = await visit(a);
    await visit(b);
    const future = await visit(b, { arrive: false, month: 10 });
    await policy('hygiene');
    await policy('hygiene-open', { excludeBooked: false });
    const on = await dueData('hygiene');
    expect(on.due.find((d) => d.patientRef === a)).toMatchObject({
      lastEventRef: aVisit,
      exclusionNotApplied: null,
    });
    expect(on.due.find((d) => d.patientRef === a)?.dueDate).toMatch(/^2030-09-0[4-9]$/);
    expect(on.excluded.find((e) => e.patientRef === b)?.reason).toBe('already_booked');
    expect(on.due.map((d) => d.patientRef)).not.toContain(b);
    const off = await dueData('hygiene-open');
    expect(off.due.find((d) => d.patientRef === b)?.exclusionNotApplied).toBe('already_booked');
    expect(on.policy).toMatchObject({
      category: 'hygiene',
      version: 1,
      intervalMonths: 6,
      excludeBooked: true,
    });
    expect(future).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('2. a patient with no qualifying event is in the no-baseline group, never counted as overdue', async () => {
    const c = await createPatient(h, 'Synthetic Recall New');
    const missed = await createPatient(h, 'Synthetic Recall No Show');
    await visit(missed, { arrive: false });
    const d = await dueData('hygiene');
    expect(d.noBaseline.map((x) => x.patientRef)).toEqual(expect.arrayContaining([c, missed]));
    expect(d.due.map((x) => x.patientRef)).not.toContain(c);
    expect(d.counts.due).toBe(d.due.length);
  });

  it('3. computing twice for the same as-of instant and policy version returns identical rows', async () => {
    const first = await dueData('hygiene');
    const second = await dueData('hygiene');
    expect({ ...second, freshness: null }).toStrictEqual({ ...first, freshness: null });
    const m = await h.mcp('a1', 'scheduling_recall_due', {
      category: 'hygiene',
      asOf: '2030-10-01T12:00:00Z',
    });
    expect({ ...(m.body as { data: Due }).data, freshness: null }).toStrictEqual({
      ...first,
      freshness: null,
    });
  });

  it('4. producing the list writes nothing; a contact task is an explicit, audited command with a channel-none intent', async () => {
    const tables = [
      'recall_tasks',
      'notification_intents',
      'appointments',
      'audit_events',
      'outbox_events',
      'command_idempotency',
    ];
    const before = await Promise.all(tables.map((t) => count(db, t)));
    await dueData('hygiene');
    expect(await Promise.all(tables.map((t) => count(db, t)))).toStrictEqual(before);
    const p = await createPatient(h, 'Synthetic Recall Task');
    await visit(p);
    const task = h.ok<{
      data: { recallTaskRef: string; created: boolean; policyVersion: number; intentRef: string };
    }>(
      await h.call('a1', 'POST', `${RECALL}/tasks`, {
        patientRef: p,
        category: 'hygiene',
        locationRef: loc.locationRef,
        expectedPolicyVersion: 1,
        asOf: '2030-10-01T12:00:00Z',
      }),
      201,
    ).data;
    expect([task.created, task.policyVersion]).toStrictEqual([true, 1]);
    const intent = h.ok<{ data: { purpose: string; channel: string } }>(
      await h.call('a1', 'GET', `/v1/scheduling/notifications/${task.intentRef}`),
    ).data;
    expect(intent).toMatchObject({ purpose: 'recall', channel: 'none' });
    const audit = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.audit_events WHERE resource_type = 'recallTask' AND resource_ref = $1`,
      [task.recallTaskRef],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('5. a location-restricted user cannot enumerate another location; another tenant is denied', async () => {
    const restricted = await due('hygiene', '2030-10-01T12:00:00Z', 'a3', `&locationRef=${loc.locationRef}`);
    expect([restricted.statusCode, restricted.json().code]).toStrictEqual([403, 'forbidden']);
    const own = h.ok<{ data: Due }>(await due('hygiene', '2030-10-01T12:00:00Z', 'a3')).data;
    // a3 sees only patients with visits at loc-north (none here): no loc-recall patient appears.
    expect(own.due).toStrictEqual([]);
    const foreign = await due('hygiene', '2030-10-01T12:00:00Z', 'b1');
    expect([foreign.statusCode, foreign.json().code]).toStrictEqual([404, 'not_found']);
  });

  it('6. a deceased or inactive patient is excluded with the patient state named', async () => {
    const d = await createPatient(h, 'Synthetic Recall Deceased');
    const i = await createPatient(h, 'Synthetic Recall Inactive');
    await visit(d);
    await visit(i);
    await setPatientStatus(h, d, 'deceased');
    await setPatientStatus(h, i, 'inactive');
    const list = await dueData('hygiene');
    const reasons = Object.fromEntries(list.excluded.map((e) => [e.patientRef, e.reason]));
    expect([reasons[d], reasons[i]]).toStrictEqual(['patient_deceased', 'patient_inactive']);
  });

  it('patient status reasons and the no-baseline patient list need patients.read; others get counts only', async () => {
    const dead = await createPatient(h, 'Synthetic Recall Hidden Deceased');
    const idle = await createPatient(h, 'Synthetic Recall Hidden Inactive');
    const fresh = await createPatient(h, 'Synthetic Recall Hidden Baseline');
    await visit(dead);
    await visit(idle);
    await setPatientStatus(h, dead, 'deceased');
    await setPatientStatus(h, idle, 'inactive');
    const scheduler = randomUUID();
    await db.admin.query(
      `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', 'user-scheduler-only')`,
      [scheduler],
    );
    await db.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, ARRAY['scheduling.read'])`,
      [T_ALPHA, scheduler],
    );
    const token = await h.issuer.issue({ sub: scheduler, tid: T_ALPHA });
    const full = await dueData('hygiene');
    expect(full.noBaseline.map((x) => x.patientRef)).toContain(fresh);
    const limited = h.ok<{ data: Due }>(await due('hygiene', '2030-10-01T12:00:00Z', token)).data;
    const named = JSON.stringify([limited.excluded, limited.noBaseline]);
    for (const id of [dead, idle, fresh]) expect(named).not.toContain(id);
    expect(named).not.toMatch(/patient_deceased|patient_inactive/);
    // The counts still say how many were left out of the lists.
    expect(limited.counts.noBaseline).toBe(full.counts.noBaseline);
    expect(limited.counts.excluded).toBe(full.counts.excluded);
    expect(limited.noBaseline).toStrictEqual([]);
  });

  it('the completion basis needs qualifying codes and the deployed C14 seam (no substitute basis is invented)', async () => {
    const res = await h.call('a1', 'POST', `${RECALL}/policies`, {
      category: 'perio',
      intervalMonths: 3,
      basis: 'completed_procedure',
    });
    expect([res.statusCode, res.json().detail?.violations?.[0]]).toStrictEqual([
      422,
      { pointer: '/procedureCodeRefs', rule: 'required' },
    ]);
    // Without the C14 seam (a domain service built without it) the basis is refused, typed.
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    await expect(
      domainAppointments(db).defineRecallPolicy(
        a1,
        envelope('scheduling.recall.definePolicy', {
          category: 'perio',
          intervalMonths: 3,
          basis: 'completed_procedure',
          procedureCodeRefs: ['SYN-PROC-RCL'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'basis_unavailable' } });
  });
});

describe('S16 failure and recovery', () => {
  it('1. a policy change yields a new version and a different list; the earlier task keeps its version', async () => {
    const p = await createPatient(h, 'Synthetic Recall Version');
    await visit(p, { month: 5 });
    await policy('recheck', { intervalMonths: 12 });
    const v1 = await dueData('recheck');
    expect(v1.due.map((x) => x.patientRef)).not.toContain(p);
    const task = await h.call('a1', 'POST', `${RECALL}/tasks`, {
      patientRef: p,
      category: 'recheck',
      locationRef: loc.locationRef,
      expectedPolicyVersion: 1,
      asOf: '2031-08-01T12:00:00Z',
    });
    expect(task.statusCode).toBe(201);
    const v2 = await policy('recheck', { intervalMonths: 3 });
    expect(v2.version).toBe(2);
    const after = await dueData('recheck');
    expect(after.policy.version).toBe(2);
    expect(after.due.map((x) => x.patientRef)).toContain(p);
    const { rows } = await db.admin.query('SELECT policy_version FROM cuspatlas.recall_tasks WHERE id = $1', [
      task.json().data.recallTaskRef,
    ]);
    expect(rows[0].policy_version).toBe(1);
    const stale = await h.call('a1', 'POST', `${RECALL}/tasks`, {
      patientRef: p,
      category: 'recheck',
      locationRef: loc.locationRef,
      expectedPolicyVersion: 1,
      asOf: '2030-10-01T12:00:00Z',
    });
    expect([stale.statusCode, stale.json().code]).toStrictEqual([409, 'stale_version']);
  });

  it('2. the due list states its freshness basis and age rather than presenting itself as current without one', async () => {
    const d = await dueData('hygiene');
    expect(d.freshness.basis).toBe('computed_from_stored_state');
    expect(d.freshness.sourceAgeSeconds).toBe(0);
    expect(Date.parse(d.freshness.computedAt)).not.toBeNaN();
    expect(d.asOf).toBe('2030-10-01T12:00:00.000Z');
  });

  it('3. a task for a patient who books before outreach stays, is flagged, and is resolved with a reason', async () => {
    const p = await createPatient(h, 'Synthetic Recall Booker');
    await visit(p);
    const task = h.ok<{ data: { recallTaskRef: string } }>(
      await h.call('a1', 'POST', `${RECALL}/tasks`, {
        patientRef: p,
        category: 'hygiene',
        locationRef: loc.locationRef,
        expectedPolicyVersion: 1,
        asOf: '2030-10-01T12:00:00Z',
      }),
      201,
    ).data;
    await visit(p, { arrive: false, month: 10 });
    const work = h.ok<{
      data: { items: { workItemRef: string; reasonCode: string; suggestedNextAction: string }[] };
    }>(await h.call('a1', 'GET', '/v1/scheduling/follow-up/worklist')).data;
    expect(work.items.find((i) => i.workItemRef === task.recallTaskRef)).toMatchObject({
      reasonCode: 'patient_booked_since_task',
      suggestedNextAction: 'resolve_task',
    });
    const resolved = h.ok<{ data: { state: string } }>(
      await h.call('a1', 'POST', `${RECALL}/tasks/${task.recallTaskRef}/resolve`, {
        expectedVersion: 1,
        reasonCode: 'patient_booked',
      }),
    ).data;
    expect(resolved.state).toBe('resolved');
    const { rows } = await db.admin.query(
      'SELECT state, resolution_reason FROM cuspatlas.recall_tasks WHERE id = $1',
      [task.recallTaskRef],
    );
    expect(rows[0]).toStrictEqual({ state: 'resolved', resolution_reason: 'patient_booked' });
  });

  it('4. creating the same task twice for one patient and policy version returns the recorded task once', async () => {
    const p = await createPatient(h, 'Synthetic Recall Twice');
    await visit(p);
    const body = {
      patientRef: p,
      category: 'hygiene',
      locationRef: loc.locationRef,
      expectedPolicyVersion: 1,
      asOf: '2030-10-01T12:00:00Z',
    };
    const one = h.ok<{ data: { recallTaskRef: string; created: boolean } }>(
      await h.call('a1', 'POST', `${RECALL}/tasks`, body, randomUUID()),
      201,
    ).data;
    const two = h.ok<{ data: { recallTaskRef: string; created: boolean } }>(
      await h.call('a1', 'POST', `${RECALL}/tasks`, body, randomUUID()),
      201,
    ).data;
    expect(two).toStrictEqual({ ...one, created: false });
  });

  it('a patient who is not due cannot be given a recall task', async () => {
    const p = await createPatient(h, 'Synthetic Recall Recent');
    const res = await h.call('a1', 'POST', `${RECALL}/tasks`, {
      patientRef: p,
      category: 'hygiene',
      locationRef: loc.locationRef,
      expectedPolicyVersion: 1,
      asOf: '2030-10-01T12:00:00Z',
    });
    expect([res.statusCode, res.json().detail?.reason]).toStrictEqual([409, 'not_due']);
  });
});

describe('PT-03 follow-up worklist (S part: recall and unbooked requests)', () => {
  it('open requests and requests whose booking was lost are owned work items; C-owned areas are reported unavailable, not empty', async () => {
    const p = await createPatient(h, 'Synthetic Follow Up');
    const open = h.ok<{ data: { requestRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/appointment-requests', {
        patientRef: p,
        locationRef: loc.locationRef,
        sourceChannel: 'phone',
        contactConsent: 'unknown',
        flexibility: 'mornings',
      }),
      201,
    ).data.requestRef;
    const q = await createPatient(h, 'Synthetic Lost Booking');
    const req = h.ok<{ data: { requestRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/appointment-requests', {
        patientRef: q,
        locationRef: loc.locationRef,
        sourceChannel: 'phone',
        contactConsent: 'unknown',
        flexibility: 'mornings',
      }),
      201,
    ).data.requestRef;
    const booked = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', APPT, {
        patientRef: q,
        locationRef: loc.locationRef,
        requestRef: req,
        startsAt: '2030-12-02T15:00:00Z',
        endsAt: '2030-12-02T16:00:00Z',
        timeZone: 'America/New_York',
        provider: { kind: 'provider', resourceRef: loc.provider },
        operatory: { kind: 'operatory', resourceRef: loc.operatory },
      }),
      201,
    ).data.appointmentRef;
    h.ok(
      await h.call('a1', 'POST', `${APPT}/${booked}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    const work = h.ok<{
      data: {
        coverage: { status: string };
        notCovered: { area: string; owner: string; reason: string }[];
        items: { workItemRef: string; kind: string; reasonCode: string; evidenceRefs: { ref: string }[] }[];
      };
    }>(await h.call('a1', 'GET', '/v1/scheduling/follow-up/worklist')).data;
    expect(work.coverage).toStrictEqual({ status: 'available' });
    expect(work.items.find((i) => i.workItemRef === open)).toMatchObject({
      kind: 'request_unbooked',
      reasonCode: 'request_open_unbooked',
    });
    expect(work.items.find((i) => i.workItemRef === req)).toMatchObject({
      kind: 'request_booking_lost',
      reasonCode: 'linked_booking_cancelled',
    });
    expect(work.notCovered.map((n) => [n.area, n.owner])).toStrictEqual([
      ['accepted_unscheduled_treatment', 'C11'],
      ['lab_returns', 'C16'],
      ['referral_responses', 'C17'],
    ]);
    // Location restriction: a3 (loc-north) sees none of these loc-recall items.
    const a3 = h.ok<{ data: { items: { workItemRef: string }[] } }>(
      await h.call('a3', 'GET', '/v1/scheduling/follow-up/worklist'),
    ).data;
    expect(a3.items.map((i) => i.workItemRef)).not.toContain(open);
    expect(north.locationRef).toBe('loc-north');
  });
});

describe('S16 races on unique records (review hardening)', () => {
  it('concurrent task creation for one patient returns the one recorded open task, never a 500', async () => {
    await policy('race-task');
    const p = await createPatient(h, 'Synthetic Recall Racer');
    await visit(p);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.call('a1', 'POST', `${RECALL}/tasks`, {
          patientRef: p,
          category: 'race-task',
          locationRef: loc.locationRef,
          expectedPolicyVersion: 1,
          asOf: '2030-10-01T12:00:00Z',
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toStrictEqual(results.map(() => 201));
    const data = results.map((r) => r.json().data as { recallTaskRef: string; created: boolean });
    expect(new Set(data.map((d) => d.recallTaskRef)).size).toBe(1);
    expect(data.filter((d) => d.created)).toHaveLength(1);
  });

  it('concurrent policy definitions for one category are serialized or refused as a typed retryable 409, never a 500', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.call('a1', 'POST', `${RECALL}/policies`, {
          category: 'race-policy',
          intervalMonths: 6,
          basis: 'attended_visit',
        }),
      ),
    );
    for (const r of results) expect([201, 409]).toContain(r.statusCode);
    for (const r of results.filter((x) => x.statusCode === 409)) expect(r.json().retryable).toBe(true);
    const versions = results.filter((r) => r.statusCode === 201).map((r) => r.json().data.version as number);
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('S16 cases bound to C14', () => {
  const USER_FRONT_DESK = '20000000-0000-4000-8000-0000000000c7';
  let frontDesk: string;
  beforeAll(async () => {
    await db.admin.query(
      `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', 'user-recall-desk')`,
      [USER_FRONT_DESK],
    );
    await db.admin.query(
      'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)',
      [T_ALPHA, USER_FRONT_DESK, [SCHED_READ, 'scheduling.write']],
    );
    frontDesk = await h.issuer.issue({ sub: USER_FRONT_DESK, tid: T_ALPHA });
  });
  /** An encounter at the recall location with its treating provider, and one rendered procedure. */
  async function rendered(patientRef: string, codeRef: string, dateOfService: string) {
    const e = h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
      await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef, locationRef: loc.locationRef }),
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
    return h.ok<{ data: { procedureRef: string } }>(
      await h.call(
        'a1',
        'POST',
        `/v1/clinical/encounters/${e.encounterRef}/procedures`,
        { sequence: 1, dateOfService, renderingProviderRef: loc.provider, codeRef },
        randomUUID(),
      ),
      201,
    ).data.procedureRef;
  }

  it('C14: a completed-procedure basis computes the last qualifying procedure from C14 completion events', async () => {
    const category = 'perio-maint';
    const pol = h.ok<{ data: { policyRef: string; version: number } }>(
      await h.call('a1', 'POST', `${RECALL}/policies`, {
        category,
        intervalMonths: 6,
        basis: 'completed_procedure',
        procedureCodeRefs: ['SYN-PROC-RCL'],
      }),
      201,
    ).data;
    const due = await createPatient(h, 'Synthetic Recall Procedure');
    await rendered(due, 'SYN-PROC-RCL', '2025-12-01');
    const latest = await rendered(due, 'SYN-PROC-RCL', '2026-01-15');
    // Another code does not qualify; a reversed procedure does not count.
    const otherCode = await createPatient(h, 'Synthetic Recall Other Code');
    await rendered(otherCode, 'SYN-PROC-XYZ', '2026-01-15');
    const reversed = await createPatient(h, 'Synthetic Recall Reversed');
    const gone = await rendered(reversed, 'SYN-PROC-RCL', '2026-01-15');
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/procedures/${gone}/corrections`, {
        reasonCode: 'recorded_in_error',
      }),
      201,
    );
    const asOf = '2026-11-01T12:00:00Z';
    const list = h.ok<{
      data: {
        policy: { version: number; basis: string; procedureCodeRefs: string[] };
        due: { patientRef: string; lastEventRef: string; dueDate: string }[];
        noBaseline: { patientRef: string }[];
      };
    }>(await h.call('a1', 'GET', `${RECALL}/due?category=${category}&asOf=${encodeURIComponent(asOf)}`)).data;
    expect([list.policy.basis, list.policy.procedureCodeRefs]).toStrictEqual([
      'completed_procedure',
      ['SYN-PROC-RCL'],
    ]);
    expect(list.due.filter((d) => [due, otherCode, reversed].includes(d.patientRef))).toMatchObject([
      { patientRef: due, lastEventRef: latest, dueDate: '2026-07-15' },
    ]);
    const baseline = list.noBaseline.map((n) => n.patientRef);
    expect([baseline.includes(otherCode), baseline.includes(reversed)]).toStrictEqual([true, true]);
    // The due list is a clinical read as well: a scheduling-only member is refused (403), typed.
    const denied = await h.call(
      frontDesk,
      'GET',
      `${RECALL}/due?category=${category}&asOf=${encodeURIComponent(asOf)}`,
    );
    expect([denied.statusCode, denied.json().code]).toStrictEqual([403, 'forbidden']);
    // A contact task records the procedure it was computed from (not an appointment).
    const task = h.ok<{ data: { recallTaskRef: string } }>(
      await h.call('a1', 'POST', `${RECALL}/tasks`, {
        patientRef: due,
        category,
        locationRef: loc.locationRef,
        expectedPolicyVersion: pol.version,
        asOf,
      }),
      201,
    ).data;
    const row = await db.admin.query(
      'SELECT last_event_procedure_id, last_event_appointment_id FROM cuspatlas.recall_tasks WHERE id = $1',
      [task.recallTaskRef],
    );
    expect(row.rows).toStrictEqual([{ last_event_procedure_id: latest, last_event_appointment_id: null }]);
  });
});
