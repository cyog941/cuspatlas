import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  openAppointmentHarness,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { SVC_A1, T_ALPHA, USER_A1, USER_A2, USER_A3, USER_A4, USER_B1 } from './support/fixtures';

/**
 * A17: audit search (bounded, filtered, privileged, itself audited, read only), access review and
 * membership revocation through the domain path; human only. Synthetic data only, runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
type Json = Record<string, any>;
const AUDIT = '/v1/admin/audit';

const snapshot = async () => {
  const out: Record<string, string> = {};
  for (const t of ['audit_events', 'security_attempt_events', 'memberships']) {
    const { rows } = await db.admin.query(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM cuspatlas.${t} t`,
    );
    out[t] = rows[0].d;
  }
  return out;
};

beforeAll(async () => {
  db = await openTestDatabase('administration');
  h = await openAppointmentHarness(db, { mcp: true });
  await db.admin.query(
    'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = ANY ($1::uuid[])',
    [
      [USER_A1, SVC_A1, USER_B1],
      ['audit.read', 'access.manage'],
    ],
  );
  const audited = await createPatient(h, 'Audited'); // a committed change
  h.ok(await h.call('a1', 'GET', `/v1/patients/${audited}`)); // a sensitive read
  await h.call('b1', 'POST', '/v1/patients', {
    legalName: { known: true, given: 'Beta', family: 'Synthetic' },
  });
  await h.call('a4', 'POST', '/v1/patients', {
    legalName: { known: true, given: 'Denied', family: 'Synthetic' },
  }); // attempt
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('A17 audit search', () => {
  it('returns committed changes, attempts and sensitive reads of the tenant only, newest first', async () => {
    const r = h.ok<{ data: Json[]; envelope: Json }>(await h.call('a1', 'GET', AUDIT));
    const sources = new Set(r.data.map((d) => d.source));
    expect(sources).toEqual(new Set(['committed_change', 'security_attempt', 'sensitive_read']));
    expect(r.data.some((d) => d.actorRef === USER_B1)).toBe(false);
    const times = r.data.map((d) => d.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(r.envelope).toMatchObject({
      ordering: { key: 'occurredAt', direction: 'desc' },
      scope: { kind: 'tenant_wide' },
    });
    const attempts = h.ok<{ data: Json[] }>(
      await h.call('a1', 'GET', `${AUDIT}?source=security_attempt&actorRef=${USER_A4}`),
    ).data;
    expect(attempts.length).toBeGreaterThan(0);
    expect(
      attempts.every((a) => a.source === 'security_attempt' && a.actorRef === USER_A4 && a.reasonCode),
    ).toBe(true);
    const bounded = h.ok<{ data: Json[]; envelope: Json }>(await h.call('a1', 'GET', `${AUDIT}?limit=1`));
    expect(bounded.data).toHaveLength(1);
    expect(bounded.envelope).toMatchObject({ truncated: true, count: { atLeast: 1 } });
    expect((await h.call('a1', 'GET', `${AUDIT}?limit=500`)).statusCode).toBe(422);
  });

  it('is read only and records itself; source rows stay byte-identical', async () => {
    const before = await snapshot();
    const reads = (
      await db.admin.query(
        `SELECT count(*)::int AS n FROM cuspatlas.sensitive_read_events WHERE operation = 'admin.audit.search'`,
      )
    ).rows[0].n;
    h.ok(await h.call('a1', 'GET', `${AUDIT}?source=committed_change`));
    expect(await snapshot()).toEqual(before);
    const after = (
      await db.admin.query(
        `SELECT count(*)::int AS n FROM cuspatlas.sensitive_read_events WHERE operation = 'admin.audit.search'`,
      )
    ).rows[0].n;
    expect(after).toBe(reads + 1);
  });

  it('refuses without audit.read, records the attempt, and admits no agent', async () => {
    const before = (
      await db.admin.query(
        `SELECT count(*)::int AS n FROM cuspatlas.security_attempt_events WHERE operation = 'admin.audit.search'`,
      )
    ).rows[0].n;
    expect((await h.call('a4', 'GET', AUDIT)).statusCode).toBe(403);
    const after = (
      await db.admin.query(
        `SELECT count(*)::int AS n FROM cuspatlas.security_attempt_events WHERE operation = 'admin.audit.search'`,
      )
    ).rows[0].n;
    expect(after).toBe(before + 1);
    // A service (agent) principal holding audit.read and access.manage is still refused on both surfaces.
    expect((await h.call('svcA1', 'GET', AUDIT)).statusCode).toBe(403);
    expect((await h.mcp('svcA1', 'admin_audit_search', {})).status).toBe(403);
    expect(
      (
        await h.mcp('svcA1', 'admin_access_revoke', {
          principalRef: USER_A3,
          reasonCode: 'left_practice',
          idempotencyKey: 'synthetic-key-0001',
        })
      ).status,
    ).toBe(403);
    // Another tenant's search never shows alpha rows.
    const beta = h.ok<{ data: Json[] }>(await h.call('b1', 'GET', AUDIT)).data;
    expect(beta.every((d) => d.actorRef === null || d.actorRef === USER_B1)).toBe(true);
  });

  it('the runtime role still cannot read audit rows directly', async () => {
    const c = await db.app.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)`,
        [T_ALPHA, USER_A1],
      );
      // Other members' memberships stay unreadable; the attempt log has no runtime-role SELECT at all.
      // (audit_events and sensitive_read_events: no runtime SELECT since 20261202500000, tested below.)
      expect((await c.query('SELECT principal_id FROM cuspatlas.memberships')).rows).toEqual([
        { principal_id: USER_A1 },
      ]);
      await c.query('SAVEPOINT s');
      const attempts = await c.query('SELECT * FROM cuspatlas.security_attempt_events').then(
        (r) => r.rows,
        () => 'denied',
      );
      expect(attempts === 'denied' || (Array.isArray(attempts) && attempts.length === 0)).toBe(true);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});

describe('A17 access review and revocation', () => {
  it('lists memberships with scopes, locations, revocation and last activity, and other principal classes', async () => {
    const res = await h.call('a1', 'GET', '/v1/admin/access-review');
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json() as { data: Json };
    const by = new Map(r.data.memberships.map((m: Json) => [m.principalRef, m]));
    expect(by.get(USER_A1)).toMatchObject({
      kind: 'human',
      active: true,
      lastActivityAt: expect.any(String),
    });
    expect(by.get(USER_A2)).toMatchObject({ active: false, revokedAt: expect.any(String) });
    expect(by.get(USER_A3)).toMatchObject({ locationRefs: ['loc-north'] });
    expect(by.get(SVC_A1)).toMatchObject({ kind: 'service', sponsor: { status: 'unavailable' } });
    expect(by.has(USER_B1)).toBe(false);
    expect(r.data.portalPrincipals).toEqual([]);
    expect(r.data.devices).toEqual([]);
    expect((await h.call('a4', 'GET', '/v1/admin/access-review')).statusCode).toBe(403);
  });

  it('revokes a human and a service membership; the principal is refused on REST and MCP next call', async () => {
    expect((await h.call('a4', 'GET', '/v1/session')).statusCode).toBe(200);
    const r = await h.call('a1', 'POST', '/v1/admin/access/revocations', {
      principalRef: USER_A4,
      reasonCode: 'left_practice',
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().data).toMatchObject({ membership: 'revoked', sessions: 'refused_on_next_request' });
    expect((await h.call('a4', 'GET', '/v1/session')).statusCode).toBe(403);
    await expect(h.mcp('a4', 'vocabularies_list', {})).rejects.toThrow(/forbidden/);
    expect(
      (
        await h.call('a1', 'POST', '/v1/admin/access/revocations', {
          principalRef: USER_A4,
          reasonCode: 'left_practice',
        })
      ).statusCode,
    ).toBe(409);
    const svc = await h.call('a1', 'POST', '/v1/admin/access/revocations', {
      principalRef: SVC_A1,
      reasonCode: 'agent_retired',
    });
    expect(svc.statusCode).toBe(201);
    expect((await h.call('svcA1', 'GET', '/v1/session')).statusCode).toBe(403);
    const audit = h.ok<{ data: Json[] }>(
      await h.call('a1', 'GET', `${AUDIT}?operation=admin.access.revoke&source=committed_change`),
    ).data;
    expect(audit.map((a) => a.resourceRef).sort()).toEqual([SVC_A1, USER_A4].sort());
  });

  it('refuses self-revocation, unknown and other-tenant principals', async () => {
    expect(
      (
        await h.call('a1', 'POST', '/v1/admin/access/revocations', {
          principalRef: USER_A1,
          reasonCode: 'test',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await h.call('a1', 'POST', '/v1/admin/access/revocations', {
          principalRef: USER_B1,
          reasonCode: 'test',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.call('a1', 'POST', '/v1/admin/access/revocations', {
          principalRef: '20000000-0000-4000-8000-0000000000ee',
          reasonCode: 'test',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await db.admin.query('SELECT revoked_at FROM cuspatlas.memberships WHERE principal_id = $1', [
          USER_B1,
        ])
      ).rows[0].revoked_at,
    ).toBeNull();
  });
});

describe('A batch 3 hardening: audit and sensitive-read rows only through the definer search', () => {
  it('the runtime role holds no SELECT on audit_events or sensitive_read_events and cannot read them', async () => {
    const grants = await db.admin.query(
      `SELECT has_table_privilege('cuspatlas_app', 'cuspatlas.audit_events', 'SELECT') AS audit,
              has_table_privilege('cuspatlas_app', 'cuspatlas.sensitive_read_events', 'SELECT') AS reads,
              has_table_privilege('cuspatlas_app', 'cuspatlas.audit_events', 'INSERT') AS audit_insert`,
    );
    expect(grants.rows[0]).toEqual({ audit: false, reads: false, audit_insert: true });
    const c = await db.app.connect();
    try {
      for (const table of ['audit_events', 'sensitive_read_events']) {
        await c.query('BEGIN');
        await c.query(
          `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)`,
          [T_ALPHA, USER_A1],
        );
        const err = await c.query(`SELECT * FROM cuspatlas.${table}`).then(
          () => null,
          (e: { code?: string }) => e.code,
        );
        expect(err).toBe('42501');
        await c.query('ROLLBACK');
      }
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    // The audit search (definer, scope rechecked) still serves them.
    expect((await h.call('a1', 'GET', '/v1/admin/audit?source=committed_change')).statusCode).toBe(200);
  });
});
