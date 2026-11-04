# Shared contracts across workstream plans

Status: proposed, 2026-11-03. This document is the single source of truth for concepts that more than one implementation plan uses. Where a plan disagrees with this page, this page wins until it is changed deliberately.

The plan set grew in parallel and three shared concepts ended up owned twice with incompatible shapes. This page fixes ownership, one representation per concept, and one naming scheme. It adds no new product scope.

## Ownership map

Each aggregate has exactly one owning workstream. Other workstreams consume its contract by reference and must not define a competing type or command.

| Concept | Owner | Everyone else |
|---|---|---|
| Patient identity, duplicate resolution, merge/unmerge | S | consumes `patientRef` and the merge contract |
| Guardian, guarantor, proxy relationships and their scopes | S | consumes; portal grants are a projection, never a parallel model |
| Appointment request aggregate | S | portal calls the same command with an `origin` parameter |
| Booking and the conflict result | S | consumes |
| Encounter, chart, perio, treatment plan and detail, notes, consent, estimates | C | consumes; billing reads estimated and rendered amounts |
| Payer coverage record and eligibility result | B | C and S read coverage state, never compute it |
| Payment plan, installments, auto-pay attempts | B | S and E read plan state for messaging only |
| Recall policy and due computation | S | E consumes due items to enroll and deliver |
| Consent, opt-out and notification suppression | E | S and B consume the suppression decision; they never evaluate it |
| Image object, storage, digest, patient association | I | C references an image by `imageRef`; C does not define matching or `matchStatus` |
| Lab case | C | I stores attachments only |
| Migration identity resolution and archive | M | consumes S merge; does not define a second merge command |
| Audit registry and command recording | F | every workstream registers its entities |

Two rules follow from the table. **A plan may not define a type whose name appears in another plan's ownership row.** And **a consumer names the owner's command rather than restating its behaviour.**

## Money

One representation, everywhere:

```
Money = { currency: string, minor: integer }
```

All monetary fields in every contract use `Money`. Scalar `amountMinor` and `currency` pairs are not permitted in contracts, and neither are strings. Arithmetic goes through the shared helpers; no plan performs its own rounding. Where a plan previously used a scalar form, it is a defect to be corrected, not a variant to be preserved.

## Identifiers

One scheme: an entity reference is an opaque string named `<entity>Ref` — `patientRef`, `appointmentRef`, `claimRef`, `imageRef`, `planVersionRef`. Bare `patientId` / `patient_id` in a contract is a defect.

Caller input never establishes tenant authority: transport inputs derive tenant from authenticated context. Persisted records, trusted internal context and audit/outbox envelopes retain tenant keys for RLS, constraints and isolation; omitting tenant from caller input does not remove it from storage.

Identifiers are opaque. No consumer parses one to learn anything.

## Booking and refusal results

One result type, `BookingResult`, with `outcome` in `booked | held | conflict | denied`.

- `conflict` and `denied` are typed domain refusals, never successful business operations. Conflict details are filtered by resource visibility; unauthorized callers never receive blocking record identities or another actor's identity.
- Internal policy may throw a typed denial. The command boundary normalizes it to the shared refusal contract; it must not become a generic 500 or an HTTP success. Unexpected faults remain faults.
- `BookingOutcome` does not exist.

The same shape applies to any command that can legitimately refuse: attempt, refusal, reason. This is why the platform foundation's idempotency and audit record the attempt either way.

### Transport mapping and replay

REST maps successful creation to 201, other successful results to the documented 2xx; invalid input to 400 (schema) or 422 (domain validation), unauthenticated to 401, authorized-context permission denial to 403, hidden cross-tenant/missing resources identically to 404, conflict/stale version to 409, rate or usage-budget refusal to 429, and unexpected faults to safe 5xx. Never return 200 with a failed business outcome. MCP tools return the same safe reason code, retryability and correlation identifier as a structured tool error with `isError: true`; authentication/protocol failures use their protocol mechanisms. MCP does not pretend to use HTTP business status codes internally.

Idempotency records may retain a terminal refusal without recording a successful mutation. Replays must reauthorize before returning any saved result. Retrying a corrected request uses a new key; changing payload under the original key conflicts. Transient or unknown external outcomes follow the reconciliation policy, never a fabricated terminal success.

### Two audit paths

Successful domain changes, committed-change audit and outbox commit atomically. Rollback removes all three. Denials and failed attempts instead produce a minimized security-attempt event through an independent durable transaction/sink after rollback, with its own unique attempt identifier, correlation ID, authenticated actor/tenant when known, safe operation and reason code. Never trust caller-supplied tenant context or persist raw input/PHI in these events. Repeated attempts are distinguishable and deduplicated only by attempt ID, not by the business idempotency key.

If attempt-audit persistence is unavailable, deny the operation anyway, emit a safe operational alert and return a safe service failure when possible; never permit the action to compensate. Document crash-window limits. Do not claim every received network attempt is durably captured before acknowledgement unless a durable ingress design proves it. Test failure, retry and recovery of both paths independently.

## Roles and scopes

One scope registry, published with the workflow and role matrix. Scope names are `noun.verb` in lower case: `patients.read`, `patients.write`, `scheduling.write`, `clinical.sign`, `claims.read`, `receivables.read`, `paymentDistribution.read`, `undistributedFunds.read`, `openClaims.read`, `admin.configure`.

Camel-case scope names (`receivables.read` written as `receivablesRead`) are a defect. A scope used in any plan must appear in the registry; a plan that needs a new scope adds it there first.

### Relationship scopes

Guardian, guarantor and proxy authority is expressed as a scope on a relationship, not as a separate permission system. The scheduling plan owns the relationship model; the portal projects it. The vocabulary is fixed here so it is not re-invented per plan:

| Scope | Grants |
|---|---|
| `demographics` | read and maintain the related patient's demographic record |
| `scheduling` | book, reschedule and cancel on the related patient's behalf |
| `clinical_read` | read the related patient's clinical record |
| `financial` | see balances, statements and payment plans |
| `consent` | give or withdraw consent on the related patient's behalf |

These five names are the complete set. A plan that needs a sixth adds it here first. No plan defines a parallel relationship kind vocabulary or a second expiry mechanism: expiry is a property of the relationship, evaluated in one place.

## Plan taxonomy: task identifiers

Every plan declares its prefix at the top and uses it consistently:

| Plan | Prefix |
|---|---|
| platform foundation | `F` |
| scheduling and patients | `S` |
| clinical record | `C` |
| billing and RCM | `B` |
| imaging and devices | `I` |
| portal and communications | `E` |
| migration and operations | `M` |

- Implementation task: `C12`.
- Discovery spike: `C-S2`. Spikes have owners and appear in the dependency graph so a task can be blocked on them.
- Open decision: `C-D3`. Decisions carry a status and the task they block.

A cross-workstream dependency names the fully qualified task (`C14`, not "the clinical workstream"). `Blocks` is derived from `Dependencies` and is not maintained separately.

## State machines

Transition sets are required for appointment, appointment request, claim, payment plan, statement, treatment plan, clinical note, consent, image, lab case and recall entry. Each transition names guard, actor and whether it is reversible. Where the incumbent only supplied labels, we record the label as observed and our designed transition as designed — the two are never merged into one table row.

## What this page does not do

It does not decide clinical policy, payer behaviour, device support or pricing. Those remain open decisions in the plans and gates in the qualification matrix. The 2026-11-03 correction pass aligns the reviewed refusal and audit contracts; implementation tests must prove conformance. Unique planned ADR identities are reserved in [ADR-REGISTRY](ADR-REGISTRY.md).
