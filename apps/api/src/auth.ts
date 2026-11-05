import type { KeyObject } from 'node:crypto';
import {
  type ActorContext,
  type MembershipSource,
  type PortalPrincipalSource,
  RefusalError,
  type SecurityReasonCode,
} from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, recordDenial } from '@cuspatlas/domain';
import type { FastifyRequest } from 'fastify';
import { type CryptoKey, importSPKI, jwtVerify } from 'jose';

export interface IdentityVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly publicKey: CryptoKey | KeyObject;
  /** Marks a test-only issuer; the server refuses to boot with it outside synthetic-test. */
  readonly testOnly?: boolean;
  /**
   * Informational. Outside synthetic-test the server accepts only configs produced by
   * `loadConfiguredIdentity` (checked structurally, not by this field).
   */
  readonly keySource?: 'test' | 'configured';
  readonly clockToleranceSec?: number;
}

const TEST_ISSUER_PREFIX = 'urn:cuspatlas:synthetic-test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TOKEN_LENGTH = 4096;

export function isTestIssuer(cfg: IdentityVerifierConfig): boolean {
  return cfg.testOnly === true || cfg.keySource === 'test' || cfg.issuer.startsWith(TEST_ISSUER_PREFIX);
}

/** Configs created by loadConfiguredIdentity. Inline objects, test keys and copies are not in here. */
const configuredIdentities = new WeakSet<IdentityVerifierConfig>();

export function isConfiguredIdentity(cfg: IdentityVerifierConfig): boolean {
  return configuredIdentities.has(cfg) && !isTestIssuer(cfg);
}

/**
 * The only production key source: issuer, audience and an Ed25519 SPKI public key read from the
 * environment (CUSPATLAS_JWT_ISSUER, CUSPATLAS_JWT_AUDIENCE, CUSPATLAS_JWT_PUBLIC_KEY_PEM).
 */
export async function loadConfiguredIdentity(env: NodeJS.ProcessEnv): Promise<IdentityVerifierConfig> {
  const issuer = env.CUSPATLAS_JWT_ISSUER;
  const audience = env.CUSPATLAS_JWT_AUDIENCE;
  const pem = env.CUSPATLAS_JWT_PUBLIC_KEY_PEM;
  if (!issuer || !audience || !pem) throw new Error('JWT issuer, audience and public key must be configured');
  if (issuer.startsWith(TEST_ISSUER_PREFIX))
    throw new Error('The test issuer cannot be a configured key source');
  const publicKey = await importSPKI(pem, 'EdDSA');
  const cfg: IdentityVerifierConfig = Object.freeze({ issuer, audience, publicKey, keySource: 'configured' });
  configuredIdentities.add(cfg);
  return cfg;
}

export interface Authenticator {
  /** Verifies the bearer token, then loads live membership. Records and throws on any denial. */
  authenticate(
    authorization: string | undefined,
    correlationId: string,
    operation: string,
  ): Promise<ActorContext>;
}

export interface AuthenticatorOptions {
  /**
   * A8/A9: agent principals reach the system only through the consented MCP deployment, where consent
   * and budgets apply (decision recommended-pending-approval). The REST and other surfaces refuse an
   * agent credential (`agent_transport_denied`); the MCP authenticator admits it.
   */
  readonly agents?: 'admit' | 'refuse';
}

export function createAuthenticator(
  identity: IdentityVerifierConfig,
  memberships: MembershipSource,
  recording: AttemptRecordingDeps,
  options: AuthenticatorOptions = {},
): Authenticator {
  async function refuse(
    err: RefusalError,
    who: { correlationId: string; operation: string; tenantId: string | null; actorId: string | null },
  ): Promise<never> {
    await recordDenial(recording, who, err);
    throw err;
  }

  return {
    async authenticate(authorization, correlationId, operation) {
      const anonymous = { correlationId, operation, tenantId: null, actorId: null };
      const claims = await verifyBearer(identity, authorization);
      if ('refusal' in claims) return refuse(claims.refusal, anonymous);
      const { sub, tid, sid } = claims;

      const m = await memberships.load(sub, tid);
      if (!m?.active) {
        // The actor is verified by signature; the tenant is recorded only if a membership row exists.
        return refuse(new RefusalError({ code: 'forbidden', reasonCode: 'membership_inactive' }), {
          correlationId,
          operation,
          actorId: sub,
          tenantId: m ? m.tenantId : null,
        });
      }
      if (m.agent) {
        const who = { correlationId, operation, actorId: sub, tenantId: m.tenantId };
        // A rotated (or foreign) credential reference: the presented credential no longer exists.
        if (sid !== m.agent.credentialRef) {
          return refuse(
            new RefusalError({ code: 'unauthenticated', reasonCode: 'agent_credential_rotated' }),
            who,
          );
        }
        if (options.agents !== 'admit') {
          return refuse(new RefusalError({ code: 'forbidden', reasonCode: 'agent_transport_denied' }), who);
        }
        return Object.freeze({
          tenantId: m.tenantId,
          actorId: m.principalId,
          principal: m.principal,
          sessionId: sid,
          scopes: m.scopes,
          correlationId,
          agent: Object.freeze({ agentRef: m.agent.agentRef, sponsorRef: m.agent.sponsorRef }),
        });
      }
      return Object.freeze({
        tenantId: m.tenantId,
        actorId: m.principalId,
        principal: m.principal,
        sessionId: sid,
        scopes: m.scopes,
        correlationId,
      });
    },
  };
}

/** Signature, issuer, audience, expiry and claim-shape check shared by every transport. */
async function verifyBearer(
  identity: IdentityVerifierConfig,
  authorization: string | undefined,
): Promise<{ sub: string; tid: string; sid: string } | { refusal: RefusalError }> {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return { refusal: new RefusalError({ code: 'unauthenticated', reasonCode: 'token_missing' }) };
  }
  const token = authorization.slice('Bearer '.length).trim();
  try {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) throw new Error('length');
    const { payload } = await jwtVerify(token, identity.publicKey, {
      issuer: identity.issuer,
      audience: identity.audience,
      algorithms: ['EdDSA'],
      requiredClaims: ['sub', 'exp', 'iat', 'tid', 'sid'],
      clockTolerance: identity.clockToleranceSec ?? 5,
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.tid !== 'string' ||
      typeof payload.sid !== 'string'
    ) {
      throw new Error('claims');
    }
    if (!UUID.test(payload.sub) || !UUID.test(payload.tid) || !/^[A-Za-z0-9-]{1,64}$/.test(payload.sid)) {
      throw new Error('claims');
    }
    return { sub: payload.sub, tid: payload.tid, sid: payload.sid };
  } catch {
    return { refusal: new RefusalError({ code: 'unauthenticated', reasonCode: 'token_invalid' }) };
  }
}

/**
 * E1 portal authenticator: the same EdDSA verifier bound to the portal audience (distinct from the
 * staff and MCP audiences), then the subject's live portal enrolment in the token's tenant. A staff
 * subject is never a portal principal (principal_kind_denied); a missing, revoked or other-tenant
 * enrolment is membership_inactive; a pending one is portal_contact_unverified. The context carries
 * principal `portal` and no scopes, so no staff policy can ever admit it.
 */
export function createPortalAuthenticator(
  identity: IdentityVerifierConfig,
  portalPrincipals: PortalPrincipalSource,
  recording: AttemptRecordingDeps,
): Authenticator {
  return {
    async authenticate(authorization, correlationId, operation) {
      const anonymous = { correlationId, operation, tenantId: null, actorId: null };
      const claims = await verifyBearer(identity, authorization);
      if ('refusal' in claims) {
        await recordDenial(recording, anonymous, claims.refusal);
        throw claims.refusal;
      }
      const row = await portalPrincipals.load(claims.sub, claims.tid);
      const denyAs = async (reasonCode: SecurityReasonCode, tenantKnown: boolean) => {
        const err = new RefusalError({ code: 'forbidden', reasonCode });
        await recordDenial(
          recording,
          { correlationId, operation, actorId: claims.sub, tenantId: tenantKnown ? claims.tid : null },
          err,
        );
        throw err;
      };
      if (row && row.kind !== 'portal') return denyAs('principal_kind_denied', false);
      if (!row || row.state === null || row.state === 'revoked') return denyAs('membership_inactive', false);
      if (row.state !== 'active') return denyAs('portal_contact_unverified', true);
      return Object.freeze({
        tenantId: claims.tid,
        actorId: claims.sub,
        principal: 'portal' as const,
        sessionId: claims.sid,
        scopes: Object.freeze([]) as readonly string[],
        correlationId,
      });
    },
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: ActorContext | null;
  }
}

/** Route-level `onRequest` hook: authenticates before Fastify parses any body. */
export function authenticateOnRequest(authenticator: Authenticator, operation: string) {
  return async (request: FastifyRequest): Promise<void> => {
    request.actor = await authenticator.authenticate(request.headers.authorization, request.id, operation);
  };
}

export function requireActor(request: FastifyRequest): ActorContext {
  if (!request.actor) throw new Error('route registered without authentication');
  return request.actor;
}
