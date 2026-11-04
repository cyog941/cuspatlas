import {
  assertSyntheticDatabaseName,
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
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
    ...(env.CUSPATLAS_MATCH_KEY_PEPPER
      ? { matchKeyPepper: new Uint8Array(Buffer.from(env.CUSPATLAS_MATCH_KEY_PEPPER, 'base64')) }
      : {}),
  });
  app.addHook('onClose', async () => {
    await Promise.all([appPool.end(), attemptPool.end()]);
  });
  await app.listen({ host: env.CUSPATLAS_HOST ?? '127.0.0.1', port: Number(env.CUSPATLAS_PORT ?? 3000) });
  return app;
}
