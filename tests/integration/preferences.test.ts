import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  openAppointmentHarness,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { T_ALPHA, USER_A1, USER_A3, USER_A4 } from './support/fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * A22 (OR-12, OR-D5 accepted): per-user saved views (filters only, no PHI in names), favourite reports
 * and recent patients (references only, 7-day retention purge, user-clearable, never shared across
 * users or tenants). Synthetic data only, runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let patient: string;
type Json = Record<string, any>;

beforeAll(async () => {
  db = await openTestDatabase('preferences');
  h = await openAppointmentHarness(db, { mcp: true });
  patient = await createPatient(h, 'Recent');
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

const save = (who: string, body: Json) => h.call(who, 'POST', '/v1/me/saved-views', body);

describe('A22 saved views', () => {
  it('saves filters only and replays to the same applied filters', async () => {
    const filters = { locationRef: 'loc-north', state: 'open' };
    const r = await save('a1', {
      name: 'Open requests north',
      operation: 'scheduling.requests.list',
      filters,
    });
    expect(r.statusCode, r.body).toBe(201);
    const views = h.ok<{ data: Json[]; envelope: Json }>(await h.call('a1', 'GET', '/v1/me/saved-views'));
    expect(views.data).toEqual([expect.objectContaining({ name: 'Open requests north', filters })]);
    expect(views.envelope).toMatchObject({
      count: { exact: 1 },
      ordering: { key: 'name', tieBreak: 'viewRef' },
    });
    const replay = await h.call(
      'a1',
      'GET',
      `/v1/scheduling/appointment-requests?${new URLSearchParams(views.data[0]?.filters)}`,
    );
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().envelope.appliedFilters).toMatchObject(filters);
    // Saving again under the same name replaces the view (new version), never duplicates it.
    const again = await save('a1', {
      name: 'Open requests north',
      operation: 'scheduling.requests.list',
      filters: { state: 'in_review' },
    });
    expect(again.json().data.version).toBe(2);
  });

  it('refuses identifying names, identifying filters and non-list targets', async () => {
    expect(
      (await save('a1', { name: 'Smith 2001-02-03', operation: 'patients.search', filters: {} })).statusCode,
    ).toBe(400);
    const sensitive = await save('a1', {
      name: 'By name',
      operation: 'patients.search',
      filters: { name: 'Synthetic' },
    });
    expect([sensitive.statusCode, sensitive.json().detail?.reason]).toEqual([422, 'identifying_filter']);
    const notList = await save('a1', {
      name: 'Book',
      operation: 'scheduling.appointments.book',
      filters: {},
    });
    expect(notList.json().detail?.reason).toBe('not_a_list_operation');
  });

  it('is never visible to, or deletable by, another user or tenant', async () => {
    const ref = h.ok<{ data: Json[] }>(await h.call('a1', 'GET', '/v1/me/saved-views')).data[0]?.viewRef;
    expect(h.ok<{ data: Json[] }>(await h.call('a3', 'GET', '/v1/me/saved-views')).data).toEqual([]);
    expect(h.ok<{ data: Json[] }>(await h.call('b1', 'GET', '/v1/me/saved-views')).data).toEqual([]);
    expect((await h.call('a3', 'POST', `/v1/me/saved-views/${ref}/delete`, {})).statusCode).toBe(404);
    expect((await h.call('b1', 'POST', `/v1/me/saved-views/${ref}/delete`, {})).statusCode).toBe(404);
    expect((await h.call('a1', 'POST', `/v1/me/saved-views/${ref}/delete`, {})).statusCode).toBe(201);
    expect(h.ok<{ data: Json[] }>(await h.call('a1', 'GET', '/v1/me/saved-views')).data).toEqual([]);
  });
});

describe('A22 favourite reports', () => {
  it('holds catalog read operations per user', async () => {
    expect(
      (await h.call('a1', 'POST', '/v1/me/favourite-reports', { operation: 'rcm.claims.measures' }))
        .statusCode,
    ).toBe(201);
    const bad = await h.call('a1', 'POST', '/v1/me/favourite-reports', {
      operation: 'billing.payments.record',
    });
    expect(bad.json().detail?.reason).toBe('not_a_report_operation');
    expect(
      h
        .ok<{ data: Json[] }>(await h.call('a1', 'GET', '/v1/me/favourite-reports'))
        .data.map((f) => f.operation),
    ).toEqual(['rcm.claims.measures']);
    expect(h.ok<{ data: Json[] }>(await h.call('a3', 'GET', '/v1/me/favourite-reports')).data).toEqual([]);
    expect(
      (await h.call('a1', 'POST', '/v1/me/favourite-reports/remove', { operation: 'rcm.claims.measures' }))
        .statusCode,
    ).toBe(201);
    expect(h.ok<{ data: Json[] }>(await h.call('a1', 'GET', '/v1/me/favourite-reports')).data).toEqual([]);
  });
});

describe('A22 recent patients', () => {
  it('records references only, per user, clearable, and refuses another tenant patient', async () => {
    const rec = await h.call('a1', 'POST', '/v1/me/recent-patients', { patientRef: patient });
    expect(rec.statusCode, rec.body).toBe(201);
    const list = h.ok<{ data: Json[]; retentionDays: number }>(
      await h.call('a1', 'GET', '/v1/me/recent-patients'),
    );
    expect(list.retentionDays).toBe(7);
    expect(list.data).toEqual([{ patientRef: patient, openedAt: expect.any(String) }]);
    expect(h.ok<{ data: Json[] }>(await h.call('a3', 'GET', '/v1/me/recent-patients')).data).toEqual([]);
    expect((await h.call('b1', 'POST', '/v1/me/recent-patients', { patientRef: patient })).statusCode).toBe(
      404,
    );
    const mcp = await h.mcp('a1', 'preferences_recent_patients_list', {});
    expect(mcp.body.data).toEqual(list.data);
    expect((await h.call('a1', 'POST', '/v1/me/recent-patients/clear', {})).json().data.cleared).toBe(1);
    expect(h.ok<{ data: Json[] }>(await h.call('a1', 'GET', '/v1/me/recent-patients')).data).toEqual([]);
  });

  it('purges entries older than 7 days for the whole tenant on access', async () => {
    await h.call('a1', 'POST', '/v1/me/recent-patients', { patientRef: patient });
    // A stale entry of another user of the tenant (fixture write, superuser path).
    await db.admin.query(
      `INSERT INTO cuspatlas.user_recent_patients (tenant_id, principal_id, patient_id, opened_at)
       VALUES ($1, $2, $3, now() - interval '8 days')`,
      [T_ALPHA, USER_A3, patient],
    );
    await db.admin.query(
      `UPDATE cuspatlas.user_recent_patients SET opened_at = now() - interval '7 days 1 minute' WHERE principal_id = $1`,
      [USER_A1],
    );
    expect(h.ok<{ data: Json[] }>(await h.call('a1', 'GET', '/v1/me/recent-patients')).data).toEqual([]);
    const { rows } = await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.user_recent_patients');
    expect(rows[0].n).toBe(0);
  });

  it('the runtime role cannot read another user rows even when they are expired', async () => {
    await db.admin.query(
      `INSERT INTO cuspatlas.user_recent_patients (tenant_id, principal_id, patient_id, opened_at) VALUES ($1, $2, $3, now())`,
      [T_ALPHA, USER_A3, patient],
    );
    const c = await db.app.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)`,
        [T_ALPHA, USER_A1],
      );
      const { rows } = await c.query('SELECT * FROM cuspatlas.user_recent_patients');
      expect(rows).toEqual([]);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('is human only: a service principal is refused', async () => {
    expect((await h.call('svcA1', 'GET', '/v1/me/recent-patients')).statusCode).toBe(403);
    expect((await h.call('a2', 'GET', '/v1/me/saved-views')).statusCode).toBe(403);
  });
});

describe('A batch 3 hardening: saved views carry no identity and need the target right', () => {
  it('refuses an identifier filter, free text and unknown keys', async () => {
    const ref = await save('a1', {
      name: 'My ledger',
      operation: 'billing.ledger.list',
      filters: { patientRef: patient },
    });
    expect([ref.statusCode, ref.json().detail?.reason]).toEqual([422, 'identifying_filter']);
    const q = await save('a1', {
      name: 'Open requests',
      operation: 'scheduling.requests.list',
      filters: { q: 'Jane Smith' },
    });
    expect([q.statusCode, q.json().detail?.reason]).toEqual([422, 'free_text_filter']);
    const unknown = await save('a1', {
      name: 'Open requests',
      operation: 'scheduling.requests.list',
      filters: { colour: 'red' },
    });
    expect([unknown.statusCode, unknown.json().detail?.reason]).toEqual([422, 'unknown_filter']);
    for (const value of ['20000000-0000-4000-8000-0000000000a3', 'chart 12345']) {
      const id = await save('a1', {
        name: 'Open requests',
        operation: 'scheduling.requests.list',
        filters: { state: value },
      });
      expect([id.statusCode, id.json().detail?.reason]).toEqual([422, 'identifying_value']);
    }
  });

  it('refuses a name outside the label vocabulary, identically whether or not a patient has it', async () => {
    const before = await save('a1', {
      name: 'Jane Smith',
      operation: 'scheduling.requests.list',
      filters: {},
    });
    h.ok(
      await h.call(
        'a1',
        'POST',
        '/v1/patients',
        patientBody('Jane', { legalName: { known: true, given: 'Jane', family: 'Smith' } }),
      ),
      201,
    );
    const after = await save('a1', {
      name: 'Jane Smith',
      operation: 'scheduling.requests.list',
      filters: {},
    });
    expect([after.statusCode, after.json().detail?.reason]).toEqual([422, 'name_not_in_vocabulary']);
    expect([before.statusCode, before.json().detail?.reason]).toEqual([422, 'name_not_in_vocabulary']);
  });

  it('authorizes the target list operation at save and on idempotent replay', async () => {
    const body = { name: 'Open requests', operation: 'scheduling.requests.list', filters: {} };
    const ledger = { name: 'My ledger', operation: 'billing.ledger.list', filters: {} };
    expect((await save('a3', ledger)).statusCode).toBe(403);
    const key = randomUUID();
    const first = await h.call('a1', 'POST', '/v1/me/saved-views', body, key);
    expect(first.statusCode).toBe(201);
    const scopes = (
      await db.admin.query(
        'SELECT scopes FROM cuspatlas.memberships WHERE principal_id = $1 AND tenant_id = $2',
        [USER_A1, T_ALPHA],
      )
    ).rows[0].scopes as string[];
    await db.admin.query(
      'UPDATE cuspatlas.memberships SET scopes = $3::text[] WHERE principal_id = $1 AND tenant_id = $2',
      [USER_A1, T_ALPHA, scopes.filter((s) => s !== 'scheduling.read')],
    );
    try {
      expect((await h.call('a1', 'POST', '/v1/me/saved-views', body, key)).statusCode).toBe(403);
    } finally {
      await db.admin.query(
        'UPDATE cuspatlas.memberships SET scopes = $3::text[] WHERE principal_id = $1 AND tenant_id = $2',
        [USER_A1, T_ALPHA, scopes],
      );
    }
  });
});

describe('A batch 3 hardening: recent patients need patients.read', () => {
  it('refuses the recent-patients list to a caller without patients.read', async () => {
    await db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2::text[] WHERE principal_id = $1', [
      USER_A4,
      ['scheduling.read'],
    ]);
    expect((await h.call('a4', 'GET', '/v1/me/recent-patients')).statusCode).toBe(403);
  });
});
