import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';
import { T_ALPHA, T_BETA, USER_A1 } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * E2: scoped portal views. Each view is an explicit allowlist projection with a redaction report; its
 * requirement is a relationship scope (never a portal-local scope name). Views whose producer is not
 * deployed (documents C15, balances B4, messages E5, forms E4) return an explicit `unavailable`
 * coverage, never an empty list. Cross-patient and cross-tenant reads are indistinguishable from a
 * missing record; revoked grants deny at read time; every data-returning read is sensitive-read logged.
 */
let db: TestDatabase;
let h: EngagementHarness;
let loc: { locationRef: string; provider: string; operatory: string };
const MINOR = { known: true, value: '2016-05-05', precision: 'day' };
const VIEWS = ['demographics', 'appointments', 'requests', 'documents', 'balances', 'messages', 'forms'];

let parent: string;
let child: string;
let guarantee: string;
let parentP: string;
let guardianRel: string;
let bookedRef: string;

beforeAll(async () => {
  db = await openTestDatabase('portal_views');
  h = await openEngagementHarness(db);
  loc = await seedLocation(h, 'loc-views');
  parent = await h.person(`Synthetic View Parent ${MARKER}`, [email('e2.parent')]);
  child = await h.person(`Synthetic View Child ${MARKER}`, [email('e2.child')], { birthDate: MINOR });
  guarantee = await h.person('Synthetic View Guarantee', []);
  const rel = await h.call('a1', 'POST', `/v1/patients/${child}/relationships`, {
    counterpartyRef: parent,
    kind: 'guardian',
    scopes: ['demographics', 'scheduling'],
  });
  guardianRel = h.ok<{ data: { relationshipRef: string } }>(rel, 201).data.relationshipRef;
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${guarantee}/relationships`, {
      counterpartyRef: parent,
      kind: 'guarantor',
      scopes: ['financial'],
    }),
    201,
  );
  parentP = await h.enroll(parent, { channel: 'email', value: 'e2.parent@example.invalid' });
  const booked = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/appointments', {
      patientRef: child,
      locationRef: loc.locationRef,
      startsAt: '2030-06-03T14:00:00Z',
      endsAt: '2030-06-03T15:00:00Z',
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  );
  bookedRef = booked.data.appointmentRef;
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type View = {
  view: string;
  patientRef: string;
  coverage: { status: string; reason?: string; owner?: string };
  fields: Record<string, unknown> | null;
  redacted: string[];
  projectionVersion: string;
  generatedAt: string;
};
const read = (principal: string, patientRef: string, view: string, q = '') =>
  h.portal(principal, 'GET', `/portal/v1/patients/${patientRef}/views/${view}${q}`);
const describeView = async (view: string) =>
  h.ok<{ data: { fields: string[]; itemFields: string[]; redactions: string[]; requiredScope: string[] } }>(
    await h.portal(parentP, 'GET', `/portal/v1/views/${view}`),
  ).data;
const attempts = async (res: { headers: Record<string, unknown> }) =>
  (
    await db.admin.query(
      'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [res.headers['x-correlation-id']],
    )
  ).rows.map((r) => r.reason_code);

describe('E2 acceptance', () => {
  it('each available view returns exactly its declared allowlist keys and a redaction report', async () => {
    for (const [patientRef, view] of [
      [parent, 'demographics'],
      [child, 'demographics'],
      [child, 'appointments'],
      [child, 'requests'],
    ] as const) {
      const v = h.ok<{ data: View }>(await read(parentP, patientRef, view)).data;
      const d = await describeView(view);
      expect(Object.keys(v).sort()).toStrictEqual(
        ['view', 'patientRef', 'coverage', 'fields', 'redacted', 'projectionVersion', 'generatedAt'].sort(),
      );
      expect(v.coverage).toStrictEqual({ status: 'available' });
      expect(Object.keys(v.fields ?? {}).sort()).toStrictEqual([...d.fields].sort());
      expect(v.redacted).toStrictEqual(d.redactions);
      for (const value of Object.values(v.fields ?? {})) {
        if (!Array.isArray(value)) continue;
        for (const item of value) expect(Object.keys(item).sort()).toStrictEqual([...d.itemFields].sort());
      }
      const raw = JSON.stringify(v);
      // Internal identifiers never appear: tenant, staff actors, provider and operatory resources.
      for (const internal of [T_ALPHA, USER_A1, loc.provider, loc.operatory])
        expect(raw).not.toContain(internal);
    }
    const appts = h.ok<{ data: View }>(await read(parentP, child, 'appointments')).data;
    expect(
      (appts.fields as { upcoming: { appointmentRef: string }[] }).upcoming.map((a) => a.appointmentRef),
    ).toStrictEqual([bookedRef]);
    // Another family member's records never appear in a view of this patient.
    const demo = JSON.stringify(h.ok<{ data: View }>(await read(parentP, child, 'demographics')).data);
    expect(demo).not.toContain('e2.parent');
  });

  it('views whose producer is not deployed are explicit unavailable states, never empty', async () => {
    for (const [view, owner] of [
      ['documents', 'C15'],
      ['messages', 'E5'],
      ['forms', 'E4'],
    ] as const) {
      const v = h.ok<{ data: View }>(await read(parentP, parent, view)).data;
      expect(v.coverage).toStrictEqual({ status: 'unavailable', reason: 'producer_not_deployed', owner });
      expect(v.fields).toBeNull();
    }
    // The guarantor relationship holds `financial`: balances is reachable and explicitly unavailable.
    const bal = h.ok<{ data: View }>(await read(parentP, guarantee, 'balances')).data;
    expect(bal.coverage).toStrictEqual({
      status: 'unavailable',
      reason: 'producer_not_deployed',
      owner: 'B4',
    });
  });

  it('a grant without the required scope is denied even when the view exists', async () => {
    for (const view of ['balances', 'documents', 'forms']) {
      const res = await read(parentP, child, view);
      expect([view, res.statusCode, res.json().detail?.reason]).toStrictEqual([
        view,
        403,
        'relationship_scope_missing',
      ]);
      expect(await attempts(res)).toStrictEqual(['relationship_scope_missing']);
    }
    // The guarantor relationship carries financial only: no demographics of the guaranteed patient.
    expect((await read(parentP, guarantee, 'demographics')).statusCode).toBe(403);
  });

  it('cross-patient, cross-tenant and random references are indistinguishable from a missing record', async () => {
    const unrelated = await h.person('Synthetic View Unrelated', []);
    const beta = h.ok<{ data: { patientRef: string } }>(
      await h.call('b1', 'POST', '/v1/patients', {
        legalName: { known: true, given: 'Synthetic', family: 'Beta' },
        birthDate: { known: true, value: '1990-01-01', precision: 'day' },
      }),
      201,
    ).data.patientRef;
    const shapes: string[] = [];
    for (const ref of [unrelated, beta, randomUUID()]) {
      for (const view of ['demographics', 'appointments']) {
        const res = await read(parentP, ref, view);
        const { correlationId: _c, ...body } = res.json();
        shapes.push(JSON.stringify([res.statusCode, body]));
      }
    }
    expect(new Set(shapes).size).toBe(1);
    expect(JSON.parse(shapes[0] as string)[0]).toBe(404);
    expect(T_BETA).not.toBe(T_ALPHA);
  });

  it('a revoked grant denies the view at read time', async () => {
    const p = await h.person('Synthetic View Revoker', [email('e2.revoker')]);
    const kid = await h.person('Synthetic View Kid', [], { birthDate: MINOR });
    const rel = h.ok<{ data: { relationshipRef: string } }>(
      await h.call('a1', 'POST', `/v1/patients/${kid}/relationships`, {
        counterpartyRef: p,
        kind: 'guardian',
        scopes: ['demographics'],
      }),
      201,
    ).data.relationshipRef;
    const principal = await h.enroll(p, { channel: 'email', value: 'e2.revoker@example.invalid' });
    h.ok(await read(principal, kid, 'demographics'));
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${kid}/relationships/${rel}/revoke`, {
        expectedVersion: 1,
        reasonCode: 'guardian_request',
      }),
    );
    const res = await read(principal, kid, 'demographics');
    expect([res.statusCode, res.json().detail?.reason]).toStrictEqual([403, 'relationship_revoked']);
    expect(await attempts(res)).toStrictEqual(['relationship_revoked']);
  });

  it('an empty producer result is an available empty list, distinct from unavailable', async () => {
    const v = h.ok<{ data: View }>(await read(parentP, parent, 'appointments')).data;
    expect(v.coverage).toStrictEqual({ status: 'available' });
    expect(v.fields).toStrictEqual({ upcoming: [] });
  });

  it('a minor reading their own record is denied until majority; unknown view and extra query are refused', async () => {
    const minorP = await h.enroll(child, { channel: 'email', value: 'e2.child@example.invalid' });
    const res = await read(minorP, child, 'demographics');
    expect([res.statusCode, res.json().detail?.reason]).toStrictEqual([403, 'self_below_majority']);
    expect((await read(parentP, parent, 'ledger')).statusCode).toBe(404);
    expect((await read(parentP, parent, 'demographics', '?fields=identifiers')).statusCode).toBe(400);
    for (const view of VIEWS) expect((await describeView(view)).requiredScope.length).toBeGreaterThan(0);
  });

  it('every data-returning read is sensitive-read logged with the portal principal; no marker leaks', async () => {
    const res = await read(parentP, child, 'demographics');
    h.ok(res);
    const { rows } = await db.admin.query(
      `SELECT actor_id, principal, operation, resource_type, resource_refs, query_fields
       FROM cuspatlas.sensitive_read_events WHERE correlation_id = $1`,
      [res.headers['x-correlation-id']],
    );
    expect(rows).toStrictEqual([
      {
        actor_id: parentP,
        principal: 'portal',
        operation: 'portal.views.read',
        resource_type: 'patient',
        resource_refs: [child],
        query_fields: ['view'],
      },
    ]);
    expect(guardianRel).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
    const audit = await db.admin.query(
      `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.sensitive_read_events t`,
    );
    expect(audit.rows[0].j).not.toContain(MARKER);
  });
});
