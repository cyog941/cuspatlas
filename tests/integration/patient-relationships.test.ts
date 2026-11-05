import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import { isRefusalError, RELATIONSHIP_SCOPES } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { evaluatePatientAccess, relationshipPermits, requireRelationshipScope } from '@cuspatlas/domain';
import { buildMcpServer, type McpServerHandle } from '@cuspatlas/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';
import { leakSurface, PATIENT_ALL, patientBody, seedPatientScopes } from './support/patient-fixtures';
import { createTestTokenIssuer, TEST_AUDIENCE, type TestTokenIssuer } from './support/test-token-issuer';

const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';
/** A synthetic minor (well under any default age of majority) and synthetic adults. */
const MINOR_BIRTH = { known: true, value: '2016-05-05', precision: 'day' };
const ADULT_BIRTH = { known: true, value: '1980-01-15', precision: 'day' };

let db: TestDatabase;
let issuer: TestTokenIssuer;
let app: FastifyInstance;
let mcp: McpServerHandle;
let mcpUrl: string;
let logLines: string[];
const tokens: Record<string, string> = {};

beforeAll(async () => {
  db = await openTestDatabase('patient_relationships');
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
    logger: { level: 'info', stream },
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
  // Sessions are issued before any relationship exists or is revoked.
  tokens.a1 = await issuer.issue({ sub: USER_A1, tid: T_ALPHA });
  tokens.b1 = await issuer.issue({ sub: USER_B1, tid: T_BETA });
  tokens.a1Mcp = await issuer.issue({ sub: USER_A1, tid: T_ALPHA, audience: MCP_AUDIENCE });
});

afterAll(async () => {
  await mcp?.close();
  await app?.close();
  await db?.close();
});

function call(who: string, method: 'GET' | 'POST', url: string, body?: unknown, keyed = method === 'POST') {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(keyed ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function patient(who: string, given: string, birthDate: object = ADULT_BIRTH): Promise<string> {
  const res = await call(who, 'POST', '/v1/patients', patientBody(given, { birthDate }));
  expect(res.statusCode).toBe(201);
  return res.json().data.patientRef;
}

const addRel = (subject: string, body: object, who = 'a1') =>
  call(who, 'POST', `/v1/patients/${subject}/relationships`, body);
const revoke = (subject: string, rel: string, version: number, reasonCode = 'patient_request') =>
  call('a1', 'POST', `/v1/patients/${subject}/relationships/${rel}/revoke`, {
    expectedVersion: version,
    reasonCode,
  });
const access = (subject: string, counterparty: string, who = 'a1') =>
  call(who, 'GET', `/v1/patients/${subject}/access?counterpartyRef=${counterparty}`);
const readOnBehalf = (subject: string, counterparty: string) =>
  call('a1', 'GET', `/v1/patients/${subject}?requestedBy=${counterparty}`);
const updateOnBehalf = (subject: string, counterparty: string, version: number) =>
  call('a1', 'POST', `/v1/patients/${subject}/demographics`, {
    expectedVersion: version,
    requestedBy: counterparty,
    pronouns: { known: true, value: 'they/them' },
  });

async function version(ref: string): Promise<number> {
  return (await db.admin.query('SELECT version FROM cuspatlas.patients WHERE id = $1', [ref])).rows[0]
    .version;
}

async function attemptReasons(res: LightMyRequestResponse): Promise<string[]> {
  const { rows } = await db.admin.query(
    'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
    [res.headers['x-correlation-id']],
  );
  return rows.map((r) => r.reason_code);
}

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

const tx = () => createTenantTransactionRunner(db.app);
const staff = () => ctxFor(T_ALPHA, USER_A1, 'human', PATIENT_ALL);

describe('S5 acceptance', () => {
  it('1. a guardian of a synthetic minor gets scoped demographic and scheduling access and is denied note signing', async () => {
    const minor = await patient('a1', 'Synthetic Minor One', MINOR_BIRTH);
    const guardian = await patient('a1', 'Synthetic Guardian One');
    const res = await addRel(minor, {
      counterpartyRef: guardian,
      kind: 'guardian',
      scopes: ['demographics', 'scheduling'],
      evidenceRef: 'synthetic-evidence-1',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      version: 1,
      data: { subjectRef: minor, counterpartyRef: guardian, kind: 'guardian', status: 'active', version: 1 },
    });
    // Guardian authority ends at the configured age of majority (default 18), computed by the server.
    expect(res.json().data.effectiveEnd).toBe('2034-05-05T00:00:00.000Z');
    const a = await access(minor, guardian);
    expect(a.statusCode).toBe(200);
    expect(a.json().data).toMatchObject({
      subjectRef: minor,
      counterpartyRef: guardian,
      scopes: ['demographics', 'scheduling'],
      reason: 'relationship_active',
    });
    expect((await readOnBehalf(minor, guardian)).statusCode).toBe(200);
    const upd = await updateOnBehalf(minor, guardian, 1);
    expect(upd.statusCode).toBe(200);
    expect((await call('a1', 'GET', `/v1/patients/${minor}`)).json().data.provenance.pronouns).toBe(
      'guardian_reported',
    );
    // Relationship scopes are the five registered names; anything else, such as note signing, is denied.
    expect([...RELATIONSHIP_SCOPES]).toStrictEqual([
      'demographics',
      'scheduling',
      'clinical_read',
      'financial',
      'consent',
    ]);
    const result = await tx()(staff(), async (t) => {
      const evaluated = await evaluatePatientAccess(t, minor, guardian);
      let denial = 'none';
      try {
        await requireRelationshipScope(t, minor, guardian, 'clinical.sign');
      } catch (err) {
        if (!isRefusalError(err)) throw err;
        denial = `${err.code}:${err.reasonCode}:${err.detail?.reason}`;
      }
      return { evaluated, denial };
    });
    expect(relationshipPermits(result.evaluated, 'demographics')).toBe(true);
    expect(relationshipPermits(result.evaluated, 'scheduling')).toBe(true);
    expect(relationshipPermits(result.evaluated, 'clinical_read')).toBe(false);
    expect(relationshipPermits(result.evaluated, 'clinical.sign')).toBe(false);
    expect(result.denial).toBe('forbidden:relationship_scope_missing:relationship_scope_missing');
  });

  it('2. an expired relationship denies access while the patient and the relationship history stay intact', async () => {
    const subject = await patient('a1', 'Synthetic Subject Expiring');
    const proxy = await patient('a1', 'Synthetic Proxy Expiring');
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const rel = await addRel(subject, {
      counterpartyRef: proxy,
      kind: 'proxy',
      scopes: ['demographics'],
      effectiveUntil: until,
    });
    expect(rel.statusCode).toBe(201);
    const relRef = rel.json().data.relationshipRef;
    expect((await readOnBehalf(subject, proxy)).statusCode).toBe(200);
    // Time passes: the stored window ends in the past (server clock decides).
    await db.admin.query(
      `UPDATE cuspatlas.patient_relationships SET effective_from = now() - interval '2 days',
         effective_until = now() - interval '1 second', version = version + 1 WHERE id = $1`,
      [relRef],
    );
    const denied = await readOnBehalf(subject, proxy);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'forbidden', detail: { reason: 'relationship_expired' } });
    expect(await attemptReasons(denied)).toStrictEqual(['relationship_expired']);
    expect((await call('a1', 'GET', `/v1/patients/${subject}`)).statusCode).toBe(200);
    const list = await call('a1', 'GET', `/v1/patients/${subject}/relationships`);
    expect(list.json().data).toMatchObject([
      { relationshipRef: relRef, status: 'expired', statusReason: 'window_ended' },
    ]);
    expect((await access(subject, proxy)).json().data).toMatchObject({
      scopes: [],
      reason: 'relationship_expired',
    });
  });

  it('3. a relationship revoked after the session was issued denies the next command', async () => {
    const minor = await patient('a1', 'Synthetic Minor Revoked', MINOR_BIRTH);
    const guardian = await patient('a1', 'Synthetic Guardian Revoked');
    const rel = await addRel(minor, {
      counterpartyRef: guardian,
      kind: 'guardian',
      scopes: ['demographics'],
    });
    const relRef = rel.json().data.relationshipRef;
    expect((await updateOnBehalf(minor, guardian, 1)).statusCode).toBe(200);
    const rv = await revoke(minor, relRef, 1, 'guardian_request');
    expect(rv.statusCode).toBe(200);
    expect(rv.json().data).toMatchObject({ status: 'revoked', version: 2 });
    const denied = await updateOnBehalf(minor, guardian, 2);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().detail).toStrictEqual({ reason: 'relationship_revoked' });
    expect(await version(minor)).toBe(2);
    // Revocation sets an end instant and never deletes the row.
    const row = (
      await db.admin.query(
        'SELECT revoked_at IS NOT NULL AS revoked, revoke_reason FROM cuspatlas.patient_relationships WHERE id = $1',
        [relRef],
      )
    ).rows;
    expect(row).toStrictEqual([{ revoked: true, revoke_reason: 'guardian_request' }]);
    expect((await revoke(minor, relRef, 2)).json()).toMatchObject({
      code: 'conflict',
      detail: { reason: 'relationship_already_revoked' },
    });
  });

  it('4. an adult revoking a proxy yields the same denial on REST and MCP for the same operation', async () => {
    const adult = await patient('a1', 'Synthetic Adult Revoker');
    const proxy = await patient('a1', 'Synthetic Proxy Revoked');
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const rel = await addRel(adult, {
      counterpartyRef: proxy,
      kind: 'proxy',
      scopes: ['demographics', 'scheduling'],
      effectiveUntil: until,
    });
    expect(rel.statusCode).toBe(201);
    const relRef = rel.json().data.relationshipRef;
    const viaTool = await tool('patients_revoke_relationship', {
      patientRef: adult,
      relationshipRef: relRef,
      expectedVersion: 1,
      reasonCode: 'patient_request',
      idempotencyKey: randomUUID(),
    });
    expect(viaTool.isError).not.toBe(true);
    const restDenied = await updateOnBehalf(adult, proxy, 1);
    const mcpDenied = await tool('patients_update_demographics', {
      patientRef: adult,
      expectedVersion: 1,
      requestedBy: proxy,
      pronouns: { known: true, value: 'they/them' },
      idempotencyKey: randomUUID(),
    });
    expect(restDenied.statusCode).toBe(403);
    expect(mcpDenied.isError).toBe(true);
    const { correlationId: rc, ...restBody } = restDenied.json();
    const { correlationId: mc, ...mcpBody } = mcpDenied.structuredContent as Record<string, unknown>;
    expect(mcpBody).toStrictEqual(restBody);
    expect(restBody).toStrictEqual({
      code: 'forbidden',
      retryable: false,
      detail: { reason: 'relationship_revoked' },
    });
    for (const c of [rc, mc]) {
      const { rows } = await db.admin.query(
        'SELECT operation, reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
        [c],
      );
      expect(rows).toStrictEqual([
        { operation: 'patients.updateDemographics', reason_code: 'relationship_revoked' },
      ]);
    }
    const mcpRead = await tool('patients_get', { patientRef: adult, requestedBy: proxy });
    expect((mcpRead.structuredContent as { code: string }).code).toBe('forbidden');
    expect(await version(adult)).toBe(1);
  });

  it('5. a relationship naming another tenant patient is refused and writes nothing', async () => {
    const subject = await patient('a1', 'Synthetic Subject Alpha');
    const foreign = await patient('b1', 'Synthetic Patient Beta');
    const before = (await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.patient_relationships'))
      .rows[0].n;
    const res = await addRel(subject, {
      counterpartyRef: foreign,
      kind: 'guardian',
      scopes: ['demographics'],
    });
    const missing = await addRel(subject, {
      counterpartyRef: randomUUID(),
      kind: 'guardian',
      scopes: ['demographics'],
    });
    expect(res.statusCode).toBe(404);
    const { correlationId: _a, ...one } = res.json();
    const { correlationId: _b, ...two } = missing.json();
    expect(one).toStrictEqual(two);
    // The other direction: beta cannot attach to an alpha subject either.
    expect(
      (await addRel(subject, { counterpartyRef: foreign, kind: 'guardian', scopes: ['demographics'] }, 'b1'))
        .statusCode,
    ).toBe(404);
    expect(
      (await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.patient_relationships')).rows[0].n,
    ).toBe(before);
    expect(await version(subject)).toBe(1);
  });

  it('6. two active guardians are allowed; a second exclusive guarantor is a typed conflict', async () => {
    const minor = await patient('a1', 'Synthetic Minor Two Guardians', MINOR_BIRTH);
    const g1 = await patient('a1', 'Synthetic Guardian A');
    const g2 = await patient('a1', 'Synthetic Guardian B');
    expect(
      (await addRel(minor, { counterpartyRef: g1, kind: 'guardian', scopes: ['demographics', 'consent'] }))
        .statusCode,
    ).toBe(201);
    expect(
      (await addRel(minor, { counterpartyRef: g2, kind: 'guardian', scopes: ['demographics'] })).statusCode,
    ).toBe(201);
    const first = await addRel(minor, { counterpartyRef: g1, kind: 'guarantor', scopes: ['financial'] });
    expect(first.statusCode).toBe(201);
    const second = await addRel(minor, { counterpartyRef: g2, kind: 'guarantor', scopes: ['financial'] });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      code: 'conflict',
      detail: {
        reason: 'exclusive_guarantor_exists',
        blockingRefs: [{ kind: 'patientRelationship', ref: first.json().data.relationshipRef }],
      },
    });
    const list = (await call('a1', 'GET', `/v1/patients/${minor}/relationships`)).json().data;
    expect(list.map((r: { kind: string }) => r.kind).sort()).toStrictEqual([
      'guarantor',
      'guardian',
      'guardian',
    ]);
  });
});

describe('S5 rules from ADR 0003 (pending approval)', () => {
  it('scopes per kind, proxy time-boxing and guardian age of majority are enforced', async () => {
    const minor = await patient('a1', 'Synthetic Minor Rules', MINOR_BIRTH);
    const adult = await patient('a1', 'Synthetic Adult Rules');
    const other = await patient('a1', 'Synthetic Other Rules');
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const cases: [object, number, string | undefined][] = [
      [
        { counterpartyRef: other, kind: 'guarantor', scopes: ['demographics'] },
        422,
        'scope_not_allowed_for_kind',
      ],
      [{ counterpartyRef: other, kind: 'guardian', scopes: [] }, 422, 'scope_required'],
      [
        { counterpartyRef: other, kind: 'dependent', scopes: ['financial'] },
        422,
        'scope_not_allowed_for_kind',
      ],
      [{ counterpartyRef: other, kind: 'proxy', scopes: ['demographics'] }, 422, 'proxy_requires_end'],
      [
        {
          counterpartyRef: other,
          kind: 'proxy',
          scopes: ['demographics'],
          effectiveUntil: new Date(Date.now() + 400 * 86_400_000).toISOString(),
        },
        422,
        'proxy_window_too_long',
      ],
      [
        {
          counterpartyRef: other,
          kind: 'proxy',
          scopes: ['demographics'],
          effectiveUntil: '2020-01-01T00:00:00Z',
        },
        422,
        'window_already_ended',
      ],
      [{ counterpartyRef: minor, kind: 'guardian', scopes: ['demographics'] }, 422, 'self_relationship'],
      [
        { counterpartyRef: other, kind: 'guardian', scopes: ['demographics', 'demographics'] },
        400,
        undefined,
      ],
      [{ counterpartyRef: other, kind: 'guardian', scopes: ['clinical.sign'] }, 400, undefined],
      [{ counterpartyRef: other, kind: 'parent', scopes: ['demographics'] }, 400, undefined],
    ];
    for (const [body, status, reason] of cases) {
      const res = await addRel(minor, body);
      expect([JSON.stringify(body), res.statusCode]).toStrictEqual([JSON.stringify(body), status]);
      if (reason) expect(res.json().detail.reason).toBe(reason);
    }
    // An adult subject cannot get a new guardian; a coarse birth date fails closed.
    const adultGuardian = await addRel(adult, {
      counterpartyRef: other,
      kind: 'guardian',
      scopes: ['demographics'],
    });
    expect(adultGuardian.json().detail?.reason).toBe('subject_reached_majority');
    const unknownBirth = await patient('a1', 'Synthetic Unknown Birth', { known: false, reason: 'declined' });
    expect(
      (
        await addRel(unknownBirth, { counterpartyRef: other, kind: 'guardian', scopes: ['demographics'] })
      ).json().detail.reason,
    ).toBe('guardian_requires_birth_date_or_end');
    expect(
      (
        await addRel(unknownBirth, {
          counterpartyRef: other,
          kind: 'guardian',
          scopes: ['demographics'],
          effectiveUntil: soon,
        })
      ).statusCode,
    ).toBe(201);
    // Per-tenant configuration: lowering the age of majority ends the guardian authority now.
    const g = await addRel(minor, { counterpartyRef: other, kind: 'guardian', scopes: ['demographics'] });
    expect(g.statusCode).toBe(201);
    await db.admin.query(
      'INSERT INTO cuspatlas.patient_policy_settings (tenant_id, age_of_majority_years) VALUES ($1, 5)',
      [T_ALPHA],
    );
    try {
      const a = (await access(minor, other)).json().data;
      expect(a).toMatchObject({ scopes: [], reason: 'relationship_expired' });
      expect(a.relationships[0]).toMatchObject({
        status: 'expired',
        statusReason: 'age_of_majority_reached',
      });
    } finally {
      await db.admin.query('DELETE FROM cuspatlas.patient_policy_settings WHERE tenant_id = $1', [T_ALPHA]);
    }
  });

  it('a future grant is pending until it starts', async () => {
    const minor = await patient('a1', 'Synthetic Minor Pending', MINOR_BIRTH);
    const g = await patient('a1', 'Synthetic Guardian Pending');
    const start = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      (
        await addRel(minor, {
          counterpartyRef: g,
          kind: 'guardian',
          scopes: ['demographics'],
          effectiveFrom: start,
        })
      ).statusCode,
    ).toBe(201);
    expect((await access(minor, g)).json().data).toMatchObject({
      scopes: [],
      reason: 'relationship_pending',
    });
    expect((await readOnBehalf(minor, g)).json().detail).toStrictEqual({ reason: 'relationship_pending' });
    const none = await patient('a1', 'Synthetic Stranger');
    expect((await readOnBehalf(minor, none)).json().detail).toStrictEqual({ reason: 'relationship_missing' });
  });
});

describe('S5 clock skew (clock audit)', () => {
  // The default effectiveFrom was the application clock while access is evaluated at the database
  // clock: with the host clock ahead, a relationship added a moment ago was still pending.
  for (const skewMs of [5_000, -5_000]) {
    it(`a relationship added without effectiveFrom is active at once (app clock ${skewMs > 0 ? 'ahead' : 'behind'} 5 s)`, async () => {
      const minor = await patient('a1', 'Synthetic Minor Skew', MINOR_BIRTH);
      const g = await patient('a1', 'Synthetic Guardian Skew');
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skewMs });
      try {
        const res = await addRel(minor, { counterpartyRef: g, kind: 'guardian', scopes: ['demographics'] });
        expect(res.statusCode).toBe(201);
        expect((await access(minor, g)).json().data).toMatchObject({ scopes: ['demographics'] });
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

describe('S5 failure and recovery', () => {
  it('1. expiry uses the server clock; no caller can supply a clock or extend a window', async () => {
    const subject = await patient('a1', 'Synthetic Subject Clock');
    const proxy = await patient('a1', 'Synthetic Proxy Clock');
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const rel = (
      await addRel(subject, {
        counterpartyRef: proxy,
        kind: 'proxy',
        scopes: ['demographics'],
        effectiveUntil: until,
      })
    ).json().data;
    for (const q of ['asOf=2020-01-01T00:00:00Z', 'now=2020-01-01T00:00:00Z']) {
      const r = await call('a1', 'GET', `/v1/patients/${subject}/access?counterpartyRef=${proxy}&${q}`);
      expect(r.statusCode).toBe(400);
    }
    const extend = await call(
      'a1',
      'POST',
      `/v1/patients/${subject}/relationships/${rel.relationshipRef}/revoke`,
      {
        expectedVersion: 1,
        reasonCode: 'other',
        effectiveUntil: '2999-01-01T00:00:00Z',
      },
    );
    expect(extend.statusCode).toBe(400);
    // The runtime role cannot rewrite a window even with direct SQL inside a tenant transaction.
    let sqlstate = 'none';
    try {
      await tx()(staff(), (t) =>
        t.query(`UPDATE cuspatlas.patient_relationships SET effective_until = '2999-01-01' WHERE id = $1`, [
          rel.relationshipRef,
        ]),
      );
    } catch (err) {
      sqlstate = (err as { code?: string }).code ?? 'unknown';
    }
    expect(sqlstate).toBe('42501');
    let deleted = 'none';
    try {
      await tx()(staff(), (t) =>
        t.query('DELETE FROM cuspatlas.patient_relationships WHERE id = $1', [rel.relationshipRef]),
      );
    } catch (err) {
      deleted = (err as { code?: string }).code ?? 'unknown';
    }
    expect(deleted).toBe('42501');
  });

  it('2. revocation racing an open command fails closed at the next authorization check; the committed command stays', async () => {
    const minor = await patient('a1', 'Synthetic Minor Race', MINOR_BIRTH);
    const guardian = await patient('a1', 'Synthetic Guardian Race');
    const rel = (
      await addRel(minor, { counterpartyRef: guardian, kind: 'guardian', scopes: ['demographics'] })
    ).json().data;
    const committed = await updateOnBehalf(minor, guardian, 1);
    expect(committed.statusCode).toBe(200);
    // A revocation is in flight (row locked, not yet committed) when the next command arrives.
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE cuspatlas.patient_relationships SET revoked_at = now(), revoked_by = $2, revoke_reason = 'guardian_request',
           version = version + 1, updated_at = now() WHERE id = $1`,
        [rel.relationshipRef, USER_A1],
      );
      const racing = updateOnBehalf(minor, guardian, 2);
      await new Promise((r) => setTimeout(r, 300));
      await client.query('COMMIT');
      const res = await racing;
      expect(res.statusCode).toBe(403);
      expect(res.json().detail).toStrictEqual({ reason: 'relationship_revoked' });
    } finally {
      client.release();
    }
    // The command that committed before the revocation is retained and audited, not rewritten.
    const audit = await db.admin.query(
      `SELECT operation, resource_version FROM cuspatlas.audit_events WHERE resource_ref = $1 ORDER BY resource_version`,
      [minor],
    );
    expect(audit.rows).toStrictEqual([
      { operation: 'patients.create', resource_version: 1 },
      { operation: 'patients.updateDemographics', resource_version: 2 },
    ]);
    expect(await version(minor)).toBe(2);
  });
});

describe('S5 audit, idempotency and privacy', () => {
  it('relationship commands are audited and replayable; references only reach audit and idempotency rows', async () => {
    const minor = await patient('a1', `Synthetic Minor ${MARKER}`, MINOR_BIRTH);
    const guardian = await patient('a1', `Synthetic Guardian ${MARKER}`);
    const key = randomUUID();
    const body = {
      counterpartyRef: guardian,
      kind: 'guardian',
      scopes: ['demographics'],
      evidenceRef: 'synthetic-evidence-2',
    };
    const first = await app.inject({
      method: 'POST',
      url: `/v1/patients/${minor}/relationships`,
      headers: {
        authorization: `Bearer ${tokens.a1}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      payload: JSON.stringify(body),
    });
    const again = await app.inject({
      method: 'POST',
      url: `/v1/patients/${minor}/relationships`,
      headers: {
        authorization: `Bearer ${tokens.a1}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      payload: JSON.stringify(body),
    });
    expect(first.statusCode).toBe(201);
    expect(again.json().replayed).toBe(true);
    expect(again.json().data).toStrictEqual(first.json().data);
    const ref = first.json().data.relationshipRef;
    const audit = await db.admin.query(
      'SELECT operation, resource_type FROM cuspatlas.audit_events WHERE resource_ref = $1',
      [ref],
    );
    expect(audit.rows).toStrictEqual([
      { operation: 'patients.relationships.add', resource_type: 'patientRelationship' },
    ]);
    await updateOnBehalf(minor, guardian, 1);
    await readOnBehalf(minor, guardian);
    expect(logLines.join('\n')).not.toContain(MARKER);
    expect(await leakSurface(db.admin)).not.toContain(MARKER);
    const reads = await db.admin.query(
      `SELECT query_fields FROM cuspatlas.sensitive_read_events WHERE operation = 'patients.read' AND $1 = ANY (resource_refs)`,
      [minor],
    );
    expect(reads.rows).toStrictEqual([{ query_fields: ['requestedBy'] }]);
  });
});
