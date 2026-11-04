import { randomUUID } from 'node:crypto';
import type { IdentityVerifierConfig } from '@cuspatlas/api';
import { type CryptoKey, generateKeyPair, SignJWT } from 'jose';

export const TEST_ISSUER = 'urn:cuspatlas:synthetic-test-issuer';
export const TEST_AUDIENCE = 'urn:cuspatlas:api:synthetic';

export interface IssueOptions {
  readonly sub: string;
  readonly tid: string;
  readonly sid?: string;
  readonly issuer?: string;
  readonly audience?: string;
  /** Seconds relative to now. Negative values produce an expired token. */
  readonly expiresInSec?: number;
  readonly notBeforeSec?: number;
  /** Sign with a different key to simulate a bad signature. */
  readonly foreignKey?: boolean;
}

export interface TestTokenIssuer {
  readonly verifierConfig: IdentityVerifierConfig;
  issue(opts: IssueOptions): Promise<string>;
}

/**
 * Test-only EdDSA token issuer. Available only when CUSPATLAS_ENV=synthetic-test; the API also
 * refuses to boot with this issuer's verifier configuration in any other environment.
 */
export async function createTestTokenIssuer(env: NodeJS.ProcessEnv = process.env): Promise<TestTokenIssuer> {
  if (env.CUSPATLAS_ENV !== 'synthetic-test') {
    throw new Error('The test token issuer is only available when CUSPATLAS_ENV=synthetic-test');
  }
  const own = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const foreign = await generateKeyPair('EdDSA', { crv: 'Ed25519' });

  return {
    verifierConfig: {
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      publicKey: own.publicKey,
      testOnly: true,
      keySource: 'test',
    },
    async issue(o: IssueOptions): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      const key: CryptoKey = o.foreignKey ? foreign.privateKey : own.privateKey;
      const jwt = new SignJWT({ tid: o.tid, sid: o.sid ?? randomUUID() })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
        .setSubject(o.sub)
        .setIssuer(o.issuer ?? TEST_ISSUER)
        .setAudience(o.audience ?? TEST_AUDIENCE)
        .setIssuedAt(now - 1)
        .setExpirationTime(now + (o.expiresInSec ?? 300));
      if (o.notBeforeSec !== undefined) jwt.setNotBefore(now + o.notBeforeSec);
      return jwt.sign(key);
    },
  };
}
