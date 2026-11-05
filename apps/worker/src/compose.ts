import { randomUUID } from 'node:crypto';
import type { ActorContext } from '@cuspatlas/contracts';
import {
  assertSyntheticDatabaseName,
  createLocalObjectStore,
  createLocalStagingMaintenance,
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
  purgeExpiredCommandIdempotency,
} from '@cuspatlas/db';
import {
  type AgentToolInvoker,
  type AttemptRecordingDeps,
  type ClaimsPartnerPort,
  createAgentService,
  createAuthorize,
  createBillingService,
  createDurableExecutor,
  createImagingAttachmentSource,
  createImagingService,
  createProposalService,
  type DeliveryAdapter,
  type MessagingPort,
  type PaymentProviderPort,
  resolveBridgeSigningKey,
  resolveIdempotencyDigestKey,
  resolveImagingTokenSecret,
  resolveMatchKeyPepper,
} from '@cuspatlas/domain';
import pg from 'pg';
import { type AgentTaskOutcome, createAgentTaskRunner } from './agent-tasks';
import { createWorker, type DispatchResult, IN_PROCESS_AGGREGATES } from './dispatch';
import { createOutboundSender, type SendResult } from './outbound-sender';

/**
 * The worker process composition (`start:worker`): real dependencies from the environment, with the
 * same startup rules as the API. Synthetic-only like the API: database names must carry the
 * cuspatlas_synthetic marker, and secrets are resolved by the domain's own resolvers (test-only
 * values are refused outside `CUSPATLAS_ENV=synthetic-test`, and a missing pepper or idempotency key is
 * refused there too).
 *
 * Consumers, per configured tenant, under the worker's own service principal (authorized freshly by
 * the domain for every batch; the principal needs `outbox.deliver`, `billing.write`,
 * `communications.deliver` and `admin.configure` for everything to run):
 * - F6 outbox: proposal execution and C14 -> B procedure consumption in process (always on); CL-08
 *   claim workflow timers in process (only with a clearinghouse port); every other event goes to the
 *   delivery adapter (only with one). Without an adapter only the in-process aggregates are leased.
 * - E7 outbound messages (only with a messaging port).
 * - I imaging reconcile (`imaging.storage.reconcile`: integrity sweep, abandoned ingress and staging,
 *   bridge lease sweep and expired device nonces; only with an object store).
 * - Maintenance on a privileged connection (only with `CUSPATLAS_MAINTENANCE_DATABASE_URL`): expired
 *   idempotency records, finished patient-reference observations and expired agent memory (A23).
 * - A23 scheduled agent tasks (only with `agentTools`, the MCP deployment tool path): due tasks run as
 *   their agent through MCP consent, budgets and authorization, the standing policy rechecked.
 *
 * No real provider exists yet (E-S1, B partner and processor selection are open), so a provider can
 * only be supplied as a test fake (`syntheticProviders`), which is refused outside synthetic-test. A
 * consumer without its provider stays disabled with a logged reason; it never sends anywhere.
 */
export const WORKER_RUNTIME_ENVIRONMENTS = ['synthetic-test', 'development', 'production'] as const;
export type WorkerRuntimeEnvironment = (typeof WORKER_RUNTIME_ENVIRONMENTS)[number];

export interface SyntheticProviders {
  /** F6 delivery adapter for events that are not settled in process. */
  readonly delivery?: DeliveryAdapter;
  /** E7 messaging port. */
  readonly messaging?: MessagingPort;
  /** B claims partner (claim workflow timers can submit, poll and follow up). */
  readonly clearinghouse?: ClaimsPartnerPort;
  /** B payment processor. */
  readonly payments?: PaymentProviderPort;
}

export interface WorkerPools {
  /** Runtime-role pool. */
  readonly app: pg.Pool;
  /** Independent runtime-role pool for the security-attempt sink. */
  readonly attempts: pg.Pool;
  /** Privileged maintenance pool (bypasses RLS); absent = maintenance disabled. */
  readonly maintenance?: pg.Pool;
}

export type WorkerConsumer =
  | 'outboxDelivery'
  | 'outboundMessages'
  | 'claimWorkflowTimers'
  | 'imagingReconcile'
  | 'agentTasks'
  | 'maintenance';

export type WorkerMainLogLine =
  | { readonly msg: 'worker_consumer_disabled'; readonly consumer: WorkerConsumer; readonly reason: string }
  | { readonly msg: 'worker_started'; readonly env: string; readonly tenants: number }
  | { readonly msg: 'worker_tick'; readonly outbox: number; readonly outbound: number }
  | { readonly msg: 'worker_stage_failed'; readonly stage: string; readonly kind: string }
  | { readonly msg: 'worker_stopped' };

export interface ComposeOptions {
  /** Injected pools (tests); not closed by `close()`. Otherwise built from the environment. */
  readonly pools?: WorkerPools;
  /** Test fakes; refused outside synthetic-test. */
  readonly syntheticProviders?: SyntheticProviders;
  /**
   * A23: the MCP tool path scheduled agent tasks run through (a co-hosted MCP server `agentTools`).
   * Absent: the scheduled-task consumer stays disabled (nothing runs outside MCP admission).
   */
  readonly agentTools?: AgentToolInvoker;
  /** The instant E6 evaluates quiet hours for (default now). */
  readonly clock?: () => Date;
  readonly log?: (line: WorkerMainLogLine) => void;
  readonly tuning?: {
    readonly backoffSeconds?: (attempt: number) => number;
    readonly batchesPerTick?: number;
  };
}

export interface TickReport {
  readonly outbox: readonly { readonly eventId: string; readonly result: DispatchResult }[];
  readonly outbound: readonly { readonly messageRef: string; readonly result: SendResult }[];
  readonly imagingReconciled: number;
  readonly agentTasks: readonly AgentTaskOutcome[];
  readonly maintenance: {
    readonly idempotencyPurged: number;
    readonly observationsPruned: number;
    readonly agentMemoryPurged: number;
  } | null;
  readonly errors: readonly { readonly stage: string; readonly kind: string }[];
}

export interface ComposedWorker {
  readonly env: WorkerRuntimeEnvironment;
  readonly tenants: readonly string[];
  readonly disabled: readonly { readonly consumer: WorkerConsumer; readonly reason: string }[];
  /** One pass over every tenant and every enabled consumer. Never throws for a failing stage. */
  tick(): Promise<TickReport>;
  /** Ticks until `signal` aborts; the tick in progress completes first. */
  run(
    signal: AbortSignal,
    opts?: { readonly intervalMs?: number; readonly onTick?: (r: TickReport) => void },
  ): Promise<void>;
  /** Closes the pools this composition opened. */
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads CUSPATLAS_ENV and refuses anything that is not a known runtime environment (as the API). */
export function resolveWorkerRuntimeEnv(env: NodeJS.ProcessEnv): WorkerRuntimeEnvironment {
  const value = env.CUSPATLAS_ENV;
  if (!value || !(WORKER_RUNTIME_ENVIRONMENTS as readonly string[]).includes(value)) {
    throw new Error(`CUSPATLAS_ENV must be one of ${WORKER_RUNTIME_ENVIRONMENTS.join(', ')}`);
  }
  return value as WorkerRuntimeEnvironment;
}

const bytes = (v: string | undefined) => (v ? new Uint8Array(Buffer.from(v, 'base64')) : undefined);

function pool(url: string, max: number): pg.Pool {
  assertSyntheticDatabaseName(decodeURIComponent(new URL(url).pathname.replace(/^\//, '')));
  const p = new pg.Pool({ connectionString: url, max, connectionTimeoutMillis: 5000 });
  // An idle client error must not crash the process; the pool discards the client.
  p.on('error', () => undefined);
  return p;
}

const errorKind = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)
    ? code
    : err instanceof Error
      ? err.name
      : 'unknown';
};

export async function composeWorker(
  env: NodeJS.ProcessEnv,
  opts: ComposeOptions = {},
): Promise<ComposedWorker> {
  // 1. Environment and secrets, before any connection.
  const runtimeEnv = resolveWorkerRuntimeEnv(env);
  const matchKeyPepper = resolveMatchKeyPepper(runtimeEnv, bytes(env.CUSPATLAS_MATCH_KEY_PEPPER));
  const digestKey = resolveIdempotencyDigestKey(runtimeEnv, bytes(env.CUSPATLAS_IDEMPOTENCY_DIGEST_KEY));
  const tokenSecret = resolveImagingTokenSecret(runtimeEnv, bytes(env.CUSPATLAS_IMAGING_TOKEN_SECRET));
  const bridgeSigningKey = resolveBridgeSigningKey(runtimeEnv, env.CUSPATLAS_BRIDGE_SIGNING_KEY_PEM);
  const providers = opts.syntheticProviders ?? {};
  if (runtimeEnv !== 'synthetic-test' && Object.values(providers).some((p) => p !== undefined)) {
    throw new Error(
      'Refusing to start: synthetic providers are permitted only in synthetic-test (fake adapters, clearinghouse, processor and messaging never run elsewhere)',
    );
  }
  const principalId = env.CUSPATLAS_WORKER_PRINCIPAL_ID ?? '';
  if (!UUID.test(principalId)) {
    throw new Error("CUSPATLAS_WORKER_PRINCIPAL_ID must name the worker's service principal (a UUID)");
  }
  const tenants = (env.CUSPATLAS_WORKER_TENANT_IDS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (
    tenants.length === 0 ||
    tenants.some((t) => !UUID.test(t)) ||
    new Set(tenants).size !== tenants.length
  ) {
    throw new Error(
      'CUSPATLAS_WORKER_TENANT_IDS must list the served tenant ids (distinct UUIDs, comma-separated)',
    );
  }
  const log = opts.log ?? (() => undefined);

  // 2. Pools (synthetic databases only).
  let owned: pg.Pool[] = [];
  let pools: WorkerPools;
  if (opts.pools) {
    pools = opts.pools;
  } else {
    const url = env.CUSPATLAS_DATABASE_URL;
    if (!url) throw new Error('CUSPATLAS_DATABASE_URL must name the runtime-role database');
    const app = pool(url, 5);
    const attempts = pool(env.CUSPATLAS_ATTEMPT_DATABASE_URL ?? url, 2);
    const maintenance = env.CUSPATLAS_MAINTENANCE_DATABASE_URL
      ? pool(env.CUSPATLAS_MAINTENANCE_DATABASE_URL, 1)
      : undefined;
    owned = [app, attempts, ...(maintenance ? [maintenance] : [])];
    pools = { app, attempts, ...(maintenance ? { maintenance } : {}) };
  }

  // 3. Services and consumers.
  const disabled: { consumer: WorkerConsumer; reason: string }[] = [];
  const disable = (consumer: WorkerConsumer, reason: string) => {
    disabled.push({ consumer, reason });
    log({ msg: 'worker_consumer_disabled', consumer, reason });
  };
  const memberships = createMembershipSource(pools.app);
  const authorize = createAuthorize(memberships);
  const withTenantTransaction = createTenantTransactionRunner(pools.app);
  const attempts = createSecurityAttemptSink(pools.attempts);
  const recording: AttemptRecordingDeps = {
    sink: attempts,
    alert: (code) => log({ msg: 'worker_stage_failed', stage: 'alert', kind: String(code) }),
  };
  const execute = createDurableExecutor(digestKey);
  const billing = createBillingService({
    authorize,
    withTenantTransaction,
    recording,
    execute,
    ...(providers.clearinghouse ? { claims: providers.clearinghouse } : {}),
    ...(providers.payments ? { payments: providers.payments } : {}),
    // R8: CL-04 attachment digests from I3's consumer reference read (never the fake).
    attachments: createImagingAttachmentSource(),
  });
  const proposals = createProposalService({
    authorize,
    memberships,
    withTenantTransaction,
    recording,
    execute,
  });
  if (!providers.delivery) disable('outboxDelivery', 'no delivery adapter is configured');
  if (!providers.clearinghouse) disable('claimWorkflowTimers', 'no clearinghouse is configured');
  if (!providers.messaging) disable('outboundMessages', 'no messaging provider is configured');
  const leaseAggregateTypes = providers.delivery
    ? undefined
    : [
        IN_PROCESS_AGGREGATES.proposals,
        IN_PROCESS_AGGREGATES.procedures,
        ...(providers.clearinghouse ? [IN_PROCESS_AGGREGATES.claimWorkflows] : []),
      ];
  const backoff = opts.tuning?.backoffSeconds;
  const outbox = createWorker({
    workerPrincipalId: principalId,
    withTenantTransaction,
    authorize,
    memberships,
    attempts,
    proposals,
    procedures: billing,
    ...(providers.clearinghouse ? { claimWorkflows: billing } : {}),
    ...(leaseAggregateTypes ? { leaseAggregateTypes } : {}),
    ...(backoff ? { backoffSeconds: backoff } : {}),
  });
  // Defence in depth: with no adapter nothing but in-process aggregates is leased; were anything else
  // ever handed here, it is definitively not performed (retried, never sent).
  const noAdapter: DeliveryAdapter = {
    deliver: async () => ({ outcome: 'failed', retryable: true }),
    lookup: async () => ({ status: 'not_found' }),
  };
  const adapter = providers.delivery ?? noAdapter;
  const sender = providers.messaging
    ? createOutboundSender({
        workerPrincipalId: principalId,
        withTenantTransaction,
        authorize,
        memberships,
        attempts,
        port: providers.messaging,
        matchKeyPepper,
        ...(opts.clock ? { clock: opts.clock } : {}),
        ...(backoff ? { backoffSeconds: backoff } : {}),
      })
    : null;
  const storeDir = env.CUSPATLAS_OBJECT_STORE_DIR;
  const imaging = storeDir
    ? createImagingService({
        authorize,
        withTenantTransaction,
        recording,
        execute,
        tokenSecret,
        matchKeyPepper,
        objectStore: createLocalObjectStore({ root: storeDir, env: runtimeEnv }),
        stagingMaintenance: createLocalStagingMaintenance(storeDir),
        bridgeSigningKey,
        alert: (code) => log({ msg: 'worker_stage_failed', stage: 'imaging_alert', kind: String(code) }),
      })
    : null;
  if (!imaging) disable('imagingReconcile', 'no object store is configured (CUSPATLAS_OBJECT_STORE_DIR)');
  const agentTasks = opts.agentTools
    ? createAgentTaskRunner({
        workerPrincipalId: principalId,
        authorize,
        memberships,
        agents: createAgentService({ authorize, withTenantTransaction, recording, execute }),
        invoker: opts.agentTools,
      })
    : null;
  if (!agentTasks) disable('agentTasks', 'no MCP tool path is configured for scheduled agent tasks');
  if (!pools.maintenance) {
    disable('maintenance', 'no maintenance connection is configured (CUSPATLAS_MAINTENANCE_DATABASE_URL)');
  }

  const serviceCtx = (tenantId: string): ActorContext => ({
    tenantId,
    actorId: principalId,
    principal: 'service',
    sessionId: randomUUID(),
    // The one scope the imaging reconcile needs; the live membership must hold it too.
    scopes: ['admin.configure'],
    correlationId: randomUUID(),
  });
  const batches = opts.tuning?.batchesPerTick ?? 20;

  const tick = async (): Promise<TickReport> => {
    const report = {
      outbox: [] as { eventId: string; result: DispatchResult }[],
      outbound: [] as { messageRef: string; result: SendResult }[],
      imagingReconciled: 0,
      agentTasks: [] as AgentTaskOutcome[],
      maintenance: null as TickReport['maintenance'],
      errors: [] as { stage: string; kind: string }[],
    };
    const stage = async (name: string, work: () => Promise<void>) => {
      try {
        await work();
      } catch (err) {
        const kind = errorKind(err);
        report.errors.push({ stage: name, kind });
        log({ msg: 'worker_stage_failed', stage: name, kind });
      }
    };
    for (const tenantId of tenants) {
      await stage('outbox', async () => {
        for (let i = 0; i < batches; i += 1) {
          const done = await outbox.runOnce(tenantId, adapter);
          report.outbox.push(...done);
          if (done.length === 0) break;
        }
      });
      if (sender) {
        await stage('outbound', async () => {
          for (let i = 0; i < batches; i += 1) {
            const done = await sender.runOnce(tenantId);
            report.outbound.push(...done);
            if (done.length === 0) break;
          }
        });
      }
      if (imaging) {
        await stage('imaging_reconcile', async () => {
          await imaging.reconcileStorage(
            serviceCtx(tenantId),
            { operation: 'imaging.storage.sweep', idempotencyKey: randomUUID(), payload: {} },
            'imaging.storage.sweep',
          );
          report.imagingReconciled += 1;
        });
      }
      if (agentTasks) {
        await stage('agent_tasks', async () => {
          report.agentTasks.push(...(await agentTasks.runDue(tenantId)));
        });
      }
    }
    const maintenancePool = pools.maintenance;
    if (maintenancePool) {
      await stage('maintenance', async () => {
        const client = await maintenancePool.connect();
        try {
          const idempotencyPurged = await purgeExpiredCommandIdempotency(client);
          const { rows } = await client.query<{ n: string }>(
            'SELECT cuspatlas.prune_patient_reference_observations() AS n',
          );
          const memory = await client.query<{ n: number }>(
            'SELECT cuspatlas.agent_memory_purge_expired() AS n',
          );
          report.maintenance = {
            idempotencyPurged,
            observationsPruned: Number(rows[0]?.n ?? 0),
            agentMemoryPurged: Number(memory.rows[0]?.n ?? 0),
          };
        } finally {
          client.release();
        }
      });
    }
    log({ msg: 'worker_tick', outbox: report.outbox.length, outbound: report.outbound.length });
    return report;
  };

  log({ msg: 'worker_started', env: runtimeEnv, tenants: tenants.length });
  return {
    env: runtimeEnv,
    tenants,
    disabled,
    tick,
    async run(signal, runOpts = {}) {
      const interval = runOpts.intervalMs ?? 5000;
      while (!signal.aborted) {
        const r = await tick();
        runOpts.onTick?.(r);
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, interval);
          function done() {
            clearTimeout(t);
            signal.removeEventListener('abort', done);
            resolve();
          }
          signal.addEventListener('abort', done, { once: true });
        });
      }
      log({ msg: 'worker_stopped' });
    },
    async close() {
      const pending = owned;
      owned = [];
      await Promise.all(pending.map((p) => p.end()));
    },
  };
}
