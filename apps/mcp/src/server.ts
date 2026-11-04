import { randomUUID } from 'node:crypto';
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type IdentityVerifierConfig,
  mapErrorToRefusal,
  RUNTIME_ENVIRONMENTS,
  type RuntimeEnvironment,
  safeErrorKind,
} from '@cuspatlas/api';
import {
  type ActorContext,
  type DomainRefusal,
  type MembershipSource,
  REFUSAL_HTTP_STATUS,
  RefusalError,
  type SecurityAttemptSink,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import {
  type AttemptRecordingDeps,
  type CommandExecutor,
  type CursorCodec,
  createAppointmentService,
  createAuthorize,
  createPatientService,
  createProposalService,
  createSchedulingResourceService,
  createSyntheticTaskService,
  executeOnce,
  resolveMatchKeyPepper,
} from '@cuspatlas/domain';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { assertDistinctAudience, assertIdentityAllowed, createMcpAuthenticator } from './auth';
import { APPOINTMENT_TOOLS } from './tools/appointments';
import { PATIENT_TOOLS } from './tools/patients';
import { PROPOSAL_TOOLS } from './tools/proposals';
import { SCHEDULING_TOOLS } from './tools/scheduling';
import { SCHEDULING_OP_TOOLS } from './tools/scheduling-ops';
import {
  compileInput,
  refuseInvalid,
  SYNTHETIC_TASK_TOOLS,
  type ToolDefinition,
  type ToolDeps,
  violationsOf,
} from './tools/synthetic-tasks';

export const MCP_PATH = '/mcp';
export const METADATA_PATH = '/.well-known/oauth-protected-resource';
const BODY_LIMIT = 16 * 1024;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const UNSPECIFIED_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '']);

/** Hostname of a Host header (port stripped, IPv6 kept in brackets), or null when unusable. */
function hostAllowed(host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) return false;
  try {
    const url = new URL(`http://${host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    return allowed.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export interface McpServerDeps {
  readonly env: RuntimeEnvironment;
  /** Match-key pepper (CUSPATLAS_MATCH_KEY_PEPPER); optional only under synthetic-test. */
  readonly matchKeyPepper?: Uint8Array;
  /** Verifier whose audience is the MCP resource identifier (distinct from the REST audience). */
  readonly identity: IdentityVerifierConfig;
  /** The REST audience; the server refuses to start if it equals the MCP audience. */
  readonly restAudience?: string;
  readonly membership: MembershipSource;
  readonly attempts: SecurityAttemptSink;
  readonly tenantTransactions: WithTenantTransaction;
  readonly execute?: CommandExecutor;
  readonly cursors?: CursorCodec;
  /** Proposal policy version (defaults to PROPOSAL_POLICY_VERSION); tests bump it. */
  readonly proposalPolicyVersion?: string;
  readonly logger?: { readonly stream?: { write(line: string): void } };
  /** Browser origins allowed to call the endpoint. Default none: native MCP clients send no Origin. */
  readonly allowedOrigins?: readonly string[];
  /**
   * Absolute URL of the protected-resource metadata, advertised in the 401 challenge. Required
   * outside synthetic-test; in synthetic-test it defaults to the listen address, which must then be
   * a concrete host (never 0.0.0.0 or ::).
   */
  readonly resourceMetadataUrl?: string;
  /**
   * Host header values (hostnames, any port) the endpoint answers. Always includes the loopback
   * names and the host of `resourceMetadataUrl`; anything else is refused with 421 (DNS rebinding).
   */
  readonly allowedHosts?: readonly string[];
}

export interface McpServerHandle {
  listen(opts: { host: string; port: number }): Promise<{ url: string }>;
  close(): Promise<void>;
}

interface Registered {
  readonly tool: ToolDefinition;
  readonly validate: ReturnType<typeof compileInput>;
}

export const TOOLS: readonly ToolDefinition[] = [
  ...SYNTHETIC_TASK_TOOLS,
  ...PROPOSAL_TOOLS,
  ...PATIENT_TOOLS,
  ...SCHEDULING_TOOLS,
  ...APPOINTMENT_TOOLS,
  ...SCHEDULING_OP_TOOLS,
];

/** Path parameters of the REST twin. A malformed one is a 404 there, decided by the domain. */
const REF_PARAMS = [
  'taskRef',
  'proposalRef',
  'patientRef',
  'relationshipRef',
  'mergeRef',
  'resourceRef',
  'locationRef',
  'requestRef',
  'appointmentRef',
  'holdRef',
  // S12-S16 path parameters.
  'itemRef',
  'seriesRef',
  'intentRef',
  'entryRef',
  'offerRef',
  'recoveryRef',
  'policyRef',
] as const;
const PLACEHOLDER_REF = '00000000-0000-4000-8000-000000000000';

/**
 * True when the arguments would be valid but for a string path reference that is malformed. Such
 * calls go to the domain, which refuses them with the same 404 as REST before any domain statement
 * (it validates the reference right after authorization).
 */
function onlyRefMalformed(registered: Registered, args: Record<string, unknown>): boolean {
  const present = REF_PARAMS.filter((p) => typeof args[p] === 'string');
  if (present.length === 0) return false;
  const patched = { ...args, ...Object.fromEntries(present.map((p) => [p, PLACEHOLDER_REF])) };
  return registered.validate(patched) === true;
}

const REGISTRY: ReadonlyMap<string, Registered> = new Map(
  TOOLS.map((tool) => [tool.name, { tool, validate: compileInput(tool.inputSchema) }]),
);

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('too large'), { tooLarge: true });
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Remote MCP endpoint for the synthetic-task domain over Streamable HTTP (stateless: every POST is
 * authenticated, served by a fresh protocol server and closed). Exposes exactly the tools in
 * TOOLS (synthetic-task, proposal, patient and scheduling tools); there is no SQL, shell, HTTP or file tool and no resources or prompts.
 */
export function buildMcpServer(deps: McpServerDeps): McpServerHandle {
  if (!RUNTIME_ENVIRONMENTS.includes(deps.env)) throw new Error('Unsupported runtime environment');
  assertIdentityAllowed(deps.env, deps.identity);
  assertDistinctAudience({
    identity: deps.identity,
    ...(deps.restAudience === undefined ? {} : { restAudience: deps.restAudience }),
  });

  const write = (line: Record<string, unknown>) =>
    (deps.logger?.stream ?? process.stderr).write(`${JSON.stringify(line)}\n`);
  const recording: AttemptRecordingDeps = {
    sink: deps.attempts,
    alert: (code) => write({ level: 'error', msg: 'security alert', alert: code }),
  };
  const authenticator = createMcpAuthenticator(
    {
      identity: deps.identity,
      ...(deps.restAudience === undefined ? {} : { restAudience: deps.restAudience }),
    },
    deps.membership,
    recording,
  );
  const authorize = createAuthorize(deps.membership);
  const service = createSyntheticTaskService({
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute: deps.execute ?? executeOnce,
    ...(deps.cursors ? { cursors: deps.cursors } : {}),
  });
  const proposals = createProposalService({
    authorize,
    memberships: deps.membership,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute: deps.execute ?? executeOnce,
    ...(deps.proposalPolicyVersion ? { policyVersion: deps.proposalPolicyVersion } : {}),
  });
  const patients = createPatientService({
    matchKeyPepper: resolveMatchKeyPepper(deps.env, deps.matchKeyPepper),
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute: deps.execute ?? executeOnce,
    ...(deps.cursors ? { cursors: deps.cursors } : {}),
  });
  const scheduling = createSchedulingResourceService({
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute: deps.execute ?? executeOnce,
  });
  const appointments = createAppointmentService({
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute: deps.execute ?? executeOnce,
  });
  const toolDeps: ToolDeps = { service, proposals, patients, scheduling, appointments, authorize, recording };
  const allowedOrigins = new Set(deps.allowedOrigins ?? []);
  if (deps.env !== 'synthetic-test' && !deps.resourceMetadataUrl) {
    throw new Error('Refusing to start: resourceMetadataUrl must be configured outside synthetic-test');
  }
  /** Advertised in the 401 challenge; defaults to the address the server actually listens on. */
  let metadataUrl = deps.resourceMetadataUrl;
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...(deps.allowedHosts ?? [])].map((h) => h.toLowerCase()));
  if (metadataUrl) allowedHosts.add(new URL(metadataUrl).hostname.toLowerCase());

  function refusalResult(refusal: DomainRefusal) {
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text: JSON.stringify(refusal) }],
      structuredContent: { ...refusal },
    };
  }

  /** One tool call: schema first (for routing), then the shared domain handler with a server-built actor. */
  async function callTool(actor: ActorContext, name: string, rawArgs: unknown) {
    const registered = REGISTRY.get(name);
    // Unknown tools are a protocol error and never echo the caller-supplied name.
    if (!registered) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
    const args =
      rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const valid = registered.validate(args);
    const violations = valid ? [] : violationsOf(registered.validate.errors);
    let code = 'ok';
    try {
      // Arguments are validated before any handler runs (the handler sees only valid input, except
      // for tools whose domain service performs the identical validation itself).
      if (!valid && registered.tool.onInvalid !== 'domain' && !onlyRefMalformed(registered, args)) {
        await refuseInvalid(toolDeps, actor, registered.tool, violations);
      }
      const result = await registered.tool.run(toolDeps, actor, args, valid, violations);
      if (!valid) {
        // Defense in depth: an input rejected by the tool schema can never succeed.
        // Invariant for `onInvalid: 'domain'` tools (propose, approve, commit): their handler has
        // already run here, so it must have refused anything this schema rejects. That holds because
        // their input schema is exactly the domain validator's sub-schema plus transport properties
        // validated by the same definitions (asserted in tool-drift.test.ts, "domain-validated MCP
        // tools are never stricter than the domain validator"). Never make such a tool's schema
        // stricter than the domain, or a call could execute and still be reported as invalid.
        throw new RefusalError({ code: 'invalid_request', detail: { violations } });
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (err) {
      const { body } = mapErrorToRefusal(err, actor.correlationId);
      code = body.code;
      if (REFUSAL_HTTP_STATUS[body.code] >= 500)
        write({ level: 'error', msg: 'tool failed', ...safeErrorKind(err) });
      return refusalResult(body);
    } finally {
      write({
        level: 'info',
        msg: 'tool_call',
        tool: name,
        actorId: actor.actorId,
        correlationId: actor.correlationId,
        code,
      });
    }
  }

  function protocolServer(actor: ActorContext): Server {
    const server = new Server(
      { name: 'cuspatlas-synthetic', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as never,
        annotations: { readOnlyHint: t.readOnly, openWorldHint: false },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      callTool(actor, request.params.name, request.params.arguments),
    );
    return server;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const correlationId = randomUUID();
    const common = { 'x-correlation-id': correlationId };
    const refuse = (status: number, err: unknown, extra: Record<string, string> = {}) => {
      const { body } = mapErrorToRefusal(err, correlationId);
      sendJson(res, status, body, { ...common, ...extra });
    };
    if (!hostAllowed(req.headers.host, allowedHosts)) {
      return refuse(421, new RefusalError({ code: 'invalid_request' }));
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && path === METADATA_PATH) {
      // RFC 9728 protected-resource metadata; public by design, contains no tenant data.
      return sendJson(
        res,
        200,
        {
          resource: deps.identity.audience,
          authorization_servers: [deps.identity.issuer],
          bearer_methods_supported: ['header'],
        },
        common,
      );
    }
    if (path !== MCP_PATH) return refuse(404, { statusCode: 404 });
    if (typeof req.headers.origin === 'string' && !allowedOrigins.has(req.headers.origin)) {
      return refuse(403, new RefusalError({ code: 'forbidden' }));
    }
    if (req.method !== 'POST') {
      return refuse(405, { statusCode: 405 }, { allow: 'POST' });
    }

    let actor: ActorContext;
    try {
      actor = await authenticator.authenticate(req.headers.authorization, correlationId);
    } catch (err) {
      const { status } = mapErrorToRefusal(err, correlationId);
      const challenge = `Bearer realm="cuspatlas-mcp"${
        metadataUrl ? `, resource_metadata="${metadataUrl}"` : ''
      }`;
      if (status >= 500) write({ level: 'error', msg: 'auth failed', ...safeErrorKind(err) });
      return refuse(status, err, status === 401 ? { 'www-authenticate': challenge } : {});
    }

    let parsed: unknown;
    try {
      parsed = await readBody(req);
    } catch (err) {
      const tooLarge = (err as { tooLarge?: boolean }).tooLarge === true;
      return refuse(tooLarge ? 413 : 400, new RefusalError({ code: 'invalid_request' }));
    }

    const server = protocolServer(actor);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('cache-control', 'no-store');
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  }

  const http: HttpServer = createServer((req, res) => {
    handle(req, res).catch((err) => {
      write({ level: 'error', msg: 'request failed', ...safeErrorKind(err) });
      if (!res.headersSent) {
        sendJson(res, 500, { code: 'internal_error', retryable: true, correlationId: randomUUID() });
      } else {
        res.end();
      }
    });
  });

  return {
    listen: (opts) =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(opts.port, opts.host, () => {
          http.off('error', reject);
          const { port } = http.address() as AddressInfo;
          if (metadataUrl === undefined) {
            if (UNSPECIFIED_HOSTS.has(opts.host)) {
              http.close();
              reject(
                new Error('resourceMetadataUrl must be configured when listening on an unspecified address'),
              );
              return;
            }
            metadataUrl = `http://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${port}${METADATA_PATH}`;
            allowedHosts.add(new URL(metadataUrl).hostname.toLowerCase());
          }
          resolve({ url: `http://${opts.host}:${port}${MCP_PATH}` });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
