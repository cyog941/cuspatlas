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
| B1 Money and append-only journal | verified on synthetic data (Windows host); decisions pending billing approval | (this commit) | 706 tests |
| B2 Payments, allocations, undistributed funds | not started | | |

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
