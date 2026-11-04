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
  createAuthorize,
  createSyntheticTaskService,
  executeOnce,
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
import {
  compileInput,
  SYNTHETIC_TASK_TOOLS,
  type ToolDefinition,
  type ToolDeps,
  violationsOf,
} from './tools/synthetic-tasks';

export const MCP_PATH = '/mcp';
export const METADATA_PATH = '/.well-known/oauth-protected-resource';
const BODY_LIMIT = 16 * 1024;

export interface McpServerDeps {
  readonly env: RuntimeEnvironment;
  /** Verifier whose audience is the MCP resource identifier (distinct from the REST audience). */
  readonly identity: IdentityVerifierConfig;
  /** The REST audience; the server refuses to start if it equals the MCP audience. */
  readonly restAudience?: string;
  readonly membership: MembershipSource;
  readonly attempts: SecurityAttemptSink;
  readonly tenantTransactions: WithTenantTransaction;
  readonly execute?: CommandExecutor;
  readonly cursors?: CursorCodec;
  readonly logger?: { readonly stream?: { write(line: string): void } };
  /** Browser origins allowed to call the endpoint. Default none: native MCP clients send no Origin. */
  readonly allowedOrigins?: readonly string[];
  /** Absolute URL of the protected-resource metadata, advertised in the 401 challenge. */
  readonly resourceMetadataUrl?: string;
}

export interface McpServerHandle {
  listen(opts: { host: string; port: number }): Promise<{ url: string }>;
  close(): Promise<void>;
}

interface Registered {
  readonly tool: ToolDefinition;
  readonly validate: ReturnType<typeof compileInput>;
}

const REGISTRY: ReadonlyMap<string, Registered> = new Map(
  SYNTHETIC_TASK_TOOLS.map((tool) => [tool.name, { tool, validate: compileInput(tool.inputSchema) }]),
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
 * authenticated, served by a fresh protocol server and closed). Exposes exactly the four tools in
 * SYNTHETIC_TASK_TOOLS; there is no SQL, shell, HTTP or file tool and no resources or prompts.
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
  const toolDeps: ToolDeps = { service, authorize, recording };
  const allowedOrigins = new Set(deps.allowedOrigins ?? []);
  /** Advertised in the 401 challenge; defaults to the address the server actually listens on. */
  let metadataUrl = deps.resourceMetadataUrl;

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
      const result = await registered.tool.run(toolDeps, actor, args, valid, violations);
      if (!valid) {
        // Defense in depth: an input rejected by the tool schema can never succeed.
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
      tools: SYNTHETIC_TASK_TOOLS.map((t) => ({
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
          metadataUrl ??= `http://${opts.host}:${port}${METADATA_PATH}`;
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
