import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '@cuspatlas/api';
import {
  createBackup,
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
  MANIFEST_FILE,
} from '@cuspatlas/db';
import { createAuthorize } from '@cuspatlas/domain';
import { createWorker } from '@cuspatlas/worker';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { FakeProvider } from './support/fake-provider';
import { seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';
import { createTestTokenIssuer, type TestTokenIssuer } from './support/test-token-issuer';

/**
 * F Task 8 privacy proof (AS-03). A representative flow puts the marker in every caller-controlled
 * field (labels, idempotency keys, path and query parameters, forwarding headers, the bearer token,
 * proposal payloads) while the REST logger runs at `trace` and the worker logs every line. The marker
 * must never reach a log line, an audit/outbox/attempt/receipt/provenance/idempotency row or the
 * backup manifest; logs must carry no Authorization header, SQL text or stack traces. The scanner is
 * then run against a deliberately unsafe throwaway logger to prove it is not vacuous.
 */

const SVC_W = '30000000-0000-4000-8000-0000000000e1';
const REPO_ROOT = resolve(import.meta.dirname, '../..');

let db: TestDatabase;
let issuer: TestTokenIssuer;
let app: FastifyInstance;
let backupDir: string;
const logLines: string[] = [];
const tokens: Record<'a1' | 'b1', string> = { a1: '', b1: '' };

/** The test's own scanner. Returns the names of the rules a line breaks. */
function unsafeLogRules(line: string): string[] {
  const hits: string[] = [];
  if (line.includes(MARKER)) hits.push('marker');
  if (/authorization/i.test(line) || /bearer\s/i.test(line)) hits.push('authorization');
  if (/\b(select|insert|update|delete)\b[\s\S]{0,200}?\b(from|into|set)\b/i.test(line)) hits.push('sql');
  if (/"stack"\s*:/.test(line) || /\n\s+at\s/.test(line) || /\\n\s+at\s/.test(line)) hits.push('stack');
  return hits;
}

function rest(
  who: 'a1' | 'b1' | 'none',
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: {
      ...(who === 'none' ? {} : { authorization: `Bearer ${tokens[who]}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-forwarded-for': MARKER,
      'user-agent': MARKER,
      ...headers,
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  db = await openTestDatabase('privacy_log');
  await seedTenancy(db.admin);
  await db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-w-priv')`,
    [SVC_W],
  );
  await db.admin.query(
    'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)',
    [T_ALPHA, SVC_W, ['outbox.deliver', 'syntheticTasks.read', 'syntheticTasks.write']],
  );
  issuer = await createTestTokenIssuer();
  tokens.a1 = await issuer.issue({ sub: USER_A1, tid: T_ALPHA });
  tokens.b1 = await issuer.issue({ sub: USER_B1, tid: T_BETA });
  const membership = createMembershipSource(db.app);
  const attempts = createSecurityAttemptSink(db.sink);
  const tenantTransactions = createTenantTransactionRunner(db.app);
  app = await buildApp({
    env: 'synthetic-test',
    logger: { level: 'trace', stream: { write: (l: string) => logLines.push(l) } },
    identity: issuer.verifierConfig,
    membership,
    attempts,
    tenantTransactions,
  });

  // Create, relabel, stale relabel (failed reservation), all with the marker in caller fields.
  const created = await rest(
    'a1',
    'POST',
    '/v1/synthetic-tasks',
    { label: `${MARKER} created` },
    {
      'idempotency-key': `${MARKER}-k1`,
    },
  );
  expect(created.statusCode).toBe(201);
  const taskRef = created.json().data.taskRef as string;
  const relabel = (key: string, expectedVersion: number) =>
    rest(
      'a1',
      'POST',
      `/v1/synthetic-tasks/${taskRef}/relabel?note=${MARKER}`,
      { label: `${MARKER} relabelled`, expectedVersion },
      { 'idempotency-key': key },
    );
  expect((await relabel(`${MARKER}-k2`, 1)).statusCode).toBe(200);
  expect((await relabel(`${MARKER}-k3`, 1)).statusCode).toBe(409);

  // Denials: cross-tenant, forged bearer, marker as path parameter.
  expect((await rest('b1', 'GET', `/v1/synthetic-tasks/${taskRef}?q=${MARKER}`)).statusCode).toBe(404);
  expect(
    (await rest('none', 'GET', '/v1/synthetic-tasks', undefined, { authorization: `Bearer ${MARKER}` }))
      .statusCode,
  ).toBe(401);
  expect((await rest('a1', 'GET', `/v1/synthetic-tasks/${MARKER}`)).statusCode).toBe(404);

  // Proposal prepare / approve / commit, plus a rejected one (altered payload).
  const propose = async (key: string) => {
    const r = await rest(
      'a1',
      'POST',
      '/v1/synthetic-tasks/proposals',
      {
        operation: 'syntheticTasks.relabel',
        payload: { taskRef, label: `${MARKER} proposed ${key.length}`, expectedVersion: 2 },
      },
      { 'idempotency-key': key },
    );
    expect(r.statusCode).toBe(201);
    return r.json().data as { proposalRef: string; payloadDigest: string };
  };
  const p1 = await propose(`${MARKER}-p1`);
  const p2 = await propose(`${MARKER}-p22`);
  for (const p of [p1, p2]) {
    const a = await rest('a1', 'POST', `/v1/synthetic-tasks/proposals/${p.proposalRef}/approve`, {
      payloadDigest: p.payloadDigest,
      execution: 'manual',
    });
    expect(a.statusCode).toBe(200);
  }
  const bad = await rest('a1', 'POST', `/v1/synthetic-tasks/proposals/${p2.proposalRef}/commit`, {
    payload: { taskRef, label: `${MARKER} altered`, expectedVersion: 2 },
  });
  expect(bad.statusCode).toBe(409);
  const good = await rest('a1', 'POST', `/v1/synthetic-tasks/proposals/${p1.proposalRef}/commit`, {
    payload: { taskRef, label: `${MARKER} proposed ${`${MARKER}-p1`.length}`, expectedVersion: 2 },
  });
  expect(good.statusCode).toBe(200);
  expect((await rest('a1', 'GET', `/v1/synthetic-tasks/proposals/${MARKER}`)).statusCode).toBe(404);

  // Worker delivery, then a dead letter, with every worker line captured.
  const worker = createWorker({
    workerPrincipalId: SVC_W,
    withTenantTransaction: tenantTransactions,
    authorize: createAuthorize(membership),
    memberships: membership,
    attempts,
    backoffSeconds: () => 0,
    deliverTimeoutSeconds: 0.1,
    log: (line) => logLines.push(JSON.stringify(line)),
  });
  const delivered = await worker.runOnce(T_ALPHA, new FakeProvider());
  expect(delivered.length).toBeGreaterThan(0);
  expect(delivered.every((d) => d.result === 'delivered')).toBe(true);
  await rest(
    'a1',
    'POST',
    '/v1/synthetic-tasks',
    { label: `${MARKER} doomed` },
    { 'idempotency-key': `${MARKER}-k9` },
  );
  const dead = await worker.runOnce(T_ALPHA, new FakeProvider({}, { fail: () => ({ retryable: false }) }));
  expect(dead.map((d) => d.result)).toEqual(['dead-letter']);

  const c = await db.admin.connect();
  try {
    backupDir = mkdtempSync(join(tmpdir(), 'cuspatlas-privacy-backup-'));
    await createBackup(c, { outDir: backupDir, repoRoot: REPO_ROOT });
  } finally {
    c.release();
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  if (backupDir) rmSync(backupDir, { recursive: true, force: true });
});

describe('privacy of logs, protected rows and backup metadata', () => {
  it('the flow really carried the marker into protected content (positive control)', async () => {
    const { rows } = await db.admin.query(
      `SELECT (SELECT count(*)::int FROM cuspatlas.synthetic_tasks WHERE label LIKE '%' || $1 || '%') AS tasks,
              (SELECT count(*)::int FROM cuspatlas.action_proposals WHERE payload::text LIKE '%' || $1 || '%') AS proposals`,
      [MARKER],
    );
    expect(rows[0].tasks).toBeGreaterThanOrEqual(2);
    expect(rows[0].proposals).toBe(2);
    expect(logLines.length).toBeGreaterThan(20);
  });

  it('no log line carries the marker, an Authorization header, SQL text or a stack trace', () => {
    const bad = logLines.map((l, i) => ({ i, rules: unsafeLogRules(l) })).filter((x) => x.rules.length > 0);
    expect(bad).toEqual([]);
  });

  it.each([
    'audit_events',
    'outbox_events',
    'security_attempt_events',
    'delivery_receipts',
    'action_proposal_provenance',
    'command_idempotency',
  ])('no %s row contains the marker (digest columns are hashes)', async (table) => {
    const { rows } = await db.admin.query(`SELECT row_to_json(t)::text AS j FROM cuspatlas.${table} t`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.j).not.toContain(MARKER);
  });

  it('the backup manifest carries no marker and no connection data; the dump itself is sensitive', () => {
    const manifest = readFileSync(join(backupDir, MANIFEST_FILE), 'utf8');
    expect(manifest).not.toContain(MARKER);
    expect(unsafeLogRules(manifest)).toEqual([]);
    expect(manifest).not.toMatch(/password|postgres:\/\/|127\.0\.0\.1/i);
    // The data files hold row values: that is why dumps stay outside the repository and CI artifacts.
    expect(readFileSync(join(backupDir, 'tables', 'synthetic_tasks.ndjson'), 'utf8')).toContain(MARKER);
  });
});

describe('the scanner is not vacuous', () => {
  it('catches a deliberately unsafe throwaway logger', async () => {
    const lines: string[] = [];
    const unsafe = Fastify({ logger: { level: 'trace', stream: { write: (l: string) => lines.push(l) } } });
    unsafe.log.info({ label: MARKER }, 'leaked marker');
    unsafe.log.info({ headers: { authorization: 'Bearer abc.def.ghi' } }, 'leaked header');
    unsafe.log.debug('SELECT label FROM cuspatlas.synthetic_tasks WHERE id = $1');
    unsafe.log.error(new Error('refusal with stack'));
    await unsafe.close();
    expect(lines.length).toBe(4);
    expect(lines.map(unsafeLogRules)).toEqual([['marker'], ['authorization'], ['sql'], ['stack']]);
  });
});
