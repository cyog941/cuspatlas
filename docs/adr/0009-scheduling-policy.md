# ADR 0009: Scheduling policy record (S-S3)

Status: **proposed, 2026-11-04.** Every policy item below is `recommended-pending-approval`. No clinical or practice-management decision-maker has reviewed this record; the deciding roles are named but **no decision has been taken**. Evidence category for the recommendations: `proposed` (derived from the plan's open decisions and from `historical-reference` observations in [TAB32-STATUS-VOCABULARIES](../TAB32-STATUS-VOCABULARIES.md); observed labels are prompts, not semantics). Synthetic data only.

Plan: [Patients and scheduling](../superpowers/plans/2026-11-04-scheduling-and-patients.md), spike S-S3. Reserved number: [ADR-REGISTRY](../ADR-REGISTRY.md) 0009.

## Context

S-S3 blocks S9, S13, S15 and S16. The plan requires recorded answers for the recurrence cap (S-D1), waitlist offer semantics (S-D6), recall basis (S-D7) and an explicit month-end and daylight-saving occurrence rule. The spike's "obtain clinical and practice-management decisions" step could not be performed: no reviewer was available in this session. This record therefore states the recommended option, the consequence of each alternative and the pending deciding role, and marks what each pending item blocks.

What this record does **not** decide: whether a due patient may be contacted (that is E's suppression decision); clinical recall intervals per patient risk; payer-dependent eligibility.

## Status vocabulary

- `decided`: a named role approved it (none yet).
- `recommended-pending-approval`: the plan's recommended option, usable in synthetic implementation, not usable for a user-facing release until approved.
- `blocking`: undecided and no implementation may assume it.

## Items

| Id | Question | Recommended option | Status | Deciding role (pending) | Blocks until approved |
|---|---|---|---|---|---|
| S-D1 | Maximum occurrences one series request may create; behaviour at the limit | 26 occurrences per request; a documented configuration ceiling of 52; an explicit `extendSeries` ("continue series") action creates the next block. A request over the limit is a denial naming the limit (reason code carries it) and writes nothing; never silent truncation or extension. The limit is a published constant in the contract | recommended-pending-approval | practice manager (front-desk workflow owner) with clinical lead sign-off for recall-driven series | S13 user-facing release; S13 synthetic implementation may use 26/52 |
| S-D6 | Whether a waitlist offer holds the slot, and for how long | An offer creates a short-lived hold (an occupancy row of kind `hold`) with an explicit expiry; an expired hold releases its range without staff action (reconciliation path). No offer ever books without an explicit staff or patient acceptance command. Hold duration is configuration; no default is decided (proposal for synthetic tests only: 15 minutes) | recommended-pending-approval | practice manager; patient-communications owner (E) for the patient-acceptance path | S15 user-facing release; the hold duration value |
| S-D7 | What makes a patient due for recall; whether already-booked patients are excluded | Interval configured per practice and per recall category (no clinical interval is fixed here); the already-booked exclusion is an explicit rule, default on; every due list states the policy version and the freshness (computed-at instant) it was produced under | recommended-pending-approval | clinical lead (intervals and categories); practice manager (exclusion default) | S16 user-facing release; any clinical interval value |
| S-S3-R1 | Month-end occurrence rule | A monthly occurrence anchored on day 29, 30 or 31 falls on the **last day** of any month that has no such day (Jan 31 → Feb 28, or Feb 29 in a leap year → Mar 31 → Apr 30). The anchor day is kept, so the series returns to day 31 in the next long month; it never drifts to the clamped day. Occurrences are never skipped and never moved into the next month | recommended-pending-approval | practice manager | S13 short-month tests (the test asserts the chosen date explicitly) |
| S-S3-R2 | Daylight-saving rule for local wall-clock times | Schedules (availability hours, series patterns) are local wall-clock times in the location's IANA zone; stored instants are UTC. A local time that does not exist on a spring-forward day is moved **forward by the length of the gap** (02:30 in America/New_York on a spring-forward day becomes 03:30 EDT). A local time that occurs twice on a fall-back day resolves to the **earlier** instant (the first 01:30, EDT). Durations are real elapsed minutes, never wall-clock differences, so a 60-minute window that starts at 01:30 EDT on a fall-back day ends at 01:30 EST. This is the "compatible" disambiguation of RFC 9557 / Temporal | recommended-pending-approval | practice manager | S9 (implemented under this rule on synthetic data), S13 |
| S-S3-R3 | Availability search horizon and result bounds | Search range at most the configured maximum window per request (default 60 local days; changed from 31 by the accepted decision OR-D6, 2026-11-04, implemented by S18); result pages of 1-100 windows (default 25) with an opaque cursor; a range beyond the horizon is refused, never truncated; duration 5-480 minutes; buffer 0-120 minutes after the window | recommended-pending-approval | practice manager | S9 user-facing release |

## Consequences of the alternatives

- S-D1 without a cap: unbounded series make one request a large write and an unbounded notification fan-out; a silent cap (the observed incumbent cap of 26 is a `historical-reference` label only) loses occurrences without telling staff. A higher default than 26 raises conflict-list size and rollback cost of the atomic create.
- S-D6 offer without a hold: two waitlisted patients can accept the same slot and one acceptance must fail after the patient was told it was free. A hold that converts automatically would book without consent; that is excluded.
- S-D7 exclusion default off: patients already booked receive recall contact. Without a stated policy version and freshness, a due list cannot be reproduced or audited.
- R1 "skip the month" or "roll into next month": both change the count or the month of an occurrence silently; clamping keeps one occurrence per month.
- R2 "reject non-existent local times": every series crossing a spring-forward day would fail creation; "later instant" for repeated times would put the first occurrence after the second hour, surprising staff.

## What S7/S9 implement now (synthetic only)

- R2 is implemented by the availability search (`packages/domain/src/scheduling/zoned-time.ts`) and asserted in `tests/integration/availability.test.ts` with America/New_York spring-forward (2030-03-10) and fall-back (2030-11-03) days.
- R3 bounds are published in `packages/contracts/src/scheduling.schema.json` and enforced by the domain.
- S-D1, S-D6, S-D7 and R1 are recorded only; S13, S15 and S16 consume them. The occupancy table created by S7 already allows a `hold` kind so S-D6 can be implemented without a second occupancy mechanism.

## Undecided and blocking

Nothing here is `decided`. Each item becomes `decided` only when the named role signs a review note referenced from this file. Until then a user-facing release of S9, S13, S15 or S16 is blocked on this record.
