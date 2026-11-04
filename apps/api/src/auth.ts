import type { KeyObject } from 'node:crypto';
import { type ActorContext, type MembershipSource, RefusalError } from '@cuspatlas/contracts';
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

export function createAuthenticator(
  identity: IdentityVerifierConfig,
  memberships: MembershipSource,
  recording: AttemptRecordingDeps,
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
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
        return refuse(new RefusalError({ code: 'unauthenticated', reasonCode: 'token_missing' }), anonymous);
      }
      const token = authorization.slice('Bearer '.length).trim();
      let sub: string;
      let tid: string;
      let sid: string;
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
        sub = payload.sub;
        tid = payload.tid;
        sid = payload.sid;
      } catch {
        return refuse(new RefusalError({ code: 'unauthenticated', reasonCode: 'token_invalid' }), anonymous);
      }

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
