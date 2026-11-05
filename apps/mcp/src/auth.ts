import {
  type Authenticator,
  createAuthenticator,
  type IdentityVerifierConfig,
  isConfiguredIdentity,
  isTestIssuer,
  loadConfiguredIdentity,
} from '@cuspatlas/api';
import type { ActorContext, MembershipSource } from '@cuspatlas/contracts';
import type { AttemptRecordingDeps } from '@cuspatlas/domain';

/**
 * MCP authorization posture (implemented against the MCP authorization specification revision
 * 2025-06-18, which classifies the MCP server as an OAuth 2.1 resource server):
 *
 * - Bearer token only, in the Authorization header (never the URL query string).
 * - The token audience MUST be this MCP server's resource identifier (RFC 8707 audience binding).
 *   It is verified with the same verifier as the REST API (EdDSA only, issuer, audience, exp, nbf,
 *   required claims, live membership lookup) but with a distinct audience, so a token minted for the
 *   REST API is refused here and an MCP token is refused by REST. No token passthrough.
 * - 401 carries a WWW-Authenticate Bearer challenge and the server publishes RFC 9728
 *   protected-resource metadata; 403 is used for an authenticated principal without access.
 * - The authorization server itself (issuance, client registration, consent) is out of scope for the
 *   synthetic foundation; only token validation is implemented.
 */
export const MCP_OPERATION = 'mcp.request';

export interface McpIdentityOptions {
  /** Verifier config whose audience is the MCP resource identifier. */
  readonly identity: IdentityVerifierConfig;
  /** The REST API audience. When given, the MCP audience must differ from it. */
  readonly restAudience?: string;
  /** The portal audience. When given, the MCP audience must differ from it too. */
  readonly portalAudience?: string;
}

/** Throws when the MCP verifier could be confused with the REST one. */
export function assertDistinctAudience(opts: McpIdentityOptions): void {
  if (opts.identity.audience.length === 0) throw new Error('MCP audience must be configured');
  if (opts.restAudience !== undefined && opts.identity.audience === opts.restAudience) {
    throw new Error('Refusing to start: the MCP audience must differ from the REST API audience');
  }
  if (opts.portalAudience !== undefined && opts.identity.audience === opts.portalAudience) {
    throw new Error('Refusing to start: the MCP audience must differ from the portal audience');
  }
}

/** Refuses test or non-configured key sources outside synthetic-test, exactly like the REST API. */
export function assertIdentityAllowed(env: string, identity: IdentityVerifierConfig): void {
  if (env !== 'synthetic-test' && (isTestIssuer(identity) || !isConfiguredIdentity(identity))) {
    throw new Error(
      'Refusing to start: the test issuer or any non-configured key source is only permitted when CUSPATLAS_ENV=synthetic-test',
    );
  }
}

/**
 * Production key source for MCP: the same issuer and public key as REST, but the audience comes from
 * CUSPATLAS_MCP_AUDIENCE (the MCP resource identifier), never from CUSPATLAS_JWT_AUDIENCE.
 */
export function loadConfiguredMcpIdentity(env: NodeJS.ProcessEnv): Promise<IdentityVerifierConfig> {
  const audience = env.CUSPATLAS_MCP_AUDIENCE;
  if (!audience) throw new Error('CUSPATLAS_MCP_AUDIENCE must be configured');
  if (audience === env.CUSPATLAS_JWT_AUDIENCE) {
    throw new Error('CUSPATLAS_MCP_AUDIENCE must differ from CUSPATLAS_JWT_AUDIENCE');
  }
  return loadConfiguredIdentity({ ...env, CUSPATLAS_JWT_AUDIENCE: audience });
}

export interface McpAuthenticator {
  authenticate(authorization: string | undefined, correlationId: string): Promise<ActorContext>;
}

/** The shared authenticator bound to the MCP audience; denials are recorded with null identity. */
export function createMcpAuthenticator(
  opts: McpIdentityOptions,
  memberships: MembershipSource,
  recording: AttemptRecordingDeps,
): McpAuthenticator {
  assertDistinctAudience(opts);
  // A8/A9: the MCP deployment is the one surface an agent credential is admitted on (consent and
  // budgets are enforced per tool call in server.ts).
  const inner: Authenticator = createAuthenticator(opts.identity, memberships, recording, {
    agents: 'admit',
  });
  return {
    authenticate: (authorization, correlationId) =>
      inner.authenticate(authorization, correlationId, MCP_OPERATION),
  };
}
