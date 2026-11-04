# Billing and RCM execution ledger (workstream B)

Branch: `codex/b-billing-1` in an isolated worktree outside the OneDrive-synced checkout. Base SHA: `2e7d61a` (foundation, S4-S11 and the practice-time requirements). Sibling worktrees build S12-S17 and C; this branch touches only `packages/domain/src/billing/**`, its contracts, transports, migrations, tests and append-only lines in shared registries. Status values: not started, in progress, blocked with cause, verified. Nothing is prechecked.

Authorization basis: user instruction to build every backend workstream on synthetic data until only the UI phase remains. Scope of this batch: B1 (Money and the append-only journal) and B2 (payments, allocations and undistributed funds).

## Financial-safety framing

- Financial rules need billing/accounting reviewer validation, which was not available. Every rule below is implemented against the plan's recommended option and marked **recommended-pending-billing-approval** in [ADR 0008](../adr/0008-money.md). Nothing here is approved, validated, compliant or deployed, and no balance, statement or claim produced by this code may be shown to a real practice.
- No real payment processor (B-S1 is blocked-on-discovery). Payment capture is a recorded fact from a synthetic in-process provider or from manual entry. No card data, PAN or provider token exists anywhere; the only instrument is a synthetic opaque reference (`syn-card-...`).
- Money is `{currency, minor}` integer minor units (SHARED-CONTRACTS), never floats; arithmetic only through the shared helpers; explicit rounding rule (largest remainder, lower-index tie-break).
- Synthetic data only. The privacy marker never reaches logs, refusals, audit, outbox, attempts, idempotency, sensitive-read or billing rows: every caller-supplied billing string is a closed pattern (lowercase synthetic references, reason codes, synthetic placeholder codes), so free text cannot be stored at all.

## Batch status

| Task | Status | Head SHA | Notes |
|---|---|---|---|
| B1 Money and append-only journal | verified on synthetic data (Windows host); decisions pending billing approval | a342b6d | 706 tests |
| B2 Payments, allocations, undistributed funds | verified on synthetic data (Windows host); decisions pending billing approval; provider execution blocked-on-discovery (B-S1) | (this commit) | 759 tests |

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

## Seams for later tasks

- C14: drive `billing.charges.post` as a service principal with the rendered-procedure reference in place of `syn-proc-...` (a new `source` value) and the procedure code once B-S4 settles; one original charge per procedure is already enforced.
- B3 (payment plans): installments split with `splitEvenly`/`allocateRemainder` (ADR 0008 M-4); collection through `billing.payments.record` with the plan period in the caller key; a declined attempt is the failed auto-pay fact, an unknown one the blocked state with its reconciliation item; plan balance derived from charge responsibility.
- B4 (statements): `billing.balances.read` with `asOf` is the cutoff balance; `lastPostedAt` after the cutoff makes a statement stale; guarantor aggregation through the S5 guarantor relationship.
- B5 (coverage): `insurer_receivable` lines carry `payer_ref` (`syn-payer-...`); B5 replaces it with a coverage reference (migration adds the column and dimension rule).
- B6/B7 (claims, remittance, CL-10): add insurer payment sources and contractual-adjustment accounts by replacing the account and dimension CHECKs and `billing_check_signs`; remittance lines post insurer payments against `insurer_receivable`; ERA posting never touches `settled_cash` (settlement stays its own command).
- B9 (adjustments, write-offs, reports): `adjustment` and `writeOff` kinds are reserved; reasons and accounts to add; the reads already use the report scopes.
- CL-12 closure: a charge closes only when patient and insurer responsibility are zero by payment, approved adjustment or transfer; the journal already distinguishes allocation, transfer and (later) adjustment kinds, and unapplied credit is a first-class worklist item.

## Unresolved

- Every financial rule awaits a billing/accounting reviewer (pending-decision table above).
- Real payment processor, tokenization and provider refunds: B-S1 blocked-on-discovery.
- Location-scoped financial access, multi-currency, opening balances, adjustment vocabulary.
- The unknown-outcome reconciliation due time (24 hours) and the unapplied escalation default (7 days) are synthetic defaults without a practice policy.
- The worklist is computed per request over the tenant's lines; a reporting projection may be needed at scale (no performance evidence collected).

## Gate runs

- `corepack pnpm run ci` after B2 (uncommitted tree): first run exit 1, 758 passed and 1 failed: `restore-smoke` (e) failed in cleanup with `EBUSY: resource busy or locked, rmdir ...\cuspatlas-backup-cluster2-...\data` (a Windows file lock on the second embedded cluster data directory; no billing code involved; sibling workers were running test suites on the same host). Immediate rerun: exit 0, 37 files, 759 tests, privacy scan, SBOM, evidence and evidence-verify ok. Recorded as an environmental flake, not fixed here.
