import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '@cuspatlas/api';
import type { ObjectStorePort } from '@cuspatlas/contracts';
import {
  createDeviceCredentialSource,
  createLocalObjectStore,
  createLocalStagingMaintenance,
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { encodePng, type ImagingLimits, resolveBridgeSigningKey, syntheticRaster } from '@cuspatlas/domain';
import { buildMcpServer, type McpServerHandle } from '@cuspatlas/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { openTestDatabase, type TestDatabase } from './db';
import { createFakeScanner, type FakeScanner } from './fake-scanner';
import {
  SVC_A1,
  SVC_B1,
  seedTenancy,
  T_ALPHA,
  USER_A1,
  USER_A2,
  USER_A3,
  USER_A4,
  USER_B1,
} from './fixtures';
import { seedPatientScopes, USER_A5, USER_A6 } from './patient-fixtures';
import { createTestTokenIssuer, TEST_AUDIENCE } from './test-token-issuer';

/** Synthetic imaging scopes (workstream I). Registered in docs/SHARED-CONTRACTS.md. */
export const IMG_READ = 'imaging.read';
export const IMG_WRITE = 'imaging.write';
export const IMG_ASSOCIATE = 'imaging.associate';
export const IMG_DELETE = 'imaging.delete';
export const IMG_HOLD = 'imaging.legalHold';
export const IMG_ALL = [IMG_READ, IMG_WRITE, IMG_ASSOCIATE, IMG_DELETE, IMG_HOLD, 'admin.configure'];

/** Second human in alpha with imaging read/write/delete (dual-approval counterpart, I-D6). */
export const USER_A7 = '20000000-0000-4000-8000-0000000000a7';

/**
 * Imaging scopes on top of seedTenancy and seedPatientScopes (superuser fixture path, test-only):
 * a1 everything, a2 the same but REVOKED, a3 read/write (loc-north membership; images are tenant-wide),
 * a4 imaging read only (downgraded), a5 no imaging scope, a6 read/write/associate, a7 read/write/delete,
 * svc-a1 read/write, b1 everything in beta, svc-b1 read/write in beta.
 */
export async function seedImagingScopes(admin: pg.Pool): Promise<void> {
  const add: [string, string[]][] = [
    [USER_A1, IMG_ALL],
    [USER_A2, IMG_ALL],
    [USER_A3, [IMG_READ, IMG_WRITE]],
    [USER_A4, [IMG_READ]],
    [USER_A6, [IMG_READ, IMG_WRITE, IMG_ASSOCIATE]],
    [SVC_A1, [IMG_READ, IMG_WRITE]],
    [USER_B1, IMG_ALL],
    [SVC_B1, [IMG_READ, IMG_WRITE]],
  ];
  for (const [principal, scopes] of add) {
    await admin.query(
      'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
      [principal, scopes],
    );
  }
  await admin.query(`INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', 'user-a7')`, [
    USER_A7,
  ]);
  await admin.query(
    'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)',
    [T_ALPHA, USER_A7, [IMG_READ, IMG_WRITE, IMG_DELETE, 'patients.read']],
  );
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A tiny synthetic grayscale PNG (gradient keyed by seed); never a radiograph. */
export const pngBytes = (seed = 0, width = 8, height = 6) => encodePng(syntheticRaster(width, height, seed));

/** A per-run object store under os.tmpdir(), removed on teardown. */
export function tempObjectStore(): { root: string; store: ObjectStorePort; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'cuspatlas-objects-'));
  return {
    root,
    store: createLocalObjectStore({ root, env: 'synthetic-test' }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Test-only fixture path: stores bytes through the adapter and registers an available object row (and
 * one provenance row) through the superuser connection, standing in for a completed I2 ingress.
 */
export async function putFixtureObject(
  admin: pg.Pool,
  store: ObjectStorePort,
  o: {
    tenantId: string;
    createdBy: string;
    bytes: Uint8Array;
    contentType?: string;
    originalFilename?: string;
    receivedAt?: string;
  },
): Promise<string> {
  const staged = await store.stage(o.tenantId, o.bytes);
  const { storageKey } = await store.promote(o.tenantId, staged.stagingKey, staged.digestSha256);
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO cuspatlas.imaging_objects (tenant_id, kind, state, content_type, byte_length, digest_sha256,
       storage_key, created_by, received_at)
     VALUES ($1, 'original', 'available', $2, $3, $4, $5, $6, coalesce($7::timestamptz, now())) RETURNING id`,
    [
      o.tenantId,
      o.contentType ?? 'image/png',
      o.bytes.byteLength,
      staged.digestSha256,
      storageKey,
      o.createdBy,
      o.receivedAt ?? null,
    ],
  );
  const id = rows[0]?.id as string;
  await admin.query(
    `INSERT INTO cuspatlas.imaging_object_provenance (tenant_id, object_id, source, operator_id, original_filename)
     VALUES ($1, $2, 'operatorUpload', $3, $4)`,
    [o.tenantId, id, o.createdBy, o.originalFilename ?? null],
  );
  return id;
}

export const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';

export type Who =
  | 'owner'
  | 'crossTenant'
  | 'revoked'
  | 'imagingReadOnly'
  | 'noImagingScopes'
  | 'writer'
  | 'associator'
  | 'deleter'
  | 'service';

export interface ImagingStack {
  readonly db: TestDatabase;
  readonly app: FastifyInstance;
  readonly store: ObjectStorePort;
  readonly storeRoot: string;
  /** The MCP endpoint (for raw-credential negatives). */
  readonly mcpUrl: string;
  readonly scanner: FakeScanner;
  readonly logLines: string[];
  readonly rest: Record<Who, string>;
  readonly mcpTokens: Record<Who, string>;
  inject(
    who: Who,
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{
    status: number;
    json: Record<string, unknown>;
    body: string;
    headers: Record<string, unknown>;
    raw: Buffer;
  }>;
  /** POST with a fresh Idempotency-Key unless `key` is given. */
  command(who: Who, url: string, body: unknown, key?: string): ReturnType<ImagingStack['inject']>;
  mcp(
    who: Who,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; body: Record<string, unknown>; raw: string }>;
  mcpToolNames(who: Who): Promise<string[]>;
  issue(sub: string, tid: string, mcp?: boolean): Promise<string>;
  close(): Promise<void>;
}

/** One REST app and one MCP server over a fresh database, a per-run object store and the fake scanner. */
export async function startImagingStack(
  label: string,
  opts: {
    limits?: ImagingLimits;
    withStore?: boolean;
    /** I9 restore drill: run over an existing (restored) database and store root, without seeding. */
    database?: TestDatabase;
    storeRoot?: string;
    seed?: boolean;
    /** Test-only: wraps the per-run store (for example to pause inside a port call). */
    wrapStore?: (store: ObjectStorePort) => ObjectStorePort;
  } = {},
): Promise<ImagingStack> {
  const db = opts.database ?? (await openTestDatabase(label));
  if (opts.seed !== false) {
    await seedTenancy(db.admin);
    await seedPatientScopes(db.admin);
    await seedImagingScopes(db.admin);
  }
  const issuer = await createTestTokenIssuer();
  const logLines: string[] = [];
  const stream = { write: (l: string) => logLines.push(l) };
  const temp = opts.storeRoot
    ? {
        root: opts.storeRoot,
        store: createLocalObjectStore({ root: opts.storeRoot, env: 'synthetic-test' }),
        cleanup: () => undefined,
      }
    : tempObjectStore();
  const scanner = createFakeScanner();
  const membership = createMembershipSource(db.app);
  const attempts = createSecurityAttemptSink(db.sink);
  const tenantTransactions = createTenantTransactionRunner(db.app);
  const shared = {
    env: 'synthetic-test' as const,
    membership,
    attempts,
    tenantTransactions,
    scanner,
    ...(opts.withStore === false
      ? {}
      : { objectStore: opts.wrapStore ? opts.wrapStore(temp.store) : temp.store }),
    ...(opts.limits ? { imagingLimits: opts.limits } : {}),
    ...(opts.withStore === false ? {} : { stagingMaintenance: createLocalStagingMaintenance(temp.root) }),
  };
  const app = await buildApp({
    ...shared,
    logger: { level: 'info', stream },
    identity: issuer.verifierConfig,
    // I6 bridge audience: device credentials and an ephemeral synthetic-test job-signing key.
    deviceCredentials: createDeviceCredentialSource(db.app),
    bridgeSigningKey: resolveBridgeSigningKey('synthetic-test', undefined),
  });
  const mcp: McpServerHandle = buildMcpServer({
    ...shared,
    identity: { ...issuer.verifierConfig, audience: MCP_AUDIENCE },
    restAudience: TEST_AUDIENCE,
    logger: { stream },
  });
  const mcpUrl = (await mcp.listen({ host: '127.0.0.1', port: 0 })).url;
  const people: [Who, string, string][] = [
    ['owner', USER_A1, T_ALPHA],
    ['crossTenant', USER_B1, '10000000-0000-4000-8000-00000000000b'],
    ['revoked', USER_A2, T_ALPHA],
    ['imagingReadOnly', USER_A4, T_ALPHA],
    ['noImagingScopes', USER_A5, T_ALPHA],
    ['writer', USER_A3, T_ALPHA],
    ['associator', USER_A6, T_ALPHA],
    ['deleter', USER_A7, T_ALPHA],
    ['service', SVC_A1, T_ALPHA],
  ];
  const rest = {} as Record<Who, string>;
  const mcpTokens = {} as Record<Who, string>;
  for (const [who, sub, tid] of people) {
    rest[who] = await issuer.issue({ sub, tid });
    mcpTokens[who] = await issuer.issue({ sub, tid, audience: MCP_AUDIENCE });
  }
  const inject: ImagingStack['inject'] = async (who, method, url, body, headers = {}) => {
    const binary = body instanceof Uint8Array;
    const res = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${rest[who]}`,
        ...(method === 'POST'
          ? { 'content-type': binary ? 'application/octet-stream' : 'application/json' }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: binary ? Buffer.from(body) : JSON.stringify(body) }),
    });
    let json: Record<string, unknown> = {};
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json, body: res.body, headers: res.headers, raw: res.rawPayload };
  };
  const client = async <T>(who: Who, fn: (c: Client) => Promise<T>) => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${mcpTokens[who]}` } },
    });
    const c = new Client({ name: 'synthetic-imaging', version: '0.0.0' });
    try {
      await c.connect(transport);
      return await fn(c);
    } finally {
      await c.close().catch(() => undefined);
    }
  };
  return {
    db,
    app,
    store: temp.store,
    storeRoot: temp.root,
    mcpUrl,
    scanner,
    logLines,
    rest,
    mcpTokens,
    inject,
    command: (who, url, body, key = randomUUID()) =>
      inject(who, 'POST', url, body, { 'idempotency-key': key }),
    mcp: (who, tool, args) =>
      client(who, async (c) => {
        const r = await c.callTool({ name: tool, arguments: args });
        return {
          isError: r.isError === true,
          body: (r.structuredContent ?? {}) as Record<string, unknown>,
          raw: JSON.stringify(r),
        };
      }),
    mcpToolNames: (who) => client(who, async (c) => (await c.listTools()).tools.map((t) => t.name)),
    issue: (sub, tid, toMcp = false) =>
      issuer.issue({ sub, tid, ...(toMcp ? { audience: MCP_AUDIENCE } : {}) }),
    async close() {
      await mcp.close();
      await app.close();
      await db.close();
      temp.cleanup();
    },
  };
}

/** Every table text a caller-controlled value could leak into (marker scans). */
export async function imagingLeakSurface(admin: pg.Pool): Promise<string> {
  const parts: string[] = [];
  for (const t of [
    'audit_events',
    'outbox_events',
    'security_attempt_events',
    'command_idempotency',
    'sensitive_read_events',
  ]) {
    const { rows } = await admin.query(`SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.${t} t`);
    parts.push(rows[0].j);
  }
  return parts.join('\n');
}

export async function attemptReasons(admin: pg.Pool, correlationId: unknown): Promise<string[]> {
  if (typeof correlationId !== 'string') return [];
  const { rows } = await admin.query(
    'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1 ORDER BY occurred_at',
    [correlationId],
  );
  return rows.map((r) => r.reason_code as string);
}

/** Begin, upload and complete one ingress through REST as `who`; returns the completion response. */
export async function ingestVia(
  s: ImagingStack,
  bytes: Uint8Array,
  extra: Record<string, unknown> = {},
  who: Who = 'owner',
): Promise<{ ingressRef: string; objectRef: string; status: number }> {
  const b = await s.command(who, '/v1/imaging/ingress', {
    contentType: 'image/png',
    byteLength: bytes.byteLength,
    declaredDigest: sha256(bytes),
    provenance: { source: 'operatorUpload' },
    ...extra,
  });
  const ingressRef = (b.json.data as { ingressRef: string }).ingressRef;
  await s.command(who, `/v1/imaging/ingress/${ingressRef}/content`, bytes);
  const c = await s.command(who, `/v1/imaging/ingress/${ingressRef}/complete`, {
    observedDigest: sha256(bytes),
  });
  return {
    ingressRef,
    objectRef: (c.json.data as { objectRef?: string } | undefined)?.objectRef ?? '',
    status: c.status,
  };
}
