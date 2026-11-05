import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import { isRefusalError } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { assertPatientSchedulable } from '@cuspatlas/domain';
import { buildMcpServer, type McpServerHandle } from '@cuspatlas/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_A3, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';
import { leakSurface, PATIENT_ALL, patientBody, phone, seedPatientScopes } from './support/patient-fixtures';
import { createTestTokenIssuer, TEST_AUDIENCE, type TestTokenIssuer } from './support/test-token-issuer';

const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';

let db: TestDatabase;
let issuer: TestTokenIssuer;
let app: FastifyInstance;
let mcp: McpServerHandle;
let mcpUrl: string;
let logLines: string[];
const tokens: Record<string, string> = {};

beforeAll(async () => {
  db = await openTestDatabase('patient_identity');
  await seedTenancy(db.admin);
  await seedPatientScopes(db.admin);
  issuer = await createTestTokenIssuer();
  logLines = [];
  const stream = { write: (l: string) => logLines.push(l) };
  const membership = createMembershipSource(db.app);
  const attempts = createSecurityAttemptSink(db.sink);
  const tenantTransactions = createTenantTransactionRunner(db.app);
  app = await buildApp({
    env: 'synthetic-test',
    logger: { level: 'trace', stream },
    identity: issuer.verifierConfig,
    membership,
    attempts,
    tenantTransactions,
  });
  mcp = buildMcpServer({
    env: 'synthetic-test',
    identity: { ...issuer.verifierConfig, audience: MCP_AUDIENCE },
    restAudience: TEST_AUDIENCE,
    membership,
    attempts,
    tenantTransactions,
    logger: { stream },
  });
  mcpUrl = (await mcp.listen({ host: '127.0.0.1', port: 0 })).url;
  tokens.a1 = await issuer.issue({ sub: USER_A1, tid: T_ALPHA });
  tokens.a3 = await issuer.issue({ sub: USER_A3, tid: T_ALPHA });
  tokens.b1 = await issuer.issue({ sub: USER_B1, tid: T_BETA });
  tokens.a1Mcp = await issuer.issue({ sub: USER_A1, tid: T_ALPHA, audience: MCP_AUDIENCE });
});

afterAll(async () => {
  await mcp?.close();
  await app?.close();
  await db?.close();
});

function call(
  who: string,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  key: string | null = randomUUID(),
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(method === 'POST' && key !== null ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

const create = (who: string, body: unknown, key?: string) => call(who, 'POST', '/v1/patients', body, key);
const read = (who: string, ref: string) => call(who, 'GET', `/v1/patients/${ref}`);
const update = (who: string, ref: string, body: unknown, key?: string) =>
  call(who, 'POST', `/v1/patients/${ref}/demographics`, body, key);
const setStatus = (who: string, ref: string, body: unknown) =>
  call(who, 'POST', `/v1/patients/${ref}/status`, body);
const search = (who: string, body: unknown) => call(who, 'POST', '/v1/patients/search', body, null);

async function count(table: string, where = 'true', values: unknown[] = []): Promise<number> {
  return (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${table} WHERE ${where}`, values))
    .rows[0].n;
}

async function newPatient(given: string, overrides = {}): Promise<{ ref: string; version: number }> {
  const res = await create('a1', patientBody(given, overrides));
  expect(res.statusCode).toBe(201);
  return { ref: res.json().data.patientRef, version: res.json().version };
}

describe('S4 acceptance', () => {
  it('1. minimum create returns a version and commits identity, audit and outbox atomically', async () => {
    const res = await create('a1', patientBody('Synthetic Patient A1'));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toStrictEqual(['correlationId', 'data', 'replayed', 'version']);
    expect(body.version).toBe(1);
    expect(body.replayed).toBe(false);
    expect(body.data).toMatchObject({
      legalName: { known: true, given: 'Synthetic Patient A1', family: 'Synthetic' },
      status: 'active',
      contactable: false,
      mergedIntoRef: null,
      version: 1,
    });
    const ref = body.data.patientRef;
    const row = (
      await db.admin.query('SELECT tenant_id, created_by FROM cuspatlas.patients WHERE id = $1', [ref])
    ).rows[0];
    expect(row).toStrictEqual({ tenant_id: T_ALPHA, created_by: USER_A1 });
    const audit = await db.admin.query(
      `SELECT operation, resource_type, resource_version, correlation_id FROM cuspatlas.audit_events
       WHERE resource_ref = $1`,
      [ref],
    );
    expect(audit.rows).toStrictEqual([
      {
        operation: 'patients.create',
        resource_type: 'patient',
        resource_version: 1,
        correlation_id: body.correlationId,
      },
    ]);
    const outbox = await db.admin.query(
      'SELECT payload FROM cuspatlas.outbox_events WHERE aggregate_id = $1',
      [ref],
    );
    expect(outbox.rows).toHaveLength(1);
    // Field names only, never values.
    expect(JSON.stringify(outbox.rows[0].payload)).not.toContain('Synthetic Patient A1');
    expect(await count('patient_status_history', 'patient_id = $1', [ref])).toBe(1);
  });

  it('2. the same idempotency key returns the same patient with one audit success', async () => {
    const key = randomUUID();
    const first = await create('a1', patientBody('Synthetic Patient A2'), key);
    const second = await create('a1', patientBody('Synthetic Patient A2'), key);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().replayed).toBe(true);
    expect(second.json().data).toStrictEqual(first.json().data);
    const ref = first.json().data.patientRef;
    expect(await count('patients', `legal_name->>'given' = 'Synthetic Patient A2'`)).toBe(1);
    expect(await count('audit_events', 'resource_ref = $1', [ref])).toBe(1);
    const changed = await create('a1', patientBody('Synthetic Patient A2 changed'), key);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe('idempotency_conflict');
  });

  it('3. a shared household phone keeps two separate records and nothing proposes a merge (pair P1)', async () => {
    const household = {
      contact: { known: true, points: [phone('+1 555 0100 001')] },
      address: {
        known: true,
        lines: ['1 Synthetic Way'],
        city: 'Synthville',
        region: 'SY',
        postalCode: '00000',
        country: 'US',
      },
    };
    const one = await create('a1', patientBody('Synthetic Household One', household));
    const two = await create(
      'a1',
      patientBody('Synthetic Household Two', {
        ...household,
        birthDate: { known: true, value: '1980-07-09', precision: 'day' },
      }),
    );
    expect(one.statusCode).toBe(201);
    expect(two.statusCode).toBe(201);
    for (const r of [one, two]) {
      expect(Object.keys(r.json().data)).not.toContain('candidates');
      expect(r.json().data.contactable).toBe(true);
    }
    const found = await search('a1', { phone: '+1 555 0100 001' });
    expect(found.statusCode).toBe(200);
    const refs = found
      .json()
      .data.map((p: { patientRef: string }) => p.patientRef)
      .sort();
    expect(refs).toStrictEqual([one.json().data.patientRef, two.json().data.patientRef].sort());
    expect(Object.keys(found.json()).sort()).toStrictEqual(['data', 'envelope', 'nextCursor']);
    expect(await count('patients', 'merged_into IS NOT NULL')).toBe(0);
  });

  it('4. deceased and inactive patients stay readable but cannot be scheduled; the refusal names the state', async () => {
    const deceased = await newPatient('Synthetic Patient Deceased');
    const inactive = await newPatient('Synthetic Patient Inactive');
    const active = await newPatient('Synthetic Patient Active');
    const r1 = await setStatus('a1', deceased.ref, {
      expectedVersion: 1,
      status: 'deceased',
      effectiveAt: '2026-10-01T00:00:00Z',
      reasonCode: 'deceased_reported',
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data).toMatchObject({
      status: 'deceased',
      statusEffectiveAt: '2026-10-01T00:00:00.000Z',
    });
    const r2 = await setStatus('a1', inactive.ref, {
      expectedVersion: 1,
      status: 'inactive',
      effectiveAt: '2026-10-01T00:00:00Z',
      reasonCode: 'moved_away',
    });
    expect(r2.statusCode).toBe(200);
    expect((await read('a1', deceased.ref)).json().data.status).toBe('deceased');
    expect((await read('a1', inactive.ref)).json().data.status).toBe('inactive');
    // Effective-dated, never deleted: both status facts are kept.
    expect(await count('patient_status_history', 'patient_id = $1', [deceased.ref])).toBe(2);

    const tx = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human', PATIENT_ALL);
    const reason = async (ref: string) => {
      try {
        await tx(ctx, (t) => assertPatientSchedulable(t, ref));
        return 'ok';
      } catch (err) {
        if (!isRefusalError(err)) throw err;
        return `${err.code}:${err.detail?.reason}`;
      }
    };
    expect(await reason(deceased.ref)).toBe('conflict:patient_deceased');
    expect(await reason(inactive.ref)).toBe('conflict:patient_inactive');
    expect(await reason(active.ref)).toBe('ok');
    expect(await reason(randomUUID())).toBe('not_found:undefined');
    // Back from deceased only as a correction.
    const back = await setStatus('a1', deceased.ref, {
      expectedVersion: 2,
      status: 'active',
      effectiveAt: '2026-10-02T00:00:00Z',
      reasonCode: 'returned',
    });
    expect(back.statusCode).toBe(409);
    expect(back.json().detail).toStrictEqual({ reason: 'status_transition_denied' });
    const future = await setStatus('a1', active.ref, {
      expectedVersion: 1,
      status: 'inactive',
      effectiveAt: '2999-01-01T00:00:00Z',
      reasonCode: 'moved_away',
    });
    expect(future.statusCode).toBe(422);
  });

  it('5. another tenant is denied read and update without learning whether the record exists', async () => {
    const { ref } = await newPatient('Synthetic Patient Hidden');
    const missing = randomUUID();
    const strip = (r: LightMyRequestResponse) => {
      const { correlationId, ...rest } = r.json();
      expect(correlationId).toBe(r.headers['x-correlation-id']);
      return rest;
    };
    const hidden = await read('b1', ref);
    const absent = await read('b1', missing);
    expect(hidden.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(strip(hidden)).toStrictEqual(strip(absent));
    const upd = await update('b1', ref, {
      expectedVersion: 1,
      pronouns: { known: true, value: 'they/them' },
    });
    const updAbsent = await update('b1', missing, {
      expectedVersion: 1,
      pronouns: { known: true, value: 'they/them' },
    });
    expect(upd.statusCode).toBe(404);
    expect(strip(upd)).toStrictEqual(strip(updAbsent));
    const st = await setStatus('b1', ref, {
      expectedVersion: 1,
      status: 'inactive',
      effectiveAt: '2026-10-01T00:00:00Z',
      reasonCode: 'moved_away',
    });
    expect(st.statusCode).toBe(404);
    const attempts = await db.admin.query(
      'SELECT tenant_id, reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [hidden.json().correlationId],
    );
    expect(attempts.rows).toStrictEqual([{ tenant_id: T_BETA, reason_code: 'resource_hidden_or_missing' }]);
    expect((await read('a1', ref)).json().data.version).toBe(1);
    // Search from the other tenant returns an empty page, not a denial-shaped error.
    const foreign = await search('b1', { name: 'Synthetic Patient Hidden' });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json()).toMatchObject({ data: [], nextCursor: null, envelope: { count: { exact: 0 } } });
    // A20: identifying search filters are never echoed back in the envelope.
    expect(foreign.json().envelope.appliedFilters.name).toBe('provided');
  });

  it('6. absent field groups are stored as explicit unknown, never as an empty string', async () => {
    const res = await create('a1', {
      legalName: { known: false, reason: 'not_provided' },
      birthDate: { known: false, reason: 'declined' },
    });
    expect(res.statusCode).toBe(201);
    const ref = res.json().data.patientRef;
    const full = (await read('a1', ref)).json().data;
    expect(full.legalName).toStrictEqual({ known: false, reason: 'not_provided' });
    expect(full.birthDate).toStrictEqual({ known: false, reason: 'declined' });
    for (const group of ['preferredName', 'pronouns', 'language', 'contact', 'address']) {
      expect([group, full[group]]).toStrictEqual([group, { known: false, reason: 'not_provided' }]);
    }
    expect(full.identifiers).toStrictEqual([]);
    expect(full.timeZone).toBeNull();
    const stored = (
      await db.admin.query(
        'SELECT legal_name, preferred_name, contact, birth_date, birth_date_precision FROM cuspatlas.patients WHERE id = $1',
        [ref],
      )
    ).rows[0];
    expect(stored).toStrictEqual({
      legal_name: { known: false, reason: 'not_provided' },
      preferred_name: { known: false, reason: 'not_provided' },
      contact: { known: false, reason: 'not_provided' },
      birth_date: null,
      birth_date_precision: 'unknown',
    });
    for (const empty of [
      patientBody('x', { legalName: { known: true, given: '', family: 'Synthetic' } }),
      patientBody('x', { preferredName: { known: true, value: '' } }),
      patientBody('x', { legalName: { known: false } }),
    ]) {
      expect((await create('a1', empty)).statusCode).toBe(400);
    }
  });
});

describe('S4 failure and recovery', () => {
  it('1. a partial write during creation rolls back identity, audit and outbox together', async () => {
    const before = [await count('patients'), await count('audit_events'), await count('outbox_events')];
    await db.admin.query('REVOKE INSERT ON cuspatlas.outbox_events FROM cuspatlas_app');
    try {
      const res = await create('a1', patientBody('Synthetic Patient Rollback'));
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe('internal_error');
    } finally {
      await db.admin.query('GRANT INSERT ON cuspatlas.outbox_events TO cuspatlas_app');
    }
    expect([
      await count('patients'),
      await count('audit_events'),
      await count('outbox_events'),
    ]).toStrictEqual(before);
    expect(
      await count('patient_status_history', `patient_id NOT IN (SELECT id FROM cuspatlas.patients)`),
    ).toBe(0);
  });

  it('2. concurrent updates with the same expectedVersion yield one commit and one typed conflict', async () => {
    const { ref } = await newPatient('Synthetic Patient Race');
    const results = await Promise.all(
      ['she/her', 'he/him'].map((value) =>
        update('a1', ref, { expectedVersion: 1, pronouns: { known: true, value } }),
      ),
    );
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toStrictEqual([200, 409]);
    const conflict = results.find((r) => r.statusCode === 409);
    expect(conflict?.json()).toMatchObject({ code: 'stale_version', detail: { currentVersion: 2 } });
    expect(await count('audit_events', 'resource_ref = $1', [ref])).toBe(2);
  });

  it('3. an unsupported birth-date precision or an unparseable IANA zone is rejected before any write', async () => {
    const before = await count('patients');
    const week = await create(
      'a1',
      patientBody('x', { birthDate: { known: true, value: '2001-02-03', precision: 'week' } }),
    );
    expect(week.statusCode).toBe(400);
    for (const bad of [
      { birthDate: { known: true, value: '2001-02', precision: 'day' } },
      { birthDate: { known: true, value: '2001-02-30', precision: 'day' } },
      { birthDate: { known: true, value: '2999-01-01', precision: 'day' } },
      { timeZone: 'Mars/Olympus_Mons' },
    ]) {
      const res = await create('a1', patientBody('x', bad));
      expect([JSON.stringify(bad), res.statusCode]).toStrictEqual([JSON.stringify(bad), 422]);
      expect(res.json().code).toBe('validation_failed');
    }
    const ok = await create('a1', patientBody('Synthetic Patient Zone', { timeZone: 'America/Chicago' }));
    expect(ok.statusCode).toBe(201);
    expect(await count('patients')).toBe(before + 1);
    const { ref, version } = { ref: ok.json().data.patientRef, version: ok.json().version };
    const badUpdate = await update('a1', ref, { expectedVersion: version, timeZone: 'Not/AZone' });
    expect(badUpdate.statusCode).toBe(422);
    expect((await read('a1', ref)).json().data.version).toBe(1);
  });

  it('4. a patient without a contact block is created and reported as not contactable', async () => {
    const { ref } = await newPatient('Synthetic Patient No Contact');
    const full = (await read('a1', ref)).json().data;
    expect(full.contactable).toBe(false);
    expect(full.contact).toStrictEqual({ known: false, reason: 'not_provided' });
    const avoid = await newPatient('Synthetic Patient Avoid', {
      contact: { known: true, points: [phone('+1 555 0100 777', 'avoid')] },
    });
    expect((await read('a1', avoid.ref)).json().data.contactable).toBe(false);
  });
});

describe('S4 updates, search, location policy and sensitive-read audit', () => {
  it('updates replace only the provided groups and bump the version', async () => {
    const { ref } = await newPatient('Synthetic Patient Update');
    const res = await update('a1', ref, {
      expectedVersion: 1,
      preferredName: { known: true, value: 'Synthetic Pref' },
      provenance: { preferredName: 'patient_reported' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: 2,
      data: { preferredName: { known: true, value: 'Synthetic Pref' } },
    });
    const full = (await read('a1', ref)).json().data;
    expect(full.legalName.given).toBe('Synthetic Patient Update');
    expect(full.provenance).toMatchObject({ legalName: 'staff_entry', preferredName: 'patient_reported' });
    const empty = await update('a1', ref, { expectedVersion: 2 });
    expect(empty.statusCode).toBe(422);
  });

  it('searches by name prefix and birth date, bounded and cursor-paginated', async () => {
    for (const n of ['One', 'Two', 'Three']) {
      await newPatient(`Synthetic Pager ${n}`, {
        birthDate: { known: true, value: '1999-09-09', precision: 'day' },
      });
    }
    const page1 = await search('a1', { name: 'synthetic pager', limit: 2 });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().data).toHaveLength(2);
    const page2 = await search('a1', { name: 'synthetic pager', limit: 2, cursor: page1.json().nextCursor });
    expect(page2.json().data).toHaveLength(1);
    expect(page2.json().nextCursor).toBeNull();
    const byDate = await search('a1', { birthDate: '1999-09-09' });
    expect(byDate.json().data.length).toBeGreaterThanOrEqual(3);
    for (const p of byDate.json().data) expect(Object.keys(p)).not.toContain('contact');
    expect((await search('a1', { limit: 101 })).statusCode).toBe(400);
    expect((await search('a1', { name: 'x' })).statusCode).toBe(400);
    expect((await search('a1', { tenantId: T_BETA })).statusCode).toBe(400);
  });

  it('identity is tenant-wide; a location-restricted member may set only its own home location', async () => {
    const south = await create(
      'a1',
      patientBody('Synthetic Patient South', { homeLocationRef: 'loc-south' }),
    );
    expect(south.statusCode).toBe(201);
    expect((await read('a3', south.json().data.patientRef)).statusCode).toBe(200);
    const denied = await create(
      'a3',
      patientBody('Synthetic Patient South Two', { homeLocationRef: 'loc-south' }),
    );
    expect(denied.statusCode).toBe(403);
    const north = await create(
      'a3',
      patientBody('Synthetic Patient North', { homeLocationRef: 'loc-north' }),
    );
    expect(north.statusCode).toBe(201);
    const move = await update('a3', north.json().data.patientRef, {
      expectedVersion: 1,
      homeLocationRef: 'loc-south',
    });
    expect(move.statusCode).toBe(403);
  });

  it('read and search are recorded as sensitive reads with references only', async () => {
    const { ref } = await newPatient('Synthetic Patient Audited');
    const r = await read('a1', ref);
    const s = await search('a1', { name: 'Synthetic Patient Audited' });
    const rows = await db.admin.query(
      `SELECT operation, actor_id, resource_refs, result_count, query_fields FROM cuspatlas.sensitive_read_events
       WHERE correlation_id = ANY ($1::uuid[]) ORDER BY operation`,
      [[r.headers['x-correlation-id'], s.headers['x-correlation-id']]],
    );
    expect(rows.rows).toStrictEqual([
      {
        operation: 'patients.read',
        actor_id: USER_A1,
        resource_refs: [ref],
        result_count: 1,
        query_fields: [],
      },
      {
        operation: 'patients.search',
        actor_id: USER_A1,
        resource_refs: [ref],
        result_count: 1,
        query_fields: ['name'],
      },
    ]);
    // A read of a hidden record leaves no sensitive-read row, only the denial attempt.
    const before = await count('sensitive_read_events');
    await read('b1', ref);
    expect(await count('sensitive_read_events')).toBe(before);
  });
});

describe('S4 MCP parity and privacy', () => {
  async function tool(name: string, args: Record<string, unknown>) {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${tokens.a1Mcp}` } },
    });
    const client = new Client({ name: 'synthetic-test-client', version: '0.0.0' });
    await client.connect(transport);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  it('MCP tools call the same handlers: an MCP create replays over REST with the same key', async () => {
    const key = randomUUID();
    const body = patientBody('Synthetic Patient Mcp');
    const viaMcp = await tool('patients_create', { ...body, idempotencyKey: key });
    expect(viaMcp.isError).not.toBe(true);
    const created = viaMcp.structuredContent as { data: { patientRef: string }; version: number };
    const viaRest = await create('a1', body, key);
    expect(viaRest.statusCode).toBe(201);
    expect(viaRest.json().replayed).toBe(true);
    expect(viaRest.json().data.patientRef).toBe(created.data.patientRef);
    const got = await tool('patients_get', { patientRef: created.data.patientRef });
    expect((got.structuredContent as { data: { version: number } }).data.version).toBe(1);
    const upd = await tool('patients_update_demographics', {
      patientRef: created.data.patientRef,
      expectedVersion: 1,
      pronouns: { known: true, value: 'they/them' },
      idempotencyKey: randomUUID(),
    });
    expect((upd.structuredContent as { version: number }).version).toBe(2);
    const st = await tool('patients_set_status', {
      patientRef: created.data.patientRef,
      expectedVersion: 2,
      status: 'inactive',
      effectiveAt: '2026-10-01T00:00:00Z',
      reasonCode: 'moved_away',
      idempotencyKey: randomUUID(),
    });
    expect((st.structuredContent as { data: { status: string } }).data.status).toBe('inactive');
    const found = await tool('patients_search', { name: 'Synthetic Patient Mcp' });
    expect((found.structuredContent as { data: unknown[] }).data).toHaveLength(1);
    const stale = await tool('patients_update_demographics', {
      patientRef: created.data.patientRef,
      expectedVersion: 1,
      pronouns: { known: true, value: 'he/him' },
      idempotencyKey: randomUUID(),
    });
    expect(stale.isError).toBe(true);
    expect((stale.structuredContent as { code: string }).code).toBe('stale_version');
  });

  it('the marker in names and contact values never reaches logs, errors, audit, outbox, attempts or idempotency rows', async () => {
    const secretBody = patientBody(`Synthetic ${MARKER}`, {
      preferredName: { known: true, value: MARKER },
      contact: {
        known: true,
        points: [
          { channel: 'email', use: 'home', value: `${MARKER}@synthetic.invalid`, preference: 'preferred' },
          phone('+1 555 0142 042'),
        ],
      },
      address: {
        known: true,
        lines: [MARKER],
        city: MARKER,
        region: 'SY',
        postalCode: '00042',
        country: 'US',
      },
      identifiers: [{ type: 'chart_number', issuer: 'synthetic-practice', value: 'CHART-42' }],
    });
    const ok = await create('a1', secretBody);
    expect(ok.statusCode).toBe(201);
    const ref = ok.json().data.patientRef;
    // Refusals carrying the marker: schema error, domain validation, cross-tenant, stale version.
    const refusals = [
      await create('a1', { ...secretBody, extra: MARKER }),
      await create('a1', { ...secretBody, timeZone: `Zone/${MARKER}` }),
      await update('b1', ref, { expectedVersion: 1, preferredName: { known: true, value: MARKER } }),
      await update('a1', ref, { expectedVersion: 9, preferredName: { known: true, value: MARKER } }),
      await search('a1', { name: MARKER }),
      await search('b1', { name: MARKER }),
    ];
    for (const r of refusals) expect(`${r.body}${JSON.stringify(r.headers)}`).not.toContain(MARKER);
    await read('a1', ref);
    await tool('patients_create', { ...secretBody, idempotencyKey: randomUUID() });
    await tool('patients_update_demographics', {
      patientRef: ref,
      expectedVersion: 1,
      preferredName: { known: true, value: `${MARKER}x` },
      idempotencyKey: randomUUID(),
    });
    expect(logLines.join('\n')).not.toContain(MARKER);
    for (const v of ['0142 042', '15550142042']) expect(logLines.join('\n')).not.toContain(v);
    const surface = await leakSurface(db.admin);
    expect(surface).not.toContain(MARKER);
    expect(surface).not.toContain('0142 042');
    expect(surface).not.toContain('15550142042');
    expect(surface).not.toContain('CHART-42');
  });
});
