import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { buildApp, loadConfiguredIdentity } from '@cuspatlas/api';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import type { FastifyInstance } from 'fastify';
import { importPKCS8, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA } from './support/appointment-fixtures';
import { openBillingHarness } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { USER_A1 } from './support/fixtures';

/**
 * Billing adapters are never faked implicitly: outside CUSPATLAS_ENV=synthetic-test an API built
 * without a payment processor or clearinghouse refuses the dependent operations with a typed 503
 * `adapter_not_configured` and logs an operator line; synthetic-test keeps the fakes (other suites).
 */
let db: TestDatabase;
let synthetic: Awaited<ReturnType<typeof openBillingHarness>>;
let dev: FastifyInstance;
let token: string;
const logLines: string[] = [];
const ISSUER = 'https://idp.invalid';
const AUDIENCE = 'urn:cuspatlas:api';

beforeAll(async () => {
  db = await openTestDatabase('billing_adapter_config');
  synthetic = await openBillingHarness(db);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const identity = await loadConfiguredIdentity({
    CUSPATLAS_JWT_ISSUER: ISSUER,
    CUSPATLAS_JWT_AUDIENCE: AUDIENCE,
    CUSPATLAS_JWT_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  dev = await buildApp({
    env: 'development',
    logger: { level: 'info', stream: { write: (l: string) => logLines.push(l) } },
    identity,
    membership: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(db.sink),
    tenantTransactions: createTenantTransactionRunner(db.app),
    matchKeyPepper: new Uint8Array(randomBytes(32)),
    idempotencyDigestKey: new Uint8Array(randomBytes(32)),
  });
  const key = await importPKCS8(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'EdDSA');
  const now = Math.floor(Date.now() / 1000);
  token = await new SignJWT({ tid: T_ALPHA, sid: randomUUID() })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setSubject(USER_A1)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now - 1)
    .setExpirationTime(now + 600)
    .sign(key);
});

afterAll(async () => {
  await dev?.close();
  await synthetic?.close();
  await db?.close();
});

const post = (url: string, body: unknown) =>
  dev.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    payload: JSON.stringify(body),
  });
const refusal = (res: Awaited<ReturnType<typeof post>>) => [res.statusCode, res.json().detail?.reason];

describe('billing adapters outside synthetic-test', () => {
  it('logs an operator line naming each adapter that is not configured', () => {
    const lines = logLines.filter((l) => l.includes('adapter_not_configured'));
    expect(lines.some((l) => l.includes('payment_processor'))).toBe(true);
    expect(lines.some((l) => l.includes('clearinghouse'))).toBe(true);
  });

  it('card capture, claim submit and remittance ingest are a typed 503, never a fake', async () => {
    const patientRef = await createPatient(synthetic, 'Synthetic Adapter Config');
    expect(
      refusal(
        await post('/v1/billing/payments', {
          patientRef,
          amount: { currency: 'USD', minor: 500 },
          method: 'card_synthetic',
          instrumentRef: 'syn-card-visa-ok',
        }),
      ),
    ).toStrictEqual([503, 'adapter_not_configured']);
    expect(
      refusal(
        await post(`/v1/rcm/claims/${randomUUID()}/submissions`, {
          expectedVersion: 1,
          authorization: { mode: 'explicit' },
        }),
      ),
    ).toStrictEqual([503, 'adapter_not_configured']);
    expect(
      refusal(await post('/v1/rcm/remittances', { remittanceRef: 'syn-era-adapter-config' })),
    ).toStrictEqual([503, 'adapter_not_configured']);
    // An operation that needs no adapter still works (cash is recorded).
    expect(
      (
        await post('/v1/billing/payments', {
          patientRef,
          amount: { currency: 'USD', minor: 500 },
          method: 'cash',
        })
      ).statusCode,
    ).toBe(201);
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.billing_payment_attempts',
    );
    expect(rows[0].n).toBe(0);
  });

  it('under synthetic-test the same card capture still uses the synthetic processor', async () => {
    const patientRef = await createPatient(synthetic, 'Synthetic Adapter Fake');
    const res = await synthetic.call('a1', 'POST', '/v1/billing/payments', {
      patientRef,
      amount: { currency: 'USD', minor: 500 },
      method: 'card_synthetic',
      instrumentRef: 'syn-card-visa-ok',
    });
    expect(res.statusCode).toBe(201);
  });
});
