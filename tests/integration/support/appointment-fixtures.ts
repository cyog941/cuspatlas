import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import { REFUSAL_HTTP_STATUS, type RefusalCode } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createPortalPrincipalSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import type { AttachmentRefResolver, ImageRefResolver } from '@cuspatlas/domain';
import { buildMcpServer, type McpServerHandle } from '@cuspatlas/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { TestDatabase } from './db';
import {
  SVC_A1,
  SVC_B1,
  seedTenancy,
  T_ALPHA,
  T_BETA,
  USER_A1,
  USER_A2,
  USER_A3,
  USER_A4,
  USER_B1,
} from './fixtures';
import { patientBody, seedPatientScopes } from './patient-fixtures';
import { seedSchedulingScopes, USER_A5 } from './scheduling-fixtures';
import { createTestTokenIssuer, TEST_AUDIENCE, type TestTokenIssuer } from './test-token-issuer';

const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';
const PORTAL_AUDIENCE = 'urn:cuspatlas:portal:synthetic';

export interface McpOutcome {
  readonly status: number;
  readonly code: string | null;
  readonly body: Record<string, unknown>;
}

/**
 * Shared setup for the S8, S10 and S11 integration files: tenancy, patient and scheduling scopes,
 * the REST app under the runtime role, and helpers that build synthetic fixtures through the domain
 * commands only (never by direct writes).
 */
export type Who = 'a1' | 'a2' | 'a3' | 'a4' | 'a5' | 'svcA1' | 'b1' | 'svcB1';

export interface AppointmentHarness {
  readonly app: FastifyInstance;
  readonly issuer: TestTokenIssuer;
  readonly logLines: string[];
  readonly tokens: Record<string, string>;
  call(
    who: Who | string,
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    key?: string | null,
  ): Promise<LightMyRequestResponse>;
  ok<T = Record<string, unknown>>(res: LightMyRequestResponse, status?: number): T;
  /** Calls an MCP tool as `who` (only when opened with `mcp: true`). */
  mcp(who: Who, tool: string, args: Record<string, unknown>, okStatus?: number): Promise<McpOutcome>;
  close(): Promise<void>;
}

export async function openAppointmentHarness(
  db: TestDatabase,
  opts: {
    pool?: number;
    mcp?: boolean;
    portal?: boolean;
    imageRefResolver?: ImageRefResolver;
    attachmentRefs?: AttachmentRefResolver;
  } = {},
): Promise<AppointmentHarness> {
  await seedTenancy(db.admin);
  await seedPatientScopes(db.admin);
  await seedSchedulingScopes(db.admin);
  const issuer = await createTestTokenIssuer();
  const logLines: string[] = [];
  const pool = opts.pool === undefined ? db.app : db.appPool(opts.pool);
  const tenantTransactions = createTenantTransactionRunner(pool);
  const membership = createMembershipSource(db.app);
  const attempts = createSecurityAttemptSink(db.sink);
  const app = await buildApp({
    env: 'synthetic-test',
    logger: { level: 'info', stream: { write: (l: string) => logLines.push(l) } },
    identity: issuer.verifierConfig,
    membership,
    attempts,
    tenantTransactions,
    ...(opts.imageRefResolver ? { imageRefResolver: opts.imageRefResolver } : {}),
    ...(opts.attachmentRefs ? { attachmentRefs: opts.attachmentRefs } : {}),
    // E1: the portal transport (its own audience) is registered only when asked for.
    ...(opts.portal
      ? {
          portalIdentity: { ...issuer.verifierConfig, audience: PORTAL_AUDIENCE },
          portalPrincipals: createPortalPrincipalSource(db.app),
        }
      : {}),
  });
  let server: McpServerHandle | null = null;
  let mcpUrl = '';
  if (opts.mcp) {
    server = buildMcpServer({
      env: 'synthetic-test',
      identity: { ...issuer.verifierConfig, audience: MCP_AUDIENCE },
      restAudience: TEST_AUDIENCE,
      membership,
      attempts,
      tenantTransactions,
      ...(opts.imageRefResolver ? { imageRefResolver: opts.imageRefResolver } : {}),
      ...(opts.attachmentRefs ? { attachmentRefs: opts.attachmentRefs } : {}),
      logger: { stream: { write: (l: string) => logLines.push(l) } },
    });
    mcpUrl = (await server.listen({ host: '127.0.0.1', port: 0 })).url;
  }
  const subjects: Record<Who, [string, string]> = {
    a1: [USER_A1, T_ALPHA],
    a2: [USER_A2, T_ALPHA],
    a3: [USER_A3, T_ALPHA],
    a4: [USER_A4, T_ALPHA],
    a5: [USER_A5, T_ALPHA],
    svcA1: [SVC_A1, T_ALPHA],
    b1: [USER_B1, T_BETA],
    svcB1: [SVC_B1, T_BETA],
  };
  const mcpTokens: Partial<Record<Who, string>> = {};
  const mcp: AppointmentHarness['mcp'] = async (who, tool, args, okStatus = 200) => {
    if (!server) throw new Error('harness opened without mcp');
    const [sub, tid] = subjects[who];
    mcpTokens[who] ??= await issuer.issue({ sub, tid, audience: MCP_AUDIENCE });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${mcpTokens[who]}` } },
    });
    const client = new Client({ name: 'synthetic-appointments', version: '0.0.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: tool, arguments: args });
      const body = result.structuredContent as Record<string, unknown>;
      if (result.isError === true) {
        return { status: REFUSAL_HTTP_STATUS[body.code as RefusalCode], code: body.code as string, body };
      }
      return { status: okStatus, code: null, body };
    } finally {
      await client.close().catch(() => undefined);
    }
  };
  const close = async () => {
    await server?.close();
    await app.close();
  };
  const tokens: Record<string, string> = {
    a1: await issuer.issue({ sub: USER_A1, tid: T_ALPHA }),
    a3: await issuer.issue({ sub: USER_A3, tid: T_ALPHA }),
    a4: await issuer.issue({ sub: USER_A4, tid: T_ALPHA }),
    a5: await issuer.issue({ sub: USER_A5, tid: T_ALPHA }),
    svcA1: await issuer.issue({ sub: SVC_A1, tid: T_ALPHA }),
    b1: await issuer.issue({ sub: USER_B1, tid: T_BETA }),
    // a2 is the REVOKED member and svc-b1 the beta service principal (B10 negative matrix).
    a2: await issuer.issue({ sub: USER_A2, tid: T_ALPHA }),
    svcB1: await issuer.issue({ sub: SVC_B1, tid: T_BETA }),
  };
  const call: AppointmentHarness['call'] = (who, method, url, body, key = randomUUID()) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${tokens[who] ?? who}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(method === 'POST' && key !== null ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const ok = <T>(res: LightMyRequestResponse, status = 200): T => {
    expect([res.statusCode, res.body]).toStrictEqual([status, res.body]);
    return res.json() as T;
  };
  return { app, issuer, logLines, tokens, call, ok, mcp, close };
}

/** Creates a synthetic location with one provider and one operatory, each with weekly hours. */
export async function seedLocation(
  h: AppointmentHarness,
  locationRef: string,
  opts: { who?: Who; timeZone?: string; weekly?: { weekday: number; start: string; end: string }[] } = {},
): Promise<{ locationRef: string; provider: string; operatory: string }> {
  const who = opts.who ?? 'a1';
  h.ok(
    await h.call(who, 'POST', '/v1/scheduling/locations', {
      locationRef,
      displayLabel: `Synthetic ${locationRef}`,
      timeZone: opts.timeZone ?? 'America/New_York',
    }),
    201,
  );
  const weekly = opts.weekly ?? [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '08:00', end: '17:00' }));
  const define = async (kind: string, label: string) => {
    const r = h.ok<{ data: { resourceRef: string } }>(
      await h.call(who, 'POST', '/v1/scheduling/resources', { kind, locationRef, displayLabel: label }),
      201,
    );
    h.ok(
      await h.call(who, 'POST', `/v1/scheduling/resources/${r.data.resourceRef}/availability`, {
        effectiveFrom: '2030-01-01',
        weekly,
      }),
      201,
    );
    return r.data.resourceRef;
  };
  return {
    locationRef,
    provider: await define('provider', 'Synthetic Provider'),
    operatory: await define('operatory', 'Operatory 1'),
  };
}

export async function createPatient(h: AppointmentHarness, given: string, who: Who = 'a1'): Promise<string> {
  const r = h.ok<{ data: { patientRef: string } }>(
    await h.call(who, 'POST', '/v1/patients', patientBody(given)),
    201,
  );
  return r.data.patientRef;
}

export const count = async (db: TestDatabase, table: string): Promise<number> =>
  (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${table}`)).rows[0].n as number;

/** Every table text a caller-controlled value could leak into (marker scans). */
export async function leakTables(db: TestDatabase): Promise<string> {
  const parts: string[] = [];
  for (const t of ['audit_events', 'outbox_events', 'security_attempt_events', 'command_idempotency']) {
    const { rows } = await db.admin.query(
      `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.${t} t`,
    );
    parts.push(rows[0].j);
  }
  return parts.join('\n');
}

export { T_ALPHA, T_BETA, USER_A1, USER_A4, USER_B1 };

export async function setPatientStatus(
  h: AppointmentHarness,
  patientRef: string,
  status: 'inactive' | 'deceased',
  expectedVersion = 1,
): Promise<void> {
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${patientRef}/status`, {
      expectedVersion,
      status,
      effectiveAt: '2026-10-01T00:00:00Z',
      reasonCode: status === 'deceased' ? 'deceased_reported' : 'moved_away',
    }),
  );
}

/** Merges `merged` into `survivor` through candidate review (both must be true duplicates). */
export async function mergePatients(
  h: AppointmentHarness,
  survivor: string,
  merged: string,
): Promise<string> {
  const review = h.ok<{ data: { candidateRef: string; confirmationToken: string }[] }>(
    await h.call('a1', 'GET', `/v1/patients/${survivor}/duplicate-candidates`),
  );
  const token = review.data.find((c) => c.candidateRef === merged)?.confirmationToken;
  expect(token).toBeDefined();
  const res = h.ok<{ data: { mergeRef: string } }>(
    await h.call('a1', 'POST', '/v1/patients/merges', {
      survivorRef: survivor,
      mergedRef: merged,
      confirmationToken: token,
      reasonCode: 'duplicate_registration',
    }),
    201,
  );
  return res.data.mergeRef;
}
