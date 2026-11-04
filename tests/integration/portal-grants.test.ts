import { randomUUID } from 'node:crypto';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAppointmentService, createAuthorize, executeOnce } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leakTables } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  type EngagementHarness,
  email,
  openEngagementHarness,
  synthPhone,
} from './support/engagement-fixtures';
import { T_ALPHA, T_BETA, USER_A1 } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * E1: portal principals and the grant projection. A portal principal is its own principal kind,
 * bound to exactly one person record (a patient-identity record of the tenant), authenticated by the
 * same EdDSA verifier under a distinct audience, and never a staff member. Authority over another
 * patient is a projection of S5 relationships evaluated in S5's single place, freshly per request.
 */
let db: TestDatabase;
let h: EngagementHarness;
const MINOR_BIRTH = { known: true, value: '2016-05-05', precision: 'day' };

beforeAll(async () => {
  db = await openTestDatabase('portal_grants');
  h = await openEngagementHarness(db, { mcp: true });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type Grant = {
  grantRef: string;
  relationshipRef: string;
  patientRef: string;
  kind: string;
  scope: string[];
  status: string;
  statusReason: string;
  effectiveUntil: string | null;
};
type Session = {
  principalRef: string;
  personRef: string;
  kind: string;
  assuranceLevel: string;
  self: { patientRef: string; status: string; reason: string };
  grants: Grant[];
  patients: { patientRef: string; via: string; scopes: string[] }[];
};
const session = async (principal: string) =>
  h.ok<{ data: Session }>(await h.portal(principal, 'GET', '/portal/v1/session')).data;
const attempts = async (correlationId: string | undefined) =>
  (
    await db.admin.query(
      'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [correlationId],
    )
  ).rows.map((r) => r.reason_code);

async function relate(subject: string, counterparty: string, kind: string, scopes: string[], extra = {}) {
  return h.ok<{ data: { relationshipRef: string } }>(
    await h.call('a1', 'POST', `/v1/patients/${subject}/relationships`, {
      counterpartyRef: counterparty,
      kind,
      scopes,
      ...extra,
    }),
    201,
  ).data.relationshipRef;
}

describe('E1 acceptance', () => {
  it('a verified principal is a portal principal bound to one person; its grants are S5 relationships', async () => {
    const parent = await h.person(`Synthetic Parent ${MARKER}`, [email('e1.parent')]);
    const child = await h.person('Synthetic Child', [], { birthDate: MINOR_BIRTH });
    const rel = await relate(child, parent, 'guardian', ['demographics', 'scheduling']);
    const principal = await h.enroll(parent, { channel: 'email', value: 'e1.parent@example.invalid' });
    const kind = await db.admin.query('SELECT kind FROM cuspatlas.principals WHERE id = $1', [principal]);
    expect(kind.rows).toStrictEqual([{ kind: 'portal' }]);
    const s = await session(principal);
    expect(s).toMatchObject({
      principalRef: principal,
      personRef: parent,
      assuranceLevel: 'unverified-synthetic',
      self: { patientRef: parent, status: 'active' },
    });
    expect(s.grants).toHaveLength(1);
    expect(s.grants[0]).toMatchObject({
      grantRef: rel,
      relationshipRef: rel,
      patientRef: child,
      kind: 'guardian',
      scope: ['demographics', 'scheduling'],
      status: 'active',
    });
    // Every grant resolves to exactly one S5 relationship of the staff view.
    const staff = h.ok<{ data: { relationshipRef: string }[] }>(
      await h.call('a1', 'GET', `/v1/patients/${child}/relationships`),
    ).data;
    expect(staff.filter((r) => r.relationshipRef === rel)).toHaveLength(1);
    const staffGrants = h.ok<{ data: { grants: Grant[] } }>(
      await h.call('a1', 'GET', `/v1/patients/${child}/portal-grants`),
    ).data.grants;
    expect(staffGrants.map((g) => g.relationshipRef)).toStrictEqual([rel]);
    expect(s.patients.map((p) => [p.patientRef, p.via]).sort()).toStrictEqual(
      [
        [parent, 'self'],
        [child, 'guardian'],
      ].sort(),
    );
    expect(h.logLines.join('\n')).not.toContain(MARKER);
    expect(await leakTables(db)).not.toContain(MARKER);
  });

  it('a principal whose contact is unverified is pending and grants nothing', async () => {
    const p = await h.person('Synthetic Pending', [email('e1.pending')]);
    const principal = await h.enroll(p, { channel: 'email', value: 'e1.pending@example.invalid' }, false);
    const res = await h.portal(principal, 'GET', '/portal/v1/session');
    expect([res.statusCode, res.json().code]).toStrictEqual([403, 'forbidden']);
    expect(await attempts(res.headers['x-correlation-id'] as string)).toStrictEqual([
      'portal_contact_unverified',
    ]);
  });

  it('a shared household contact matching two patients produces no principal and an explicit ambiguity', async () => {
    const a = await h.person('Synthetic Household', [synthPhone('11')]);
    await h.person('Synthetic Household Other', [synthPhone('11')]);
    const before = await db.admin.query(
      "SELECT count(*)::int AS n FROM cuspatlas.principals WHERE kind = 'portal'",
    );
    const res = await h.call('a1', 'POST', '/v1/portal/principals', {
      personRef: a,
      contact: { channel: 'phone', value: '+1-202-555-0111' },
    });
    expect([res.statusCode, res.json().detail?.reason]).toStrictEqual([409, 'shared_contact_ambiguous']);
    const after = await db.admin.query(
      "SELECT count(*)::int AS n FROM cuspatlas.principals WHERE kind = 'portal'",
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    // A contact that is not on the person's own record is refused, never matched elsewhere.
    const other = await h.call('a1', 'POST', '/v1/portal/principals', {
      personRef: a,
      contact: { channel: 'email', value: 'not.on.record@example.invalid' },
    });
    expect([other.statusCode, other.json().detail?.violations?.[0]?.rule]).toStrictEqual([
      422,
      'contactNotOnRecord',
    ]);
  });

  it('a grant cannot be widened by a request parameter and two grants do not multiply access', async () => {
    const parent = await h.person('Synthetic Widen', [email('e1.widen')]);
    const child = await h.person('Synthetic Widen Child', [], { birthDate: MINOR_BIRTH });
    await relate(child, parent, 'guardian', ['scheduling']);
    await relate(child, parent, 'proxy', ['demographics'], {
      effectiveUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const principal = await h.enroll(parent, { channel: 'email', value: 'e1.widen@example.invalid' });
    const res = await h.portal(principal, 'GET', `/portal/v1/session?patientRef=${child}&scope=financial`);
    expect(res.statusCode).toBe(400);
    const s = await session(principal);
    expect(s.grants).toHaveLength(2);
    const childAccess = s.patients.filter((p) => p.patientRef === child);
    expect(childAccess).toHaveLength(1);
    expect(childAccess[0]?.scopes).toStrictEqual(['demographics', 'scheduling']);
  });

  it('a guardian grant ends at the minor’s age of majority without deleting anything; the minor then has self access', async () => {
    const parent = await h.person('Synthetic Majority Parent', [email('e1.majority.parent')]);
    const minor = await h.person('Synthetic Majority Minor', [email('e1.majority.minor')], {
      birthDate: MINOR_BIRTH,
    });
    const rel = await relate(minor, parent, 'guardian', ['scheduling']);
    const parentP = await h.enroll(parent, { channel: 'email', value: 'e1.majority.parent@example.invalid' });
    const minorP = await h.enroll(minor, { channel: 'email', value: 'e1.majority.minor@example.invalid' });
    expect((await session(minorP)).self).toMatchObject({ status: 'denied', reason: 'self_below_majority' });
    expect((await session(parentP)).grants[0]?.status).toBe('active');
    // The tenant's age of majority (S5 policy, evaluated in S5's single place) is lowered.
    await db.admin.query(
      `INSERT INTO cuspatlas.patient_policy_settings (tenant_id, age_of_majority_years) VALUES ($1, 5)
       ON CONFLICT (tenant_id) DO UPDATE SET age_of_majority_years = 5`,
      [T_ALPHA],
    );
    try {
      const g = (await session(parentP)).grants[0];
      expect(g).toMatchObject({
        relationshipRef: rel,
        status: 'expired',
        statusReason: 'age_of_majority_reached',
      });
      expect((await session(parentP)).patients.map((p) => p.patientRef)).not.toContain(minor);
      expect((await session(minorP)).self).toMatchObject({ status: 'active' });
      const kept = await db.admin.query(
        'SELECT (SELECT count(*)::int FROM cuspatlas.patient_relationships WHERE id = $1) AS r, (SELECT count(*)::int FROM cuspatlas.patients WHERE id = $2) AS p',
        [rel, minor],
      );
      expect(kept.rows[0]).toStrictEqual({ r: 1, p: 1 });
    } finally {
      await db.admin.query(
        'UPDATE cuspatlas.patient_policy_settings SET age_of_majority_years = 18 WHERE tenant_id = $1',
        [T_ALPHA],
      );
    }
  });

  it('an expired proxy and a revoked guardian are shown as such and grant nothing; history is kept', async () => {
    const holder = await h.person('Synthetic Proxy Holder', [email('e1.proxy')]);
    const subjectA = await h.person('Synthetic Proxy Subject', []);
    const subjectB = await h.person('Synthetic Guardian Subject', [], { birthDate: MINOR_BIRTH });
    const proxy = await relate(subjectA, holder, 'proxy', ['demographics'], {
      effectiveUntil: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const guardian = await relate(subjectB, holder, 'guardian', ['scheduling']);
    const principal = await h.enroll(holder, { channel: 'email', value: 'e1.proxy@example.invalid' });
    expect((await session(principal)).patients.map((p) => p.patientRef)).toContain(subjectA);
    // Elapsed time simulated through the superuser (the window ended); version bump as S5 requires.
    await db.admin.query(
      `UPDATE cuspatlas.patient_relationships SET effective_from = now() - interval '2 days',
         effective_until = now() - interval '1 hour', version = version + 1 WHERE id = $1`,
      [proxy],
    );
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${subjectB}/relationships/${guardian}/revoke`, {
        expectedVersion: 1,
        reasonCode: 'guardian_request',
      }),
    );
    const s = await session(principal);
    const byRef = new Map(s.grants.map((g) => [g.relationshipRef, g]));
    expect(byRef.get(proxy)).toMatchObject({ status: 'expired', statusReason: 'window_ended' });
    expect(byRef.get(guardian)).toMatchObject({ status: 'revoked' });
    expect(s.patients.map((p) => p.patientRef)).toStrictEqual([holder]);
    const rows = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.patient_relationships WHERE id = ANY ($1::uuid[])',
      [[proxy, guardian]],
    );
    expect(rows.rows[0].n).toBe(2);
  });

  it('revoking a principal denies its existing session at the next request', async () => {
    const p = await h.person('Synthetic Revoked Principal', [email('e1.revoked')]);
    const principal = await h.enroll(p, { channel: 'email', value: 'e1.revoked@example.invalid' });
    await session(principal);
    h.ok(
      await h.call('a1', 'POST', `/v1/portal/principals/${principal}/revoke`, {
        expectedVersion: 2,
        reasonCode: 'patient_request',
      }),
    );
    const res = await h.portal(principal, 'GET', '/portal/v1/session');
    expect([res.statusCode, res.json().code]).toStrictEqual([403, 'forbidden']);
    expect(await attempts(res.headers['x-correlation-id'] as string)).toStrictEqual(['membership_inactive']);
    const read = h.ok<{ data: { state: string; proofingLevel: string } }>(
      await h.call('a1', 'GET', `/v1/portal/principals/${principal}`),
    ).data;
    expect(read).toMatchObject({ state: 'revoked', proofingLevel: 'unverified-synthetic' });
  });
});

describe('E1 isolation and cross-transport', () => {
  it('a principal of tenant alpha cannot be resolved with a tenant beta token, nor seen by beta staff', async () => {
    const p = await h.person('Synthetic Tenant Bound', [email('e1.tenant')]);
    const principal = await h.enroll(p, { channel: 'email', value: 'e1.tenant@example.invalid' });
    const res = await h.portal(principal, 'GET', '/portal/v1/session', undefined, null, T_BETA);
    expect(res.statusCode).toBe(403);
    const missing = await h.portal(randomUUID(), 'GET', '/portal/v1/session');
    expect([missing.statusCode, missing.json().code]).toStrictEqual([res.statusCode, res.json().code]);
    const staff = await h.call('b1', 'GET', `/v1/portal/principals/${principal}`);
    const random = await h.call('b1', 'GET', `/v1/portal/principals/${randomUUID()}`);
    expect([staff.statusCode, staff.json().code]).toStrictEqual([404, 'not_found']);
    expect(random.statusCode).toBe(404);
    const grants = await h.call('b1', 'GET', `/v1/patients/${p}/portal-grants`);
    expect(grants.statusCode).toBe(404);
  });

  it('a portal token cannot reach a staff route or MCP; a staff token cannot reach the portal', async () => {
    const p = await h.person('Synthetic Transport', [email('e1.transport')]);
    const principal = await h.enroll(p, { channel: 'email', value: 'e1.transport@example.invalid' });
    const portalToken = await h.portalToken(principal);
    for (const url of ['/v1/session', `/v1/patients/${p}`, '/v1/scheduling/locations']) {
      const r = await h.call(portalToken, 'GET', url);
      expect([url, r.statusCode, r.json().code]).toStrictEqual([url, 401, 'unauthenticated']);
    }
    const staff = await h.portal(h.tokens.a1 as string, 'GET', '/portal/v1/session');
    expect([staff.statusCode, staff.json().code]).toStrictEqual([401, 'unauthenticated']);
    // A portal-audience token whose subject is a staff member is refused: staff are never portal principals.
    const minted = await h.issuer.issue({
      sub: USER_A1,
      tid: T_ALPHA,
      audience: 'urn:cuspatlas:portal:synthetic',
    });
    const asPortal = await h.portal(minted, 'GET', '/portal/v1/session');
    expect([asPortal.statusCode, asPortal.json().code]).toStrictEqual([403, 'forbidden']);
    expect(await attempts(asPortal.headers['x-correlation-id'] as string)).toStrictEqual([
      'principal_kind_denied',
    ]);
    // A staff-audience token minted for a portal principal finds no membership.
    const misissued = await h.issuer.issue({ sub: principal, tid: T_ALPHA });
    const r = await h.call(misissued, 'GET', '/v1/session');
    expect([r.statusCode, r.json().code]).toStrictEqual([403, 'forbidden']);
  });

  it('the database refuses a staff membership for a portal principal; a portal context is denied by staff policy', async () => {
    const p = await h.person('Synthetic No Membership', [email('e1.nomember')]);
    const principal = await h.enroll(p, { channel: 'email', value: 'e1.nomember@example.invalid' });
    let code = 'none';
    try {
      await db.admin.query(
        `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, ARRAY['patients.read'])`,
        [T_ALPHA, principal],
      );
    } catch (err) {
      code = (err as { code?: string }).code ?? 'unknown';
    }
    expect(code).toBe('42501');
    const svc = createAppointmentService({
      authorize: createAuthorize(createMembershipSource(db.app)),
      withTenantTransaction: createTenantTransactionRunner(db.app),
      recording: { sink: createSecurityAttemptSink(db.sink), alert: () => undefined },
      execute: executeOnce,
    });
    const ctx = {
      tenantId: T_ALPHA,
      actorId: principal,
      principal: 'portal' as const,
      sessionId: randomUUID(),
      scopes: ['scheduling.read'],
      correlationId: randomUUID(),
    };
    await expect(svc.listRequests(ctx, {})).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('one live principal per person; enrollment of a merged or unknown person is refused', async () => {
    const p = await h.person('Synthetic Single', [email('e1.single')]);
    await h.enroll(p, { channel: 'email', value: 'e1.single@example.invalid' }, false);
    const again = await h.call('a1', 'POST', '/v1/portal/principals', {
      personRef: p,
      contact: { channel: 'email', value: 'e1.single@example.invalid' },
    });
    expect([again.statusCode, again.json().detail?.reason]).toStrictEqual([409, 'portal_principal_exists']);
    const unknown = await h.call('a1', 'POST', '/v1/portal/principals', {
      personRef: randomUUID(),
      contact: { channel: 'email', value: 'e1.single@example.invalid' },
    });
    expect(unknown.statusCode).toBe(404);
    const tenantField = await h.call('a1', 'POST', '/v1/portal/principals', {
      personRef: p,
      contact: { channel: 'email', value: 'e1.single@example.invalid' },
      tenantId: T_BETA,
    });
    expect(tenantField.statusCode).toBe(400);
    // MCP is the same command (staff side), with the same refusal.
    const m = await h.mcp('a1', 'portal_principals_enroll', {
      personRef: p,
      contact: { channel: 'email', value: 'e1.single@example.invalid' },
      idempotencyKey: randomUUID(),
    });
    expect([m.status, (m.body.detail as { reason?: string })?.reason]).toStrictEqual([
      409,
      'portal_principal_exists',
    ]);
  });
});
