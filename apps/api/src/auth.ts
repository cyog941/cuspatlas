import type { KeyObject } from 'node:crypto';
import { type ActorContext, type MembershipSource, RefusalError } from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, recordDenial } from '@cuspatlas/domain';
import { type CryptoKey, jwtVerify } from 'jose';

export interface IdentityVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly publicKey: CryptoKey | KeyObject;
  /** Marks a test-only issuer; the server refuses to boot with it outside synthetic-test. */
  readonly testOnly?: boolean;
  readonly clockToleranceSec?: number;
}

const TEST_ISSUER_PREFIX = 'urn:cuspatlas:synthetic-test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TOKEN_LENGTH = 4096;

export function isTestIssuer(cfg: IdentityVerifierConfig): boolean {
  return cfg.testOnly === true || cfg.issuer.startsWith(TEST_ISSUER_PREFIX);
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
