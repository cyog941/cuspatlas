# Billing and RCM execution ledger (workstream B)

Branch: `codex/b-billing-1` in an isolated worktree outside the OneDrive-synced checkout. Base SHA: `2e7d61a` (foundation, S4-S11 and the practice-time requirements). Sibling worktrees build S12-S17 and C; this branch touches only `packages/domain/src/billing/**`, its contracts, transports, migrations, tests and append-only lines in shared registries. Status values: not started, in progress, blocked with cause, verified. Nothing is prechecked.

Authorization basis: user instruction to build every backend workstream on synthetic data until only the UI phase remains. Scope of batch 1: B1 (Money and the append-only journal) and B2 (payments, allocations and undistributed funds). Scope of batch 2: B3 (payment plans), B4 (statements) and B5 (coverage and eligibility).

## Financial-safety framing

- Financial rules need billing/accounting reviewer validation, which was not available. Every rule below is implemented against the plan's recommended option and marked **recommended-pending-billing-approval** in [ADR 0008](../adr/0008-money.md). Nothing here is approved, validated, compliant or deployed, and no balance, statement or claim produced by this code may be shown to a real practice.
- No real payment processor (B-S1 is blocked-on-discovery). Payment capture is a recorded fact from a synthetic in-process provider or from manual entry. No card data, PAN or provider token exists anywhere; the only instrument is a synthetic opaque reference (`syn-card-...`).
- Money is `{currency, minor}` integer minor units (SHARED-CONTRACTS), never floats; arithmetic only through the shared helpers; explicit rounding rule (largest remainder, lower-index tie-break).
- Synthetic data only. The privacy marker never reaches logs, refusals, audit, outbox, attempts, idempotency, sensitive-read or billing rows: every caller-supplied billing string is a closed pattern (lowercase synthetic references, reason codes, synthetic placeholder codes), so free text cannot be stored at all.

## Batch status

| Task | Status | Head SHA | Notes |
|---|---|---|---|
| B1 Money and append-only journal | verified on synthetic data (Windows host); decisions pending billing approval | a342b6d | 706 tests |
| B2 Payments, allocations, undistributed funds | verified on synthetic data (Windows host); decisions pending billing approval; provider execution blocked-on-discovery (B-S1) | 66ea613 | 759 tests |
| B3 Payment plans, expired-card and failed-auto-pay worklists | verified on synthetic data (Windows host); decisions pending billing approval; card and auto-pay execution blocked-on-discovery (B-S1, PAY-02..04, PAY-07) | 31f9cd6 | 805 tests |
| B4 Audited statements, snapshot and staleness | verified on synthetic data (Windows host); decisions pending billing approval; delivery not built (E7) | 2542e00 | 823 tests |
| B5 Coverage, eligibility records, coverage provenance | verified on synthetic data (Windows host); decisions pending billing approval; live eligibility blocked-on-discovery (B-S3); fee schedules B9 (B-S4) | 6ca38d9 | 853 tests |
| B1/B2 hardening after independent review of 66ea613 | verified on synthetic data (Windows host); no MUST-FAIL finding; decisions pending billing approval | (this commit) | 863 tests |

## Pending decisions

| Id | Question | Recommendation implemented | Status | Deciding role | Blocks |
|---|---|---|---|---|---|
| M-1..M-3 | Money representation, arithmetic, single tenant currency | ADR 0008 M-1..M-3 | recommended-pending-billing-approval | billing reviewer | user-facing release |
| B-D3 (M-4) | Residual minor unit | largest remainder, ties to lower index | recommended-pending-billing-approval | billing reviewer | B3 installments, B7 spreads |
| M-5 | Allocation ordering | explicit caller order; holders in patient-reference order | recommended-pending-billing-approval | billing reviewer, practice manager | auto-allocation policy |
| M-6/M-7 | Journal accounts, sign rules, reversal-only correction | ADR 0008 | recommended-pending-billing-approval | accounting reviewer | user-facing release |
| M-8 | Received vs settled | separate settlement entry | recommended-pending-billing-approval | billing reviewer | B7 settlement reconciliation |
| B-D4 (M-9) | Undistributed funds | hold with age basis, derived owned work item, escalation 7 days | recommended-pending-billing-approval | practice financial policy owner | B2 user-facing release |
| B-D1 (M-10) | Card data | no card data; synthetic provider only | blocked-on-discovery (B-S1) | billing reviewer, security owner | any real payment |
| M-11 | Merge of patients | never relink posted rows; read-time merge set; post-merge probe | recommended-pending-billing-approval | billing reviewer, identity owner | unmerge with money |
| M-12 | Who may correct | reversals, refunds, cross-patient transfers human only | recommended-pending-billing-approval | billing reviewer, practice owner | standing policies for corrections |
| P-1 | Plan schedule | monthly installments from the first due date; contract total minus collected basis split evenly, residue to the earliest (M-4) | recommended-pending-billing-approval | billing reviewer | other cadences |
| P-2 | Authorization evidence (PAY-07) | a synthetic authorization reference plus signed-agreement evidence reference per terms version; each authorization reference used once per plan, so a card update needs a new one | recommended-pending-billing-approval | billing operations lead | e-signature method, retention |
| P-3 | Attempts per installment | one attempt per period; a further attempt only with an explicit `retry`; none while any attempt is unknown; provider key = plan, terms version, period, attempt number | recommended-pending-billing-approval | billing reviewer | PAY-04 exactly-once contract |
| P-4 | Expired and expiring card | expired when the expiry month has ended in the plan's time zone (a run records a blocked attempt, no charge); expiring within 30 days | recommended-pending-billing-approval | billing operations lead | PAY-03 card-update service |
| P-5 | Failed auto-pay due time | 2 days after the declined attempt; one item per plan (latest attempt) | recommended-pending-billing-approval | practice financial policy owner | user-facing release |
| P-6 | Void and default | human-only `billing.correct` decision with a reason, refused while an attempt is unknown; collected money stays in the journal (no automatic refund or reallocation) | recommended-pending-billing-approval | billing reviewer, practice owner | collections workflow |
| P-7 | Amendment | a new terms version whose basis is the money collected so far; refused at or below collected and while an attempt is unknown; needs a new authorization | recommended-pending-billing-approval | billing reviewer | user-facing release |
| ST-1 | Statement coverage | the guarantor's current S5 dependents plus its own account unless another guarantor holds it; each by merge set; relationships as of generation | recommended-pending-billing-approval | billing reviewer, practice manager | user-facing release |
| ST-2 | Statement amount | patient receivable less unapplied credit, entries posted at or before the cutoff (millisecond precision); net-zero entries (allocations, settlements) omitted | recommended-pending-billing-approval | billing reviewer | user-facing release |
| ST-3 | Credit and zero totals | explicit `totalClass` (`due`/`zero`/`credit`) with `amountDue` and `creditBalance`; never a silent negative amount due | recommended-pending-billing-approval | billing reviewer | user-facing release |
| ST-4 | Staleness | derived on read: a net-nonzero posting after the cutoff, a changed account membership, or a newer version; never stored | recommended-pending-billing-approval | billing reviewer | E7 delivery gate |
| B-D5 | Statement delivery | not built here: channel `none`, owner E7 (portal plus recorded manual print recommended) | open (E7) | operator | delivery |
| CV-1 | Coverage overlap | two coverages of one rank in the patient account may not overlap (any payer; stricter than the plan's same-payer rule) unless an override names a reason | recommended-pending-billing-approval | billing reviewer | COB (B8) |
| CV-2 | Coverage history | a change is a new version of the whole changeable field set; the payer is fixed per coverage (a new payer is a new coverage); effective-until inclusive | recommended-pending-billing-approval | billing reviewer | migration of coverage history (M) |
| CV-3 | Eligibility freshness | current for a service date within the record's window either side of its capture date (UTC dates); default window 168 hours | recommended-pending-billing-approval | billing operations lead | CL-01 visit preparation |
| CV-4 | Coverage status for estimates | `entered` when the latest usable (verified or unverified) record is current for the service date, `stale` outside it, `unknown` otherwise; a later timeout keeps the earlier usable record and is reported as `latestAttempt` | recommended-pending-billing-approval | billing reviewer, C12 owner | estimate presentation |
| CV-5 | Staff-entered eligibility | always `unverified` (B-S3 stop condition) | recommended-pending-billing-approval | billing operations lead | live eligibility |
| CV-6 | Insurer responsibility seam | `billing.responsibility.transfer` names a coverage of the charge patient's account effective on the service date; legacy payer-only lines stay readable | recommended-pending-billing-approval | billing reviewer | B6 claims |
| B-loc | Location-scoped financial access | tenant-wide (like S-D8) | recommended-pending-billing-approval | practice owner | location-restricted roles |

## Command log

### B1 (Money and append-only journal)

Acceptance and failure cases (tests/integration/billing-journal.test.ts, 15 tests, REST and MCP under the runtime role):

1. a balanced charge posts (Dr patient_receivable +12345, Cr production_revenue -12345), reads back with exact minor units, audits once (`billing.charges.post`, `billingCharge`, v1) with a field-names-only outbox row, and replays under the same key with `replayed: true` and one entry;
2. malformed money (fraction, string, lower-case currency, zero, negative, extra property, missing currency, bare number), marker text in every caller string and a caller `tenantId` are 400 before any write; no billing row changes; the marker is absent from logs and every audit, outbox, attempt, idempotency, sensitive-read and billing table;
3. a currency other than the tenant configuration is 422 `currency_mismatch` (never converted); a tenant configured as EUR accepts EUR only; a balance read in another currency is 422; a future service date is 422 `service_date_in_future`;
4. a reversal exactly negates its original line by line, both stay readable with links, the balance returns to zero, and a balance `asOf` the original's posting instant still shows the full amount;
5. a second reversal is 409 `already_reversed` naming the existing reversal; reversing a reversal is 409 `reversal_not_reversible`; a reversal without a reason is 400; nothing changes;
6. correction by replacement: a second original for one procedure is 409 `charge_already_posted`; a replacement of an unreversed charge is 409 `replaced_charge_not_reversed`; for another procedure 422 `replacement_mismatch`; after reversal the replacement links both ways and the balance is exactly the replacement; a second replacement is 409 `charge_already_replaced`;
7. three concurrent reversals of one entry: exactly one 201 and two 409 `already_reversed`, one reversal row;
8. another tenant's entry, charge, reversal, ledger, balance and charge posting are 404 with a body identical to a missing reference (attempt rows `resource_hidden_or_missing`); malformed references are 404; a reversal of a forged reference posts nothing;
9. a read-only role cannot post (403) but can read; a member without billing scopes cannot read the ledger (403); a service principal can post (the C14 driver) but its reversal is 403 `principal_kind_denied`; a poster without `billing.correct` cannot reverse;
10. MCP and REST share outcomes and one idempotency scope (an MCP post replays over REST); a second MCP reversal is the same 409; another tenant's MCP read is 404;
11. the runtime role cannot update, delete or truncate posted lines, entries or charges, cannot insert billing settings, and cannot move a charge version by more than one (42501); the owner's update of a line is refused by the append-only trigger;
12. the database refuses at commit (23514) an unbalanced entry, an entry with fewer lines than declared, a balanced pair appended to a posted entry, a "reversal" that does not exactly negate its original, and an over-credit of a receivable (sign rule); nothing changes;
13. a failure inside the posting transaction (outbox insert grant revoked) is a 500 with no charge, entry, line, audit or outbox row;
14. a merge changes no billing row (digest), the survivor balance covers both identities, posting to the merged identity is 409 `patient_merged`, and after a post-merge charge the unmerge needs the reconciliation review (422 `reconciliation_review_required`, then 200 with a review reference); afterwards each identity's balance is its own again;
15. the balance equals the sum of the receivable lines of the paged ledger (cursor pages of one), writes a sensitive-read row, and the billing source names no clinical or estimate table.

Unit cases: `packages/contracts/src/money.test.ts` (7: representation, exact parsing, mixed-currency refusal, overflow refusal, seeded properties of add/subtract/negate/compare over 2000 cases, seeded properties of `allocateRemainder` over 2000 cases, the documented residue and tie-break examples); `packages/domain/src/billing/no-float-money.test.ts` (4: non-vacuous scan, no float parsing/formatting/rounding in billing TypeScript, no float column in billing migrations, integer-only minor units in the contract); `apps/mcp/src/billing-tool-drift.test.ts` (one tool per billing route, input schemas mirror the REST contract).

- Red: `corepack pnpm test -- packages/contracts/src/money.test.ts` before `money.ts` → exit 1 (module missing, no test ran). `corepack pnpm test -- no-float-money` → exit 1, 3 failed, 1 passed. `corepack pnpm test -- billing-journal` before any domain code → exit 1, 15 failed (15).
- Green: money → exit 0, 7 passed; billing-journal → exit 0, 15 passed; full `corepack pnpm test` → exit 0, 36 files, 706 tests (655 at start + 7 money + 4 float guard + 15 journal + 18 negative-harness rows + 7 billing tool drift).
- `corepack pnpm typecheck` → exit 0; `corepack pnpm lint` → exit 0; `corepack pnpm contract:check` → exit 0.

Invariants and where they are enforced:

| Invariant | Database | Domain |
|---|---|---|
| Entry balanced, at least two lines, declared line count | deferred constraint trigger | `assertBalancedEntry` |
| One currency per entry | composite foreign key line -> entry currency | `assertBalancedEntry` |
| Tenant currency only | - | `inTenantCurrency` |
| Posted rows immutable | grants (SELECT/INSERT) + append-only trigger | no update path exists |
| Reversal exactly negates, one per entry, not of a reversal | deferred trigger + unique index | `negatedLines`, `assertReversible`, charge lock |
| Receivable never below zero, revenue never a debit | deferred trigger (sign rules) | `assertSigns` under aggregate locks |
| Charge facts immutable, version +1 | trigger + column grant | `bumpAggregates` |
| One original charge per procedure, one replacement per charge | unique partial indexes | pre-check under lock |
| No float on money paths | no float column (scanned) | BigInt helpers; scanned |
| Merge never alters posted rows | no relink grant on billing columns | `MERGE_EXCLUDED_REFERENCES`, `mergeSet`, post-merge probe |

Shared files touched (minimal, append-only): `packages/contracts/src/index.ts`, `packages/contracts/package.json` (export), `packages/domain/src/index.ts`, `commands/execute-once.ts` (codecs), `policy/authorize.ts` (6 rows), `patients/merge.ts` (2 exclusion rows), `apps/api/src/app.ts`, `routes/manifest.ts`, `contract-drift.ts` (`billing:` prefix, bodies, shared defs, integer guard), `apps/mcp/src/server.ts`, `tools/synthetic-tasks.ts` (ToolDeps, known properties), `docs/api/openapi.yaml`, `tests/integration/negative-harness.test.ts` (6 rows, scopes, fixture, state), `tenant-isolation.test.ts` (+4 tables), `mcp-parity.test.ts` (+6 tools), `docs/SHARED-CONTRACTS.md` (scope registry), `docs/execution/foundation-contract-decisions.md` (B1 record).

Deviations: the plan's generic `postJournalEntry` is not exposed as an endpoint. A caller-composed entry could debit any account; instead each business command composes its own lines and calls the internal `postEntry`, which is the plan's posting contract. The plan's `JournalEntry.amount` is replaced by signed lines (double entry needs at least two amounts). Charges carry a synthetic procedure reference (the C14 seam). The B1 completion condition (a charge, a partial payment and a partial refund reconciling to an exact remaining balance) needs B2 commands and is proved in B2's suite.

### B2 (payments, allocations and undistributed funds)

Acceptance and failure cases (tests/integration/billing-allocations.test.ts, 17 tests, REST and MCP under the runtime role):

1. completion condition (also B1's): a 10000 charge, an 8000 cash payment, a 5000 allocation and a 3000 refund leave exactly 5000 owed, zero unapplied funds and no worklist item; the payment shows allocated 5000, refunded 3000, unapplied 0 and its allocation;
2. an allocation beyond the payment's funds is 409 `insufficient_funds`; beyond what the charge owes 409 `charge_overallocated`; the same charge twice in one command 422 `duplicate_charge`; another currency 422 `currency_mismatch`; nothing changes;
3. two allocations in one command commit together or not at all (the second's shortfall refuses both);
4. four concurrent allocations against one payment: exactly one 201 and three 409 `insufficient_funds`; two payments racing for one charge: one 201 and one 409 `charge_overallocated`; the charge is never over-allocated;
5. a payment cannot pay an unrelated patient's charge (422 `patient_mismatch`); a merged identity's money pays the survivor's charge (one account, nothing relinked); a payment for a merged identity is 409 `patient_merged`;
6. unapplied money is a derived worklist item per payment and holder with age basis, owner `practice`, queue `billing`, reason `unapplied_funds`, due time (received + 7 days), overdue flag and suggested action, ordered by due time, with total and truncation; the balance's unapplied credit equals the items; no billing table has a balance or unapplied column;
7. moving funds between patients needs a reason (400 without), a human (service 403), different patients (422 `same_patient`) and enough funds (409 `insufficient_funds`); it is audited (`billing.funds.transfer`) and posts two unapplied lines; the recipient can then allocate; the original payer cannot refund money that moved;
8. a refund beyond unapplied funds is 409 `refund_exceeds_funds`; refunds are human-only `billing.correct` (service and a poster without the scope get 403);
9. a duplicate check number is 409 `duplicate_receipt` naming the first payment; a replay returns the first payment; a card replay under one key returns one payment (stable provider key); a card without a synthetic instrument is 422 `instrument_required`, cash with one 422 `instrument_not_allowed`;
10. provider outcomes: declined records an attempt and no entry; three timeouts record unknown attempts, post nothing, add no unapplied credit and appear as `unknown_payment_outcome` items; reconcile of a still-unknown outcome is a retryable 409 `outcome_still_unknown`; a captured one posts the payment exactly once (second reconcile 409 `already_resolved`); an absent one resolves declined with no payment; a declined attempt is 409 `not_reconcilable`; four attempts exist (nothing retried automatically);
11. received is not settled: settlement is its own entry; settling twice is 409 `nothing_to_settle`; reversing the payment is 409 `allocation_reversal_required` naming the allocation, then (after reversing it) `settlement_reversal_required`, then succeeds after the settlement reversal; the reversed payment reads `reversed` and refuses allocation (409 `payment_reversed`);
12. responsibility moves to and from a synthetic payer, never beyond what is open (409 `responsibility_exceeded` both ways); balances split patient and insurer responsibility; a charge with dependent entries cannot be reversed (409 `dependent_reversal_required` naming both);
13. another tenant's payment (read, settle, allocate, refund, transfer), an alpha payment allocated to a beta charge, a payment for another tenant's patient, a forged beta guarantor and a transfer to a beta patient are 404 identical to a missing reference; nothing changes;
14. a guarantor must be the patient's current S5 guarantor (422 `guarantor_unresolved` otherwise);
15. marker text in every synthetic reference, reason code and charge reference is 400; the marker is absent from logs and every audit, outbox, attempt, idempotency, sensitive-read and billing table;
16. MCP gives the same allocation conflict, worklist and read outcomes as REST; another tenant's MCP read is 404; a member without billing scopes cannot list the worklist (403);
17. the database refuses at commit an allocation that over-spends unapplied credit (23514) and refuses editing payment or attempt facts under the runtime role (42501).

- Red: `corepack pnpm test -- billing-allocations` before any B2 code → exit 1, 17 failed (17).
- Green: `corepack pnpm test -- billing-allocations` → exit 0, 17 passed; full `corepack pnpm test` → exit 0, 37 files, 759 tests (706 + 17 B2 + 27 negative-harness rows + 9 billing tool drift).
- `corepack pnpm typecheck` → exit 0; `corepack pnpm lint` → exit 0; `corepack pnpm contract:check` → exit 0.

Invariants and where they are enforced (in addition to B1):

| Invariant | Database | Domain |
|---|---|---|
| Allocation never exceeds available funds | deferred sign rule: unapplied credit per payment and holder never a debit | holder balances under the payment lock |
| A charge is never over-allocated or over-transferred | deferred sign rule: receivables never below zero | open balance under the charge lock |
| Concurrent allocations: one wins | row locks (payment, then charges in id order) | typed 409 for the loser |
| Refund never beyond collected and unapplied | sign rules on unapplied credit and cash accounts | holder and cash balances under the payment lock |
| Received vs settled | separate accounts; settlement is an entry | `settlePayment` |
| Duplicate receipt never a second payment | unique (tenant, method, external reference), unique attempt | pre-check plus 23505 mapping |
| Unknown provider outcome never posted or retried | outcome immutable, resolution once (trigger) | unknown -> attempt only; reconcile by lookup |
| Payment and attempt facts immutable | triggers and column grants | no update path except version and one resolution |
| Undistributed funds never a stored balance | no such column (tested) | derived worklist |

Shared files touched in B2 (minimal, append-only): `policy/authorize.ts` (9 rows), `patients/merge.ts` (4 exclusion rows), `contract-drift.ts` (9 bodies), `docs/api/openapi.yaml`, `negative-harness.test.ts` (9 rows, fixture payment and attempt, state), `tenant-isolation.test.ts` (+2 tables), `mcp-parity.test.ts` (+9 tools), `docs/execution/foundation-contract-decisions.md` (B2 record).

Deviations: `moveUnappliedFunds` takes the payment (path) and an optional `fromPatientRef` instead of patients only, so moved money keeps its payment provenance (PT-05 explainability; no FIFO guess). Allocations are journal entries of kind `allocation` (allocationRef = entryRef) rather than a separate mutable table, so an allocation is reversed by the one reversal path. A declined payment is a 201 recording command (the attempt is the created fact, `outcome: declined`), not a refusal of our command; every refusal of our command remains a typed 4xx. Provider refunds are recorded facts only (B-S1). The provider is called inside the idempotent handler: replays never call it, and a retry after a lost commit reuses the same provider key, so the synthetic provider (and any future one, by the frozen adapter rule) deduplicates it.

### B3 (payment plans, expired-card and failed-auto-pay worklists)

Acceptance and failure cases (tests/integration/billing-payment-plans.test.ts, 14 tests, REST and MCP under the runtime role):

1. contract total, installment (residue to the earliest: 334/333/333), schedule, collected, balance, overdue and next due date, authorization, auto-pay and card state are distinct derived fields; past due dates make the plan overdue without touching the contract total; an unsigned plan is one `missing_signature` item (owner, queue, reason, due, action) and collection is 409 `unsigned_authorization`; authorization without evidence is 400; a stale expected version is 409 `stale_version`; a self-guaranteed plan names the patient (`guarantorBasis: self`);
2. a guarantor that is not the current S5 guarantor is 422 `guarantor_unresolved`; an unknown IANA zone 422 `invalid_time_zone`; another currency 422 `currency_mismatch`; another tenant's patient is 404 identical to a missing one; malformed counts, float money, marker text and a caller `tenantId` are 400; nothing changes; a read-only role cannot create (403);
3. a confirmed run posts one B2 card payment; the scheduler rerun under its key replays; another key is 409 `duplicate_period`; three concurrent runs for one period give one 201 and two 409 with one attempt; completion derives `completed` and refuses further collection (`plan_completed`);
4. a declined attempt is a recorded fact (no payment), `autoPayState: failed` and exactly one `failed_autopay` item with the attempt as evidence; a second run is `duplicate_period`; after a new instrument (new authorization) an explicit retry collects and the item resolves;
5. an unknown outcome blocks the plan (`autoPayState: blocked`); retry, another period, void and amendment are 409 `attempt_in_flight`; the only reconciliation item is B2's `unknown_payment_outcome`; reconciliation (lookup, never a new capture) posts the payment and the period reads paid;
6. an expired card derives `expired` and an `expired_card` item; the run records a `blocked` attempt with no provider attempt and no payment, the plan is not voided; reusing the prior authorization for the card update is 409 `authorization_reused`; a new one makes the card current and a retry collects; both enrollment facts stay readable;
7. pausing refuses collection (409 `autopay_paused`), resuming reuses the instrument; no instrument is 409 `instrument_absent`; a future period 422 `period_not_due`; an unknown period 422 `period_not_found`;
8. a partial collection reads `partially_paid` with the exact collected amount, never rounded to paid; an amount beyond the installment is 422 `amount_exceeds_installment`;
9. an amendment is terms version 2 with the collected money as its basis (350/350), unsigned until authorized; earlier terms and attempts stay readable; at or below collected is 422 `amendment_below_collected`;
10. void needs a human with `billing.correct` and a reason (a3 and the service are 403, no reason 400); the voided plan keeps attempts, facts and its collected money (the payment stays `received`); collection is 409 `plan_voided`; a second closure 409 `plan_closed`; closed plans leave every worklist; default is a distinct outcome; create and close are audited;
11. another tenant's read, collection, authorization and closure are 404 identical to a missing plan; its worklist is empty; a member without billing scopes is 403; the report-scope reader can read;
12. MCP gives the same collection, `duplicate_period` conflict, read and worklist outcomes as REST; another tenant's MCP read is 404;
13. the runtime role cannot update a plan's facts, update or delete terms, events or attempts (42501), and a second attempt row with the same period and attempt number is 23505; no plan table has a balance, overdue, state or status column;
14. marker text in every caller string is 400 and never reaches a log or a row.

- Red: `corepack pnpm test -- billing-payment-plans` before any B3 code → exit 1, 14 failed (14).
- Green: `corepack pnpm test -- billing-payment-plans` → exit 0, 14 passed; full `corepack pnpm test` → exit 0, 38 files, 805 tests (759 + 14 B3 + 24 negative-harness rows + 8 billing tool drift).
- `corepack pnpm typecheck` → exit 0; `corepack pnpm lint` → exit 0; `corepack pnpm contract:check` → exit 0.

Invariants and where they are enforced:

| Invariant | Database | Domain |
|---|---|---|
| No stored plan balance, overdue or state | no such column (tested) | `computePlan` derives every figure from terms, facts, attempts and journal payments |
| Plan facts append-only | grants SELECT/INSERT; append-only triggers; plan row version only (aggregate guard) | no update path except the version |
| One attempt per period and attempt number | unique (plan, terms version, period, attempt number); unique provider attempt | plan row lock; `duplicate_period` unless `retry` |
| Unknown outcome never retried or advanced | B2 attempt resolution once | `attempt_in_flight` for every plan command that could charge, amend or close |
| Authorization used once (card update needs a new one) | partial unique index (plan, authorization) | pre-check `authorization_reused` |
| Closed at most once | partial unique index | `plan_closed` |
| Blocked attempt never reaches the provider | CHECK (blocked = no provider attempt = block reason) | expired-card branch before capture |

Shared files touched in B3 (append-only lines): `policy/authorize.ts` (8 rows), `patients/merge.ts` (2 exclusion rows), `billing/payments.ts` (exports `insertPayment`, `assertGuarantor`, and the extracted `captureWithProvider`), `contract-drift.ts` (7 bodies), `docs/api/openapi.yaml`, `negative-harness.test.ts` (8 rows, fixture plan, state), `tenant-isolation.test.ts` (+4 tables), `mcp-parity.test.ts` (+8 tools), `billing-tool-drift.test.ts` (one query mapping), `support/billing-fixtures.ts` (`receivables.read` in the report reads, `addGuarantor`).

Deviations: `PaymentPlanView` gains `not_enrolled` and `blocked` auto-pay states and drops `revoked` (no revocation command exists; an amendment makes the new terms `unsigned`). `recordInstallmentAttempt` is `billing.plans.collect`: the outcome comes from the provider port, not from the caller, and an expired card is a recorded `blocked` attempt (B-06) rather than a refusal. `voidPlan` is `billing.plans.close` with outcome `voided` or `defaulted`, keeping default distinct from void and from collection state. Plan collection goes through the B2 capture path (`captureWithProvider` + `insertPayment`), not through a nested `billing.payments.record` command, so the provider key is bound to the installment period instead of to a caller key. Collected money is unapplied patient credit until allocated (M-5: no automatic allocation).

### B4 (audited statements, balance snapshot and staleness)

Acceptance and failure cases (tests/integration/billing-statements.test.ts, 10 tests, REST and MCP under the runtime role):

1. a guarantor statement groups its own account and its S5 dependent's account from the journal lines (charge +5000, payment -1000), with total, amount due, credit balance, class, a sha256 snapshot digest verified on read, delivery `none`/`not_requested`/owner E7, and fresh freshness; one audit row (`billing.statements.generate`, `billingStatement`, v1);
2. the same key replays the same record (`replayed: true`); a new cutoff is version 2 superseding version 1, and a reissue with the old cutoff is version 3 superseding version 2; version 1 keeps its digest and total and derives stale (`superseded`); three concurrent generations serialize into versions 4, 5 and 6;
3. a payment after generation makes the statement stale (`posted_after_cutoff`, current total 2500) while its snapshot, digest and total stay; reversing that payment returns the current total to 4000 but both later postings still count; the stored row is byte-identical before and after;
4. a cutoff before a posting excludes it (one line, total 1000) and the statement is stale at once;
5. a credit balance is `credit` with amount due 0 and credit balance 300; an empty account is `zero`;
6. a merged pair is one account under the survivor (both identities covered); generating for the merged identity is 409 `patient_merged`;
7. a future cutoff is 422 `cutoff_in_future`; a patient guaranteed by someone else who guarantees no one is 422 `guarantor_unresolved`; another tenant's guarantor and statement are 404 identical to a missing one; an unknown basis, marker text and a caller `tenantId` are 400; nothing changes; a member without billing scopes is 403 on read; the report reader cannot generate (403) but can read;
8. a failure inside generation (outbox insert grant revoked) is a 500 with no statement, audit or outbox row;
9. MCP generation and read match REST (same digest); another tenant's MCP read is 404; a future cutoff is the same 422; no snapshot digest, entry reference or marker reaches a log;
10. the runtime role cannot update or delete a statement row (42501); no stale or fresh column exists.

- Red: `corepack pnpm test -- billing-statements` before any B4 code → exit 1, 10 failed (10).
- Green: `corepack pnpm test -- billing-statements` → exit 0, 10 passed; full `corepack pnpm test` → exit 0, 39 files, 823 tests (805 + 10 B4 + 6 negative-harness rows + 2 billing tool drift).
- `corepack pnpm typecheck` → exit 0; `corepack pnpm lint` → exit 0; `corepack pnpm contract:check` → exit 0.

Invariants and where they are enforced:

| Invariant | Database | Domain |
|---|---|---|
| A statement row is never updated or deleted | grants SELECT/INSERT; append-only trigger | no update path |
| One chain of versions per guarantor | unique (guarantor, version); unique supersedes; version 1 iff no predecessor | guarantor row lock (`FOR NO KEY UPDATE`), predecessor = latest version |
| Snapshot integrity | digest CHECK (hex) | canonical JSON digest recomputed on every read (`integrity`) |
| Class matches total | CHECK | explicit class, amount due, credit balance |
| Staleness never stored | no such column (tested) | derived per read |
| Delivery not decided here | CHECK channel = `none` | view states owner E7 |

Shared files touched in B4 (append-only lines): `policy/authorize.ts` (2 rows), `patients/merge.ts` (1 exclusion row), `codecs.ts`, `contract-drift.ts` (1 body), `docs/api/openapi.yaml`, `negative-harness.test.ts` (2 rows, fixture statement, state), `tenant-isolation.test.ts` (+1 table), `mcp-parity.test.ts` (+2 tools).

Deviations: `StatementRecord.state` (`generated | reissued | voided`) is replaced by the version chain (`statementVersion`, `supersedesStatementRef`, `supersededByStatementRef`); there is no void command (a statement is superseded, never voided, pending billing approval). `recordStatementDelivery` is not built: delivery, print and the suppression decision belong to E7. `deriveStatementFreshness(record, currentBalance)` is the read's `freshness` (it also reports later postings, membership changes and supersession, not only a balance difference). The refusal `garantor_unresolved` is spelled `guarantor_unresolved`. The domain statement guard forbids `pg_*` function calls, so generation serializes on the guarantor's patient row instead of an advisory lock.

### B5 (coverage, eligibility records and coverage provenance)

Acceptance and failure cases (tests/integration/rcm-eligibility.test.ts, 10 tests, REST and MCP under the runtime role; plus B2 case 12 re-expressed on a coverage):

1. coverage is effective-dated; resolution for a service date returns primary then secondary with effective dates, coverage status `unknown` without eligibility and `paymentAssurance: none`; a date outside a range drops that coverage; before every range nothing resolves; a missing service date is 400;
2. a second primary overlapping the first is 409 `overlapping_coverage` naming it; an inverted range is 422 `invalid_effective_range`; nothing changes; an explicit override with a reason is recorded on the version; another rank never overlaps;
3. a change is version 2 (end date, fee schedule, member); a stale expected version is 409 `stale_version`; version 1 stays byte-identical in the history; resolution follows the latest version (no coverage after its end date);
4. a subscriber who is another patient is a separate reference with its relationship; self with a relationship other than `self`, or another subscriber with `self`, is 422 `subscriber_relationship_mismatch`; another tenant's subscriber is 404 identical to a missing one;
5. a staff-entered record is `unverified`, its status, limits and frequencies groups each carry provenance (source, capture, recorder); it is current for today (`coverageStatus: entered`) and stale for a service date outside its window in the same query; a future capture is 422 `retrieved_in_future`; adapter requests may not carry benefits (422 `benefits_not_allowed`);
6. the fake adapter maps a response to verified limits and frequencies; the same key replays the same record; a timeout records `unknown` with no benefit fields; an unmappable response records `unparsed` with raw evidence and its digest and no benefit fields; an inactive answer is a verified status, not a claim outcome; statuses resolve as entered, unknown, unknown;
7. a second record never rewrites the first; the runtime role cannot update or delete eligibility records, coverage versions or coverage facts (42501);
8. responsibility moves to a coverage of the charge patient effective on the service date (charge shows coverage, payer and amount; the journal line names the coverage); another patient's coverage is 422 `coverage_patient_mismatch`, one not yet effective 422 `coverage_not_effective`, another tenant's 404 identical to a missing one; a bare `payerRef` is now 400;
9. a merged identity's coverage resolves under the survivor; recording coverage for the merged identity is 409 `patient_merged`; another tenant's read, eligibility, change and resolution are 404; a member without billing scopes is 403; the read-only reader can read but not record eligibility;
10. MCP record, overlap conflict, resolution and hidden read match REST; marker text in every caller string, a float freshness window and a caller `tenantId` are 400; the marker never reaches a row (billing and rcm tables) or a log.

- Red: `corepack pnpm test -- rcm-eligibility billing-allocations` before any B5 code → exit 1, 11 failed (10 B5 + B2 case 12), 16 passed.
- Green: `corepack pnpm test -- rcm-eligibility billing-allocations billing-journal` → exit 0, 42 passed; full `corepack pnpm test` → exit 0, 40 files, 853 tests (823 + 10 B5 + 15 negative-harness rows + 5 billing tool drift).
- `corepack pnpm typecheck` → exit 0; `corepack pnpm lint` → exit 0; `corepack pnpm contract:check` → exit 0.

Invariants and where they are enforced:

| Invariant | Database | Domain |
|---|---|---|
| Coverage history never rewritten | versions and eligibility append-only (grants, triggers); coverage row version only | new version per change |
| No overlap of one rank without a reason | (domain only: "latest version" overlap is not expressible as an exclusion constraint) | patient row lock (`FOR NO KEY UPDATE`) then overlap query over the merge set |
| Timeout never ineligible; unparsed never interpreted | CHECK: unknown/unparsed carry no benefits; unparsed iff raw evidence and digest | port outcome mapping, exact v1 mapper |
| Staff entry is unverified | CHECK (entered iff unverified) | fixed state |
| Freshness and coverage status never stored | no such column | derived per service date |
| New insurer lines name a coverage | NOT VALID CHECK (new rows), FK to coverage, dimension CHECK; sign rule and reversal negation key on the coverage | `loadCoverageForCharge`, account and effective-date checks |

Shared files touched in B5 (append-only lines): `policy/authorize.ts` (5 rows), `patients/merge.ts` (2 exclusion rows), `billing/base.ts` (eligibility port dependency), `billing/journal.ts`, `billing/charges.ts`, `billing/allocations.ts` (coverage dimension), `contract-drift.ts` (6 bodies), `docs/api/openapi.yaml`, `docs/SHARED-CONTRACTS.md` (scopes `coverage.read`, `coverage.write`), `negative-harness.test.ts` (5 rows, fixture coverage, state), `tenant-isolation.test.ts` (+3 tables), `mcp-parity.test.ts` (+5 tools), `billing-tool-drift.test.ts` (`rcm.` operations), `no-float-money.test.ts` (scans `packages/domain/src/rcm`), `billing-allocations.test.ts` (case 12 on a coverage), `support/billing-fixtures.ts` (coverage scopes, `recordCoverage`, rcm tables in the digest and leak surface).

Deviations: the RCM operations live in `packages/domain/src/rcm/coverage.ts` but are served by the billing service and contract (`rcm.*` operation names, `/v1/rcm/...` routes, `rcm_*` tools) instead of a second contract file. `recordEligibility` takes `source` (`entered` or `fake_adapter`); state `unparsed` is added beside `verified | unverified | unknown`. `assessEligibilityFreshness` is the per-record `freshness` of the resolution (`current | stale`; no record is `unknown` status). The overlap rule is stricter than the plan (any payer of the same rank). `stale_eligibility` and `unparsed_response` are not refusals: both are recorded, visible states. The `ResponsibilityTransfer` body replaced `payerRef` with `coverageRef` (pre-release contract change; legacy rows untouched).

### Hardening of B1/B2 after independent review (review of 66ea613: no MUST-FAIL)

Findings addressed (tests/integration/billing-hardening.test.ts, 9 tests; `no-float-money.test.ts` +1):

1. Capture loss: a card capture is now three steps. (a) Validate and commit the attempt as `pending` under its stable provider key; (b) call the provider outside any transaction (a throw or timeout is `unknown`); (c) in executeOnce, record the answer once and post a confirmed payment. A failure after the capture leaves the pending attempt as an `unknown_payment_outcome` reconciliation item; reconciliation (lookup, never a new capture) posts once. Plan collection uses the same steps (the plan attempt is `submitted` and reports the B2 attempt's outcome). Cases: a provider that throws (1), an outbox fault after a confirmed capture (2), a plan installment whose provider throws (4).
2. The commit-time sign rule now locks the touched payments then charges (`FOR NO KEY UPDATE`, compatible with the foreign-key KEY SHARE locks of line inserts) before summing: two raw runtime-role transactions over-allocating one charge at once give one commit and one 23514 (5).
3. Backstops at commit: each entry kind may touch only its accounts; entries must be in the tenant currency; a received entry must match its payment and a card payment needs a captured attempt of the same amount; at most one received entry per payment (unique partial index) (6). The unapplied holder versus merge set stays a domain rule (documented in the migration: transfers legitimately move funds and the merge set is resolved at read time).
4. Key reuse after idempotency expiry: the pending insert is `ON CONFLICT (provider key) DO NOTHING`; an existing attempt is 409 `duplicate_attempt` naming it, never a second capture (3).
5. `BILLING_POST_MERGE_PROBE` walks the whole merge chain (root and everything merged into it, like `mergeSet`) with `posted_at >= merged_at`; entries take `clock_timestamp()` (7).
6. Reconciling a capture after the payer was merged posts the payment to the survivor (merge-set root) (8).
- Nits: BigInt instead of `Math.min`/Number arithmetic in allocation and refund; `Number(` and `Math.` are now flagged on every billing and rcm money path (only `money.ts` performs the one sanctioned conversion); a seeded property run of 60 random post/pay/allocate/refund/reverse operations keeps every entry balanced, every sign rule and balance = receivable + unapplied lines, with only typed refusals (9).

- Red: `corepack pnpm test -- billing-hardening no-float-money` before the fixes → exit 1, 9 hardening failed; the guard extension failed 1 of 5.
- Green: `corepack pnpm test -- billing-hardening no-float-money` → exit 0, 14 passed; full `corepack pnpm test` → 41 files, 863 tests (853 + 9 + 1). One full run had two host-load timing failures (`restore-smoke` (e), `worker-recovery` lease timing) that passed on an isolated rerun (38 passed); the gate run below is the record.
- Migration `20261120050000_billing_hardening.sql` (attempt `pending` outcome, guard and update policy, plan attempt `submitted`, one-receipt index, `clock_timestamp()` posting default, replaced `billing_check_signs` and `billing_check_entry`). B1 case 15's structural allowlist names `command_idempotency` (the replay check before a capture).
- Deviation: a pending attempt left by a crash between steps (a) and (c) has no audit row until it is reconciled (the audit is written with the outcome); it is visible in the worklist from the moment it is committed.

### Integration merges (batch 3 start)

- `4b65466` merges `codex/scheduling-patients` (0c8cfdf): additive conflicts kept both sides; the billing journal-entry path parameter is `JournalEntryRef` in OpenAPI (S15 owns `EntryRef`); harness fixture `alphaJournalEntry`. 1176 tests green.
- `88082c6` merges `codex/c-chart` at 4fbde64 (1365bff plus the S12-S17 merge C already did), so C's migration renumbering and its S13/S15 merge-registry mirror are reused. Billing migrations moved to the `20261120xxxxxx` range (their `20261109` versions collided with C in `schema_migrations`). `clinical-care.ts` re-exports the shared `Money`. Probes: clinical plus billing. Harness: B3 plan fixture `alphaPaymentPlan`. Billing tables are `MERGE_EXCLUDED_REFERENCES` only, never record classes, so the SQL class mirror needs no billing rows. 1627 tests green.

### Hardening of B3-B5 after independent review (review of 74f3232)

Tests: `tests/integration/billing-review-hardening-b3b5.test.ts` (15). Red first: exit 1, 14 failed and 1 passed (the payer-mismatch backstop was already refused by an existing check). Green: exit 0, 15 passed; `billing-hardening.test.ts` case 2 updated for the lease (asserted 409 `attempt_in_flight` inside the lease, then the item and the reconciliation after it). Migration `20261120060000_billing_review_hardening_b3_b5.sql`.

- M1 in-flight lease: a pending attempt stores `call_deadline` (provider timeout plus margin; defaults 30 s + 30 s, injectable as `providerTimeoutMs` / `providerLeaseMarginMs`). Provider capture and lookup calls are bounded by the timeout (`withTimeout`: throw or no answer is `unknown`). Reconcile refuses a pending attempt before its deadline with 409 `attempt_in_flight`; the worklist hides it until then. A premature `not_captured` resolution can be corrected exactly once to `captured` (by the original request's late confirmed answer in finalize, or by one more lookup), keeping `superseded_resolution`, `corrected_at`, `corrected_by`; the guard trigger allows only that transition. Finalize after a reconciliation that already posted the capture answers with that payment (never a second one). Same path for plan installments (tested with a gated provider).
- M2 eligibility: the fake adapter is called outside any transaction (no coverage `FOR SHARE` is held while it answers), with the same timeout; a throw or timeout is an `unknown` record. A committed replay is checked before calling. No request row: the check is side-effect free, so a lost result only means another check (recorded decision; payments keep the request-first pattern because money can move).
- S1 statement staleness: `pre_cutoff_changed` when the sum of entries posted up to the cutoff differs from the snapshot total (a late-committed pre-cutoff entry; tested with a gated raw runtime-role entry, since every service path takes the guarantor lock the generation takes).
- S2 plan collection after a merge posts to the merge root; the attempt and payment name the survivor (a merge during the provider call is re-resolved at posting).
- S3 coverage status: a record is current only for its own service date, on the latest coverage version and inside its freshness window now; a verified inactive member is `inactive` (new value of the billing `CoverageResolutionStatus`; C's own estimate `CoverageStatus` stays three-valued: C12 must map `inactive`, seam below).
- S4: the runtime role inserts attempts only as `pending` with a lease (RLS); a card payment must match a captured attempt's amount, currency and receipt (trigger, 23514).
- S5: the insurer-coverage CHECK became an insert trigger: a reversal line may carry a NULL coverage only when the line it negates did (same payer and charge), so pre-B5 entries reverse exactly; any other insurer line names a coverage and carries that coverage's payer.
- S6: authorization references are unique per tenant (index plus pre-check, 409 `authorization_reused`).

### B9 (fee schedules, adjustments, report scope) and the C14 -> B consumer

Tests: `tests/integration/billing-fees-procedures.test.ts` (10). Red first with the implementation stashed: exit 1 (suite setup failed on the missing fee-schedule route; 10 skipped). Green: exit 0, 10 passed. Full suite: 1657 passed, 13 todo (one float-guard failure on `Number()` in the new REST registration fixed before commit). Migration `20261120070000_billing_fees_procedures_adjustments.sql`.

- Fee schedules: `billing_fee_schedules` (practice per location or tenant-wide; allowance schedules named by a coverage `fee_schedule_ref`), append-only versions effective from a date with a declared item count (checked at commit) and SYN- items in integer minor units. A version effective before the latest is 409 `effective_date_out_of_order`; a same-day correction is a higher version; no version ever reprices a posted charge (the charge records `fee_schedule_version_id`). Open-ended versions make a gap impossible (recorded deviation from the plan's `effective_date_gap`).
- `billing.fees.resolve` (GET `/v1/billing/fees`) is the C12 seam: practice fee at the location and, with a coverage, the payer allowance; `null` when nothing is configured.
- C14 consumer: the worker leases `clinicalRenderedProcedure` events and calls `billing.procedures.consume` in-process (new `WorkerDeps.procedures`), with its own service principal authorized freshly by the domain (`billing.write`, service only); the clinical author is not reauthorized (the clinical fact stands). One consumption row per (procedureRef, event version), inserted first (`ON CONFLICT DO NOTHING`), so duplicates, re-leases and 5 concurrent consumers produce one charge (tested). Rendered: price from the practice schedule at the encounter location (read through C's `loadEncounter`); posted to the merge root. Reversed: exact reversal of the original charge entry (an allocated charge is 409 `allocation_reversal_required` and dead-letters for review). Replacement: needs the replaced charge reversed (retryable 409 `replaced_charge_not_reversed`), links `replaces_charge_id`. No fee: retryable 409 `fee_not_configured`, nothing posted. Non-retryable refusals dead-letter with the existing F reason `provider_rejected` (no F schema change).
- Contract mismatch fixed: charges accept a UUID `procedureRef` (source `clinical_procedure`) and SYN- codes up to 40 characters with hyphens. The manual `billing.charges.post` stays for non-clinical synthetic charges only (`syn-proc-` references; a UUID is refused by its schema), pending a reviewer decision on whether non-clinical charges exist.
- Adjustments: kinds contractual (insurer, posts directly, B-D2), courtesy and write-off (a request; another human with `billing.correct` approves and posts; self-decision refused by domain and trigger). Reasons from a configured synthetic vocabulary (`reason_not_configured` otherwise); entries `adjustment`/`writeOff` debit the new `adjustment_expense` account per charge and credit the chosen receivable; sign rules refuse more than the balance (`adjustment_exceeds_balance`); corrected by reversal.
- Journal: accounts `adjustment_expense`, `insurer_clearing`, `insurer_cash` (B7), kinds `insurerSettlement`, and `remittance_id` on entries and lines; `billing_check_entry` (review nit: B7/B9 kinds) and `billing_check_signs` replaced keeping the race-safety locks and exact reversal (now including the remittance dimension).
- Report scope: `billing.reports.receivables` needs `receivables.read`; location-restricted readers see only their locations (naming another is 403). Billing code names billing tables only: coverage and location reads moved to `packages/domain/src/rcm/lookups.ts`.
- REST/MCP: one operation table `apps/api/src/routes/billing-ops.ts` (REST registration, MCP tools and closed-body drift derive from it); OpenAPI block generated from it.

### B6 (claims, denial codes and appeals; fake clearinghouse only)

Tests: `tests/integration/rcm-claims.test.ts` (8). Red first with the implementation stashed: exit 1, 8 failed. Green: exit 0, 8 passed. Full suite: 1677 passed, 1 failed (`patient-merge` 7: the new `rcm_claims.patient_id` foreign key was not registered; now a `MERGE_EXCLUDED_REFERENCES` row, no SQL mirror change since it is not a record class), then the affected suites green (129). Migration `20261120080000_rcm_claims.sql`.

- Claims (CL-02) are prepared only from C14 rendered procedures with posted, unreversed clinical charges (a procedure without a charge is retryable 409 `missing_completion_fact`; another tenant's or an unknown procedure is 404); lines carry SYN- code, date of service, rendering provider, billed amount (the charge) and the coverage allowance (B9 allowance schedule). Claim versions are immutable rows (attachment or corrective replacement = a new version linked by `supersedes_id`).
- Readiness (CL-03): deterministic rules with owner and source: `eligibility_not_current` and `coverage_not_effective` / `coverage_inactive` (front_office), `charge_reversed` and `coverage_changed` (billing), `attachment_required` for `SYN-ATT-` codes (clinical). The validation row stores an input digest; any change makes it not current and submission is 409 `validation_stale`.
- Submission (CL-04/CL-05): one submission per claim version (409 `already_submitted`, never a blind resubmission), recorded `pending` before the fake adapter is called outside any transaction (timeout = unknown). Authorization: explicit (human caller) or a revocable standing policy (`rcm_submission_policies`, a minimal billing record: the S standing-policy model is scheduling-specific) rechecked at execution (`policy_revoked`, `policy_payer_mismatch`, `policy_limit_exceeded`). Transmission moves the billed amount to insurer receivable of the claim's coverage.
- Responses: transport acknowledgement/rejection, payer acknowledgement/rejection and adjudication (paid/denied) are distinct `rcm_claim_events`, idempotent per partner event reference; rejection and denial codes carry their synthetic source and version (`syn-clearinghouse-rejections` / `syn-denial-codes`, `v1`). An unknown submission is resolved once by lookup (`resolved_by_lookup`).
- Appeals (CL-07): drafts tied to a recorded denial (one per basis, 409 `duplicate_appeal`), sent only after another human (billing.correct, never the drafter: domain and trigger) approves.
- Worklist (CL-08): validation issues by owner, submit, reconcile unknown, correct and replace, review denial, review appeal draft, and follow-up 30 days after transmission without adjudication; each with owner, reason, due time and source.

### B7 (remittance ingestion and reconciliation; fake clearinghouse only)

Tests: `tests/integration/rcm-remittance.test.ts` (3). Red first with the implementation stashed: exit 1, 3 failed. Green: exit 0, 3 passed. Migration `20261120090000_rcm_remittance.sql`.

- Synthetic ERA-like advice (not X12) fetched from the fake clearinghouse by reference; idempotent per reference (a duplicate ERA returns `duplicate` and posts nothing); a total that does not equal its lines is refused (`partial_parse`), a foreign currency is `currency_mismatch`.
- Each line matches exactly one transmitted claim line of the tenant (another tenant's claim is invisible, so unmatched). Routed to review instead of posting: `unmatched_claim`, `amount_mismatch` (paid + contractual + patient responsibility differs from billed), `underpayment` (paid + patient responsibility below the allowance), `insurer_balance_mismatch`. A denial line is recorded with its synthetic code and posts nothing.
- Posting (balanced entries tagged with the remittance): insurer payment = Dr `insurer_clearing` / Cr insurer receivable (an ERA is never cash); contractual adjustment (B-D2, posted directly); patient responsibility = responsibility transfer back to the patient.
- Settlement (EFT/check) is a separate fact: Dr `insurer_cash` / Cr `insurer_clearing`, only for exactly the open clearing balance (`settlement_mismatch` otherwise, never posted).
- Corrections: `rcm.remittances.reverse` (human `billing.correct`) reverses every posting newest first, settlement included; nothing is edited.
- Not built (pending): a review-resolution command for review lines (they stay visible on the remittance); secondary-claim chaining (B8).

### Hardening of B6, B7 and B9 after independent review (review of 6ee7f65)

Tests: `tests/integration/rcm-review-hardening-b6b9.test.ts` (11). Red first with the implementation stashed: `corepack pnpm test -- rcm-review-hardening-b6b9` → exit 1, 11 failed. Green: exit 0, 11 passed. `billing-fees-procedures.test.ts` case 9 re-expressed (a manual contractual adjustment without an adjudicated claim is 422 `claim_required`, an unknown claim 404); `tenant-isolation.test.ts` +2 tables. Migration `20261120100000_rcm_review_hardening_b6_b9.sql`.

MUST-FAIL:
1. Replacement gate: a corrective replacement needs the LATEST submission to be of the head version and rejected (transport) or carrying a payer rejection or denial. Pending/unknown is 409 `submission_unresolved`, a paid adjudication 409 `claim_adjudicated_paid`, anything else `replacement_not_needed` (a rejection of an earlier version no longer counts).
2. One open claim lineage per procedure and coverage rank: `rcm_claim_procedure_holds` with a partial unique index `(tenant, procedure, benefit_rank) WHERE released_at IS NULL`; taken at preparation and replacement, released only by a replacement of the same claim that drops the procedure (guard trigger); domain 409 `procedure_on_open_claim` naming the holding claim; existing claims backfilled. Tested: prepare twice (409, one claim) and a raw runtime-role insert (23505).
3. Malformed ERA: the fetched advice is validated against the new `RemittanceAdvice` definition (non-negative integer minor units, line numbers, reference) before anything is matched: 422 `malformed_remittance` for paid 60 / contractual 60 / PR -20 and for 10.5; nothing stored or posted. Per-line atomicity: the statement guard forbids SAVEPOINT in domain work (recorded deviation from the review's suggested mechanism), so the line's charge is locked and its insurer balance re-read before the first entry; the line posts only when all of paid + contractual + PR fit, otherwise it goes to review; a sign failure after that aborts the whole remittance (409 `remittance_line_not_postable`), never a partial line.
4. Contractual adjustments: a manual contractual adjustment names the adjudicated (paid) claim of its coverage (`claimRef`; 422 `claim_required`, 409 `claim_not_adjudicated`, 422 `charge_not_on_claim` / `coverage_claim_mismatch`), is capped at billed − allowance (`resolveAllowance`; 409 `allowance_unknown`) net of posted contractual entries (and their reversals) and pending contractual requests (422 `contractual_exceeds_allowance_gap`, rechecked at approval), and is a request another human approves (self-decision refused by domain and trigger). `billing.adjustments.post` is human-only; service principals post contractual amounts only through remittance ingestion. The claim read lives in `rcm/lookups.ts` (billing names billing tables only).
5. Receivables report: a location-restricted reader sees only charges at its locations; charges without a location are visible only to tenant-wide readers.

SHOULD:
- Settlement: the deposit must equal the ERA total (`settlement_mismatch`); when review lines with paid amounts keep clearing below the total it is 409 `settlement_pending_review` naming those lines. `rcm.remittances.settle` is human-only.
- A submission left `pending` by a crash stores `call_deadline` (provider timeout + margin); after it `rcm.claims.poll` resolves it once by lookup with the same key (guard trigger allows exactly that transition), the worklist shows `reconcile_submission/submission_pending` from the deadline, and before it poll is 409 `submission_in_flight`. A partner answer of `not_found` leaves it pending and visible (no resubmission path for the same version yet).
- Readiness locks the claim's charges `FOR SHARE` during validation and submission phase 1; only a verified eligibility record is current (staff-entered `unverified` is `eligibility_not_current`).
- Claims worklist: newest first, one page of 200 with `truncated`.
- RLS binds `drafted_by`, `reviewed_by`, `requested_by` and `decided_by` to `current_actor_id()` (tested: a forged drafter is 42501).
- Appeal `send_unknown` is not terminal: `rcm.claims.poll` looks the send up by key and, only when the partner never received it, sends once more with the same key; recorded in `rcm_appeal_send_resolutions` (`lookup` / `resend_same_key`); the view reports `sent`. New port method `lookupAppeal`.
- C14 consumer reversal re-reads the charge after locking it and maps 23505 to 409 `already_reversed` (no dedicated test: the race needs two distinct reversal events of one charge, which C does not emit).
- Remittance ingest: `ON CONFLICT DO NOTHING` on the reference, so a concurrent ingest dedupes (tested: two parallel ingests answer `ingested` and `duplicate`); a re-ingest whose content digest differs is 409 `remittance_content_changed`.
- The 22 operation-table rows join the negative matrix in B10.
- Contract: `ClaimView.events[].eventRef`, `ClaimWorklist.truncated`, `AdjustmentPost.claimRef`, `RemittanceAdvice` (all in billing.schema.json).

### OpenAPI generator for the billing operation table (batch 4)

- The generator that produced the `BILLING_OPS` block of `docs/api/openapi.yaml` lived in an ignored cache directory. It is now `apps/api/src/billing-openapi.ts` (pure render, extract and splice) plus the CLI `scripts/openapi-billing.ts` (`corepack pnpm run openapi:billing`). The block header names the script.
- The contract drift check renders the block from `BILLING_OPS` and `billing.schema.json` and fails (`generated BILLING_OPS block differs ...`) when the committed block differs: a hand edit, a changed operation or a changed query definition without regeneration.
- Red: `corepack pnpm test -- contract-drift` with the new case before the change → exit 1, 1 failed, 8 passed. Green: exit 0, 9 passed; regeneration changed only the header line (the committed block was already exactly the generator's output).

### B7 follow-up: remittance review-line resolution and workflow policy data

Tests: `tests/integration/rcm-remittance-resolution.test.ts` (5). Red first (operations absent): `corepack pnpm test -- rcm-remittance-resolution` → exit 1, 5 failed. Green: exit 0, 5 passed; billing/rcm/harness/parity/isolation/drift suites → exit 0, 22 files, 984 passed. Migration `20261120110000_rcm_remittance_resolution.sql`.

- `rcm.remittances.resolveLine` (POST `/v1/rcm/remittances/{remittanceRef}/lines/{lineNo}/resolutions`, human `billing.write`): one resolution fact per review line (a rejected one may be followed by another; 409 `line_already_resolved` otherwise; a posted line is 409 `line_not_in_review`). The line row is never edited (tested byte-identical).
  - `match_claim_line` (unmatched lines only; needs `claimRef` + `claimLineNo` of a transmitted claim line of the same payer): the standard checks (amount, underpayment, insurer balance under the charge lock) then the same postings as a matched line.
  - `post_with_adjustment`: the reported paid / contractual / PR plus the residual (billed − reported, never negative: 409 `residual_negative`) as an `adjustment` entry `remittance_residual_adjustment`; pending until another human approves.
  - `write_off`: as above with a `writeOff` entry `remittance_residual_write_off`, only under the latest workflow policy of the payer (or the default) whose `writeOffLimit` covers the residual (409 `write_off_policy_required` / `write_off_limit_exceeded`), rechecked at approval (a lowered limit refuses the approval), and another human's approval.
  - `route_to_appeal`: posts the paid amount only (clearing); the rest stays insurer responsibility and is never moved to the patient (CL-11); the appeal itself is a workflow exception (no denial event exists for an underpayment, so no B6 appeal draft).
- `rcm.remittances.decideResolution` (POST `/v1/rcm/remittance-resolutions/{resolutionRef}/decision`, human `billing.correct`): never the requester (domain and trigger), once (409 `already_decided`), balances and limit rechecked under the charge lock.
- Every posting is a balanced entry tagged with the remittance and linked in `rcm_remittance_resolution_postings`; a remittance reversal reverses them with the rest. The remittance view reports each line's latest `resolution` (`posted | pending_approval | routed | rejected`, derived). A resolved line lets the settlement match the ERA total (tested).
- `rcm.workflowPolicies.publish` (POST `/v1/rcm/workflow-policies`, human `billing.correct`): versioned per payer or tenant default (acknowledgement, payer follow-up and exception due minutes, maximum escalations, residual write-off limit as Money); earlier versions are never changed. The CL workflow reads the same rows.
- RLS binds `created_by`, `requested_by`, `decided_by` to the transaction actor. Remittance helpers (`loadRemittanceForUpdate`, `matchClaimLine`, `insurerOpen`, `postRemittanceLine`) are module exports shared by ingestion and resolution.

### B8 (secondary claims and coordination of benefits; fake clearinghouse only)

Tests: `tests/integration/rcm-secondary.test.ts` (5). Red first (operation absent): `corepack pnpm test -- rcm-secondary` → exit 1, 5 failed. Green: exit 0, 5 passed; billing/rcm/harness/parity/isolation/drift suites → exit 0, 23 files, 990 passed. Migration `20261120120000_rcm_secondary_claims.sql`.

- `rcm.claims.prepareSecondary` (POST `/v1/rcm/claims/{claimRef}/secondary`, body `{coverageRef}`): only from a rank-1 claim whose latest submission is transmitted with a paid adjudication (otherwise retryable 409 `primary_pending`; a denial is 409 `primary_denied`), and whose lines each have a posted, unreversed remittance line (409 `missing_adjudication` / `primary_reversed`). The coverage must be a rank-2 coverage of the account (422 `coverage_not_secondary`; rank 3 is 422 `tertiary_not_supported`); one secondary per primary (409 `secondary_exists`, unique per primary).
- COB evidence: `rcm_secondary_claims` names the primary claim, the primary submission and, per line, the primary remittance lines with paid, contractual and patient-responsibility amounts (by reference), with a digest. Secondary lines bill only the patient responsibility the primary left (never what it paid) and carry the secondary allowance when configured.
- CL-11 (patient not billed for unresolved insurer responsibility): a primary ERA's patient responsibility, when the account has a rank-2 coverage effective on the date of service, posts as a responsibility transfer from the primary to the secondary coverage (`remittance_secondary_pending`), not to the patient. A secondary coverage recorded after the ERA takes the amount from the patient at preparation (`secondary_claim_prepared`). Transmission of a secondary claim moves nothing (the amount is already the secondary's: no double posting, tested by entry count).
- Full lifecycle reuses B6 (readiness incl. its own eligibility, submission, events, remittance; the secondary's PR goes to the patient). A primary remittance reversed after preparation is a readiness issue `primary_reversed` (owner billing): the validation stops being current and submission is 409 `validation_stale`, never a silent resubmission. A secondary's lines are fixed by its evidence (replacement with new procedures is 422 `secondary_lines_fixed`). Procedure holds use rank 2, so the same procedure can be on one primary and one secondary lineage.
- `ClaimView` gains `rank` and `primaryClaimRef`. Not built: coverage swap (re-ranking produces new claims through the ordinary commands; no automatic pair rebuild), tertiary coordination, real COB rules (B-S2).

### Closed-loop claims workflow (CL-01..CL-12), attachment packages and visit preparation

Tests: `tests/integration/rcm-workflow.test.ts` (5) and `tests/scenarios/claims-closed-loop.test.ts` (1). Red first (operations absent): `corepack pnpm test -- rcm-workflow claims-closed-loop` → exit 1 (workflow suite failed to load: `createFakeAttachmentSource` missing; scenario 1 failed: `prepareVisit` missing). Green: exit 0, 6 passed; billing/rcm/harness/parity/isolation/drift/worker/scenario suites → exit 0, 27 files, 1027 passed. Migration `20261120130000_rcm_claim_workflows.sql`.

- Workflow instance (`rcm_claim_workflows`, one per primary claim lineage; the secondary belongs to its primary's workflow): `rcm.workflows.start` (optional standing submission policy and workflow policy version), `rcm.workflows.advance` (unkeyed, idempotent), `rcm.workflows.read`, `rcm.workflows.close` (human `billing.correct`), `rcm.workflows.fireTimer` (service only; worker and REST twin).
- Steps (`rcm_claim_workflow_steps`) link owning-domain facts by reference and never copy or collapse their state machines: claim versions (assembly, correction, attachment version), validations (with input digest), attachment packages, submissions (authority: explicit approval by whom, or standing policy), partner events (transport/payer acknowledgement and rejection, adjudication, denial with code source and version), appeals and reviews, remittance lines and resolutions (second-human authority), the secondary claim (COB evidence digest), settlements, journal entries on the lineage's charges (allocation / patient payment, reversals named), statements (version, snapshot digest), timers and closure. Each step has input versions, authority, outcome, attempt and next expected event; uniqueness on (step, subject, outcome, attempt) makes every observation idempotent.
- Automation (CL-05): only with a standing submission policy, the workflow drives the owned claim work items through the owning commands as the caller (`validate_claim` → validate, `submit_claim` → submit under the policy, `reconcile_submission` / silent payer → poll, open secondary responsibility → prepare the secondary), with deterministic idempotency keys and at most 3 refused attempts per action and claim; those items are not a person's exception until the attempts are spent. Models own no financial state; the workflow never posts money.
- Exceptions (`rcm_claim_workflow_exceptions` + events): one owned exception per underlying issue key (claim work items by kind or readiness code and source; remittance review lines, pending resolution approvals, routed underpayments; open secondary responsibility; unsettled ERA; unbilled patient responsibility (statement due); unapplied credit; silent payer after the policy deadline), with owner, owed-by (practice / patient / payer / platform), reason, source reference and due time; resolved by an event when the issue is no longer observed; a recurrence is a new occurrence.
- Durable timers (CL-08): timer rows plus one outbox event each (`rcmWorkflowTimer`, `next_attempt_at` = due), leased by the outbox worker (new `WorkerDeps.claimWorkflows`, in-process under the worker principal, shared `settleInProcess`). Payer follow-up at submission + `followUpMinutes`; exception escalation at `exceptionDueMinutes`, raised one level per firing up to `maxEscalations` then no further timer (bounded); a firing is recorded once per timer (a redelivery records nothing). Deadlines are workflow policy data (synthetic defaults 1 day / 30 days / 1 day / 2 when no version exists).
- Closure (CL-12): refused (409 `closure_blocked`, naming each charge or exception) while any patient or insurer responsibility is non-zero or any exception is open (unsettled ERA, pending approval and unapplied credit are exceptions); the closure fact stores per charge billed, insurer payment, patient payment, contractual and other adjustments, write-off, net transfers and unresolved (zero), with a digest. No silent write-off: write-offs exist only as approved entries and are listed.
- CL-01 `rcm.visits.prepare` (GET `/v1/rcm/patients/{patientRef}/visit-preparation?serviceDate=`): a read over B5 coverage resolution: per coverage rank, payer, status, eligibility state, freshness and record reference; missing facts with owner (`no_coverage_on_file`, `eligibility_unknown`, `eligibility_stale`, `eligibility_unverified`, `coverage_inactive`); `paymentAssurance: none`.
- CL-04 `rcm.claims.packageAttachments`: a package bound to the head claim version, its object references and their digests (checked against the object source port; I owns the bytes; fake `createFakeAttachmentSource` only); items must equal the version's attachments; a version with attachments is not ready without its package (`attachment_package_missing`, owner clinical); before dispatch every digest is rechecked and an altered original is 409 `attachment_package_stale` with no submission row.
- Fixes found by the scenario: a remittance line now matches the claim's adjudicated (else latest) transmitted version (after a corrected replacement two transmitted versions existed and matching returned none); the fake clearinghouse's `syn-payer-cl-reject-first` payer-rejects version 1 (SYN-RJ-014) and pays a replacement. Test helper `today()` is the location's date (America/New_York): the UTC date failed the clinical not-in-future rule between 00:00 and 05:00 UTC. The hardening crash test now crashes the third transaction (submission gained a package-read transaction before phase 1).

Full `corepack pnpm test` after this task: exit 1, 75 files passed and `clinical-procedures.test.ts` 13 failed, all `dateOfServiceInFuture`: the run crossed 00:00 UTC and that suite's `TODAY` was the UTC date (a time-of-day flake, not a regression). The C test now uses the location's date like `today()`; rerun → exit 0, 13 passed.

Scenario result (synthetic, fake partner): rendered procedure → C14 charge → claim → readiness invalid (`eligibility_not_current`, front office) → eligibility recorded → revalidated → dispatched under the standing policy → transport and payer acknowledgement → payer rejection (`correct_and_replace`) → human corrected replacement → dispatched → paid → ERA 12000 paid / 5000 contractual / 3000 PR (PR to the secondary, patient 0; closure refused) → secondary prepared, validated, dispatched and paid by the workflow → secondary ERA 2000 / PR 1000 → two settlements (a replayed settlement replays) → statement due → statement → cash 1000 allocated → closure (billed 20000 = insurer 14000 + contractual 5000 + patient 1000). 40 steps, 7 automation steps, 13 human-authored facts, 4 exceptions all resolved, 8 journal entries on the charge (one each; three extra advances, a re-ingested ERA and the replays added no step and no entry). Interventions (human commands in the journey): claim preparation, the two policies and the workflow start, the eligibility entry that fixed readiness, the corrected replacement, two ERA ingests, two settlements, the statement, the payment with its allocation and the closure; the workflow drove 3 validations, 3 dispatches, the polls and the secondary preparation.

Not built: exception reassignment and owner-departure handling (exceptions carry an owner role, not a person), pause/resume and cancellation of the workflow, E7 statement delivery and patient follow-up messaging (the workflow stops at `statement` / `patient_payment` facts and the `statement_due` exception), portal-only payer steps, partner-specific deadlines beyond per-payer policy versions, an attachment request from the payer (CL-04 is a placeholder bound to versions).

## Seams for later tasks

- C14: drive `billing.charges.post` as a service principal with the rendered-procedure reference in place of `syn-proc-...` (a new `source` value) and the procedure code once B-S4 settles; one original charge per procedure is already enforced.
- B3 (done; was the seam): installments split with `splitEvenly`/`allocateRemainder` (ADR 0008 M-4); collection through `billing.payments.record` with the plan period in the caller key; a declined attempt is the failed auto-pay fact, an unknown one the blocked state with its reconciliation item; plan balance derived from charge responsibility.
- B4 (statements): `billing.balances.read` with `asOf` is the cutoff balance; `lastPostedAt` after the cutoff makes a statement stale; guarantor aggregation through the S5 guarantor relationship.
- B5 (coverage): `insurer_receivable` lines carry `payer_ref` (`syn-payer-...`); B5 replaces it with a coverage reference (migration adds the column and dimension rule).
- B6/B7 (claims, remittance, CL-10): add insurer payment sources and contractual-adjustment accounts by replacing the account and dimension CHECKs and `billing_check_signs`; remittance lines post insurer payments against `insurer_receivable`; ERA posting never touches `settled_cash` (settlement stays its own command).
- B9 (adjustments, write-offs, reports): `adjustment` and `writeOff` kinds are reserved; reasons and accounts to add; the reads already use the report scopes.
- C12 (estimates): read `rcm.coverages.resolve` (`GET /v1/rcm/patients/{patientRef}/coverage?serviceDate=`) and copy `coverageRefs` as (coverageRef, coverageVersion) pairs plus `coverageStatus` into `EstimateView`; never compute coverage. `paymentAssurance` is always `none`; an estimate with no usable record is `unknown`. `feeScheduleRef` is a synthetic B9 placeholder (B-S4). B does not edit C code; this is the published read.
- B6 (claims): a claim names (coverageRef, coverageVersion) and the eligibility record it relied on; insurer receivable lines already carry the coverage. B8 (secondary/COB): `rank` and effective dates order coverages; secondary eligibility is a separate record.
- E7 (statement delivery): read `billing.statements.read`; deliver only a statement whose `freshness.state` is `fresh` and that is not superseded; a stale one needs a new `billing.statements.generate` (the reissue names the superseded version). Record delivery, print and suppression as E7 events keyed by `statementRef`; never update the statement row.
- E (portal/messaging) and S read plan state through `billing.plans.read` / the plan worklist only; a reminder for a `missing_signature` or `expired_card` item cites the item, it does not evaluate it.
- Scheduler (worker): call `billing.plans.collect` as a service principal for each due period with key `plan:<planRef>:t<terms>:p<period>`; a rerun replays, and the provider key is period-bound regardless of the caller key.
- CL-12 closure: a charge closes only when patient and insurer responsibility are zero by payment, approved adjustment or transfer; the journal already distinguishes allocation, transfer and (later) adjustment kinds, and unapplied credit is a first-class worklist item.

- C12 (coverage status): the billing resolution may now be `inactive` (verified inactive member); C12 estimates should treat it as no expected insurer payment. C code not edited.

- C12 (fees): read `billing.fees.resolve` for the practice fee and the coverage allowance of a SYN- code; never compute a fee. C code not edited.
- Worker deployment: pass the billing service as `WorkerDeps.procedures`; the worker principal needs `outbox.deliver` and `billing.write`.

- I (attachments, CL-04): a claim version holds object references only (`syn-img-`/`syn-obj-`); I supplies the manifest-bound package and its digest; B never stores bytes.
- B8 (secondary/COB): prepare a secondary claim from the same procedures with the secondary coverage after the primary adjudication; the event and remittance facts are per claim.
- CL workflow: the claim worklist items are the owned exceptions; a durable workflow engine can drive validate/submit/poll under a standing policy.

- B8: a remittance line with patient responsibility after a primary adjudication is where a secondary claim starts; B10 adds the parity/negative matrix rows for the BILLING_OPS operations (today covered by their own suites).

## Unresolved

- B6/B7/B9: claims and remittance are fake-clearinghouse only (B-S2 blocked); fee content and code sets synthetic (B-S4); the BILLING_OPS operations are not yet rows of the shared negative harness (their suites test cross-tenant, role, revoked and service-kind denials directly).

- B5: no carrier catalog (unknown payer aliases are just synthetic references); eligibility freshness uses UTC dates; per-group provenance is per record (a later partial record does not merge groups); the overlap rule is domain-only.

- B3: plan collection only by synthetic card (no cash installment link); a payment reversed after an amendment leaves the new basis stale (balance stays exact, the schedule does not re-spread); the plan worklist computes every plan per request (no projection, no performance evidence); due dates are evaluated at query time in the plan's IANA zone.

- Every financial rule awaits a billing/accounting reviewer (pending-decision table above).
- Real payment processor, tokenization and provider refunds: B-S1 blocked-on-discovery.
- Location-scoped financial access, multi-currency, opening balances, adjustment vocabulary.
- The unknown-outcome reconciliation due time (24 hours) and the unapplied escalation default (7 days) are synthetic defaults without a practice policy.
- The worklist is computed per request over the tenant's lines; a reporting projection may be needed at scale (no performance evidence collected).

## Gate runs

- `corepack pnpm run ci` after B2 (uncommitted tree): first run exit 1, 758 passed and 1 failed: `restore-smoke` (e) failed in cleanup with `EBUSY: resource busy or locked, rmdir ...\cuspatlas-backup-cluster2-...\data` (a Windows file lock on the second embedded cluster data directory; no billing code involved; sibling workers were running test suites on the same host). Immediate rerun: exit 0, 37 files, 759 tests, privacy scan, SBOM, evidence and evidence-verify ok. Recorded as an environmental flake, not fixed here.
- `corepack pnpm run ci` after batch 2 and the hardening (uncommitted hardening tree on top of 6ca38d9): exit 0, 41 files, 863 tests, privacy scan, SBOM, evidence and evidence-verify ok (controls unreviewed, not certified).
- `corepack pnpm run ci` after B6/B7/B9 and the B3-B5 hardening (uncommitted B7 tree on top of ee3afea): exit 0, 71 files, 1685 tests passed (13 todo), privacy scan, SBOM, evidence and evidence-verify ok (controls unreviewed, not certified).
- `corepack pnpm run ci` after the B6/B7/B9 review hardening (uncommitted tree on top of 6ee7f65): exit 0, 72 files, 1696 tests passed (13 todo), privacy scan, SBOM, evidence and evidence-verify ok (controls unreviewed, not certified).
