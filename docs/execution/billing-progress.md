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
| B5 Coverage, eligibility records, coverage provenance | verified on synthetic data (Windows host); decisions pending billing approval; live eligibility blocked-on-discovery (B-S3); fee schedules B9 (B-S4) | (this commit) | 853 tests |

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

## Unresolved

- B5: no carrier catalog (unknown payer aliases are just synthetic references); eligibility freshness uses UTC dates; per-group provenance is per record (a later partial record does not merge groups); the overlap rule is domain-only.

- B3: plan collection only by synthetic card (no cash installment link); a payment reversed after an amendment leaves the new basis stale (balance stays exact, the schedule does not re-spread); the plan worklist computes every plan per request (no projection, no performance evidence); due dates are evaluated at query time in the plan's IANA zone.

- Every financial rule awaits a billing/accounting reviewer (pending-decision table above).
- Real payment processor, tokenization and provider refunds: B-S1 blocked-on-discovery.
- Location-scoped financial access, multi-currency, opening balances, adjustment vocabulary.
- The unknown-outcome reconciliation due time (24 hours) and the unapplied escalation default (7 days) are synthetic defaults without a practice policy.
- The worklist is computed per request over the tenant's lines; a reporting projection may be needed at scale (no performance evidence collected).

## Gate runs

- `corepack pnpm run ci` after B2 (uncommitted tree): first run exit 1, 758 passed and 1 failed: `restore-smoke` (e) failed in cleanup with `EBUSY: resource busy or locked, rmdir ...\cuspatlas-backup-cluster2-...\data` (a Windows file lock on the second embedded cluster data directory; no billing code involved; sibling workers were running test suites on the same host). Immediate rerun: exit 0, 37 files, 759 tests, privacy scan, SBOM, evidence and evidence-verify ok. Recorded as an environmental flake, not fixed here.
