import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import { isRefusalError } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  createAuthorize,
  createMergeConfirmationCodec,
  createPatientService,
  MERGE_EXCLUDED_REFERENCES,
  MERGE_RECORD_CLASSES,
  SYNTHETIC_TEST_MATCH_KEY_PEPPER,
} from '@cuspatlas/domain';
import { buildMcpServer, type McpServerHandle } from '@cuspatlas/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, SVC_A1, seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_A4, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';
import {
  leakSurface,
  PATIENT_ALL,
  PATIENT_RW,
  patientBody,
  phone,
  seedPatientScopes,
  USER_A6,
} from './support/patient-fixtures';
import { createTestTokenIssuer, TEST_AUDIENCE, type TestTokenIssuer } from './support/test-token-issuer';

const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';
const MINOR_BIRTH = { known: true, value: '2016-05-05', precision: 'day' };

let db: TestDatabase;
let issuer: TestTokenIssuer;
let app: FastifyInstance;
let mcp: McpServerHandle;
let mcpUrl: string;
let logLines: string[];
const tokens: Record<string, string> = {};

beforeAll(async () => {
  db = await openTestDatabase('patient_merge');
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
  tokens.a1 = await issuer.issue({ sub: USER_A1, tid: T_ALPHA });
  tokens.a4 = await issuer.issue({ sub: USER_A4, tid: T_ALPHA });
  tokens.a6 = await issuer.issue({ sub: USER_A6, tid: T_ALPHA });
  tokens.svcA1 = await issuer.issue({ sub: SVC_A1, tid: T_ALPHA });
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

async function patient(given: string, overrides: Record<string, unknown> = {}, who = 'a1'): Promise<string> {
  const res = await call(who, 'POST', '/v1/patients', patientBody(given, overrides));
  expect(res.statusCode).toBe(201);
  return res.json().data.patientRef;
}

async function relate(subject: string, counterparty: string, kind = 'guardian', scopes = ['demographics']) {
  const res = await call('a1', 'POST', `/v1/patients/${subject}/relationships`, {
    counterpartyRef: counterparty,
    kind,
    scopes,
  });
  expect(res.statusCode).toBe(201);
  return res.json().data.relationshipRef as string;
}

const candidates = (ref: string, who = 'a1') => call(who, 'GET', `/v1/patients/${ref}/duplicate-candidates`);
const history = (ref: string, who = 'a1') => call(who, 'GET', `/v1/patients/${ref}/merge-history`);
const unmerge = (mergeRef: string, body: object, who = 'a1') =>
  call(who, 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, body);

async function tokenFor(target: string, candidate: string, who = 'a1'): Promise<string> {
  const res = await candidates(target, who);
  expect(res.statusCode).toBe(200);
  const c = res.json().data.find((x: { candidateRef: string }) => x.candidateRef === candidate);
  expect(c).toBeDefined();
  return c.confirmationToken;
}

async function merge(
  survivor: string,
  merged: string,
  who = 'a1',
  token?: string,
): Promise<LightMyRequestResponse> {
  const confirmationToken = token ?? (await tokenFor(survivor, merged));
  return call(who, 'POST', '/v1/patients/merges', {
    survivorRef: survivor,
    mergedRef: merged,
    confirmationToken,
    reasonCode: 'duplicate_registration',
  });
}

/** A duplicate pair that qualifies: same legal name, same birth date, shared phone. */
async function duplicatePair(given: string): Promise<[string, string]> {
  const contact = {
    contact: { known: true, points: [phone(`+1 555 01${String(Math.floor(Math.random() * 90) + 10)} 300`)] },
  };
  const a = await patient(given, contact);
  const b = await patient(given, contact);
  return [a, b];
}

async function count(table: string, where = 'true', values: unknown[] = []): Promise<number> {
  return (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${table} WHERE ${where}`, values))
    .rows[0].n;
}

async function relOwner(rel: string) {
  return (
    await db.admin.query(
      'SELECT subject_patient_id, counterparty_patient_id FROM cuspatlas.patient_relationships WHERE id = $1',
      [rel],
    )
  ).rows[0];
}

// Review hardening: revocation columns are lifecycle, not content (a later revocation never blocks unmerge).
const RELATIONSHIP_DIGEST = `encode(sha256(convert_to((to_jsonb(r) - 'subject_patient_id' - 'counterparty_patient_id'
  - 'revoked_at' - 'revoked_by' - 'revoke_reason' - 'version' - 'updated_at')::text, 'UTF8')), 'hex')`;

describe('S6 acceptance', () => {
  it('1. candidates show reasons and write nothing; shared phone or household never qualifies alone (pairs P1, P2)', async () => {
    const [a, b] = await duplicatePair('Synthetic Duplicate One');
    const household = {
      contact: { known: true, points: [phone('+1 555 0177 001')] },
      address: {
        known: true,
        lines: ['7 Synthetic Lane'],
        city: 'Synthville',
        postalCode: '00007',
        country: 'US',
      },
    };
    const h1 = await patient('Synthetic Household Alpha', household);
    const h2 = await patient('Synthetic Household Beta', {
      ...household,
      birthDate: { known: true, value: '1975-03-04', precision: 'day' },
    });
    const twin1 = await patient('Synthetic Patient Twin', {
      birthDate: { known: true, value: '2003-02-03', precision: 'day' },
    });
    const twin2 = await patient('Synthetic Patient Twin', {
      birthDate: { known: true, value: '1973-02-03', precision: 'day' },
    });
    const before = [await count('audit_events'), await count('outbox_events'), await count('patient_merges')];
    const res = await candidates(a);
    expect(res.statusCode).toBe(200);
    const list = res.json().data;
    expect(list.map((c: { candidateRef: string }) => c.candidateRef)).toStrictEqual([b]);
    expect(list[0].reasons.sort()).toStrictEqual(['same_birth_date', 'same_legal_name', 'same_phone']);
    expect(list[0].score).toBe(85);
    expect(list[0].summary).toMatchObject({ patientRef: b });
    expect(Object.keys(list[0].summary)).not.toContain('contact');
    expect(res.json()).toMatchObject({ minScore: 40 });
    // P1: shared phone and address never produce a candidate on their own.
    expect((await candidates(h1)).json().data).toStrictEqual([]);
    expect((await candidates(h2)).json().data).toStrictEqual([]);
    // P2: same name, different birth date: below the default threshold, listed with reasons when lowered.
    expect((await candidates(twin1)).json().data).toStrictEqual([]);
    await db.admin.query(
      'INSERT INTO cuspatlas.patient_policy_settings (tenant_id, candidate_min_score) VALUES ($1, 5)',
      [T_ALPHA],
    );
    try {
      const low = (await candidates(twin1)).json().data;
      expect(low).toHaveLength(1);
      expect(low[0]).toMatchObject({ candidateRef: twin2, score: 10 });
      expect(low[0].reasons.sort()).toStrictEqual(['birth_date_conflict', 'same_legal_name']);
    } finally {
      await db.admin.query('DELETE FROM cuspatlas.patient_policy_settings WHERE tenant_id = $1', [T_ALPHA]);
    }
    expect([
      await count('audit_events'),
      await count('outbox_events'),
      await count('patient_merges'),
    ]).toStrictEqual(before);
    for (const ref of [a, b, h1, h2, twin1, twin2]) {
      expect(
        (await db.admin.query('SELECT version, merged_into FROM cuspatlas.patients WHERE id = $1', [ref]))
          .rows[0],
      ).toStrictEqual({
        version: 1,
        merged_into: null,
      });
    }
  });

  it('2-3. a merge moves every enumerated record, leaves one survivor, and the result count equals the history count', async () => {
    const [survivor, merged] = await duplicatePair('Synthetic Duplicate Two');
    const minor = await patient('Synthetic Minor Of Merged', { birthDate: MINOR_BIRTH });
    const dependentOf = await patient('Synthetic Subject Of Merged');
    const asCounterparty = await relate(minor, merged, 'guardian', ['demographics', 'scheduling']);
    const asSubject = await relate(merged, dependentOf, 'guarantor', ['financial']);
    const res = await merge(survivor, merged);
    expect(res.statusCode).toBe(201);
    const result = res.json().data;
    expect(result).toMatchObject({
      survivorRef: survivor,
      mergedRef: merged,
      state: 'merged',
      moveCount: 2,
      reversedAt: null,
    });
    expect(
      result.moves
        .map((m: Record<string, string>) => [
          m.recordClass,
          m.recordRef,
          m.referenceField,
          m.priorPatientRef,
          m.newPatientRef,
        ])
        .sort(),
    ).toStrictEqual(
      [
        ['patientRelationship', asCounterparty, 'counterpartyRef', merged, survivor],
        ['patientRelationship', asSubject, 'subjectRef', merged, survivor],
      ].sort(),
    );
    expect(await relOwner(asCounterparty)).toStrictEqual({
      subject_patient_id: minor,
      counterparty_patient_id: survivor,
    });
    expect(await relOwner(asSubject)).toStrictEqual({
      subject_patient_id: survivor,
      counterparty_patient_id: dependentOf,
    });
    // One survivor: the merged record is reachable only through merge history.
    const read = await call('a1', 'GET', `/v1/patients/${merged}`);
    expect(read.statusCode).toBe(409);
    expect(read.json().detail).toStrictEqual({ reason: 'patient_merged' });
    const found = await call('a1', 'POST', '/v1/patients/search', { name: 'Synthetic Duplicate Two' }, false);
    expect(found.json().data.map((p: { patientRef: string }) => p.patientRef)).toStrictEqual([survivor]);
    for (const ref of [survivor, merged]) {
      const h = (await history(ref)).json().data;
      expect(h).toHaveLength(1);
      expect(h[0].mergeRef).toBe(result.mergeRef);
      expect(h[0].moveCount).toBe(result.moveCount);
      expect(h[0].moves).toHaveLength(result.moves.length);
      expect(h[0].moves).toStrictEqual(result.moves);
    }
    expect(await count('patient_merge_moves', 'merge_id = $1', [result.mergeRef])).toBe(2);
    // Both source identifiers are preserved: the merged row is kept and points at the survivor.
    const rows = await db.admin.query(
      'SELECT id, merged_into FROM cuspatlas.patients WHERE id = ANY ($1::uuid[]) ORDER BY id',
      [[survivor, merged]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((r) => r.id === merged)?.merged_into).toBe(survivor);
    // The survivor keeps working: the relinked guardian authority now names the survivor.
    const access = (
      await call('a1', 'GET', `/v1/patients/${minor}/access?counterpartyRef=${survivor}`)
    ).json().data;
    expect(access).toMatchObject({ reason: 'relationship_active', scopes: ['demographics', 'scheduling'] });
    // S5 failure 3: the counterparty's relationship history shows the relinked relationship.
    const rels = (await call('a1', 'GET', `/v1/patients/${survivor}/relationships`)).json().data;
    expect(rels.map((r: { relationshipRef: string }) => r.relationshipRef).sort()).toStrictEqual(
      [asCounterparty, asSubject].sort(),
    );
    const audit = await db.admin.query(
      `SELECT resource_type, count(*)::int AS n FROM cuspatlas.audit_events WHERE operation = 'patients.merge'
       AND correlation_id = $1 GROUP BY resource_type ORDER BY resource_type`,
      [res.headers['x-correlation-id']],
    );
    expect(audit.rows).toStrictEqual([
      { resource_type: 'patient', n: 2 },
      { resource_type: 'patientMerge', n: 1 },
      { resource_type: 'patientRelationship', n: 2 },
    ]);
  });

  it('4. a merge without a valid confirmation, or by a role without the merge scope, is a typed denial', async () => {
    const [survivor, merged] = await duplicatePair('Synthetic Duplicate Four');
    const other = await patient('Synthetic Unrelated Four');
    const good = await tokenFor(survivor, merged);
    const tampered = `${good.slice(0, -2)}${good.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const token of [tampered, 'v1.0000000000.1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']) {
      const r = await merge(survivor, merged, 'a1', token);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ code: 'forbidden', detail: { reason: 'confirmation_invalid' } });
    }
    // A token is for one exact pair.
    const wrongPair = await merge(survivor, other, 'a1', good);
    expect(wrongPair.json().detail).toStrictEqual({ reason: 'confirmation_invalid' });
    // A token is for the reviewer who received it.
    expect((await merge(survivor, merged, 'a6', good)).json().detail).toStrictEqual({
      reason: 'confirmation_invalid',
    });
    const missing = await call('a1', 'POST', '/v1/patients/merges', {
      survivorRef: survivor,
      mergedRef: merged,
      reasonCode: 'other',
    });
    expect(missing.statusCode).toBe(400);
    expect((await merge(survivor, merged, 'a4', good)).statusCode).toBe(403);
    const svc = await merge(survivor, merged, 'svcA1', good);
    expect(svc.statusCode).toBe(403);
    const reason = await db.admin.query(
      'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [svc.headers['x-correlation-id']],
    );
    expect(reason.rows).toStrictEqual([{ reason_code: 'principal_kind_denied' }]);
    // A reviewed pair changed after review: the token is stale.
    const upd = await call('a1', 'POST', `/v1/patients/${merged}/demographics`, {
      expectedVersion: 1,
      pronouns: { known: true, value: 'she/her' },
    });
    expect(upd.statusCode).toBe(200);
    const stale = await merge(survivor, merged, 'a1', good);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().detail).toStrictEqual({ reason: 'confirmation_stale' });
    expect(await count('patient_merges', 'merged_patient_id = $1', [merged])).toBe(0);
    // Candidates (and their tokens) need the merge scope.
    expect((await candidates(survivor, 'a4')).statusCode).toBe(403);
    const a6 = await merge(survivor, merged, 'a6', await tokenFor(survivor, merged, 'a6'));
    expect(a6.statusCode).toBe(201);
  });

  it('5. a cross-tenant merge is refused without confirming the other patient exists', async () => {
    const survivor = await patient('Synthetic Cross Survivor');
    const foreign = await patient('Synthetic Cross Survivor', {}, 'b1');
    const token = 'v1.9999999999.1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const strip = (r: LightMyRequestResponse) => {
      const { correlationId: _c, ...rest } = r.json();
      return rest;
    };
    const cross = await merge(survivor, foreign, 'a1', token);
    const absent = await merge(survivor, randomUUID(), 'a1', token);
    expect(cross.statusCode).toBe(absent.statusCode);
    expect(strip(cross)).toStrictEqual(strip(absent));
    expect([403, 404]).toContain(cross.statusCode);
    expect((await candidates(survivor)).json().data).toStrictEqual([]);
    expect((await candidates(foreign, 'a1')).statusCode).toBe(404);
    expect((await history(foreign, 'a1')).statusCode).toBe(404);
    expect(await count('patient_merges', 'merged_patient_id = $1', [foreign])).toBe(0);
  });

  it('6. unmerge inside the window restores the prior links; outside it the refusal names the reason', async () => {
    const [survivor, merged] = await duplicatePair('Synthetic Duplicate Six');
    const minor = await patient('Synthetic Minor Six', { birthDate: MINOR_BIRTH });
    const rel = await relate(minor, merged);
    const m = (await merge(survivor, merged)).json().data;
    expect((await relOwner(rel)).counterparty_patient_id).toBe(survivor);
    const back = await unmerge(m.mergeRef, { reasonCode: 'merged_in_error' }, 'a6');
    expect(back.statusCode).toBe(200);
    expect(back.json().data).toMatchObject({ mergeRef: m.mergeRef, state: 'reversed', moveCount: 1 });
    expect(back.json().data.reversal).toMatchObject({ reasonCode: 'merged_in_error', elevated: false });
    expect((await relOwner(rel)).counterparty_patient_id).toBe(merged);
    expect((await call('a1', 'GET', `/v1/patients/${merged}`)).statusCode).toBe(200);
    // The merge link is kept; a reversal link is appended.
    const h = (await history(merged)).json().data;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ state: 'reversed', moveCount: 1 });
    expect(await count('patient_merges', 'id = $1', [m.mergeRef])).toBe(1);
    expect(await count('patient_merge_reversals', 'merge_id = $1', [m.mergeRef])).toBe(1);
    expect((await unmerge(m.mergeRef, { reasonCode: 'merged_in_error' })).json().detail).toStrictEqual({
      reason: 'merge_already_reversed',
    });

    // Outside the window (tenant window 0 days): the ordinary merge role is refused with the reason.
    const [s2, m2] = await duplicatePair('Synthetic Duplicate Six B');
    const second = (await merge(s2, m2)).json().data;
    await db.admin.query(
      'INSERT INTO cuspatlas.patient_policy_settings (tenant_id, unmerge_window_days) VALUES ($1, 0)',
      [T_ALPHA],
    );
    try {
      const refused = await unmerge(second.mergeRef, { reasonCode: 'merged_in_error' }, 'a6');
      expect(refused.statusCode).toBe(403);
      expect(refused.json().detail).toStrictEqual({ reason: 'unmerge_requires_reconciliation_review' });
      const noReview = await unmerge(second.mergeRef, { reasonCode: 'reconciliation_review' }, 'a1');
      expect(noReview.statusCode).toBe(422);
      expect(noReview.json().detail).toStrictEqual({ reason: 'reconciliation_review_required' });
      const elevated = await unmerge(
        second.mergeRef,
        { reasonCode: 'reconciliation_review', reconciliationReviewRef: 'synthetic-review-6' },
        'a1',
      );
      expect(elevated.statusCode).toBe(200);
      expect(elevated.json().data.reversal).toMatchObject({
        elevated: true,
        reconciliationReviewRef: 'synthetic-review-6',
      });
    } finally {
      await db.admin.query('DELETE FROM cuspatlas.patient_policy_settings WHERE tenant_id = $1', [T_ALPHA]);
    }
  });

  it('7. merge only relinks references: every moved record keeps its content digest', async () => {
    const [survivor, merged] = await duplicatePair('Synthetic Duplicate Seven');
    const minor = await patient('Synthetic Minor Seven', { birthDate: MINOR_BIRTH });
    const rel = await relate(minor, merged, 'guardian', ['demographics', 'consent']);
    const digest = async () =>
      (
        await db.admin.query(
          `SELECT ${RELATIONSHIP_DIGEST} AS d FROM cuspatlas.patient_relationships r WHERE id = $1`,
          [rel],
        )
      ).rows[0].d;
    const before = await digest();
    const m = (await merge(survivor, merged)).json().data;
    expect(await digest()).toBe(before);
    const moves = await db.admin.query(
      'SELECT content_digest_before, content_digest_after FROM cuspatlas.patient_merge_moves WHERE merge_id = $1',
      [m.mergeRef],
    );
    expect(moves.rows).toStrictEqual([{ content_digest_before: before, content_digest_after: before }]);
    // Structural guarantees: the registry names only reference columns, and every foreign key to
    // patients is either a registered merge reference or an explicit exclusion.
    const fks = await db.admin.query(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'cuspatlas.patients'::regclass ORDER BY 1, 2`,
    );
    const known = new Set([
      ...MERGE_RECORD_CLASSES.map((r) => `cuspatlas.${r.table}.${r.column}`),
      ...MERGE_EXCLUDED_REFERENCES.map((r) => `cuspatlas.${r.table}.${r.column}`),
    ]);
    for (const fk of fks.rows) expect(known).toContain(`${fk.tbl}.${fk.col}`);
    expect(MERGE_RECORD_CLASSES.every((r) => r.column.endsWith('_patient_id'))).toBe(true);
    // A move whose digest changed is refused by the database itself.
    let code = 'none';
    try {
      await db.admin.query(
        `INSERT INTO cuspatlas.patient_merge_moves (tenant_id, merge_id, record_class, record_ref, reference_column,
           prior_patient_id, new_patient_id, content_digest_before, content_digest_after)
         VALUES ($1, $2, 'patientRelationship', $3, 'subject_patient_id', $4, $5, repeat('a', 64), repeat('b', 64))`,
        [T_ALPHA, m.mergeRef, rel, merged, survivor],
      );
    } catch (err) {
      code = (err as { code?: string }).code ?? 'unknown';
    }
    expect(code).toBe('23514');
  });
});

describe('S6 failure and recovery', () => {
  it('1. a merge failing partway rolls back every re-point, the merge link, audit and outbox', async () => {
    const [survivor, merged] = await duplicatePair('Synthetic Duplicate Rollback');
    const minor = await patient('Synthetic Minor Rollback', { birthDate: MINOR_BIRTH });
    const rel = await relate(minor, merged);
    const token = await tokenFor(survivor, merged);
    const before = [await count('audit_events'), await count('outbox_events'), await count('patient_merges')];
    await db.admin.query('REVOKE INSERT ON cuspatlas.patient_merge_moves FROM cuspatlas_app');
    try {
      const res = await merge(survivor, merged, 'a1', token);
      expect(res.statusCode).toBe(500);
    } finally {
      await db.admin.query('GRANT INSERT ON cuspatlas.patient_merge_moves TO cuspatlas_app');
    }
    expect([
      await count('audit_events'),
      await count('outbox_events'),
      await count('patient_merges'),
    ]).toStrictEqual(before);
    expect((await relOwner(rel)).counterparty_patient_id).toBe(merged);
    expect(
      (await db.admin.query('SELECT merged_into, version FROM cuspatlas.patients WHERE id = $1', [merged]))
        .rows[0],
    ).toStrictEqual({
      merged_into: null,
      version: 1,
    });
    expect((await merge(survivor, merged, 'a1', token)).statusCode).toBe(201);
  });

  it('2. two concurrent merges over overlapping patients: one commits, one typed conflict, nothing re-pointed twice', async () => {
    const contact = { contact: { known: true, points: [phone('+1 555 0199 222')] } };
    const a = await patient('Synthetic Overlap', contact);
    const b = await patient('Synthetic Overlap', contact);
    const c = await patient('Synthetic Overlap', contact);
    const minor = await patient('Synthetic Minor Overlap', { birthDate: MINOR_BIRTH });
    const rel = await relate(minor, b);
    const tAB = await tokenFor(a, b);
    const tCB = await tokenFor(c, b);
    const [r1, r2] = await Promise.all([merge(a, b, 'a1', tAB), merge(c, b, 'a1', tCB)]);
    expect([r1.statusCode, r2.statusCode].sort()).toStrictEqual([201, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    expect(['patient_already_merged', 'confirmation_stale']).toContain(loser.json().detail.reason);
    expect(await count('patient_merges', 'merged_patient_id = $1', [b])).toBe(1);
    expect(await count('patient_merge_moves', 'record_ref = $1', [rel])).toBe(1);
    // Overlapping sets: b is merged, so c cannot absorb it, but c can merge into the survivor.
    const winner = r1.statusCode === 201 ? a : c;
    const other = winner === a ? c : a;
    expect((await relOwner(rel)).counterparty_patient_id).toBe(winner);
    expect((await merge(winner, other)).statusCode).toBe(201);
    const h = (await history(winner)).json().data;
    expect(h).toHaveLength(2);
  });

  it('3. a merge with a record that cannot be re-pointed fails before any write and lists the blocking references', async () => {
    const [survivor, merged] = await duplicatePair('Synthetic Duplicate Blocked');
    // The two records are related to each other: relinking would make a self-relationship.
    const between = await relate(survivor, merged, 'guarantor', ['financial']);
    const token = await tokenFor(survivor, merged);
    const before = [
      await count('audit_events'),
      await count('patient_merges'),
      await count('patient_merge_moves'),
    ];
    const res = await merge(survivor, merged, 'a1', token);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toStrictEqual({
      reason: 'merge_blocked',
      blockingRefs: [{ kind: 'patientRelationship', ref: between }],
    });
    expect([
      await count('audit_events'),
      await count('patient_merges'),
      await count('patient_merge_moves'),
    ]).toStrictEqual(before);
    expect(await relOwner(between)).toStrictEqual({
      subject_patient_id: survivor,
      counterparty_patient_id: merged,
    });
    // Two unrevoked guardians that would collapse into one duplicate also block.
    const [s2, m2] = await duplicatePair('Synthetic Duplicate Blocked B');
    const minor = await patient('Synthetic Minor Blocked', { birthDate: MINOR_BIRTH });
    const g1 = await relate(minor, s2);
    const g2 = await relate(minor, m2);
    const blocked = await merge(s2, m2);
    expect(blocked.json().detail.reason).toBe('merge_blocked');
    expect(blocked.json().detail.blockingRefs.map((x: { ref: string }) => x.ref)).toStrictEqual([g2]);
    expect((await relOwner(g1)).counterparty_patient_id).toBe(s2);
  });

  it('4. merging an already-merged patient requires resolving the prior merge first', async () => {
    const contact = { contact: { known: true, points: [phone('+1 555 0188 444')] } };
    const a = await patient('Synthetic Chain', contact);
    const b = await patient('Synthetic Chain', contact);
    const c = await patient('Synthetic Chain', contact);
    const tCB = await tokenFor(c, b);
    expect((await merge(a, b)).statusCode).toBe(201);
    const again = await merge(c, b, 'a1', tCB);
    expect(again.statusCode).toBe(409);
    expect(['patient_already_merged', 'confirmation_stale']).toContain(again.json().detail.reason);
    expect((await candidates(b)).json().detail).toStrictEqual({ reason: 'patient_merged' });
    // Unmerging a merge whose survivor was merged later must resolve the later merge first.
    expect((await merge(c, a)).statusCode).toBe(201);
    const first = (await history(b)).json().data[0];
    const blocked = await unmerge(first.mergeRef, { reasonCode: 'merged_in_error' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().detail).toStrictEqual({ reason: 'survivor_merged' });
  });
});

describe('S6 elevated reversal after new facts (S-D2, pending approval)', () => {
  it('a new clinical or financial fact on the survivor requires the elevated role and a review reference', async () => {
    const [survivor, merged] = await duplicatePair('Synthetic Duplicate Facts');
    const m = (await merge(survivor, merged)).json().data;
    const membership = createMembershipSource(db.app);
    // No clinical or financial record class exists yet; a probe stands in for one (registered by C/B later).
    const service = createPatientService({
      matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
      authorize: createAuthorize(membership),
      withTenantTransaction: createTenantTransactionRunner(db.app),
      recording: { sink: createSecurityAttemptSink(db.sink), alert: () => undefined },
      postMergeFactProbes: [{ factKind: 'clinical', count: async () => 1 }],
    });
    const env = (body: object) => ({
      operation: 'patients.unmerge',
      idempotencyKey: randomUUID(),
      payload: body,
    });
    const reason = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'ok';
      } catch (err) {
        if (!isRefusalError(err)) throw err;
        return `${err.code}:${err.detail?.reason}`;
      }
    };
    const a6 = ctxFor(T_ALPHA, USER_A6, 'human', [...PATIENT_RW, 'patients.merge']);
    const a1 = ctxFor(T_ALPHA, USER_A1, 'human', PATIENT_ALL);
    expect(
      await reason(service.unmergePatients(a6, m.mergeRef, env({ reasonCode: 'merged_in_error' }))),
    ).toBe('forbidden:unmerge_requires_reconciliation_review');
    expect(
      await reason(
        service.unmergePatients(
          a1,
          m.mergeRef,
          env({ reasonCode: 'reconciliation_review', reconciliationReviewRef: 'synthetic-review-f' }),
        ),
      ),
    ).toBe('ok');
  });

  it('a confirmation token expires', async () => {
    const [survivor, merged] = await duplicatePair('Synthetic Duplicate Expiry');
    const membership = createMembershipSource(db.app);
    const service = createPatientService({
      matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
      authorize: createAuthorize(membership),
      withTenantTransaction: createTenantTransactionRunner(db.app),
      recording: { sink: createSecurityAttemptSink(db.sink), alert: () => undefined },
      mergeConfirmations: createMergeConfirmationCodec({ ttlSeconds: -1 }),
    });
    const a1 = ctxFor(T_ALPHA, USER_A1, 'human', PATIENT_ALL);
    const list = await service.findDuplicateCandidates(a1, survivor);
    const token = list.data.find((c) => c.candidateRef === merged)?.confirmationToken ?? '';
    let detail = 'none';
    try {
      await service.mergePatients(a1, {
        operation: 'patients.merge',
        idempotencyKey: randomUUID(),
        payload: { survivorRef: survivor, mergedRef: merged, confirmationToken: token, reasonCode: 'other' },
      });
    } catch (err) {
      if (!isRefusalError(err)) throw err;
      detail = `${err.code}:${err.detail?.reason}`;
    }
    expect(detail).toBe('forbidden:confirmation_expired');
  });
});

describe('S6 MCP parity, idempotency and privacy', () => {
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

  it('merge and unmerge through MCP call the same handlers; a replay returns the recorded merge', async () => {
    const contact = { contact: { known: true, points: [phone('+1 555 0142 777')] } };
    const s = await patient(`Synthetic ${MARKER}`, contact);
    const m = await patient(`Synthetic ${MARKER}`, contact);
    const found = await tool('patients_find_duplicates', { patientRef: s });
    const token = (
      found.structuredContent as { data: { candidateRef: string; confirmationToken: string }[] }
    ).data.find((c) => c.candidateRef === m)?.confirmationToken;
    const key = randomUUID();
    const args = {
      survivorRef: s,
      mergedRef: m,
      confirmationToken: token,
      reasonCode: 'duplicate_registration',
      idempotencyKey: key,
    };
    const first = await tool('patients_merge', args);
    expect(first.isError).not.toBe(true);
    const replay = await tool('patients_merge', args);
    expect((replay.structuredContent as { replayed: boolean }).replayed).toBe(true);
    const mergeRef = (first.structuredContent as { data: { mergeRef: string } }).data.mergeRef;
    expect((replay.structuredContent as { data: { mergeRef: string } }).data.mergeRef).toBe(mergeRef);
    expect(await count('patient_merges', 'merged_patient_id = $1', [m])).toBe(1);
    const restHistory = (await history(m)).json().data;
    const mcpHistory = (await tool('patients_list_merge_history', { patientRef: m })).structuredContent as {
      data: unknown[];
    };
    expect(mcpHistory.data).toStrictEqual(restHistory);
    const un = await tool('patients_unmerge', {
      mergeRef,
      reasonCode: 'merged_in_error',
      idempotencyKey: randomUUID(),
    });
    expect((un.structuredContent as { data: { state: string } }).data.state).toBe('reversed');
    const bad = await tool('patients_merge', {
      ...args,
      idempotencyKey: randomUUID(),
      confirmationToken: 'v1.0000000000.1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect((bad.structuredContent as { code: string }).code).toBe('forbidden');
    expect(logLines.join('\n')).not.toContain(MARKER);
    const surface = `${await leakSurface(db.admin)}${JSON.stringify(
      (await db.admin.query('SELECT * FROM cuspatlas.patient_merges')).rows,
    )}${JSON.stringify((await db.admin.query('SELECT * FROM cuspatlas.patient_merge_moves')).rows)}`;
    expect(surface).not.toContain(MARKER);
    expect(surface).not.toContain('0142 777');
  });
});
