import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import { type ActorContext, REFUSAL_HTTP_STATUS, type RefusalCode } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  createAuthorize,
  createProposalService,
  PROPOSAL_POLICY_VERSION,
  type ProposalService,
} from '@cuspatlas/domain';
import { buildMcpServer, type McpServerHandle } from '@cuspatlas/mcp';
import { createWorker } from '@cuspatlas/worker';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { FakeProvider } from './support/fake-provider';
import {
  ctxFor,
  SVC_A1,
  seedTenancy,
  T_ALPHA,
  T_BETA,
  USER_A1,
  USER_A3,
  USER_A4,
  USER_B1,
} from './support/fixtures';
import { MARKER } from './support/marker';
import { createTestTokenIssuer, TEST_AUDIENCE, type TestTokenIssuer } from './support/test-token-issuer';

/** Synthetic principals created only for this file (alpha tenant). */
const USER_A6 = '20000000-0000-4000-8000-0000000000a6'; // human approver (read/write/approve), revocable
const USER_A7 = '20000000-0000-4000-8000-0000000000a7'; // human executor (read/write), revocable
const SVC_A3 = '30000000-0000-4000-8000-0000000000a3'; // agent proposer (read only), revocable
const SVC_WORKER = '30000000-0000-4000-8000-0000000000c7'; // worker: outbox.deliver + read/write
const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';
const POLICY_V2 = 'synthetic-proposals.2';

const RW = ['syntheticTasks.read', 'syntheticTasks.write'];
const RWA = [...RW, 'syntheticTasks.approve'];
const WORKER_SCOPES = ['outbox.deliver', ...RW];

let db: TestDatabase;
let pool: pg.Pool;
let issuer: TestTokenIssuer;
let apps: { v1: FastifyInstance; v2: FastifyInstance };
let mcps: { v1: McpServerHandle; v2: McpServerHandle };
let mcpUrls: { v1: string; v2: string };
let logLines: string[];
let proposals: ProposalService;

interface TokenPair {
  readonly rest: string;
  readonly mcp: string;
}
type TokenName = 'a1' | 'a3' | 'a4' | 'a6' | 'a7' | 'svcA1' | 'svcA3' | 'b1' | 'wrongTenant';
const tokens = {} as Record<TokenName, TokenPair>;

const ctx = {
  a1: () => ctxFor(T_ALPHA, USER_A1, 'human'),
  a6: () => ctxFor(T_ALPHA, USER_A6, 'human'),
  a7: () => ctxFor(T_ALPHA, USER_A7, 'human', RW),
  svcA1: () => ctxFor(T_ALPHA, SVC_A1, 'service'),
  svcA3: () => ctxFor(T_ALPHA, SVC_A3, 'service', ['syntheticTasks.read']),
};

beforeAll(async () => {
  db = await openTestDatabase('proposals');
  await seedTenancy(db.admin);
  await db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES
       ($1, 'human', 'user-a6'), ($2, 'human', 'user-a7'), ($3, 'service', 'svc-a3'), ($4, 'service', 'svc-worker-7a')`,
    [USER_A6, USER_A7, SVC_A3, SVC_WORKER],
  );
  await db.admin.query(
    `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES
       ($1, $2, $3), ($1, $4, $5), ($1, $6, $7), ($1, $8, $9)`,
    [T_ALPHA, USER_A6, RWA, USER_A7, RW, SVC_A3, ['syntheticTasks.read'], SVC_WORKER, WORKER_SCOPES],
  );
  pool = db.appPool(12);
  issuer = await createTestTokenIssuer();
  logLines = [];
  const stream = { write: (l: string) => logLines.push(l) };
  const membership = createMembershipSource(pool);
  const attempts = createSecurityAttemptSink(db.sink);
  const tenantTransactions = createTenantTransactionRunner(pool);
  proposals = createProposalService({
    authorize: createAuthorize(membership),
    memberships: membership,
    withTenantTransaction: tenantTransactions,
    recording: { sink: attempts, alert: () => undefined },
  });
  const app = (proposalPolicyVersion?: string) =>
    buildApp({
      env: 'synthetic-test',
      logger: { level: 'info', stream },
      identity: issuer.verifierConfig,
      membership,
      attempts,
      tenantTransactions,
      ...(proposalPolicyVersion ? { proposalPolicyVersion } : {}),
    });
  const mcp = (proposalPolicyVersion?: string) =>
    buildMcpServer({
      env: 'synthetic-test',
      identity: { ...issuer.verifierConfig, audience: MCP_AUDIENCE },
      restAudience: TEST_AUDIENCE,
      membership,
      attempts,
      tenantTransactions,
      logger: { stream },
      ...(proposalPolicyVersion ? { proposalPolicyVersion } : {}),
    });
  apps = { v1: await app(), v2: await app(POLICY_V2) };
  mcps = { v1: mcp(), v2: mcp(POLICY_V2) };
  mcpUrls = {
    v1: (await mcps.v1.listen({ host: '127.0.0.1', port: 0 })).url,
    v2: (await mcps.v2.listen({ host: '127.0.0.1', port: 0 })).url,
  };
  const both = async (sub: string, tid: string): Promise<TokenPair> => ({
    rest: await issuer.issue({ sub, tid }),
    mcp: await issuer.issue({ sub, tid, audience: MCP_AUDIENCE }),
  });
  tokens.a1 = await both(USER_A1, T_ALPHA);
  tokens.a3 = await both(USER_A3, T_ALPHA);
  tokens.a4 = await both(USER_A4, T_ALPHA);
  tokens.a6 = await both(USER_A6, T_ALPHA);
  tokens.a7 = await both(USER_A7, T_ALPHA);
  tokens.svcA1 = await both(SVC_A1, T_ALPHA);
  tokens.svcA3 = await both(SVC_A3, T_ALPHA);
  tokens.b1 = await both(USER_B1, T_BETA);
  tokens.wrongTenant = await both(USER_A1, T_BETA);
});

async function resetMemberships(): Promise<void> {
  await db.admin.query(
    `UPDATE cuspatlas.memberships SET revoked_at = NULL, scopes = CASE principal_id
       WHEN $1::uuid THEN $5::text[] WHEN $2::uuid THEN $6::text[] WHEN $3::uuid THEN $7::text[] ELSE $8::text[] END
     WHERE principal_id IN ($1, $2, $3, $4)`,
    [USER_A6, USER_A7, SVC_A3, SVC_WORKER, RWA, RW, ['syntheticTasks.read'], WORKER_SCOPES],
  );
}

beforeEach(resetMemberships);

afterAll(async () => {
  await mcps?.v1.close();
  await mcps?.v2.close();
  await apps?.v1.close();
  await apps?.v2.close();
  await db?.close();
});

// ---------------------------------------------------------------------------------------------
// Fixture helpers (domain service with server-built contexts; the superuser only seeds and reads back).

async function freshTask(location: string | null = null): Promise<string> {
  const { rows } = await db.admin.query(
    'INSERT INTO cuspatlas.synthetic_tasks (tenant_id, label, location_ref, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [T_ALPHA, 'fresh task', location, USER_A1],
  );
  return rows[0].id;
}

async function prepared(
  proposer: ActorContext,
  opts: { label?: string; location?: string | null; create?: boolean } = {},
) {
  const payload = opts.create
    ? { label: opts.label ?? 'proposed create' }
    : {
        taskRef: await freshTask(opts.location ?? null),
        label: opts.label ?? 'proposed label',
        expectedVersion: 1,
      };
  const r = await proposals.prepareProposal(proposer, {
    operation: 'syntheticTasks.proposals.prepare',
    idempotencyKey: randomUUID(),
    payload: { operation: opts.create ? 'syntheticTasks.create' : 'syntheticTasks.relabel', payload },
  });
  return { ref: r.data.proposalRef, digest: r.data.payloadDigest, payload };
}

async function approved(
  proposer: ActorContext,
  approver: ActorContext = ctx.a1(),
  execution: 'manual' | 'deferred' = 'manual',
  opts: Parameters<typeof prepared>[1] = {},
) {
  const p = await prepared(proposer, opts);
  await proposals.approveProposal(approver, p.ref, { payloadDigest: p.digest, execution });
  return p;
}

async function committed(proposer: ActorContext = ctx.svcA1()) {
  const p = await approved(proposer);
  const r = await proposals.commitProposal(ctx.a1(), p.ref, { payload: p.payload });
  return { ...p, result: r };
}

/** Privileged tamper (superuser, triggers bypassed): the threat the commit-time rechecks exist for. */
async function tamper(sql: string, params: unknown[]): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(sql, params);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

const expire = (ref: string) =>
  tamper(
    `UPDATE cuspatlas.action_proposals SET created_at = now() - interval '30 minutes',
       expires_at = now() - interval '1 minute' WHERE id = $1`,
    [ref],
  );

async function setMembership(principal: string, change: 'revoke' | string[]): Promise<void> {
  if (change === 'revoke') {
    await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1', [
      principal,
    ]);
  } else {
    await db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2 WHERE principal_id = $1', [
      principal,
      change,
    ]);
  }
}

async function proposalRow(ref: string) {
  const { rows } = await db.admin.query(
    `SELECT state, version, approver_id, committed_by, result_ref, result_version, disposition_reason
     FROM cuspatlas.action_proposals WHERE id = $1`,
    [ref],
  );
  return rows[0];
}

async function taskRow(id: string) {
  return (await db.admin.query('SELECT label, version FROM cuspatlas.synthetic_tasks WHERE id = $1', [id]))
    .rows[0];
}

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  (await db.admin.query(sql, params)).rows[0].n;

const auditFor = (taskRef: string) =>
  count('SELECT count(*)::int AS n FROM cuspatlas.audit_events WHERE resource_ref = $1', [taskRef]);
const outboxFor = (aggregate: string) =>
  count('SELECT count(*)::int AS n FROM cuspatlas.outbox_events WHERE aggregate_id = $1', [aggregate]);

async function attemptRows(correlationId: string | null) {
  if (correlationId === null) return [];
  return (
    await db.admin.query(
      'SELECT tenant_id, actor_id, operation, reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [correlationId],
    )
  ).rows;
}

// ---------------------------------------------------------------------------------------------
// Transport drivers (same Outcome for REST and MCP).

type Op = 'prepare' | 'read' | 'approve' | 'commit';
type Args = Record<string, unknown>;
type Version = 'v1' | 'v2';

interface Outcome {
  readonly status: number;
  readonly code: string | null;
  readonly correlationId: string | null;
  readonly replayed: boolean | null;
  readonly body: Record<string, unknown> | null;
  readonly raw: string;
}

const SUCCESS: Record<Op, number> = { prepare: 201, read: 200, approve: 200, commit: 200 };
const TOOL: Record<Op, string> = {
  prepare: 'synthetic_tasks_propose',
  read: 'synthetic_tasks_get_proposal',
  approve: 'synthetic_tasks_approve',
  commit: 'synthetic_tasks_commit',
};

const dataOf = (o: Outcome): Record<string, unknown> => (o.body?.data ?? {}) as Record<string, unknown>;

function outcomeOf(status: number, body: Record<string, unknown> | null, raw: string): Outcome {
  const refused = body !== null && typeof body.code === 'string' && typeof body.retryable === 'boolean';
  return {
    status,
    code: refused ? (body.code as string) : null,
    correlationId: body !== null && typeof body.correlationId === 'string' ? body.correlationId : null,
    replayed: body !== null && typeof body.replayed === 'boolean' ? body.replayed : null,
    body,
    raw,
  };
}

async function viaRest(op: Op, token: string, args: Args, v: Version = 'v1'): Promise<Outcome> {
  const { proposalRef, idempotencyKey, ...body } = args;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (op !== 'read') headers['content-type'] = 'application/json';
  if (op === 'prepare' && idempotencyKey !== undefined) headers['idempotency-key'] = String(idempotencyKey);
  const ref = encodeURIComponent(String(proposalRef));
  const res = await apps[v].inject({
    method: op === 'read' ? 'GET' : 'POST',
    url:
      op === 'prepare'
        ? '/v1/synthetic-tasks/proposals'
        : op === 'read'
          ? `/v1/synthetic-tasks/proposals/${ref}`
          : `/v1/synthetic-tasks/proposals/${ref}/${op}`,
    headers,
    ...(op === 'read' ? {} : { payload: JSON.stringify(body) }),
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = res.json();
  } catch {
    parsed = null;
  }
  return outcomeOf(res.statusCode, parsed, `${res.body}${JSON.stringify(res.headers)}`);
}

async function viaMcp(op: Op, token: string, args: Args, v: Version = 'v1'): Promise<Outcome> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrls[v]), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'synthetic-test-client', version: '0.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: TOOL[op], arguments: args });
    const raw = JSON.stringify(result);
    const body = result.structuredContent as Record<string, unknown>;
    if (result.isError === true) return outcomeOf(REFUSAL_HTTP_STATUS[body.code as RefusalCode], body, raw);
    return outcomeOf(SUCCESS[op], body, raw);
  } catch (e) {
    const err = e as { code?: unknown; message?: string };
    if (typeof err.code !== 'number') throw e;
    const message = String(err.message);
    const start = message.indexOf('{');
    let body: Record<string, unknown> | null = null;
    try {
      body = start >= 0 ? JSON.parse(message.slice(start)) : null;
    } catch {
      body = null;
    }
    return outcomeOf(err.code, body, message);
  } finally {
    await client.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// The allow/deny matrix. Every row runs once through REST and once through MCP with fresh state.

interface Setup {
  readonly args: Args;
  /** Proposal and task touched by the case, for post-conditions. */
  readonly ref?: string;
  readonly taskRef?: string | undefined;
}

interface Case {
  readonly op: Op;
  readonly name: string;
  readonly who: TokenName;
  readonly setup: () => Promise<Setup>;
  readonly status: number;
  readonly code: string | null;
  readonly replayed?: boolean;
  /** Proposal state after the call, when the case changes (or must not change) it. */
  readonly state?: string;
  readonly reason?: string | null;
  /** Task version after the call (proves the mutation did or did not run). */
  readonly taskVersion?: number;
  readonly policy?: Version;
}

const key = () => randomUUID();
const relabelArgs = async (location: string | null = null, expectedVersion = 1) => {
  const taskRef = await freshTask(location);
  return {
    taskRef,
    args: {
      operation: 'syntheticTasks.relabel',
      payload: { taskRef, label: 'proposed label', expectedVersion },
      idempotencyKey: key(),
    },
  };
};
const forCommit = (p: { ref: string; payload: object }, payload: object = p.payload): Setup => ({
  args: { proposalRef: p.ref, payload },
  ref: p.ref,
  taskRef: (p.payload as { taskRef?: string }).taskRef,
});

const CASES: readonly Case[] = [
  // prepare
  {
    op: 'prepare',
    name: 'human proposer',
    who: 'a1',
    setup: async () => {
      const r = await relabelArgs();
      return { args: r.args, taskRef: r.taskRef };
    },
    status: 201,
    code: null,
    taskVersion: 1,
  },
  {
    op: 'prepare',
    name: 'agent proposer with read scope only',
    who: 'svcA3',
    setup: async () => {
      const r = await relabelArgs();
      return { args: r.args, taskRef: r.taskRef };
    },
    status: 201,
    code: null,
    taskVersion: 1,
  },
  {
    op: 'prepare',
    name: 'agent proposes a create',
    who: 'svcA1',
    setup: async () => ({
      args: { operation: 'syntheticTasks.create', payload: { label: 'agent create' }, idempotencyKey: key() },
    }),
    status: 201,
    code: null,
  },
  {
    op: 'prepare',
    name: 'token for a tenant without membership',
    who: 'wrongTenant',
    setup: async () => ({ args: (await relabelArgs()).args }),
    status: 403,
    code: 'forbidden',
  },
  {
    op: 'prepare',
    name: 'another tenant task',
    who: 'b1',
    setup: async () => ({ args: (await relabelArgs()).args }),
    status: 404,
    code: 'not_found',
  },
  {
    op: 'prepare',
    name: 'location denied',
    who: 'a3',
    setup: async () => ({ args: (await relabelArgs('loc-south')).args }),
    status: 403,
    code: 'forbidden',
  },
  {
    op: 'prepare',
    name: 'unknown property',
    who: 'a1',
    setup: async () => {
      const r = await relabelArgs();
      return { args: { ...r.args, payload: { ...r.args.payload, extra: 1 } } };
    },
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'prepare',
    name: 'operation and payload disagree',
    who: 'a1',
    setup: async () => ({ args: { ...(await relabelArgs()).args, operation: 'syntheticTasks.create' } }),
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'prepare',
    name: 'missing idempotency key',
    who: 'a1',
    setup: async () => {
      const { idempotencyKey: _k, ...args } = (await relabelArgs()).args;
      return { args };
    },
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'prepare',
    name: 'stale expected version',
    who: 'a1',
    setup: async () => ({ args: (await relabelArgs(null, 2)).args }),
    status: 409,
    code: 'stale_version',
  },
  // read
  {
    op: 'read',
    name: 'proposer',
    who: 'svcA3',
    setup: async () => {
      const p = await prepared(ctx.svcA3());
      return { args: { proposalRef: p.ref }, ref: p.ref };
    },
    status: 200,
    code: null,
    state: 'prepared',
  },
  {
    op: 'read',
    name: 'approver-capable member',
    who: 'a1',
    setup: async () => ({ args: { proposalRef: (await prepared(ctx.svcA3())).ref } }),
    status: 200,
    code: null,
  },
  {
    op: 'read',
    name: 'read-only member who is not the proposer',
    who: 'a4',
    setup: async () => ({ args: { proposalRef: (await prepared(ctx.svcA3())).ref } }),
    status: 404,
    code: 'not_found',
  },
  {
    op: 'read',
    name: 'another tenant',
    who: 'b1',
    setup: async () => ({ args: { proposalRef: (await prepared(ctx.svcA3())).ref } }),
    status: 404,
    code: 'not_found',
  },
  {
    op: 'read',
    name: 'missing',
    who: 'a1',
    setup: async () => ({ args: { proposalRef: randomUUID() } }),
    status: 404,
    code: 'not_found',
  },
  {
    op: 'read',
    name: 'location-restricted member, other location',
    who: 'a3',
    setup: async () => ({ args: { proposalRef: (await prepared(ctx.a1(), { location: 'loc-south' })).ref } }),
    status: 404,
    code: 'not_found',
  },
  // approve
  {
    op: 'approve',
    name: 'human approves an agent proposal',
    who: 'a1',
    setup: async () => {
      const p = await prepared(ctx.svcA1());
      return { args: { proposalRef: p.ref, payloadDigest: p.digest }, ref: p.ref };
    },
    status: 200,
    code: null,
    state: 'approved',
  },
  {
    op: 'approve',
    name: 'agent self-approval of its own proposal',
    who: 'svcA1',
    setup: async () => {
      const p = await prepared(ctx.svcA1());
      return { args: { proposalRef: p.ref, payloadDigest: p.digest }, ref: p.ref };
    },
    status: 403,
    code: 'self_approval_denied',
    state: 'prepared',
  },
  {
    op: 'approve',
    name: 'agent approves a human proposal',
    who: 'svcA1',
    setup: async () => {
      const p = await prepared(ctx.a1());
      return { args: { proposalRef: p.ref, payloadDigest: p.digest }, ref: p.ref };
    },
    status: 403,
    code: 'forbidden',
    state: 'prepared',
  },
  {
    op: 'approve',
    name: 'human without approve scope',
    who: 'a7',
    setup: async () => {
      const p = await prepared(ctx.svcA1());
      return { args: { proposalRef: p.ref, payloadDigest: p.digest }, ref: p.ref };
    },
    status: 403,
    code: 'forbidden',
    state: 'prepared',
  },
  {
    op: 'approve',
    name: 'cross-tenant approval',
    who: 'b1',
    setup: async () => {
      const p = await prepared(ctx.svcA1());
      return { args: { proposalRef: p.ref, payloadDigest: p.digest }, ref: p.ref };
    },
    status: 404,
    code: 'not_found',
    state: 'prepared',
  },
  {
    op: 'approve',
    name: 'digest the approver did not review',
    who: 'a1',
    setup: async () => {
      const p = await prepared(ctx.svcA1());
      return { args: { proposalRef: p.ref, payloadDigest: 'f'.repeat(64) }, ref: p.ref };
    },
    status: 409,
    code: 'payload_mismatch',
    state: 'prepared',
  },
  {
    op: 'approve',
    name: 'human approves own proposal (frozen rule allows it)',
    who: 'a1',
    setup: async () => {
      const p = await prepared(ctx.a1());
      return { args: { proposalRef: p.ref, payloadDigest: p.digest }, ref: p.ref };
    },
    status: 200,
    code: null,
    state: 'approved',
  },
  {
    op: 'approve',
    name: 'expired',
    who: 'a1',
    setup: async () => {
      const p = await prepared(ctx.svcA1());
      await expire(p.ref);
      return { args: { proposalRef: p.ref, payloadDigest: p.digest }, ref: p.ref };
    },
    status: 409,
    code: 'proposal_expired',
    state: 'expired',
    reason: 'expired',
  },
  {
    op: 'approve',
    name: 'already approved by someone else',
    who: 'a1',
    setup: async () => {
      const p = await approved(ctx.svcA1(), ctx.a6());
      return { args: { proposalRef: p.ref, payloadDigest: p.digest }, ref: p.ref };
    },
    status: 409,
    code: 'conflict',
    state: 'approved',
  },
  {
    op: 'approve',
    name: 'policy version changed since prepare',
    who: 'a1',
    policy: 'v2',
    setup: async () => {
      const p = await prepared(ctx.svcA1());
      return { args: { proposalRef: p.ref, payloadDigest: p.digest }, ref: p.ref };
    },
    status: 409,
    code: 'policy_changed',
    state: 'rejected',
    reason: 'policy_changed',
  },
  {
    op: 'approve',
    name: 'invalid body',
    who: 'a1',
    setup: async () => {
      const p = await prepared(ctx.svcA1());
      return { args: { proposalRef: p.ref, payloadDigest: p.digest, execution: 'now' }, ref: p.ref };
    },
    status: 400,
    code: 'invalid_request',
    state: 'prepared',
  },
  // commit
  {
    op: 'commit',
    name: 'approved, valid',
    who: 'a7',
    setup: async () => forCommit(await approved(ctx.svcA1())),
    status: 200,
    code: null,
    replayed: false,
    state: 'committed',
    taskVersion: 2,
  },
  {
    op: 'commit',
    name: 'agent executes after human approval',
    who: 'svcA1',
    setup: async () => forCommit(await approved(ctx.svcA1())),
    status: 200,
    code: null,
    replayed: false,
    state: 'committed',
    taskVersion: 2,
  },
  {
    op: 'commit',
    name: 'already committed (replay to another committer)',
    who: 'a7',
    setup: async () => forCommit(await committed()),
    status: 200,
    code: null,
    replayed: true,
    state: 'committed',
    taskVersion: 2,
  },
  {
    op: 'commit',
    name: 'altered payload',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1());
      return forCommit(p, { ...p.payload, label: 'altered label' });
    },
    status: 409,
    code: 'payload_mismatch',
    state: 'rejected',
    reason: 'payload_mismatch',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'expired',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1());
      await expire(p.ref);
      return forCommit(p);
    },
    status: 409,
    code: 'proposal_expired',
    state: 'expired',
    reason: 'expired',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'stale resource',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1());
      await db.admin.query('UPDATE cuspatlas.synthetic_tasks SET version = 2 WHERE id = $1', [
        p.payload.taskRef,
      ]);
      return forCommit(p);
    },
    status: 409,
    code: 'stale_version',
    state: 'rejected',
    reason: 'stale_version',
    taskVersion: 2,
  },
  {
    op: 'commit',
    name: 'not approved',
    who: 'a7',
    setup: async () => forCommit(await prepared(ctx.svcA1())),
    status: 409,
    code: 'conflict',
    state: 'prepared',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'policy version changed between approval and commit',
    who: 'a7',
    policy: 'v2',
    setup: async () => forCommit(await approved(ctx.svcA1())),
    status: 409,
    code: 'policy_changed',
    state: 'rejected',
    reason: 'policy_changed',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'forged approval digest',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1());
      await tamper('UPDATE cuspatlas.action_proposals SET approval_digest = $2 WHERE id = $1', [
        p.ref,
        'e'.repeat(64),
      ]);
      return forCommit(p);
    },
    status: 409,
    code: 'approval_invalid',
    state: 'rejected',
    reason: 'approval_invalid',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'forged approval policy version',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1());
      await tamper('UPDATE cuspatlas.action_proposals SET approval_policy_version = $2 WHERE id = $1', [
        p.ref,
        'synthetic-proposals.0',
      ]);
      return forCommit(p);
    },
    status: 409,
    code: 'approval_invalid',
    state: 'rejected',
    reason: 'approval_invalid',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'forged approver (principal without approve scope)',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1());
      await tamper('UPDATE cuspatlas.action_proposals SET approver_id = $2 WHERE id = $1', [p.ref, USER_A4]);
      return forCommit(p);
    },
    status: 403,
    code: 'forbidden',
    state: 'rejected',
    reason: 'approver_unauthorized',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'stored payload altered after approval',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1());
      await tamper(
        `UPDATE cuspatlas.action_proposals SET payload = jsonb_set(payload, '{label}', '"tampered"') WHERE id = $1`,
        [p.ref],
      );
      return forCommit(p);
    },
    status: 409,
    code: 'approval_invalid',
    state: 'rejected',
    reason: 'approval_invalid',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'approver revoked between approve and commit',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1(), ctx.a6());
      await setMembership(USER_A6, 'revoke');
      return forCommit(p);
    },
    status: 403,
    code: 'forbidden',
    state: 'rejected',
    reason: 'approver_unauthorized',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'proposer revoked between approve and commit',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA3());
      await setMembership(SVC_A3, 'revoke');
      return forCommit(p);
    },
    status: 403,
    code: 'forbidden',
    state: 'rejected',
    reason: 'proposer_unauthorized',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'executor revoked between approve and commit',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1());
      await setMembership(USER_A7, 'revoke');
      return forCommit(p);
    },
    status: 403,
    code: 'forbidden',
    state: 'approved',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'executor lost write scope',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1());
      await setMembership(USER_A7, ['syntheticTasks.read']);
      return forCommit(p);
    },
    status: 404,
    code: 'not_found',
    state: 'approved',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'cross-tenant commit',
    who: 'b1',
    setup: async () => forCommit(await approved(ctx.svcA1())),
    status: 404,
    code: 'not_found',
    state: 'approved',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'rejected proposal stays closed',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1());
      await proposals
        .commitProposal(ctx.a1(), p.ref, { payload: { ...p.payload, label: 'altered' } })
        .catch(() => undefined);
      return forCommit(p);
    },
    status: 409,
    code: 'payload_mismatch',
    state: 'rejected',
    reason: 'payload_mismatch',
    taskVersion: 1,
  },
  {
    op: 'commit',
    name: 'invalid body',
    who: 'a7',
    setup: async () => {
      const p = await approved(ctx.svcA1());
      return { args: { proposalRef: p.ref, payload: { label: '' } }, ref: p.ref };
    },
    status: 400,
    code: 'invalid_request',
    state: 'approved',
  },
];

const matrix: { op: Op; name: string; rest: string; mcp: string }[] = [];

describe('allow/deny matrix through REST and MCP', () => {
  it.each(CASES.map((c) => [`${c.op}: ${c.name}`, c] as const))('%s', async (_label, c) => {
    const results: Record<'rest' | 'mcp', Outcome> = {} as never;
    for (const transport of ['rest', 'mcp'] as const) {
      await resetMemberships();
      const s = await c.setup();
      const token = tokens[c.who]?.[transport];
      if (!token) throw new Error(`no token ${c.who}`);
      const outboxBefore = await count('SELECT count(*)::int AS n FROM cuspatlas.outbox_events');
      const out = await (transport === 'rest' ? viaRest : viaMcp)(c.op, token, s.args, c.policy ?? 'v1');
      results[transport] = out;
      expect([transport, out.status, out.code]).toStrictEqual([transport, c.status, c.code]);
      if (c.replayed !== undefined) expect([transport, out.replayed]).toStrictEqual([transport, c.replayed]);
      if (c.code !== null) {
        // Every refusal, denial or not, has a durable security attempt row.
        expect((await attemptRows(out.correlationId)).length).toBeGreaterThanOrEqual(1);
        expect(Object.keys(out.body ?? {}).sort()).toStrictEqual(
          Object.keys(out.body ?? {}).includes('detail')
            ? ['code', 'correlationId', 'detail', 'retryable']
            : ['code', 'correlationId', 'retryable'],
        );
      }
      const ref = s.ref ?? (out.body?.data as { proposalRef?: string } | undefined)?.proposalRef;
      if (c.state !== undefined && ref) {
        const row = await proposalRow(ref);
        expect([transport, row.state]).toStrictEqual([transport, c.state]);
        if (c.reason !== undefined) expect(row.disposition_reason).toBe(c.reason);
      }
      if (c.taskVersion !== undefined && s.taskRef) {
        expect([transport, (await taskRow(s.taskRef)).version]).toStrictEqual([transport, c.taskVersion]);
      }
      // Only a successful first commit enqueues anything (the task's own outbox row).
      const outboxAfter = await count('SELECT count(*)::int AS n FROM cuspatlas.outbox_events');
      const enqueued = c.op === 'commit' && c.code === null && c.replayed === false ? 1 : 0;
      expect([transport, outboxAfter - outboxBefore]).toStrictEqual([transport, enqueued]);
    }
    expect([results.mcp.status, results.mcp.code]).toStrictEqual([results.rest.status, results.rest.code]);
    matrix.push({
      op: c.op,
      name: c.name,
      rest: `${results.rest.status} ${results.rest.code ?? 'ok'}`,
      mcp: results.mcp.code ?? 'ok',
    });
  });

  afterAll(() => {
    const lines = matrix.map(
      (m) => `${m.op.padEnd(8)} ${m.name.padEnd(62)} REST ${m.rest.padEnd(26)} MCP ${m.mcp}`,
    );
    process.stdout.write(`\nPROPOSAL MATRIX (${matrix.length} rows)\n${lines.join('\n')}\n`);
  });
});

// ---------------------------------------------------------------------------------------------

describe('read and prepare never mutate', () => {
  it('prepare + get leave the task, audit and outbox unchanged and enqueue nothing', async () => {
    const taskRef = await freshTask();
    const before = {
      task: await taskRow(taskRef),
      audit: await count('SELECT count(*)::int AS n FROM cuspatlas.audit_events'),
      outbox: await count('SELECT count(*)::int AS n FROM cuspatlas.outbox_events'),
    };
    const prep = await viaRest('prepare', tokens.svcA3.rest, {
      operation: 'syntheticTasks.relabel',
      payload: { taskRef, label: 'proposed', expectedVersion: 1 },
      idempotencyKey: key(),
    });
    expect(prep.status).toBe(201);
    const ref = String(dataOf(prep).proposalRef);
    for (const out of [
      await viaRest('read', tokens.svcA3.rest, { proposalRef: ref }),
      await viaMcp('read', tokens.a1.mcp, { proposalRef: ref }),
    ]) {
      expect(out.status).toBe(200);
      const data = out.body?.data as Record<string, unknown>;
      expect(data.state).toBe('prepared');
      expect(data.payload).toStrictEqual({ taskRef, label: 'proposed', expectedVersion: 1 });
      expect(data.approval).toBeNull();
      expect(data.proposerRef).toBe(SVC_A3);
    }
    expect({
      task: await taskRow(taskRef),
      audit: await count('SELECT count(*)::int AS n FROM cuspatlas.audit_events'),
      outbox: await count('SELECT count(*)::int AS n FROM cuspatlas.outbox_events'),
    }).toStrictEqual(before);
    expect((await proposalRow(ref)).version).toBe(1);
  });

  it('a prepare replay with the same key returns the same proposal; another body conflicts', async () => {
    const taskRef = await freshTask();
    const args = {
      operation: 'syntheticTasks.relabel',
      payload: { taskRef, label: 'proposed', expectedVersion: 1 },
      idempotencyKey: key(),
    };
    const first = await viaRest('prepare', tokens.a1.rest, args);
    const second = await viaMcp('prepare', tokens.a1.mcp, args);
    expect(second.replayed).toBe(true);
    expect(String(dataOf(second).proposalRef)).toBe(String(dataOf(first).proposalRef));
    const conflict = await viaRest('prepare', tokens.a1.rest, {
      ...args,
      payload: { ...args.payload, label: 'x' },
    });
    expect([conflict.status, conflict.code]).toStrictEqual([409, 'idempotency_conflict']);
    expect(
      await count('SELECT count(*)::int AS n FROM cuspatlas.action_proposals WHERE resource_ref = $1', [
        taskRef,
      ]),
    ).toBe(1);
  });
});

describe('a valid approved commit executes exactly once', () => {
  it('creates one result, one audit row, one outbox row and protected provenance', async () => {
    const p = await approved(ctx.svcA1());
    const out = await viaRest('commit', tokens.a7.rest, { proposalRef: p.ref, payload: p.payload });
    expect([out.status, out.replayed]).toStrictEqual([200, false]);
    expect(out.body?.data).toStrictEqual({ taskRef: p.payload.taskRef, label: 'proposed label' });
    expect(await taskRow(p.payload.taskRef as string)).toStrictEqual({ label: 'proposed label', version: 2 });
    expect(await auditFor(p.payload.taskRef as string)).toBe(1);
    expect(await outboxFor(p.payload.taskRef as string)).toBe(1);
    const row = await proposalRow(p.ref);
    expect(row).toMatchObject({ state: 'committed', version: 3, committed_by: USER_A7, result_version: 2 });
    // executeOnce reservation keyed by the proposal id, in the committer's scope.
    const { rows: res } = await db.admin.query(
      `SELECT principal_id, operation, state, aggregate_version FROM cuspatlas.command_idempotency
       WHERE key_digest = $1 ORDER BY operation`,
      [createHash('sha256').update(p.ref).digest('hex')],
    );
    expect(res).toStrictEqual([
      {
        principal_id: USER_A1,
        operation: 'syntheticTasks.proposals.approve',
        state: 'committed',
        aggregate_version: 2,
      },
      {
        principal_id: USER_A7,
        operation: 'syntheticTasks.proposals.commit',
        state: 'committed',
        aggregate_version: 2,
      },
    ]);
    const { rows: prov } = await db.admin.query(
      `SELECT step, actor_id, actor_kind, policy_version, reason, result_ref FROM cuspatlas.action_proposal_provenance
       WHERE proposal_id = $1 ORDER BY occurred_at, step`,
      [p.ref],
    );
    expect(prov.map((r) => [r.step, r.actor_id, r.actor_kind])).toStrictEqual([
      ['prepared', SVC_A1, 'service'],
      ['approved', USER_A1, 'human'],
      ['committed', USER_A7, 'human'],
    ]);
    expect(prov.every((r) => r.policy_version === PROPOSAL_POLICY_VERSION)).toBe(true);
  });

  it('a sequential second commit (REST then MCP, other committer) replays and does not execute', async () => {
    const p = await approved(ctx.svcA1());
    const first = await viaRest('commit', tokens.a7.rest, { proposalRef: p.ref, payload: p.payload });
    const again = await viaRest('commit', tokens.a7.rest, { proposalRef: p.ref, payload: p.payload });
    const other = await viaMcp('commit', tokens.a1.mcp, { proposalRef: p.ref, payload: p.payload });
    for (const o of [again, other]) {
      expect([o.status, o.replayed]).toStrictEqual([200, true]);
      expect(o.body?.data).toStrictEqual(first.body?.data);
      expect(o.body?.version).toBe(2);
    }
    expect((await taskRow(p.payload.taskRef as string)).version).toBe(2);
    expect(await auditFor(p.payload.taskRef as string)).toBe(1);
  });

  it('10 concurrent commits (REST and MCP, two committers) execute once', async () => {
    for (let i = 0; i < 3; i += 1) {
      const p = await approved(ctx.svcA1());
      const calls = Array.from({ length: 10 }, (_, j) =>
        j % 2 === 0
          ? viaRest('commit', (j % 4 === 0 ? tokens.a7 : tokens.a1).rest, {
              proposalRef: p.ref,
              payload: p.payload,
            })
          : viaMcp('commit', (j % 3 === 0 ? tokens.a7 : tokens.a1).mcp, {
              proposalRef: p.ref,
              payload: p.payload,
            }),
      );
      const outs = await Promise.all(calls);
      expect(outs.map((o) => o.status)).toStrictEqual(Array(10).fill(200));
      expect(outs.filter((o) => o.replayed === false)).toHaveLength(1);
      expect(new Set(outs.map((o) => JSON.stringify(o.body?.data))).size).toBe(1);
      expect((await taskRow(p.payload.taskRef as string)).version).toBe(2);
      expect(await auditFor(p.payload.taskRef as string)).toBe(1);
      expect(await outboxFor(p.payload.taskRef as string)).toBe(1);
    }
  });

  it('10 concurrent commits of a create proposal create exactly one task', async () => {
    const p = await approved(ctx.svcA1(), ctx.a1(), 'manual', {
      create: true,
      label: `once-${randomUUID()}`,
    });
    const outs = await Promise.all(
      Array.from({ length: 10 }, (_, j) =>
        (j % 2 ? viaMcp : viaRest)('commit', tokens.a1[j % 2 ? 'mcp' : 'rest'], {
          proposalRef: p.ref,
          payload: p.payload,
        }),
      ),
    );
    expect(outs.filter((o) => o.status === 200)).toHaveLength(10);
    expect(outs.filter((o) => o.replayed === false)).toHaveLength(1);
    expect(
      await count('SELECT count(*)::int AS n FROM cuspatlas.synthetic_tasks WHERE label = $1', [
        p.payload.label,
      ]),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('deferred worker execution', () => {
  const provider = () => new FakeProvider();
  const worker = () =>
    createWorker({
      workerPrincipalId: SVC_WORKER,
      withTenantTransaction: createTenantTransactionRunner(pool),
      authorize: createAuthorize(createMembershipSource(pool)),
      memberships: createMembershipSource(pool),
      attempts: createSecurityAttemptSink(db.sink),
      backoffSeconds: () => 0,
      proposals,
    });
  const requestOf = async (ref: string) =>
    (
      await db.admin.query(
        `SELECT id, state, dead_letter_reason, operation FROM cuspatlas.outbox_events
         WHERE aggregate_type = 'actionProposal' AND aggregate_id = $1`,
        [ref],
      )
    ).rows;

  beforeEach(async () => {
    await db.admin.query(
      `UPDATE cuspatlas.outbox_events SET state = 'delivered', last_outcome = 'test_reset', leased_until = NULL
       WHERE state NOT IN ('delivered', 'dead_letter')`,
    );
  });

  it('a deferred approval enqueues one execution request; the worker commits once; REST/MCP then replay', async () => {
    const p = await approved(ctx.svcA1(), ctx.a1(), 'deferred');
    const reqs = await requestOf(p.ref);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ state: 'pending', operation: 'syntheticTasks.proposals.approve' });
    expect((await taskRow(p.payload.taskRef as string)).version).toBe(1);

    const fake = provider();
    const results = await worker().runOnce(T_ALPHA, fake);
    expect(results).toContainEqual({ eventId: reqs[0].id, result: 'delivered' });
    // The execution request never reaches an adapter.
    expect(fake.callsFor(reqs[0].id)).toBe(0);
    expect(await proposalRow(p.ref)).toMatchObject({ state: 'committed', committed_by: SVC_WORKER });
    expect(await taskRow(p.payload.taskRef as string)).toStrictEqual({ label: 'proposed label', version: 2 });
    expect(await auditFor(p.payload.taskRef as string)).toBe(1);

    for (const out of [
      await viaRest('commit', tokens.a7.rest, { proposalRef: p.ref, payload: p.payload }),
      await viaMcp('commit', tokens.a1.mcp, { proposalRef: p.ref, payload: p.payload }),
    ]) {
      expect([out.status, out.replayed, out.body?.version]).toStrictEqual([200, true, 2]);
    }
    // Running the worker again does not lease the finished request.
    const again = await worker().runOnce(T_ALPHA, fake);
    expect(again.map((r) => r.eventId)).not.toContain(reqs[0].id);
    expect((await taskRow(p.payload.taskRef as string)).version).toBe(2);
  });

  it('a REST commit before the worker runs leaves the worker nothing to execute', async () => {
    const p = await approved(ctx.svcA1(), ctx.a1(), 'deferred');
    await viaRest('commit', tokens.a7.rest, { proposalRef: p.ref, payload: p.payload });
    const results = await worker().runOnce(T_ALPHA, provider());
    const req = (await requestOf(p.ref))[0];
    expect(results).toContainEqual({ eventId: req.id, result: 'delivered' });
    expect((await proposalRow(p.ref)).committed_by).toBe(USER_A7);
    expect((await taskRow(p.payload.taskRef as string)).version).toBe(2);
    expect(await auditFor(p.payload.taskRef as string)).toBe(1);
  });

  it('approver revoked after approval: the worker denies, executes nothing, and REST then rejects', async () => {
    const p = await approved(ctx.svcA1(), ctx.a6(), 'deferred');
    await setMembership(USER_A6, 'revoke');
    const req = (await requestOf(p.ref))[0];
    const results = await worker().runOnce(T_ALPHA, provider());
    expect(results).toContainEqual({ eventId: req.id, result: 'denied' });
    expect((await requestOf(p.ref))[0]).toMatchObject({
      state: 'dead_letter',
      dead_letter_reason: 'membership_revoked',
    });
    expect((await taskRow(p.payload.taskRef as string)).version).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM cuspatlas.security_attempt_events WHERE actor_id = $1 AND operation = 'syntheticTasks.proposals.approve' AND reason_code = 'membership_inactive'`,
        [USER_A6],
      ),
    ).toBeGreaterThanOrEqual(1);
    const out = await viaRest('commit', tokens.a7.rest, { proposalRef: p.ref, payload: p.payload });
    expect([out.status, out.code]).toStrictEqual([403, 'forbidden']);
    expect((await proposalRow(p.ref)).state).toBe('rejected');
  });

  it('proposer revoked after approval: the worker refuses and the proposal is rejected', async () => {
    const p = await approved(ctx.svcA3(), ctx.a1(), 'deferred');
    await setMembership(SVC_A3, 'revoke');
    const req = (await requestOf(p.ref))[0];
    const results = await worker().runOnce(T_ALPHA, provider());
    expect(results).toContainEqual({ eventId: req.id, result: 'denied' });
    expect((await requestOf(p.ref))[0].dead_letter_reason).toBe('authorization_denied');
    expect(await proposalRow(p.ref)).toMatchObject({
      state: 'rejected',
      disposition_reason: 'proposer_unauthorized',
    });
    expect((await taskRow(p.payload.taskRef as string)).version).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM cuspatlas.security_attempt_events WHERE actor_id = $1 AND operation = 'syntheticTasks.proposals.commit' AND reason_code = 'proposer_unauthorized'`,
        [SVC_WORKER],
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it('executor (worker) lost write scope: refused, the proposal stays approved for a human committer', async () => {
    const p = await approved(ctx.svcA1(), ctx.a1(), 'deferred');
    await setMembership(SVC_WORKER, ['outbox.deliver', 'syntheticTasks.read']);
    const req = (await requestOf(p.ref))[0];
    const results = await worker().runOnce(T_ALPHA, provider());
    expect(results).toContainEqual({ eventId: req.id, result: 'denied' });
    expect((await requestOf(p.ref))[0].dead_letter_reason).toBe('authorization_denied');
    expect((await proposalRow(p.ref)).state).toBe('approved');
    expect((await taskRow(p.payload.taskRef as string)).version).toBe(1);
  });

  it('expired before execution: dead-lettered as proposal_refused and marked expired', async () => {
    const p = await approved(ctx.svcA1(), ctx.a1(), 'deferred');
    await expire(p.ref);
    const req = (await requestOf(p.ref))[0];
    const results = await worker().runOnce(T_ALPHA, provider());
    expect(results).toContainEqual({ eventId: req.id, result: 'dead-letter' });
    expect((await requestOf(p.ref))[0].dead_letter_reason).toBe('proposal_refused');
    expect((await proposalRow(p.ref)).state).toBe('expired');
    expect((await taskRow(p.payload.taskRef as string)).version).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('database enforcement under the runtime role', () => {
  async function asApp(actor: string, sql: string, params: unknown[] = [], tenant = T_ALPHA) {
    const c = await db.app.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)`,
        [tenant, actor],
      );
      return await c.query(sql, params);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }
  const sqlstate = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: { code?: string }) => e.code,
    );

  it('binding columns are not updatable, nothing is deletable, approvals cannot be forged', async () => {
    const p = await prepared(ctx.svcA1());
    for (const sql of [
      'UPDATE cuspatlas.action_proposals SET payload_digest = $2 WHERE id = $1',
      'UPDATE cuspatlas.action_proposals SET policy_version = $2 WHERE id = $1',
      'UPDATE cuspatlas.action_proposals SET proposer_id = $2 WHERE id = $1',
      'UPDATE cuspatlas.action_proposals SET expires_at = now() WHERE id = $1 AND $2::uuid IS NOT NULL',
    ]) {
      expect(await sqlstate(asApp(USER_A1, sql, [p.ref, USER_A1]))).toBe('42501');
    }
    expect(
      await sqlstate(asApp(USER_A1, 'DELETE FROM cuspatlas.action_proposals WHERE id = $1', [p.ref])),
    ).toBe('42501');
    // Approval recorded for another principal than the acting one: the trigger refuses.
    expect(
      await sqlstate(
        asApp(
          USER_A1,
          `UPDATE cuspatlas.action_proposals SET state = 'approved', version = 2, approver_id = $2, approver_kind = 'human',
             approved_at = now(), approval_policy_version = policy_version, approval_digest = payload_digest, execution = 'manual'
           WHERE id = $1`,
          [p.ref, USER_A6],
        ),
      ),
    ).toBe('42501');
    // Service self-approval is refused by a constraint even with a forged statement.
    expect(
      await sqlstate(
        asApp(
          SVC_A1,
          `UPDATE cuspatlas.action_proposals SET state = 'approved', version = 2, approver_id = $2, approver_kind = 'human',
             approved_at = now(), approval_policy_version = policy_version, approval_digest = payload_digest, execution = 'manual'
           WHERE id = $1`,
          [p.ref, SVC_A1],
        ),
      ),
    ).toMatch(/^(23514|42501)$/);
    // A committed proposal cannot be reopened.
    const c = await committed();
    expect(
      await sqlstate(
        asApp(
          USER_A1,
          `UPDATE cuspatlas.action_proposals SET state = 'approved', version = 4 WHERE id = $1`,
          [c.ref],
        ),
      ),
    ).toMatch(/^(23514|42501)$/);
    // Provenance is append-only.
    expect(
      await sqlstate(
        asApp(
          USER_A1,
          'UPDATE cuspatlas.action_proposal_provenance SET reason = NULL WHERE proposal_id = $1',
          [c.ref],
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlstate(
        asApp(USER_A1, 'DELETE FROM cuspatlas.action_proposal_provenance WHERE proposal_id = $1', [c.ref]),
      ),
    ).toBe('42501');
  });

  it('a proposal can only be inserted for the acting principal and its real kind', async () => {
    const insert = `INSERT INTO cuspatlas.action_proposals (id, tenant_id, operation, payload, payload_digest,
        policy_version, proposer_id, proposer_kind, correlation_id, expires_at)
      VALUES (gen_random_uuid(), $1, 'syntheticTasks.create', '{"label":"x"}', $2, 'synthetic-proposals.1', $3, $4,
        gen_random_uuid(), now() + interval '5 minutes')`;
    expect(await sqlstate(asApp(SVC_A1, insert, [T_ALPHA, 'a'.repeat(64), USER_A1, 'human']))).toBe('42501');
    expect(await sqlstate(asApp(SVC_A1, insert, [T_ALPHA, 'a'.repeat(64), SVC_A1, 'human']))).toBe('42501');
    expect(await sqlstate(asApp(SVC_A1, insert, [T_BETA, 'a'.repeat(64), SVC_A1, 'service']))).toBe('42501');
    expect(await sqlstate(asApp(SVC_A1, insert, [T_ALPHA, 'a'.repeat(64), SVC_A1, 'service']))).toBe('ok');
  });

  it('another tenant sees none of the proposals or provenance', async () => {
    await prepared(ctx.svcA1());
    for (const t of ['action_proposals', 'action_proposal_provenance']) {
      const { rows } = await asApp(USER_B1, `SELECT count(*)::int AS n FROM cuspatlas.${t}`, [], T_BETA);
      expect([t, rows[0].n]).toStrictEqual([t, 0]);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('privacy', () => {
  it('the marker in payload labels, keys and refs never reaches logs, errors, attempt rows or provenance', async () => {
    const from = logLines.length;
    const taskRef = await freshTask();
    const payload = { taskRef, label: `label ${MARKER}`, expectedVersion: 1 };
    const prep = await viaRest('prepare', tokens.svcA1.rest, {
      operation: 'syntheticTasks.relabel',
      payload,
      idempotencyKey: `${MARKER}-key`,
    });
    expect(prep.status).toBe(201);
    expect(prep.raw).not.toContain(MARKER);
    const ref = String(dataOf(prep).proposalRef);
    const digest = String(dataOf(prep).payloadDigest);
    const outs: Outcome[] = [
      await viaMcp('prepare', tokens.svcA1.mcp, {
        operation: 'syntheticTasks.relabel',
        payload: { ...payload, [MARKER]: 1 },
        idempotencyKey: key(),
      }),
      await viaRest('approve', tokens.svcA1.rest, { proposalRef: ref, payloadDigest: digest }),
      await viaMcp('read', tokens.a4.mcp, { proposalRef: `${MARKER}` }),
      await viaRest('read', tokens.a4.rest, { proposalRef: MARKER }),
      await viaRest('approve', tokens.a1.rest, { proposalRef: ref, payloadDigest: digest }),
      await viaMcp('commit', tokens.a7.mcp, {
        proposalRef: ref,
        payload: { ...payload, label: `other ${MARKER}` },
      }),
    ];
    for (const o of outs) expect(o.raw).not.toContain(MARKER);
    expect(outs.map((o) => o.code)).toStrictEqual([
      'invalid_request',
      'self_approval_denied',
      'not_found',
      'not_found',
      null,
      'payload_mismatch',
    ]);
    // The committed path, through both transports, never echoes the marker except as the caller's own label.
    const p2 = await approved(ctx.svcA1(), ctx.a1(), 'manual', { label: `ok ${MARKER}` });
    const done = await viaRest('commit', tokens.a7.rest, { proposalRef: p2.ref, payload: p2.payload });
    expect(done.status).toBe(200);
    for (const l of logLines.slice(from)) expect(l).not.toContain(MARKER);
    for (const table of [
      'security_attempt_events',
      'action_proposal_provenance',
      'audit_events',
      'outbox_events',
    ]) {
      const { rows } = await db.admin.query(
        `SELECT count(*)::int AS n FROM cuspatlas.${table} t WHERE t::text LIKE $1`,
        [`%${MARKER}%`],
      );
      expect([table, rows[0].n]).toStrictEqual([table, 0]);
    }
  });
});
