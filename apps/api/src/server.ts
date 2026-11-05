import {
  assertSyntheticDatabaseName,
  createDeviceCredentialSource,
  createLocalObjectStore,
  createLocalStagingMaintenance,
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { resolveBridgeSigningKey } from '@cuspatlas/domain';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp, resolveRuntimeEnv } from './app';
import { loadConfiguredIdentity } from './auth';

function runtimePool(url: string): pg.Pool {
  assertSyntheticDatabaseName(decodeURIComponent(new URL(url).pathname.replace(/^\//, '')));
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 });
  // An idle client error must not crash the process; the pool discards the client.
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Starts the API from the environment. Synthetic-only: database names must carry the
 * cuspatlas_synthetic marker; tokens are verified only against a configured key source.
 * Listens on loopback unless CUSPATLAS_HOST says otherwise. Secrets are never printed.
 */
export async function startServer(env: NodeJS.ProcessEnv): Promise<FastifyInstance> {
  const runtimeEnv = resolveRuntimeEnv(env);
  const url = env.CUSPATLAS_DATABASE_URL;
  if (!url) throw new Error('CUSPATLAS_DATABASE_URL must name the runtime-role database');
  const appPool = runtimePool(url);
  const attemptPool = runtimePool(env.CUSPATLAS_ATTEMPT_DATABASE_URL ?? url);
  const app = await buildApp({
    env: runtimeEnv,
    identity: await loadConfiguredIdentity(env),
    membership: createMembershipSource(appPool),
    attempts: createSecurityAttemptSink(attemptPool),
    tenantTransactions: createTenantTransactionRunner(appPool),
    ...(env.CUSPATLAS_MCP_AUDIENCE ? { mcpAudience: env.CUSPATLAS_MCP_AUDIENCE } : {}),
    ...(env.CUSPATLAS_MATCH_KEY_PEPPER
      ? { matchKeyPepper: new Uint8Array(Buffer.from(env.CUSPATLAS_MATCH_KEY_PEPPER, 'base64')) }
      : {}),
    // Closeout A1: list cursors shared by every instance; the previous key is a decode-only rotation grace.
    ...(env.CUSPATLAS_CURSOR_KEY
      ? { cursorKey: new Uint8Array(Buffer.from(env.CUSPATLAS_CURSOR_KEY, 'base64')) }
      : {}),
    ...(env.CUSPATLAS_CURSOR_KEY_PREVIOUS
      ? { cursorPreviousKey: new Uint8Array(Buffer.from(env.CUSPATLAS_CURSOR_KEY_PREVIOUS, 'base64')) }
      : {}),
    ...(env.CUSPATLAS_IDEMPOTENCY_DIGEST_KEY
      ? {
          idempotencyDigestKey: new Uint8Array(Buffer.from(env.CUSPATLAS_IDEMPOTENCY_DIGEST_KEY, 'base64')),
        }
      : {}),
    ...(env.CUSPATLAS_IMAGING_TOKEN_SECRET
      ? { imagingTokenSecret: new Uint8Array(Buffer.from(env.CUSPATLAS_IMAGING_TOKEN_SECRET, 'base64')) }
      : {}),
    // I1: the local adapter is synthetic only (refused under production); I-D1 picks the managed store.
    ...(env.CUSPATLAS_OBJECT_STORE_DIR
      ? {
          objectStore: createLocalObjectStore({ root: env.CUSPATLAS_OBJECT_STORE_DIR, env: runtimeEnv }),
          stagingMaintenance: createLocalStagingMaintenance(env.CUSPATLAS_OBJECT_STORE_DIR),
        }
      : {}),
    // I6 bridge audience (server side only; no bridge is built). Without a configured Ed25519 key outside
    // synthetic-test, claims are a typed 503 with an alert.
    deviceCredentials: createDeviceCredentialSource(appPool),
    bridgeSigningKey: resolveBridgeSigningKey(runtimeEnv, env.CUSPATLAS_BRIDGE_SIGNING_KEY_PEM),
  });
  app.addHook('onClose', async () => {
    await Promise.all([appPool.end(), attemptPool.end()]);
  });
  await app.listen({ host: env.CUSPATLAS_HOST ?? '127.0.0.1', port: Number(env.CUSPATLAS_PORT ?? 3000) });
  return app;
}
