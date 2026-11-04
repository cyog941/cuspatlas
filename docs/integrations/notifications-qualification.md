# Notification channel and reminder qualification (S-S2)

Status: **blocked-on-discovery, 2026-11-07.** No channel is qualified. No vendor is chosen, contacted, signed, purchased or configured. Every row below is `unknown` with an owner role; nothing here is `verified` or `unavailable` because nothing was probed. Evidence category: `proposed`. Synthetic data only.

Plan: [Patients and scheduling](../superpowers/plans/2026-11-04-scheduling-and-patients.md), spike S-S2; open decision S-D5 (first-release messaging channels: recommended intent recording only, pending approval). Delivery belongs to E7 ([portal and communications plan](../superpowers/plans/2026-11-04-portal-and-communications.md)); consent, opt-out and the suppression decision belong to E6 ([SHARED-CONTRACTS](../SHARED-CONTRACTS.md)).

## What runs today without a channel (S14, implemented on synthetic data)

- Booking, rescheduling and cancelling record one `NotificationIntent` each in the same transaction, with `channel: 'none'`, a stable delivery key (`<purpose>:<subjectRef>`), the policy reference `notification-intent-pending-approval-1` and the E6 suppression decision as an `undecided` placeholder (no reference, no reason invented by scheduling). Waitlist offers (S15) and recall contact tasks (S16) record intents the same way.
- Scheduling sends nothing, holds no delivery state and reads no consent state (`tests/integration/notification-separation.test.ts`).
- Fallback required by S-S2: staff see every intent that no channel will deliver as a work item (`GET /v1/scheduling/notifications/worklist`, MCP `scheduling_notifications_worklist`): reason `no_verified_channel`, a plain-language explanation, the subject reference, owner queue `front_desk`, the due time, the suggested manual action and the blocking dependencies `S-S2`, `E6`, `E7`.

## Minimum contract a channel must expose before E7 may use it

Delivery by the stable delivery key with provider-side deduplication; a side-effect-free lookup by delivery key for reconciliation of unknown outcomes; typed receipts (`delivered | duplicate | unknown | failed{retryable}`); opt-out and consent signals E6 can record; quiet-hours support or an E6-side schedule; templating with a withdrawable template reference; a test environment usable with synthetic data only; data-processing terms covering protected health information. This mirrors the frozen adapter contract in `docs/execution/foundation-contract-decisions.md` (F Task 6).

## Per-channel qualification

| Criterion | SMS | Email | Voice | Portal |
|---|---|---|---|---|
| Consent capture supported | unknown | unknown | unknown | unknown |
| Opt-out signal (and how it reaches E6) | unknown | unknown | unknown | unknown |
| Quiet hours | unknown | unknown | unknown | unknown |
| Delivery receipts and their semantics | unknown | unknown | unknown | unknown |
| Deduplication by delivery key | unknown | unknown | unknown | unknown |
| Lookup by delivery key (reconciliation) | unknown | unknown | unknown | unknown |
| Templating and template withdrawal | unknown | unknown | unknown | unknown |
| Cost model | unknown | unknown | unknown | unknown |
| Data-processing terms (PHI) | unknown | unknown | unknown | unknown |
| Synthetic-data test environment | unknown | unknown | unknown | unknown |
| Owner role | patient-communications owner (E) with practice manager | patient-communications owner (E) with practice manager | patient-communications owner (E) with telephony owner (E8) | portal owner (E1/E5) |
| Probe (not run) | sandbox send and receipt with a synthetic number | sandbox send, bounce and complaint with a synthetic mailbox | sandbox call with a synthetic number and a call reference | portal inbox delivery to a synthetic portal principal |

The portal channel depends on E1 portal principals and E5 secure messaging, neither of which exists yet.

## Blocks

- E7 delivery and any claim of reminders being sent: blocked until at least one column above is `verified` with an owner sign-off and S-D5 is decided.
- S14 intent recording is not blocked (it runs with `channel: 'none'`).
