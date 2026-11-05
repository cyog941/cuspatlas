import { randomUUID } from 'node:crypto';
import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  listEnvelope,
  type TenantTransaction,
  validateWebhookDeliveryListQuery,
  validateWebhookEventTypeListQuery,
  validateWebhookFailureListQuery,
  validateWebhookReplay,
  validateWebhookSubscriptionCreate,
  validateWebhookSubscriptionListQuery,
  validateWebhookSubscriptionRevoke,
  validateWebhookSubscriptionRotate,
} from '@cuspatlas/contracts';
import { transactionNow } from '../clock';
import type { ReplayCodec, StoredResult } from '../commands/execute-once';
import { recordCommand } from '../events/record-command';
import {
  type AutomationBase,
  assertRef,
  checkEnvelope,
  conflict,
  failed,
  isPgError,
  notFound,
  unavailable,
  validate,
} from './base';
import {
  WEBHOOK_EVENT_BY_TYPE,
  WEBHOOK_EVENT_CATALOG,
  WEBHOOK_EVENT_CATALOG_VERSION,
  webhookBodyV1,
} from './webhook-catalog';
import { guardWebhookEndpoint } from './webhook-guard';
import {
  newWebhookSecret,
  openSecret,
  resolveWebhookSecretKey,
  sealSecret,
  secretFingerprint,
  signatureHeader,
} from './webhook-signing';

/**
 * One outbound request handed to the delivery port. The port never sees a secret. Transport contract
 * (mandatory for any implementation): connect to `connectAddress` (the guard-checked IP; never
 * re-resolve the name), send `hostHeader` as Host and `serverName` as TLS SNI / certificate name, and
 * never follow a redirect (`redirect: 'error'`): a 3xx is returned as-is and becomes a terminal
 * `redirect_refused`.
 */
export interface WebhookSendRequest {
  readonly url: string;
  readonly connectAddress: string;
  readonly port: number;
  readonly hostHeader: string;
  readonly serverName: string;
  readonly redirect: 'error';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs: number;
}
export type WebhookSendResult =
  | { readonly outcome: 'response'; readonly status: number }
  | { readonly outcome: 'network_error' }
  | { readonly outcome: 'timeout' };

/**
 * A14 delivery port. No real egress exists yet: a port is honoured only in synthetic-test (the
 * in-process fake receiver); elsewhere deliveries wait as `adapter_not_configured`, visible in the
 * failures worklist, never dropped. A `network` port (real egress) is refused at composition unless a
 * resolver is configured, since DNS pinning needs the send-time resolution.
 */
export interface WebhookDeliveryPort {
  readonly egress: 'in_process_fake' | 'network';
  send(req: WebhookSendRequest): Promise<WebhookSendResult>;
}

type ResolveHost = (host: string) => Promise<readonly string[]>;

function assertResolverForNetworkPort(
  port: WebhookDeliveryPort | null | undefined,
  resolveHost?: ResolveHost,
) {
  if (port && port.egress !== 'in_process_fake' && !resolveHost)
    throw new Error('webhook_resolver_required: a network delivery port needs a resolver for DNS pinning');
}

export function resolveWebhookPort(
  env: string,
  port: WebhookDeliveryPort | null | undefined,
  resolveHost?: ResolveHost,
): WebhookDeliveryPort | null {
  assertResolverForNetworkPort(port, resolveHost);
  return env === 'synthetic-test' && port ? port : null;
}

export interface WebhookDeps {
  readonly port?: WebhookDeliveryPort | null;
  /** Operator allowlist of endpoint hosts (A-D7), read at registration and before every send. */
  readonly allowlist?: () => readonly string[];
  /** Name resolution for the send-time guard (DNS rebinding); absent: literal checks only. */
  readonly resolveHost?: (host: string) => Promise<readonly string[]>;
  /** AES-GCM sealing key of subscription secrets; absent outside synthetic-test: create refuses. */
  readonly secretKey?: Uint8Array | null;
  readonly backoffSeconds?: (attempt: number) => number;
  /** Lease floor; the effective per-delivery lease always covers the send timeout plus a margin. */
  readonly leaseSeconds?: number;
  /** Rotation overlap; at most WEBHOOK_MAX_ROTATION_OVERLAP_SECONDS. */
  readonly rotationOverlapSeconds?: number;
  readonly sendTimeoutMs?: number;
  /** Outbox rows considered per fan-out pass. */
  readonly fanOutWindow?: number;
  /** Deliveries attempted per dispatch run (each one leased on its own). */
  readonly batchSize?: number;
}

export const WEBHOOK_MAX_ATTEMPTS = 5;
/** Upper bound of the configurable rotation overlap (both secrets verify): seven days. */
export const WEBHOOK_MAX_ROTATION_OVERLAP_SECONDS = 7 * 86_400;
/** Payload versions this build can render; subscriptions on other versions are not fanned out. */
const RENDERABLE_EVENT_VERSIONS = [1];
const FAILURE_STATES = ['dead_lettered', 'adapter_not_configured', 'paused'];
const defaultBackoff = (attempt: number) => Math.min(30 * 2 ** (attempt - 1), 3600);

interface SubscriptionRow extends Record<string, unknown> {
  id: string;
  endpoint_url: string;
  event_types: string[];
  event_version: number;
  state: 'active' | 'revoked';
  secret_fingerprint: string;
  previous_secret_expires_at: Date | null;
  version: number;
  created_at: Date;
}
interface DeliveryRow extends Record<string, unknown> {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  event_version: number;
  state: string;
  attempts: number;
  max_attempts: number;
  last_response_class: string | null;
  last_guard: string | null;
  replay_of: string | null;
  next_attempt_at: Date;
  delivered_at: Date | null;
  created_at: Date;
}

const iso = (d: Date | null) => (d === null ? null : new Date(d).toISOString());
const presentSubscription = (r: SubscriptionRow) => ({
  subscriptionRef: r.id,
  endpointUrl: r.endpoint_url,
  eventTypes: [...r.event_types],
  eventVersion: r.event_version,
  state: r.state,
  secretFingerprint: r.secret_fingerprint,
  previousSecretExpiresAt: iso(r.previous_secret_expires_at),
  version: r.version,
  createdAt: new Date(r.created_at).toISOString(),
});
export type WebhookSubscriptionView = ReturnType<typeof presentSubscription>;
const presentDelivery = (r: DeliveryRow) => ({
  deliveryRef: r.id,
  subscriptionRef: r.subscription_id,
  eventRef: r.event_id,
  eventType: r.event_type,
  eventVersion: r.event_version,
  state: r.state,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  lastResponseClass: r.last_response_class,
  lastGuard: r.last_guard,
  replayOf: r.replay_of,
  nextAttemptAt: new Date(r.next_attempt_at).toISOString(),
  deliveredAt: iso(r.delivered_at),
  createdAt: new Date(r.created_at).toISOString(),
});
export type WebhookDeliveryView = ReturnType<typeof presentDelivery>;

const normalizeUrl = (url: string) => new URL(url).toString();

/** Replay projections: server values only; the endpoint and event types come back from the payload. */
// biome-ignore lint/suspicious/noExplicitAny: codecs are heterogeneous per operation.
export const AUTOMATION_WEBHOOK_CODECS: Readonly<Record<string, ReplayCodec<any>>> = {
  'webhooks.subscriptions.create': {
    persist: (d: WebhookSubscriptionView): StoredResult => ({
      kind: 'success',
      subscriptionRef: d.subscriptionRef,
      state: d.state,
      secretFingerprint: d.secretFingerprint,
      version: d.version,
      createdAt: d.createdAt,
    }),
    restore(stored, payload) {
      const p = payload as { endpointUrl: string; eventTypes: string[]; eventVersion: number };
      if (stored.kind !== 'success') throw new Error('Stored result is malformed');
      return {
        subscriptionRef: String(stored.subscriptionRef),
        endpointUrl: normalizeUrl(p.endpointUrl),
        eventTypes: [...p.eventTypes].sort(),
        eventVersion: p.eventVersion,
        state: stored.state === 'revoked' ? 'revoked' : 'active',
        secretFingerprint: String(stored.secretFingerprint),
        previousSecretExpiresAt: null,
        version: Number(stored.version),
        createdAt: String(stored.createdAt),
      };
    },
  } satisfies ReplayCodec<WebhookSubscriptionView>,
  'webhooks.deliveries.replay': {
    persist: (d: WebhookDeliveryView): StoredResult => ({ kind: 'success', ...d }),
    restore(stored) {
      if (stored.kind !== 'success') throw new Error('Stored result is malformed');
      const { kind: _k, ...rest } = stored;
      return rest as unknown as WebhookDeliveryView;
    },
  } satisfies ReplayCodec<WebhookDeliveryView>,
};

export function createWebhookOperations(base: AutomationBase, wh: WebhookDeps = {}) {
  const { deps, execute } = base;
  const port = resolveWebhookPort(deps.env, wh.port, wh.resolveHost);
  const allowlist = wh.allowlist ?? (() => []);
  const key = wh.secretKey === undefined ? resolveWebhookSecretKey(deps.env, undefined) : wh.secretKey;
  const backoff = wh.backoffSeconds ?? defaultBackoff;
  const timeoutMs = Math.min(wh.sendTimeoutMs ?? 10_000, 30_000);
  // Per-delivery lease covering the whole send budget (guard resolution + timeout + margin).
  const leaseSeconds = Math.max(wh.leaseSeconds ?? 30, Math.ceil(timeoutMs / 1000) + 5);
  const batchSize = wh.batchSize ?? 100;
  const overlap = wh.rotationOverlapSeconds ?? 86_400;
  if (!(overlap >= 0 && overlap <= WEBHOOK_MAX_ROTATION_OVERLAP_SECONDS))
    throw new Error(
      `webhook_rotation_overlap_out_of_range: 0..${WEBHOOK_MAX_ROTATION_OVERLAP_SECONDS} seconds`,
    );
  const sealingKey = () => {
    if (!key) throw unavailable();
    return key;
  };
  const now = async (tx: TenantTransaction) => await transactionNow(tx);

  const loadSubscription = async (tx: TenantTransaction, ref: string) => {
    assertRef(ref);
    const { rows } = await tx.query<SubscriptionRow>(
      'SELECT * FROM cuspatlas.webhook_subscriptions WHERE id = $1 FOR UPDATE',
      [ref],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  };

  const listOf = async (
    ctx: ActorContext,
    op: 'webhooks.deliveries.list' | 'webhooks.deliveries.failures.list',
    q: { limit?: number; cursor?: string; subscriptionRef?: string; state?: string },
    states: readonly string[] | null,
  ) => {
    const decision = await base.tenantWide(ctx, op, 'webhooks');
    const pg = base.page(ctx, q);
    const sub = q.subscriptionRef ?? null;
    const state = q.state ?? null;
    return deps.withTenantTransaction(ctx, async (tx) => {
      const at = await now(tx);
      const where = `($1::uuid IS NULL OR subscription_id = $1) AND ($2::text IS NULL OR state = $2)
        AND ($3::text[] IS NULL OR state = ANY($3))`;
      const args = [sub, state, states];
      const total = Number(
        (
          await tx.query<{ n: string }>(
            `SELECT count(*) AS n FROM cuspatlas.webhook_deliveries WHERE ${where}`,
            args,
          )
        ).rows[0]?.n ?? 0,
      );
      const { rows } = await tx.query<DeliveryRow>(
        `SELECT * FROM cuspatlas.webhook_deliveries WHERE ${where}
         ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
        [...args, pg.limit, pg.offset],
      );
      return {
        ...listEnvelope({
          asOf: at,
          appliedFilters:
            op === 'webhooks.deliveries.list' ? { subscriptionRef: sub, state } : { subscriptionRef: sub },
          locationRefs: decision.locationRefs,
          limit: pg.limit,
          nextCursor: pg.next(rows.length, total),
          ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'deliveryRef' },
          total,
        }),
        items: rows.map(presentDelivery),
      };
    });
  };

  return {
    /** The published, closed event catalog (returned whole). */
    listWebhookEventTypes(ctx: ActorContext, query: unknown) {
      const op = 'webhooks.eventTypes.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.tenantWide(ctx, op, 'webhooks');
        validate<Record<string, never>>(validateWebhookEventTypeListQuery, query);
        return {
          ...listEnvelope({
            asOf: new Date(),
            appliedFilters: {},
            locationRefs: decision.locationRefs,
            limit: WEBHOOK_EVENT_CATALOG.length,
            nextCursor: null,
            ordering: { key: 'eventType', direction: 'asc', tieBreak: 'eventType' },
            total: WEBHOOK_EVENT_CATALOG.length,
          }),
          catalogVersion: WEBHOOK_EVENT_CATALOG_VERSION,
          items: WEBHOOK_EVENT_CATALOG.map((e) => ({ ...e, versions: [...e.versions] })),
        };
      });
    },

    /**
     * Registers a subscription (human only). The endpoint passes the guard, every event type is in
     * the catalog at the selected version, and no active subscription has the same endpoint and
     * version. The signing secret is returned once, outside the stored idempotency result.
     */
    createWebhookSubscription(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<WebhookSubscriptionView & { signingSecret?: string }>> {
      const op = 'webhooks.subscriptions.create';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'webhooks');
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ endpointUrl: string; eventTypes: string[]; eventVersion: number }>(
          validateWebhookSubscriptionCreate,
          p,
        );
        for (const t of p.eventTypes) {
          const e = WEBHOOK_EVENT_BY_TYPE.get(t);
          if (!e) throw failed('unknown_event_type');
          if (!e.versions.includes(p.eventVersion)) throw failed('unsupported_event_version');
        }
        const guard = await guardWebhookEndpoint(p.endpointUrl, allowlist(), wh.resolveHost);
        if (!guard.ok) throw failed(guard.reason);
        const sk = sealingKey();
        const secret = newWebhookSecret();
        const url = normalizeUrl(p.endpointUrl);
        const subscriptionId = randomUUID();
        const r = await deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const dup = await tx.query(
              `SELECT 1 FROM cuspatlas.webhook_subscriptions WHERE endpoint_url = $1 AND event_version = $2
                 AND state = 'active'`,
              [url, p.eventVersion],
            );
            if (dup.rows.length > 0) throw conflict('endpoint_already_subscribed');
            let rows: SubscriptionRow[];
            try {
              ({ rows } = await tx.query<SubscriptionRow>(
                `INSERT INTO cuspatlas.webhook_subscriptions (id, tenant_id, endpoint_url, endpoint_host, event_types,
                   event_version, secret_ciphertext, secret_fingerprint, created_by)
                 VALUES ($7, cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id())
                 RETURNING *`,
                [
                  url,
                  guard.host,
                  [...p.eventTypes].sort(),
                  p.eventVersion,
                  sealSecret(sk, secret, subscriptionId),
                  secretFingerprint(secret),
                  subscriptionId,
                ],
              ));
            } catch (err) {
              if (isPgError(err, '23505')) throw conflict('endpoint_already_subscribed');
              throw err;
            }
            const row = rows[0] as SubscriptionRow;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'webhookSubscription', resourceRef: row.id, resourceVersion: 1 },
              { changedFields: ['endpointUrl', 'eventTypes', 'eventVersion'] },
            );
            return { data: presentSubscription(row), version: 1 };
          }),
        );
        return r.replayed ? r : { ...r, data: { ...r.data, signingSecret: secret } };
      });
    },

    /**
     * Rotates the signing secret (human only). The previous secret keeps verifying until the overlap
     * deadline (default 24 h): during it every delivery carries both signatures. Not idempotent by
     * design (like I1 grants): each call mints a new secret, which is returned once.
     */
    rotateWebhookSecret(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'webhooks.subscriptions.rotateSecret';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'webhooks');
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ subscriptionRef: string }>(validateWebhookSubscriptionRotate, p);
        const sk = sealingKey();
        const secret = newWebhookSecret();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const cur = await loadSubscription(tx, p.subscriptionRef);
          if (cur.state !== 'active') throw conflict('subscription_revoked');
          const { rows } = await tx.query<SubscriptionRow>(
            `UPDATE cuspatlas.webhook_subscriptions SET previous_secret_ciphertext = secret_ciphertext,
               previous_secret_expires_at = now() + make_interval(secs => $2), secret_ciphertext = $3,
               secret_fingerprint = $4, version = version + 1, updated_at = now()
             WHERE id = $1 RETURNING *`,
            [cur.id, overlap, sealSecret(sk, secret, cur.id), secretFingerprint(secret)],
          );
          const row = rows[0] as SubscriptionRow;
          await recordCommand(
            tx,
            {
              operation: op,
              resourceType: 'webhookSubscription',
              resourceRef: row.id,
              resourceVersion: row.version,
            },
            { changedFields: ['secret'] },
          );
          return {
            data: { ...presentSubscription(row), signingSecret: secret },
            version: row.version,
            correlationId: ctx.correlationId,
            replayed: false,
          };
        });
      });
    },

    /** Revokes a subscription (human only): queued deliveries are cancelled in the same transaction. */
    revokeWebhookSubscription(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'webhooks.subscriptions.revoke';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'webhooks');
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ subscriptionRef: string; reason: string }>(validateWebhookSubscriptionRevoke, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          let row = await loadSubscription(tx, p.subscriptionRef);
          if (row.state === 'active') {
            row = (
              await tx.query<SubscriptionRow>(
                `UPDATE cuspatlas.webhook_subscriptions SET state = 'revoked', revoke_reason = $2,
                   version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
                [row.id, p.reason],
              )
            ).rows[0] as SubscriptionRow;
            await tx.query(
              `UPDATE cuspatlas.webhook_deliveries SET state = 'cancelled', lease_token = NULL,
                 lease_expires_at = NULL, updated_at = now()
               WHERE subscription_id = $1 AND state NOT IN ('delivered', 'dead_lettered', 'cancelled')`,
              [row.id],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: 'webhookSubscription',
                resourceRef: row.id,
                resourceVersion: row.version,
              },
              { changedFields: ['state'] },
            );
          }
          return {
            data: presentSubscription(row),
            version: row.version,
            correlationId: ctx.correlationId,
            replayed: false,
          };
        });
      });
    },

    listWebhookSubscriptions(ctx: ActorContext, query: unknown) {
      const op = 'webhooks.subscriptions.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.tenantWide(ctx, op, 'webhooks');
        validate<{ limit?: number; cursor?: string; state?: string }>(
          validateWebhookSubscriptionListQuery,
          query,
        );
        const pg = base.page(ctx, query);
        const state = query.state ?? null;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const at = await now(tx);
          const total = Number(
            (
              await tx.query<{ n: string }>(
                'SELECT count(*) AS n FROM cuspatlas.webhook_subscriptions WHERE ($1::text IS NULL OR state = $1)',
                [state],
              )
            ).rows[0]?.n ?? 0,
          );
          const { rows } = await tx.query<SubscriptionRow>(
            `SELECT * FROM cuspatlas.webhook_subscriptions WHERE ($1::text IS NULL OR state = $1)
             ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
            [state, pg.limit, pg.offset],
          );
          return {
            ...listEnvelope({
              asOf: at,
              appliedFilters: { state },
              locationRefs: decision.locationRefs,
              limit: pg.limit,
              nextCursor: pg.next(rows.length, total),
              ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'subscriptionRef' },
              total,
            }),
            items: rows.map(presentSubscription),
          };
        });
      });
    },

    listWebhookDeliveries(ctx: ActorContext, query: unknown) {
      return base.guarded(ctx, 'webhooks.deliveries.list', async () => {
        validate<{ limit?: number; cursor?: string; subscriptionRef?: string; state?: string }>(
          validateWebhookDeliveryListQuery,
          query,
        );
        return listOf(ctx, 'webhooks.deliveries.list', query, null);
      });
    },

    /** Failures worklist: dead-lettered, waiting for an adapter, or paused by the endpoint guard. */
    listWebhookFailures(ctx: ActorContext, query: unknown) {
      return base.guarded(ctx, 'webhooks.deliveries.failures.list', async () => {
        validate<{ limit?: number; cursor?: string; subscriptionRef?: string }>(
          validateWebhookFailureListQuery,
          query,
        );
        return listOf(ctx, 'webhooks.deliveries.failures.list', query, FAILURE_STATES);
      });
    },

    /**
     * Replays a delivered or dead-lettered delivery (human only): a new delivery identity for the same
     * event identity and bytes; each attempt gets a fresh signature timestamp, so a consumer tells a
     * replay (valid signature, known event id) from a forgery (invalid signature).
     */
    replayWebhookDelivery(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'webhooks.deliveries.replay';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'webhooks');
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ deliveryRef: string }>(validateWebhookReplay, p);
        assertRef(p.deliveryRef);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const { rows } = await tx.query<DeliveryRow & { body: string; sub_state: string }>(
              `SELECT d.*, s.state AS sub_state FROM cuspatlas.webhook_deliveries d
               JOIN cuspatlas.webhook_subscriptions s ON s.id = d.subscription_id WHERE d.id = $1`,
              [p.deliveryRef],
            );
            const orig = rows[0];
            if (!orig) throw notFound();
            if (orig.state !== 'delivered' && orig.state !== 'dead_lettered')
              throw conflict('delivery_not_replayable');
            if (orig.sub_state !== 'active') throw conflict('subscription_revoked');
            const created = (
              await tx.query<DeliveryRow>(
                `INSERT INTO cuspatlas.webhook_deliveries (tenant_id, subscription_id, event_id, event_type,
                   event_version, body, replay_of, created_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id())
                 RETURNING *`,
                [
                  orig.subscription_id,
                  orig.event_id,
                  orig.event_type,
                  orig.event_version,
                  orig.body,
                  orig.id,
                ],
              )
            ).rows[0] as DeliveryRow;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'webhookDelivery', resourceRef: created.id, resourceVersion: 1 },
              { changedFields: ['replayOf'] },
            );
            return { data: presentDelivery(created), version: 1 };
          }),
        );
      });
    },

    /**
     * Worker command (service principal, `outbox.deliver`): fans new catalog events out to active
     * subscriptions, then leases due deliveries (fenced by a lease token), re-runs the endpoint guard,
     * signs the fixed bytes with a fresh timestamp and records the outcome. At least once: a lost
     * acknowledgement or an expired lease re-sends the same event identity. Without a port every due
     * delivery becomes `adapter_not_configured` (attempts untouched).
     */
    dispatchWebhookDeliveries(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'webhooks.deliveries.dispatch';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'webhooks');
        checkEnvelope(envelope, op);
        const fannedOut = await deps.withTenantTransaction(ctx, async (tx) => {
          const aggregates = WEBHOOK_EVENT_CATALOG.map((e) => e.aggregateType);
          const { rows } = await tx.query<{
            sub_id: string;
            event_version: number;
            id: string;
            operation: string;
            aggregate_type: string;
            aggregate_id: string;
            aggregate_version: number;
            occurred_at: Date;
            payload: { changedFields?: string[] };
          }>(
            `SELECT s.id AS sub_id, s.event_version, o.id, o.operation, o.aggregate_type, o.aggregate_id,
               o.aggregate_version, o.occurred_at, o.payload
             FROM cuspatlas.outbox_events o
             JOIN cuspatlas.webhook_subscriptions s ON s.state = 'active' AND o.created_at >= s.created_at
               AND (o.aggregate_type || '.changed') = ANY (s.event_types)
               AND s.event_version = ANY ($3::int[])
             WHERE o.aggregate_type = ANY ($1::text[])
               AND NOT EXISTS (SELECT 1 FROM cuspatlas.webhook_deliveries d
                 WHERE d.subscription_id = s.id AND d.event_id = o.id AND d.replay_of IS NULL)
             ORDER BY o.created_at, o.id, s.id LIMIT $2`,
            [aggregates, wh.fanOutWindow ?? 500, RENDERABLE_EVENT_VERSIONS],
          );
          let n = 0;
          for (const e of rows) {
            const type = `${e.aggregate_type}.changed`;
            const body = webhookBodyV1({
              id: e.id,
              type,
              occurredAt: new Date(e.occurred_at),
              operation: e.operation,
              aggregateType: e.aggregate_type,
              aggregateId: e.aggregate_id,
              aggregateVersion: e.aggregate_version,
              changedFields: e.payload?.changedFields ?? [],
            });
            const r = await tx.query(
              `INSERT INTO cuspatlas.webhook_deliveries (tenant_id, subscription_id, event_id, event_type,
                 event_version, body, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, 1, $4, cuspatlas.current_actor_id())
               ON CONFLICT (subscription_id, event_id) WHERE replay_of IS NULL DO NOTHING`,
              [e.sub_id, e.id, type, body],
            );
            n += r.rowCount ?? 0;
          }
          return n;
        });

        const attempted: { deliveryRef: string; state: string }[] = [];
        if (!port) {
          await deps.withTenantTransaction(ctx, (tx) =>
            tx.query(
              `UPDATE cuspatlas.webhook_deliveries SET state = 'adapter_not_configured',
                 next_attempt_at = now() + make_interval(secs => $1), lease_token = NULL, lease_expires_at = NULL,
                 updated_at = now()
               WHERE state IN ('pending', 'retrying')
                  OR (state = 'delivering' AND lease_expires_at < now() AND attempts < max_attempts)`,
              [backoff(1)],
            ),
          );
          return { data: { fannedOut, attempted, adapter: 'adapter_not_configured' as const } };
        }
        // A crash or poison delivery after its last counted attempt: the expired lease dead-letters.
        await deps.withTenantTransaction(ctx, (tx) =>
          tx.query(
            `UPDATE cuspatlas.webhook_deliveries SET state = 'dead_lettered', lease_token = NULL,
               lease_expires_at = NULL, last_guard = 'lease_expired', updated_at = now()
             WHERE state = 'delivering' AND lease_expires_at < now() AND attempts >= max_attempts`,
          ),
        );
        const seen: string[] = [];
        for (let n = 0; n < batchSize; n += 1) {
          // One delivery per lease, sized for the whole send budget: a slow endpoint never lets the
          // lease of a queued delivery lapse while an earlier one is still being sent.
          const token = randomUUID();
          const d = await deps.withTenantTransaction(ctx, async (tx) => {
            const { rows } = await tx.query<{
              id: string;
              subscription_id: string;
              event_id: string;
              event_type: string;
              event_version: number;
              body: string;
              attempts: number;
              endpoint_url: string;
              secret_ciphertext: string;
              previous_secret_ciphertext: string | null;
              prev_live: boolean;
            }>(
              `WITH due AS (
                 SELECT d.id FROM cuspatlas.webhook_deliveries d
                 JOIN cuspatlas.webhook_subscriptions s ON s.id = d.subscription_id AND s.state = 'active'
                 WHERE ((d.state IN ('pending', 'retrying', 'adapter_not_configured', 'paused')
                         AND d.next_attempt_at <= now())
                    OR (d.state = 'delivering' AND d.lease_expires_at < now()))
                   AND d.attempts < d.max_attempts
                   AND NOT (d.id = ANY ($3::uuid[]))
                 ORDER BY d.next_attempt_at, d.created_at, d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED)
               UPDATE cuspatlas.webhook_deliveries d SET state = 'delivering', lease_token = $1,
                 lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
               FROM due, cuspatlas.webhook_subscriptions s
               WHERE d.id = due.id AND s.id = d.subscription_id
               RETURNING d.id, d.subscription_id, d.event_id, d.event_type, d.event_version, d.body, d.attempts,
                 s.endpoint_url, s.secret_ciphertext, s.previous_secret_ciphertext,
                 coalesce(s.previous_secret_expires_at > now(), false) AS prev_live`,
              [token, leaseSeconds, seen],
            );
            return rows[0];
          });
          if (!d) break;
          seen.push(d.id);
          const fence = (sql: string, args: unknown[]) =>
            deps.withTenantTransaction(ctx, (tx) =>
              tx.query(
                `UPDATE cuspatlas.webhook_deliveries SET ${sql}, lease_token = NULL, lease_expires_at = NULL,
                   updated_at = now() WHERE id = $1 AND lease_token = $2 AND state = 'delivering'`,
                [d.id, token, ...args],
              ),
            );
          const guard = await guardWebhookEndpoint(d.endpoint_url, allowlist(), wh.resolveHost);
          const pinned = guard.ok ? guard.addresses[0] : undefined;
          if (!guard.ok || pinned === undefined) {
            await fence(
              `state = 'paused', last_guard = $3, next_attempt_at = now() + make_interval(secs => $4)`,
              [guard.ok ? 'endpoint_unresolved' : guard.reason, backoff(Math.max(d.attempts, 1))],
            );
            attempted.push({ deliveryRef: d.id, state: 'paused' });
            continue;
          }
          // Recheck under the fence immediately before the send and count the attempt before it leaves:
          // a revoke (which cancels the delivery and clears the lease) after the lease sends nothing, and
          // a crash during the send still consumes an attempt, so a poison delivery dead-letters.
          const claimed = await deps.withTenantTransaction(ctx, async (tx) => {
            const r = await tx.query<{ attempts: number }>(
              `UPDATE cuspatlas.webhook_deliveries d SET attempts = d.attempts + 1, updated_at = now()
               FROM cuspatlas.webhook_subscriptions s
               WHERE d.id = $1 AND d.lease_token = $2 AND d.state = 'delivering' AND d.attempts < d.max_attempts
                 AND s.id = d.subscription_id AND s.state = 'active'
               RETURNING d.attempts`,
              [d.id, token],
            );
            return r.rows[0]?.attempts;
          });
          if (claimed === undefined) {
            attempted.push({ deliveryRef: d.id, state: 'skipped' });
            continue;
          }
          const sk = sealingKey();
          const secrets = [openSecret(sk, d.secret_ciphertext, d.subscription_id)];
          if (d.prev_live && d.previous_secret_ciphertext)
            secrets.push(openSecret(sk, d.previous_secret_ciphertext, d.subscription_id));
          const bodyBytes = new TextEncoder().encode(d.body);
          const timestamp = Math.floor(Date.now() / 1000);
          let result: WebhookSendResult;
          let timer: NodeJS.Timeout | undefined;
          try {
            result = await Promise.race([
              port.send({
                url: d.endpoint_url,
                connectAddress: pinned,
                port: guard.port,
                hostHeader: guard.host,
                serverName: guard.host,
                redirect: 'error',
                headers: {
                  'content-type': 'application/json',
                  'cuspatlas-event-id': d.event_id,
                  'cuspatlas-event-type': d.event_type,
                  'cuspatlas-event-version': String(d.event_version),
                  'cuspatlas-delivery-id': d.id,
                  'cuspatlas-signature': signatureHeader({ bodyBytes, timestamp, secrets }),
                },
                body: bodyBytes,
                timeoutMs,
              }),
              new Promise<WebhookSendResult>((res) => {
                timer = setTimeout(() => res({ outcome: 'timeout' }), timeoutMs);
              }),
            ]);
          } catch {
            result = { outcome: 'network_error' };
          } finally {
            clearTimeout(timer);
          }
          const cls =
            result.outcome === 'response'
              ? result.status >= 200 && result.status < 300
                ? '2xx'
                : result.status >= 300 && result.status < 400
                  ? 'redirect_refused'
                  : result.status >= 400 && result.status < 500
                    ? '4xx'
                    : '5xx'
              : result.outcome === 'timeout'
                ? 'timeout'
                : 'network';
          // A redirect is never followed and never retried: the endpoint answered somewhere else.
          const state =
            cls === '2xx'
              ? 'delivered'
              : cls === 'redirect_refused' || claimed >= WEBHOOK_MAX_ATTEMPTS
                ? 'dead_lettered'
                : 'retrying';
          await fence(
            `state = $3, last_response_class = $4, last_guard = 'passed',
             next_attempt_at = now() + make_interval(secs => $5),
             delivered_at = CASE WHEN $3 = 'delivered' THEN now() ELSE delivered_at END`,
            [state, cls, state === 'retrying' ? backoff(claimed) : 0],
          );
          attempted.push({ deliveryRef: d.id, state });
        }
        return { data: { fannedOut, attempted, adapter: 'configured' as const } };
      });
    },
  };
}
