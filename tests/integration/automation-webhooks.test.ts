import { randomUUID } from 'node:crypto';
import type { ActorContext } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  checkWebhookEndpoint,
  createAuthorize,
  createAutomationService,
  executeOnce,
  resolveWebhookPort,
  signDelivery,
  verifyWebhookSignature,
  WEBHOOK_EVENT_CATALOG,
  type WebhookDeliveryPort,
} from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorFor } from './support/domain-harness';
import { createFakeWebhookReceiver } from './support/fake-webhook-receiver';
import { SVC_A1, T_ALPHA, USER_A1, USER_B1 } from './support/fixtures';
import { type ImagingStack, startImagingStack } from './support/imaging-fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * A14 webhook subscriptions (synthetic only; A-D7 registration model recommended-pending-approval).
 * Nothing leaves the process: delivery goes through the WebhookDeliveryPort to an in-process fake
 * receiver, honoured only in synthetic-test. Subscriptions are human-only administration; payloads
 * carry event identity, type, version and references only; each attempt is signed over the exact
 * transmitted bytes with a fresh timestamp.
 */
const receiver = createFakeWebhookReceiver();
let allow: string[] = [
  'hooks.example.test',
  'rebind.example.test',
  '127.0.0.1',
  '169.254.169.254',
  'localhost',
];
const dns = new Map<string, string[]>([
  ['hooks.example.test', ['203.0.113.10']],
  ['rebind.example.test', ['203.0.113.11']],
]);
const resolveHost = async (host: string) => dns.get(host) ?? ['203.0.113.99'];
const webhookDeps = {
  webhookPort: receiver.port,
  webhookAllowlist: () => allow,
  webhookResolveHost: resolveHost,
};
let s: ImagingStack;
let worker: ActorContext;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
const SUB = '/v1/webhooks/subscriptions';

function service(port: WebhookDeliveryPort | null) {
  return createAutomationService({
    env: 'synthetic-test',
    authorize: createAuthorize(createMembershipSource(s.db.app)),
    withTenantTransaction: createTenantTransactionRunner(s.db.app),
    recording: { sink: createSecurityAttemptSink(s.db.sink), alert: () => undefined },
    execute: executeOnce,
    webhooks: {
      port,
      allowlist: () => allow,
      resolveHost,
      backoffSeconds: () => 0,
    },
  });
}
const dispatch = (port: WebhookDeliveryPort | null = receiver.port) =>
  service(port).dispatchWebhookDeliveries(worker, {
    operation: 'webhooks.deliveries.dispatch',
    idempotencyKey: randomUUID(),
    payload: {},
  });

async function subscribe(path: string, host = 'hooks.example.test') {
  const r = await s.command('owner', SUB, {
    endpointUrl: `https://${host}${path}`,
    eventTypes: ['patient.changed'],
    eventVersion: 1,
  });
  expect([r.status, r.body.slice(0, 300)]).toStrictEqual([201, r.body.slice(0, 300)]);
  return data<{ subscriptionRef: string; signingSecret: string; secretFingerprint: string }>(r);
}
const newPatient = async (name: string) =>
  data<{ patientRef: string }>(await s.command('owner', '/v1/patients', patientBody(name))).patientRef;
type Delivery = {
  deliveryRef: string;
  subscriptionRef: string;
  eventRef: string;
  state: string;
  attempts: number;
  lastResponseClass: string | null;
  lastGuard: string | null;
  replayOf: string | null;
};
async function deliveries(subscriptionRef: string): Promise<Delivery[]> {
  const r = await s.inject('owner', 'GET', `/v1/webhooks/deliveries?subscriptionRef=${subscriptionRef}`);
  expect([r.status, r.body.slice(0, 200)]).toStrictEqual([200, r.body.slice(0, 200)]);
  return (r.json.items as Delivery[]) ?? [];
}

beforeAll(async () => {
  s = await startImagingStack('automation_webhooks', { extraDeps: webhookDeps });
  for (const [p, scopes] of [
    [USER_A1, ['webhooks.manage', 'webhooks.read']],
    [USER_B1, ['webhooks.manage', 'webhooks.read']],
    [SVC_A1, ['webhooks.read', 'outbox.deliver']],
  ] as const)
    await s.db.admin.query(
      'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
      [p, scopes],
    );
  worker = await actorFor(s.db, SVC_A1, T_ALPHA);
}, 120_000);
afterAll(async () => {
  await s?.close();
});

describe('A14 event catalog and subscription administration', () => {
  it('publishes a closed, versioned event catalog derived from outbox aggregate types', async () => {
    const r = await s.inject('owner', 'GET', '/v1/webhooks/event-types');
    expect(r.status).toBe(200);
    const items = r.json.items as { eventType: string; aggregateType: string; versions: number[] }[];
    expect(items.map((i) => i.eventType)).toStrictEqual(WEBHOOK_EVENT_CATALOG.map((e) => e.eventType));
    expect(items.find((i) => i.eventType === 'patient.changed')).toMatchObject({
      aggregateType: 'patient',
      versions: [1],
    });
    const bad = await s.command('owner', SUB, {
      endpointUrl: 'https://hooks.example.test/x',
      eventTypes: ['patient.deleted'],
      eventVersion: 1,
    });
    expect(bad.status).toBe(422);
  });

  it('shows the signing secret once; never in a replay, a list, the logs or any table', async () => {
    const key = randomUUID();
    const body = {
      endpointUrl: 'https://hooks.example.test/once',
      eventTypes: ['patient.changed'],
      eventVersion: 1,
    };
    const first = await s.command('owner', SUB, body, key);
    expect(first.status).toBe(201);
    const secret = data<{ signingSecret: string }>(first).signingSecret;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const again = await s.command('owner', SUB, body, key);
    expect(again.json.replayed).toBe(true);
    expect(again.body).not.toContain(secret);
    expect(data<Record<string, unknown>>(again).signingSecret).toBeUndefined();
    const list = await s.inject('owner', 'GET', SUB);
    expect(list.status).toBe(200);
    expect(list.body).not.toContain(secret);
    expect(s.logLines.join('\n')).not.toContain(secret);
    const dump = await s.db.admin.query(
      `SELECT string_agg(t::text, '|') AS d FROM (
         SELECT row_to_json(x)::text AS t FROM cuspatlas.webhook_subscriptions x
         UNION ALL SELECT row_to_json(y)::text FROM cuspatlas.command_idempotency y
         UNION ALL SELECT row_to_json(z)::text FROM cuspatlas.audit_events z) q`,
    );
    expect(String(dump.rows[0]?.d)).not.toContain(secret);
  });

  it('refuses a second active subscription for the same endpoint and event version', async () => {
    await subscribe('/dup');
    const r = await s.command('owner', SUB, {
      endpointUrl: 'https://hooks.example.test/dup',
      eventTypes: ['patient.changed'],
      eventVersion: 1,
    });
    expect(r.status).toBe(409);
  });

  it('refuses non-https, unlisted, private, loopback, link-local, metadata and credentialed endpoints', async () => {
    const cases: [string, string][] = [
      ['http://hooks.example.test/x', 'endpoint_not_https'],
      ['https://unlisted.example.test/x', 'endpoint_not_allowlisted'],
      ['https://127.0.0.1/x', 'endpoint_private_address'],
      ['https://169.254.169.254/latest/meta-data', 'endpoint_private_address'],
      ['https://localhost/x', 'endpoint_private_address'],
      ['https://user:pw@hooks.example.test/x', 'endpoint_credentials'],
    ];
    for (const [endpointUrl, reason] of cases) {
      const r = await s.command('owner', SUB, {
        endpointUrl,
        eventTypes: ['patient.changed'],
        eventVersion: 1,
      });
      expect([endpointUrl, r.status, (r.json.detail as { reason?: string })?.reason]).toStrictEqual([
        endpointUrl,
        422,
        reason,
      ]);
    }
    // The guard is a pure function too: private ranges are refused even when allowlisted.
    for (const ip of [
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '[::1]',
      '[fe80::1]',
      '[fd00::1]',
    ])
      expect(checkWebhookEndpoint(`https://${ip}/x`, [ip.replace(/[[\]]/g, '')]).ok, ip).toBe(false);
  });

  it('subscriptions are human-only administration and tenant-scoped', async () => {
    const svc = await s.command('service', SUB, {
      endpointUrl: 'https://hooks.example.test/svc',
      eventTypes: ['patient.changed'],
      eventVersion: 1,
    });
    expect(svc.status).toBe(403);
    const { subscriptionRef } = await subscribe('/tenant');
    const other = await s.command('crossTenant', `${SUB}/revoke`, { subscriptionRef, reason: 'retired' });
    const missing = await s.command('crossTenant', `${SUB}/revoke`, {
      subscriptionRef: randomUUID(),
      reason: 'retired',
    });
    expect([other.status, missing.status]).toStrictEqual([404, 404]);
    const list = await s.inject('crossTenant', 'GET', SUB);
    expect(list.body).not.toContain(subscriptionRef);
  });
});

describe('A14 signed at-least-once delivery', () => {
  it('delivers a minimal signed payload a reference verifier accepts from the received bytes', async () => {
    const { subscriptionRef, signingSecret } = await subscribe('/ok');
    const patientRef = await newPatient('Webhook Markerperson');
    await dispatch();
    const got = receiver.to('/ok');
    expect(got.length).toBeGreaterThanOrEqual(1);
    const hit = got.find((g) => new TextDecoder().decode(g.body).includes(patientRef));
    expect(hit).toBeDefined();
    const h = hit as NonNullable<typeof hit>;
    const text = new TextDecoder().decode(h.body);
    expect(text).not.toContain('Markerperson');
    const payload = JSON.parse(text);
    expect(payload).toMatchObject({
      type: 'patient.changed',
      version: 1,
      resource: { type: 'patient', ref: patientRef },
    });
    expect(h.headers['cuspatlas-event-id']).toBe(payload.id);
    const ok = verifyWebhookSignature({
      bodyBytes: h.body,
      header: h.headers['cuspatlas-signature'] as string,
      secrets: [signingSecret],
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(ok).toMatchObject({ valid: true });
    // Re-serialized bytes, a tampered body and a wrong secret all fail.
    const reserialized = new TextEncoder().encode(JSON.stringify(payload, null, 1));
    const tampered = new TextEncoder().encode(text.replace(patientRef, randomUUID()));
    for (const bytes of [reserialized, tampered])
      expect(
        verifyWebhookSignature({
          bodyBytes: bytes,
          header: h.headers['cuspatlas-signature'] as string,
          secrets: [signingSecret],
          nowSeconds: Math.floor(Date.now() / 1000),
        }),
      ).toStrictEqual({ valid: false, reason: 'signature_mismatch' });
    // Outside the replay window (300 s) the same valid signature is refused.
    expect(
      verifyWebhookSignature({
        bodyBytes: h.body,
        header: h.headers['cuspatlas-signature'] as string,
        secrets: [signingSecret],
        nowSeconds: Math.floor(Date.now() / 1000) + 301,
      }),
    ).toStrictEqual({ valid: false, reason: 'timestamp_out_of_window' });
    // signDelivery is exactly HMAC-SHA-256 over "<t>.<bytes>".
    const t = Number(/t=(\d+)/.exec(h.headers['cuspatlas-signature'] as string)?.[1]);
    expect(h.headers['cuspatlas-signature']).toContain(
      `v1=${signDelivery({ bodyBytes: h.body, timestamp: t, secret: signingSecret })}`,
    );
    const log = await deliveries(subscriptionRef);
    expect(log.find((d) => d.eventRef === payload.id)).toMatchObject({
      state: 'delivered',
      attempts: 1,
      lastResponseClass: '2xx',
    });
  });

  it('retries with the same event identity after a lost acknowledgement; the consumer dedupes it', async () => {
    const { subscriptionRef } = await subscribe('/lost-ack');
    receiver.dropAckOnce('/lost-ack');
    await newPatient('Webhook Lost Ack');
    await dispatch();
    expect((await deliveries(subscriptionRef))[0]).toMatchObject({
      state: 'retrying',
      lastResponseClass: 'network',
    });
    await dispatch();
    const got = receiver.to('/lost-ack');
    expect(got.length).toBe(2);
    expect(got[0]?.eventId).toBe(got[1]?.eventId);
    expect(got.map((g) => g.repeat)).toStrictEqual([false, true]);
    expect((await deliveries(subscriptionRef))[0]).toMatchObject({ state: 'delivered', attempts: 2 });
  });

  it('dead-letters after the bounded attempts and lists it with attempts and the last response class', async () => {
    const { subscriptionRef } = await subscribe('/failing');
    receiver.respond('/failing', 503);
    await newPatient('Webhook Failing');
    for (let i = 0; i < 6; i += 1) await dispatch();
    const [d] = await deliveries(subscriptionRef);
    expect(d).toMatchObject({ state: 'dead_lettered', attempts: 5, lastResponseClass: '5xx' });
    expect(receiver.to('/failing').length).toBe(5);
    const w = await s.inject('owner', 'GET', '/v1/webhooks/deliveries/failures');
    expect(w.status).toBe(200);
    expect((w.json.items as Delivery[]).find((x) => x.deliveryRef === d?.deliveryRef)).toMatchObject({
      state: 'dead_lettered',
      attempts: 5,
      lastResponseClass: '5xx',
    });
  });

  it('replay keeps the event identity with a fresh signature timestamp; replay is human only', async () => {
    const { subscriptionRef, signingSecret } = await subscribe('/replay');
    receiver.respond('/replay', 500);
    await newPatient('Webhook Replay');
    for (let i = 0; i < 6; i += 1) await dispatch();
    const [dead] = await deliveries(subscriptionRef);
    expect(dead?.state).toBe('dead_lettered');
    receiver.respond('/replay', 200);
    const bySvc = await s.command('service', '/v1/webhooks/deliveries/replay', {
      deliveryRef: dead?.deliveryRef,
    });
    expect(bySvc.status).toBe(403);
    const r = await s.command('owner', '/v1/webhooks/deliveries/replay', { deliveryRef: dead?.deliveryRef });
    expect([r.status, r.body.slice(0, 200)]).toStrictEqual([201, r.body.slice(0, 200)]);
    const replay = data<{ deliveryRef: string; eventRef: string; replayOf: string }>(r);
    expect(replay).toMatchObject({ eventRef: dead?.eventRef, replayOf: dead?.deliveryRef });
    expect(replay.deliveryRef).not.toBe(dead?.deliveryRef);
    await new Promise((res) => setTimeout(res, 1100));
    await dispatch();
    const got = receiver.to('/replay');
    const last = got[got.length - 1] as (typeof got)[number];
    expect(last.eventId).toBe(dead?.eventRef);
    expect(last.headers['cuspatlas-delivery-id']).toBe(replay.deliveryRef);
    const ts = (h: (typeof got)[number]) =>
      Number(/t=(\d+)/.exec(h.headers['cuspatlas-signature'] ?? '')?.[1]);
    expect(ts(last)).toBeGreaterThan(ts(got[0] as (typeof got)[number]));
    expect(
      verifyWebhookSignature({
        bodyBytes: last.body,
        header: last.headers['cuspatlas-signature'] as string,
        secrets: [signingSecret],
        nowSeconds: Math.floor(Date.now() / 1000),
      }).valid,
    ).toBe(true);
    // Replaying the delivered one again reaches the consumer as a repeat it can absorb.
    const again = await s.command('owner', '/v1/webhooks/deliveries/replay', {
      deliveryRef: replay.deliveryRef,
    });
    expect(again.status).toBe(201);
    await dispatch();
    expect(receiver.to('/replay').at(-1)?.repeat).toBe(true);
  });

  it('a revoked subscription stops its queued deliveries immediately', async () => {
    const { subscriptionRef } = await subscribe('/revoked');
    receiver.respond('/revoked', 503);
    await newPatient('Webhook Revoked');
    await dispatch();
    expect(receiver.to('/revoked').length).toBe(1);
    expect((await deliveries(subscriptionRef))[0]?.state).toBe('retrying');
    const r = await s.command('owner', `${SUB}/revoke`, { subscriptionRef, reason: 'retired' });
    expect(r.status).toBe(200);
    await newPatient('Webhook Revoked Later');
    await dispatch();
    expect(receiver.to('/revoked').length).toBe(1);
    const log = await deliveries(subscriptionRef);
    expect(log.length).toBe(1);
    expect(log[0]?.state).toBe('cancelled');
  });

  it('re-checks the endpoint at send: a host now resolving privately or removed from the allowlist pauses', async () => {
    const a = await subscribe('/rebind', 'rebind.example.test');
    dns.set('rebind.example.test', ['10.0.0.5']);
    await newPatient('Webhook Rebind');
    await dispatch();
    expect(receiver.to('/rebind').length).toBe(0);
    expect((await deliveries(a.subscriptionRef))[0]).toMatchObject({
      state: 'paused',
      lastGuard: 'endpoint_private_address',
      attempts: 0,
    });
    dns.set('rebind.example.test', ['203.0.113.11']);
    const b = await subscribe('/unlisted-later');
    allow = allow.filter((h) => h !== 'hooks.example.test');
    await newPatient('Webhook Unlisted');
    await dispatch();
    expect(receiver.to('/unlisted-later').length).toBe(0);
    expect((await deliveries(b.subscriptionRef))[0]).toMatchObject({
      state: 'paused',
      lastGuard: 'endpoint_not_allowlisted',
    });
    allow.push('hooks.example.test');
  });

  it('secret rotation keeps an overlap in which both secrets verify', async () => {
    const { subscriptionRef, signingSecret: oldSecret } = await subscribe('/rotate');
    const r = await s.command('owner', `${SUB}/rotate-secret`, { subscriptionRef });
    expect(r.status).toBe(200);
    const newSecret = data<{ signingSecret: string }>(r).signingSecret;
    expect(newSecret).not.toBe(oldSecret);
    await newPatient('Webhook Rotate');
    await dispatch();
    const h = receiver.to('/rotate').at(-1) as NonNullable<ReturnType<typeof receiver.to>[number]>;
    for (const secret of [oldSecret, newSecret])
      expect(
        verifyWebhookSignature({
          bodyBytes: h.body,
          header: h.headers['cuspatlas-signature'] as string,
          secrets: [secret],
          nowSeconds: Math.floor(Date.now() / 1000),
        }).valid,
      ).toBe(true);
  });

  it('without a delivery adapter nothing is dropped: deliveries wait as adapter_not_configured in the worklist', async () => {
    const { subscriptionRef } = await subscribe('/no-adapter');
    await newPatient('Webhook No Adapter');
    await dispatch(null);
    const [d] = await deliveries(subscriptionRef);
    expect(d).toMatchObject({ state: 'adapter_not_configured', attempts: 0 });
    const w = await s.inject('owner', 'GET', '/v1/webhooks/deliveries/failures');
    expect((w.json.items as Delivery[]).some((x) => x.deliveryRef === d?.deliveryRef)).toBe(true);
    // A port is honoured only in synthetic-test.
    expect(resolveWebhookPort('production', receiver.port)).toBeNull();
    expect(resolveWebhookPort('development', receiver.port)).toBeNull();
    expect(resolveWebhookPort('synthetic-test', receiver.port)).toBe(receiver.port);
    await dispatch();
    expect((await deliveries(subscriptionRef))[0]?.state).toBe('delivered');
  });
});
