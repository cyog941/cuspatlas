import {
  type ActorContext,
  type DeviceCredentialSource,
  RefusalError,
  type SecurityReasonCode,
} from '@cuspatlas/contracts';
import {
  type AttemptRecordingDeps,
  BRIDGE_AUDIENCE,
  DEVICE_ASSERTION_TYP,
  peekHeader,
  publicKeyFromRaw,
  recordDenial,
  verifyCompact,
} from '@cuspatlas/domain';
import type { FastifyRequest } from 'fastify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KID = /^([0-9a-f-]{36})\.([1-9][0-9]{0,5})$/;
/** Longest accepted assertion lifetime and clock tolerance, in seconds. */
export const DEVICE_ASSERTION_MAX_SECONDS = 120;
const TOLERANCE_SECONDS = 5;

export interface DeviceAuthenticator {
  authenticate(
    authorization: string | undefined,
    request: { readonly method: string; readonly path: string },
    correlationId: string,
    operation: string,
  ): Promise<ActorContext>;
}

/**
 * I6 bridge-audience authenticator. A device assertion is a compact JWS (EdDSA, typ
 * cuspatlas-device-assertion+jws) signed by the device's own active key, naming the device (kid
 * `<deviceRef>.<keyVersion>`, iss = sub), the bridge audience, the device's tenant, a lifetime of at
 * most 120 s, a single-use jti and the request it is for (htm and htu). The device and its tenant are
 * loaded from the database; a tenant claim that disagrees is refused. Staff bearer tokens are never
 * device assertions (no device kid, wrong signer) and device assertions never verify against the
 * staff issuer key, so neither credential works on the other's routes. The context carries principal
 * `device` and no scopes: no staff policy can admit it.
 */
export function createDeviceAuthenticator(
  devices: DeviceCredentialSource,
  recording: AttemptRecordingDeps,
): DeviceAuthenticator {
  return {
    async authenticate(authorization, request, correlationId, operation) {
      const deny = async (
        code: 'unauthenticated' | 'forbidden',
        reasonCode: SecurityReasonCode,
        who: { tenantId: string | null; actorId: string | null } = { tenantId: null, actorId: null },
      ): Promise<never> => {
        const err = new RefusalError({ code, reasonCode });
        await recordDenial(recording, { correlationId, operation, ...who }, err);
        throw err;
      };
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
        return deny('unauthenticated', 'token_missing');
      const token = authorization.slice('Bearer '.length).trim();
      const header = peekHeader(token);
      const kid = header?.typ === DEVICE_ASSERTION_TYP ? KID.exec(header.kid) : null;
      if (!kid) return deny('unauthenticated', 'device_assertion_invalid');
      const deviceRef = kid[1] as string;
      const keyVersion = Number(kid[2]);
      if (!UUID.test(deviceRef)) return deny('unauthenticated', 'device_assertion_invalid');
      const record = await devices.load(deviceRef);
      if (!record) return deny('unauthenticated', 'device_assertion_invalid');
      const key = record.keys.find((k) => k.keyVersion === keyVersion);
      const pub = key ? publicKeyFromRaw(key.publicKey) : null;
      const claims = pub ? verifyCompact(token, pub, DEVICE_ASSERTION_TYP) : null;
      if (!claims) {
        // A revoked device has no active key: say so (its identity is established by the kid only).
        if (record.state === 'revoked')
          return deny('forbidden', 'device_revoked', { tenantId: record.tenantId, actorId: deviceRef });
        return deny('unauthenticated', 'device_assertion_invalid');
      }
      const now = Math.floor(Date.now() / 1000);
      const iat = claims.iat;
      const exp = claims.exp;
      const valid =
        Object.keys(claims).sort().join(',') === 'aud,exp,htm,htu,iat,iss,jti,sub,tid' &&
        claims.iss === deviceRef &&
        claims.sub === deviceRef &&
        claims.aud === BRIDGE_AUDIENCE &&
        claims.tid === record.tenantId &&
        typeof iat === 'number' &&
        typeof exp === 'number' &&
        Number.isInteger(iat) &&
        Number.isInteger(exp) &&
        exp > iat &&
        exp - iat <= DEVICE_ASSERTION_MAX_SECONDS &&
        iat <= now + TOLERANCE_SECONDS &&
        exp > now - TOLERANCE_SECONDS &&
        typeof claims.jti === 'string' &&
        UUID.test(claims.jti) &&
        claims.htm === request.method &&
        claims.htu === request.path;
      if (!valid) return deny('unauthenticated', 'device_assertion_invalid');
      const who = { tenantId: record.tenantId, actorId: deviceRef };
      if (record.state !== 'active') return deny('forbidden', 'device_revoked', who);
      const fresh = await devices.consumeNonce(
        record,
        claims.jti as string,
        new Date((exp + TOLERANCE_SECONDS) * 1000),
      );
      if (!fresh) return deny('unauthenticated', 'device_assertion_replayed', who);
      return Object.freeze({
        tenantId: record.tenantId,
        actorId: deviceRef,
        principal: 'device' as const,
        sessionId: claims.jti as string,
        scopes: Object.freeze([]) as readonly string[],
        correlationId,
      });
    },
  };
}

/** Route-level `onRequest` hook for bridge routes: binds the assertion to this method and path. */
export function authenticateDeviceOnRequest(authenticator: DeviceAuthenticator, operation: string) {
  return async (request: FastifyRequest): Promise<void> => {
    const path = request.url.split('?')[0] ?? '';
    request.actor = await authenticator.authenticate(
      request.headers.authorization,
      { method: request.method, path },
      request.id,
      operation,
    );
  };
}
