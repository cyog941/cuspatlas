# Webhooks (A14): consumer contract

Status: synthetic implementation, tested against an in-process fake receiver only. No outbound
network delivery exists: the delivery port is honoured only in `synthetic-test`; in every other
environment deliveries are created and wait as `adapter_not_configured` in the failures worklist
(never dropped). The registration model (A-D7: operator-approved host allowlist, human-registered
endpoints) is recommended-pending-approval. Nothing here is a production or compliance claim.

## Registration

- `webhooks.subscriptions.create` (human only, `webhooks.manage`): an `https` endpoint URL, a set of
  event types from the published catalog and one event version.
- The endpoint guard refuses (422, `detail.reason`): `endpoint_not_https`, `endpoint_credentials`
  (user info in the URL), `endpoint_not_allowlisted` (host not on the operator allowlist),
  `endpoint_private_address` (private, loopback, link-local, carrier NAT, unspecified, multicast,
  unique-local, `localhost`/`.internal`/`.local` names, cloud metadata addresses, or a name that
  resolves to any of them), `endpoint_invalid`. The guard runs at registration and again before every
  send; a host removed from the allowlist or now resolving privately pauses its deliveries
  (`paused`, `lastGuard` names the reason) instead of sending.
- One active subscription per endpoint URL and event version (409 `endpoint_already_subscribed`).
- The signing secret (`whsec_…`) is returned once, in the create (or rotate) response. It is stored
  only as AES-256-GCM ciphertext, never in an idempotency result, a list, an audit row or a log; an
  idempotent replay of the create returns the subscription without it.
- `webhooks.subscriptions.rotateSecret` mints a new secret; for 24 hours both the previous and the new
  secret sign every delivery (two `v1=` entries), so a consumer can switch without a gap.
- `webhooks.subscriptions.revoke` cancels every queued delivery in the same transaction; nothing
  further is sent.

## Event catalog

`webhooks.eventTypes.list` returns the closed, versioned catalog (`cuspatlas-webhook-events.1`): one
`<aggregateType>.changed` type per published outbox aggregate. A new payload shape is a new event
version; earlier versions keep delivering to subscriptions that selected them.

Version 1 body (the exact bytes are fixed when the event is fanned out; retries and replays send the
same bytes):

```json
{"id":"<outbox event id>","type":"patient.changed","version":1,"occurredAt":"…","operation":"patients.create",
 "resource":{"type":"patient","ref":"<uuid>","version":1},"changedFields":["…field names…"]}
```

No patient name, note text, contact value or credential is carried; `changedFields` are field names,
never values. Fetch the resource through the API with your own authorization.

## Headers and signature

| Header | Meaning |
| --- | --- |
| `cuspatlas-event-id` | Event identity: the deduplication key. Repeated on every retry and replay. |
| `cuspatlas-delivery-id` | Delivery identity: a replay has a new one. |
| `cuspatlas-event-type`, `cuspatlas-event-version` | Catalog type and version. |
| `cuspatlas-signature` | `t=<unix seconds>,v1=<hex>[,v1=<hex>]` |

`v1 = hex(HMAC-SHA-256(secret, "<t>." || received body bytes))`. Verify the bytes exactly as
received (a re-serialized body does not verify), compare in constant time, and refuse a `t` more than
300 seconds from your clock. The reference verifier is `verifyWebhookSignature` in
`packages/domain/src/automation/webhook-signing.ts`.

## Delivery semantics and consumer obligations

- At least once. A lost acknowledgement, a timeout, a network error or an expired worker lease re-sends
  the same event identity. Deduplicate on `cuspatlas-event-id`, retaining seen identities for at least
  7 days (the longest a retry or an operator replay is expected to arrive after the first attempt; the
  retention figure is recommended-pending-approval).
- A replay (`webhooks.deliveries.replay`, human only) re-sends a delivered or dead-lettered delivery:
  same event identity and bytes, new delivery identity, fresh signature timestamp. A replay therefore
  verifies; a forgery does not.
- Ordering is not guaranteed across events; use `resource.version` to discard stale notifications.
- Any 2xx is success. Anything else is retried with exponential backoff (30 s doubling, capped at 1 h)
  up to 5 attempts, then `dead_lettered`, listed in `webhooks.deliveries.failures.list` with its attempt
  count and last response class (`2xx`/`3xx`/`4xx`/`5xx`/`network`/`timeout`).
- A consumer that returns 2xx for a body it did not process cannot be detected; that is a consumer
  obligation, not something the sender handles.
