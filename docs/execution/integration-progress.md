# Backend integration ledger (foundation F + workstreams S, C, E, I, B)

Branch: `codex/backend-integration` in the isolated worktree `src/cuspatlas-c1` (outside the OneDrive-synced checkout). Base: `0c93aa9` (C final, which contains S final `0c8cfdf` and F). Authorization basis: the user instruction to build every backend workstream on synthetic data until only the UI phase remains. Synthetic data only; no Supabase cloud, no host installs, nothing pushed. Nothing here is approved, deployed, compliant or clinically validated; clinical and legal semantics stay recommended-pending-approval exactly as each workstream ledger records them.

Integration migrations are numbered `20261125*`, after I (`20261111*`-`20261113*`) and B (`20261120*`), which reuse no integration version.

Status values: not started, in progress, blocked with cause, verified (on synthetic data, Windows host, `corepack pnpm run ci` exit 0).

## Status

| Step | Status | Commit | Notes |
|---|---|---|---|
| 1. Merge `codex/e-portal-1` (a2966ef) | verified | merge commit | 16 conflicted files, all resolved keeping both behaviours; combined S+C+E import |
| 2. Integration seams (E4 to C8, E2 `clinical_read`, E attachment port, E6 over C14) | verified (E4 to C8, E6 over C14); E2 documents and E attachments recorded as ports | step 2 commit | migration `20261125000000` |
| 3. S-table relink guard | verified | step 3 commit | migration `20261125010000` |
| 4. Keyed idempotency payload digest | verified | step 4 commit | migration `20261125020000` |
| 5. Merge `codex/i-imaging-1` (4bf86c5) | verified | merge commit | 22 conflicted files; merge-registry mirror gains `imagingAssociation` (`20261125030000`) |
| 6. I seams (C15 and E resolvers to I3, S+I+C+E import) | verified | step 6 commit | no migration |
| 7. Merge `codex/b-billing-1` (344256f) | verified | merge commit | 11 conflicted files |
| 8. B seams (C12 fees and coverage, CL-04 to I3, five-way round trip) | C12 and CL-04 done; five-way round trip open | | |

## 1. Merge of codex/e-portal-1

Conflicts (both sides kept unless stated):

- Registries and wiring: `packages/contracts/package.json` (clinical and engagement schema exports), `packages/contracts/src/context.ts` (C and E security reason codes), `packages/domain/src/commands/execute-once.ts` (C and E replay codecs), `apps/api/src/app.ts`, `apps/api/src/routes/manifest.ts`, `apps/api/src/contract-drift.ts` (clinical and engagement schema files, refs, closed-body checks), `apps/mcp/src/server.ts` and `apps/mcp/src/tools/synthetic-tasks.ts` (C and E services, tools and known properties), `tests/integration/support/appointment-fixtures.ts` (harness takes `imageRefResolver`, `attachmentRefs` and `portal`).
- Shared work-item model: `WorkItemKind` and its JSON Schema enum carry S, C (lab returns, referrals) and E (delivery exception, intake review, message awaiting reply) kinds.
- Merge registry: `MERGE_EXCLUDED_REFERENCES` carries the C origin/signer exclusions and the E exclusions (portal principals, consent facts, decisions, recall enrollments, contact verifications, intake submissions and review items, threads, call links, outbound messages). `MERGE_RECORD_CLASSES` is unchanged by E, so the SQL mirror (`merge_class_table`, 13 classes) needs no change; the pinned registry test passes.
- Docs: `docs/SHARED-CONTRACTS.md` (C and E scope registrations), `docs/execution/foundation-contract-decisions.md` (C and E task records).
- Tests: `tenant-isolation.test.ts` (runtime-role table list: union, sorted); `notification-separation.test.ts` keeps E's version (consent statements only from E6's decision module, exact list of E consent tables) and excludes C13 `clinical_consent*` tables, which are clinical records, not communication consent; `portal-intake.test.ts` no longer asserts that no clinical table exists (C8 is deployed here); it asserts that the hand-off wrote no clinical history for the patient.

Semantic fixes needed by the combination (no conflict markers):

- Name clash: C and E both exported `CONSENT_RESOURCE`; E's is now `COMMUNICATION_CONSENT_RESOURCE` (value unchanged, `communicationConsent`).
- E6 recall enrollment over the S16 completed-procedure basis (C added the basis, E consumes `recallDueFor`): `recallDueFor` takes the C14 reader and the caller's `clinical.procedures.list`, refusing such a policy without that scope (as `scheduling.recall.due` does) and returning `basis_unavailable` without the reader; `EngagementDeps.completedProcedures` is wired to `readLatestCompletedProcedures` in API and MCP. The enrollment list joins the qualifying event as an appointment or a C14 rendered procedure (location from its encounter).
- One import path (`packages/db/src/export-import.ts`, `importExports(pool, tenant, docs, { verifyNoteDigests })`): S17, C18 and E9 documents in one transaction, loaded in the platform order S, C, E whatever order they are given in (`IMPORT_ORDER`), S and E foreign keys validated across documents, C tables with C18's stricter tenant/membership check, C18 invariants and note digests (verifier required with a C18 document). `importSchedulingExport` and `importClinicalExport` are thin wrappers. The S17 document no longer imports without the E9 document once a booking has an E6 decision (S intents reference E decisions), so the C18 tests import S with its E companion.
- New test: `clinical-export.test.ts` "S17 + C18 + E9 import in one call": verifier required, a cross-document orphan rolls back all three documents, duplicates refused, reverse-order import succeeds and all three exports round-trip identically.

Gate: see the commit message of the merge for the run counts.

## 2. Integration seams

- E4 medical-history hand-off to C8 (wired). C8 exposes no proposal queue: history enters the record only as a clinician's own `clinical.history.recordChange` (structured items; free text cannot be mapped automatically without clinical judgment). The seam is therefore "record, then close": the clinician records the change with provenance `patient_reported` and `sourceRef` `intake-submission:<submission>`; `intake.reviews.resolve` with `apply` on a hand-off then names that version (`historyVersionRef` in the result, `applied_history_version_id` on the item, resolution `recorded_in_clinical_history`). Without such a version: 409 `clinical_history_not_recorded` with alternative `clinical.history.recordChange` (replaces E's `c8_not_deployed`); without `clinical.history.read`: 403. Nothing is copied from the submission; the proposal stays `{}`. Migration `20261125000000_integration_intake_history_handoff.sql`: column with composite FK to the C8 version, the E4 CHECK "a hand-off is never applied" relaxed to "applied only with a C8 version", and the review-item guard checks the version is a patient-reported version of the item's own patient recorded from the item's own submission. Worklist suggestion `record_in_clinical_history` (was `hold_for_c8`). Recommended-pending-clinical-approval. Tests: `portal-intake.test.ts` (refusal, wrong-source version, 403, apply, DB binding under the runtime role: 42501 for another submission's version, 23514 without a version; reject still available).
- E6 recall enrollment over S16's completed-procedure basis (wired in the merge, tested here): `integration-seams.test.ts` (procedure-due patient enrolled, listed with the procedure as last event, other code `no_baseline`, 403 without `clinical.read` for enroll and list).
- E2 portal `clinical_read` view (`documents`): kept `unavailable` (owner C15). C exposes no patient-facing projection: every C read is a staff sensitive read, and C15 stores opaque `imageRef`s whose documents live in I. Revisit in Phase 2 when I3 reference reads exist and a patient-facing document projection is specified.
- E `AttachmentRefResolver`: kept as a port (fail closed) until I merges (wired in step 6).
- Test-only fix carried with this step: `clinical-procedures.test.ts` and `clinical-review-hardening-c12.test.ts` computed TODAY as the UTC date while the server checks the date of service in the location zone (America/New_York), so 21 C14 tests failed between 00:00 and 05:00 UTC; TODAY is now the New York date.

## 3. S-table relink guard

Gap reported by C: the S record classes of the merge registry had no database relink guard. Migration `20261125010000_integration_s_relink_guard.sql` adds `merge_reference_relink_guard(column)`, the column-parameterised form of C's `clinical_subject_relink_guard` (as hardened by `20261109100000`: forward relink only with an unreversed merge of that pair recorded and observed in the same transaction that lists the record and column; reversal relink only with the reversal recorded and observed in the same transaction, a listed move, and no later merge of the record), as deferred constraint triggers on every S class of `MERGE_RECORD_CLASSES`: `patient_relationships.subject_patient_id` and `.counterparty_patient_id`, `appointment_requests`, `appointments`, `appointment_series`, `waitlist_entries` (`subject_patient_id`). Bound to the runtime role `cuspatlas_app` (the C guard scope assumption); privileged roles can disable triggers in any case. The excluded S reference `recall_tasks.subject_patient_id` never moves under the runtime role. The existing S6 observation triggers (`20261109050000`) and the moves-cover guard already applied to these tables.

Tests (`s-relink-guard.test.ts`, runtime role, committed so deferred checks run): per class, a bare relink to the survivor or a stranger is refused (42501), the real merge and unmerge relink, a bare move back after a merge is refused, and after merge/unmerge/merge a bare relink cannot borrow the old reversal; the trigger set equals the S classes; a recall task's patient cannot be moved and a real merge leaves it in place. Without the migration all 8 tests fail (checked).

## 4. Keyed idempotency payload digest

Platform finding held earlier: `command_idempotency.payload_digest` was an unkeyed SHA-256 over canonical JSON that can contain low-entropy PHI (allergen names, contact values), so it could be confirmed by guessing. Now (scheme 2) it is HMAC-SHA-256 under a dedicated server secret `CUSPATLAS_IDEMPOTENCY_DIGEST_KEY` (base64, at least 32 bytes; read by `apps/api/src/server.ts`, `AppDeps`/`McpServerDeps.idempotencyDigestKey`) over a purpose label, the tenant id and the canonical JSON (`idempotencyPayloadDigest`). A dedicated key rather than the match-key pepper, so the two secrets rotate independently. `resolveIdempotencyDigestKey`: the test-only key `SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY` is used when none is configured under synthetic-test and is refused elsewhere; outside synthetic-test a key is required. The API and MCP builders resolve the key for their environment and run `createDurableExecutor(key)` for every service (the key is required outside synthetic-test even when a test injects its own executor; MCP refusal tests in `mcp-parity.test.ts`). The fallback `executeOnce` of a domain service built without an executor uses the process key (`configureIdempotencyDigestKey`; a second, different key in one process is refused) and fails closed without one. Integration tests set the test key in a vitest setup file (`tests/integration/support/idempotency-key-setup.ts`) because some build domain services directly.

Comparison semantics are unchanged (equal canonical payload within a tenant and key, equal digest). Migration `20261125020000_integration_idempotency_digest_key.sql` adds `payload_digest_scheme` (existing rows 1, new rows 2): legacy scheme 1 rows (synthetic only) are still compared by their own unkeyed scheme until they expire (7 days, purged by maintenance); a takeover rewrites them as scheme 2. Action proposals keep the unkeyed digest: the payload is stored beside it and the client submits it for approval.

Tests: `idempotency.test.ts` (stored digest differs from a plain SHA-256 of the payload and equals the tenant-bound HMAC; tenant binding; replay and conflict unchanged; a legacy scheme 1 row conflicts on another body and is taken over as scheme 2 with the same body; existing raw-row tests use the keyed digest), `digest.test.ts` (HMAC properties, key resolution and refusals, fail-closed without a key, no second key).

## 5. Merge of codex/i-imaging-1

Conflicts (both sides kept): `PrincipalKind` is `human | service | portal | device` (E's portal and I's device; the DB constraints already listed both) and the audit-event schema enum agrees; the tenant transaction rechecks a portal principal's live enrolment and a device principal's live device row instead of a membership; schema exports, contract-drift checks (clinical, engagement and imaging schema files and closed-body checks), routes, MCP tools and known path parameters, reason codes, action policies, replay codecs (`ALL_CODECS` now includes `IMAGING_REPLAY_CODECS`; I's service runs the keyed durable executor like every other), server env (idempotency key and I's object store, token secret and bridge key), runtime-role table list, MCP tool list, restore-smoke cleanup retries (I's stabilised values), docs. `docs/api/openapi.yaml` (34 hunks, generated blocks interleaved) was rebuilt as the integration version plus I's generated imaging block and `deviceAssertion` scheme, verbatim; the drift check passes.

Merge registry: I added `imagingAssociation` (`imaging_match_decisions.subject_patient_id`) to `MERGE_RECORD_CLASSES` on a base without C's SQL mirror. Migration `20261125030000_integration_imaging_merge_registry.sql` restates `merge_class_table` and `merge_class_digest_exclude` with all 14 classes and adds the S6 observation trigger on the decision's patient (I keeps its own relink guard from `20261111050000`); the regression pin passes.

Test fix: `portal-requests.test.ts` asserted every table whose name contains `request` is an appointment-request table; I8's `imaging_deletion_requests` is excluded by prefix.

## 6. I seams

- C15  and E5  are implemented over I3's consumer reference read  (now exported from the imaging module) in  and wired by default in the API and MCP builders (a test may still inject a double). C's port now passes the expected patient (the encounter's patient when linking, the link's patient when reading). Mapping: missing, malformed or other-tenant reference ->  (C) / not attachable (E); object not  ->  (); unassociated -> ; otherwise  with the decision as  (C compares the patient itself: ). E accepts an attachment only when  is true; an  is checked through its latest imageRef (none -> refused).
- One import order S, I, C, E:  loads I9 documents (content key re-derived from the digest as in I's importer);  is a wrapper; bytes still go through .
- Tests (, real I stack and object store): C15 links its own patient's current imageRef, 409  for another patient's, 404 for an unknown one; under a beta tenant transaction an alpha imageRef is  and not attachable by imageRef or objectRef; E5 staff thread attaches the patient's image by imageRef and objectRef and refuses another patient's; S17 + I9 + C18 + E9 exported, imported in reverse order plus blobs into a fresh database and store, all four exports identical, and the imported link resolves  through I3 in the target.
- E2  view: still ; a patient-facing document projection needs a specification (which images a patient may see, grants) and is not invented here.

## 7. Merge of codex/b-billing-1

Merged at 99d7da6 and completed to 344256f (B8/CL/B10 review fixes, migration 20261120140000) before committing; one merge commit. B already contained S and C up to 4fbde64. Conflicts (both sides kept): billing, clinical, engagement and imaging schema exports, contract-drift (billing ref prefix in the same ternary chain as clinical, engagement and imaging; B's generated-block check kept), API, contracts and db index exports (B's  and  beside the integration modules), MCP path parameters, replay codecs ( in ; B's service runs the keyed durable executor like every other), runtime-role table list, task records. B's  helper in  is the same New York date fix and was taken. : B's histogram diff is additions only (info line, generated  block, two component blocks); applied to the integration version; the drift check passes.

Test fixes: `portal-requests.test.ts` also excludes `billing_`/`rcm_` tables from the appointment-request check; `clinical-parity.test.ts` (C's parser of the negative-harness COMMANDS table) now reads B's spread of `[operation, tool, ...]` tuples instead of refusing it.

## 8. B seams

### 8.1 C12 estimates -> B9 fees and B5 coverage

- Port `ClinicalDeps.estimatePricing` (`packages/domain/src/clinical/estimate-pricing.ts`), implemented by `createBillingEstimatePricing()` in `packages/domain/src/integration/estimate-pricing.ts` over B9 `resolvePracticeFee` and B5 `coverageSummariesFor` (extracted from `rcm.coverages.resolve`, `eligibilityOf` moved to module level). Injected in the API and MCP builders and the domain test harness; absent, estimate generation is refused typed (`fee_source_unavailable`), never priced from client input.
- Each line's fee is the B9 practice fee for the item's `procedure_code_ref` on the service date (today in the plan version's encounter location IANA zone, else UTC; location schedule before tenant-wide). Line `fee` is optional: a supplied fee that differs, or one for an item B9 does not price, is `409 fee_mismatch`. An item with no configured fee is left unpriced (`itemsWithoutFee`, estimate incomplete, no amount). Each line records `feeScheduleVersionRef`; the estimate header records the single version (null when lines span versions). A caller `feeScheduleVersionRef` is a pin: a different resolved version is `409 fee_schedule_version_mismatch`.
- `CoverageStatus` gains `inactive` (contracts, `clinical.schema.json`, migration `20261125040000_integration_estimate_pricing.sql` replacing both unnamed CHECKs found by a DO block, plus the nullable line version column). B5 `inactive` gives range low = high = gross with basis `coverage_inactive` (no insurer portion); B5 `stale` gives `stale`; otherwise the entered sources decide as before. A B5-decided `inactive`/`stale` stays on read. `notAGuarantee` unchanged.
- Tests: `tests/integration/integration-estimate-pricing.test.ts` (6: server fee and version, mismatch 409 writing nothing, missing fee incomplete, new fee version reprices and pin refused, inactive no insurer portion, stale). Red: 6 failed, exit 1; green: 6 passed. Existing C12 tests seed B9 through `tests/integration/support/fee-fixtures.ts` (`seedPracticeFees`) and assertions that relied on caller fees were updated (EUR/mixed caller fees now `409 fee_mismatch`). `corepack pnpm run ci` exit 0: 125 files, 2830 tests.
- Not done: no insurer portion is computed from B5 benefits or B9 allowances (`resolveAllowance`); the estimate still shows a bounded range only.

### 8.2 B CL-04 attachment packages -> I3

- `AttachmentSourcePort.digestOf(tx, objectRef, expectedPatientRef)` now runs in the caller's tenant transaction with the claim's patient. `createImagingAttachmentSource()` (`packages/domain/src/integration/imaging-refs.ts`) is built on `imageReferenceOrNull`: it returns I3's `digestSha256` only when `matchesExpected` and the object is `available`, else null (another patient, another tenant under RLS, missing or malformed). Wired into the API and MCP billing builders; the fake source keeps `syn-img-`/`syn-obj-` for domain tests.
- `packageClaimAttachments` checks each digest inside its `FOR UPDATE` transaction; `submitClaim` rechecks the head package inside the locked dispatch transaction (no `withTimeout` outside a transaction any more). The B contract `ObjectRef` and the `rcm_claim_attachments` / `rcm_claim_attachment_package_items` CHECKs (migration `20261125050000_integration_claim_attachments_i3.sql`, unnamed CHECKs found by a DO block) accept an I3 imageRef uuid as well as the synthetic forms.
- Tests: `tests/integration/integration-claim-attachments.test.ts` (4: happy path with a real I3 image packaged and submitted; another patient's image refused with its true digest; I3 digest changed between package and submit refuses dispatch with no submission row; another tenant, made-up and synthetic refs read no digest). Red: suite failed to load (port not exported), exit 1; green: 4 passed. `corepack pnpm run ci` exit 0: 126 files, 2834 tests (a first run hit four 120 s beforeAll hook timeouts under load in suites unrelated to this change; those four passed alone and the full rerun passed).

## Open items

Status 8 (B seams): C12 and CL-04 are wired; the remaining items stay recorded here so the next step is explicit:

- C12 estimates -> B9 fees and B5 coverage: done (section 8.1). Open: no insurer portion from B5 benefits or B9 allowances.
- B CL-04 attachment packages -> I3: done (section 8.2).
- Five-way export round trip: done, see section 8.4.
- Worker: done, see section 8.5.
- E2 portal  () stays  until a patient-facing document projection is specified.
- Nothing here is approved, deployed, compliant or clinically validated; all workstream decisions stay as their own ledgers record them.

## 8.3 No implicit billing fakes (item 3)

`createBillingService` no longer falls back to the fake payment processor or clearinghouse. A missing adapter disables only the dependent operations with `503 service_unavailable`, reason `adapter_not_configured`, naming the adapter, before any write. The API and MCP builders construct fakes only under `CUSPATLAS_ENV=synthetic-test` and otherwise log `alert: adapter_not_configured` at build. Test: `tests/integration/billing-adapter-config.test.ts` (red: 2 failed, a development app captured a card through a fake; green: 3 passed).

Verification (orchestrator, 2026-11-05): full `corepack pnpm run ci` on the working tree, under reduced load: 126 of 127 files, 2836 of 2837 tests. The single failure (`rcm-review-hardening-b6b9`, crash-left submission reconciled after its deadline) passed 11/11 twice when run alone, so it is load timing, not this change. Earlier full runs by the worker failed only on hook timeouts while four other worktrees ran suites concurrently. The final integration run reconfirms.

## 8.4 Five-way export import (S, I, C, E, B)

- `importExports` (`packages/db/src/export-import.ts`) now knows B10 as the last format: platform import order S17, I9, C18, E9, B10 in one transaction (replica role). B rows are converted back to integer minor units before anything is written (a malformed amount is refused up front); after the S/I/E foreign-key validation and C18's checks, B's own checks run on the same transaction: every billing/rcm foreign key (tenant-blind single-column keys must name a parent of the same tenant), the tenant currency, the trigger-enforced invariants the replica role skips, and the database's journal check of every entry (`verifiedEntries`). Any failure rolls back every document of the call.
- `importBillingExport` (`packages/db/src/billing-import.ts`) is a thin wrapper (`importExports(pool, tenant, [doc])`); its checks are exported (`billingRowFromExport`, `assertBillingReferences`, `assertBillingCurrency`, `assertBillingTriggerInvariants`, `assertBillingLedger`) and used by `importExports`. `billing-export.test.ts` passes unchanged.
- Test (`tests/integration/integration-imaging.test.ts`, red first: `Unsupported export format`, exit 1): the source stack also gets a B chain (fee schedule, coverage and fake eligibility, encounter with a provider, rendered procedure, charge by the C14 consumer twin, claim prepared/validated/submitted/polled through the fake clearinghouse, ERA ingested and settled, cash payment allocated to the charge). All five exports are taken; a B document with one unbalanced journal line is refused with the other four (`journal invariant`) and the target has no S patient and no journal entry afterwards; then all five (given in reverse order) plus blobs are imported, `verifiedEntries` equals the exported entries, and all five re-export identically. `clinical-export.test.ts` pins the five-entry `IMPORT_ORDER`.
- Gate: `corepack pnpm run ci` exit 0, 124 files / 2824 tests.

## 8.5 Worker entry point

- `apps/worker/src/main.ts` (root script `start:worker`) runs `composeWorker` (`apps/worker/src/compose.ts`, exported from `@cuspatlas/worker`) and ticks until SIGINT/SIGTERM; the tick in progress completes, then the pools it opened close. The worker package now depends on `@cuspatlas/db` and `pg` (pinned `8.23.1`, lockfile updated by an offline workspace install).
- Boot mirrors the API: `CUSPATLAS_ENV` must be known; `resolveMatchKeyPepper`, `resolveIdempotencyDigestKey`, `resolveImagingTokenSecret` and `resolveBridgeSigningKey` resolve the secrets before any connection (test-only values and a missing pepper or digest key are refused outside synthetic-test); database names must be synthetic; `CUSPATLAS_WORKER_PRINCIPAL_ID` and `CUSPATLAS_WORKER_TENANT_IDS` (explicit list, no cross-tenant listing) are validated. Fake providers (delivery adapter, messaging, clearinghouse, processor) can be supplied only in-process (`syntheticProviders`) and are refused outside synthetic-test; no real provider exists, so from the command line those consumers log `worker_consumer_disabled` with a reason.
- Per tick and tenant, under the worker principal (authorized freshly by the domain): F6 outbox with proposal execution and C14 -> B procedure consumption (always on), CL-08 claim workflow timers (only with a clearinghouse) and adapter delivery (only with an adapter; without one, `leaseAggregateTypes` restricts the lease to the in-process aggregates, so nothing burns attempts waiting for an adapter); E7 outbound messages (only with a messaging port); `imaging.storage.reconcile` (only with an object store: integrity sweep, abandoned ingress and staging, I7 bridge lease sweep, expired device nonces); then maintenance on `CUSPATLAS_MAINTENANCE_DATABASE_URL` (idempotency purge, patient-reference observation prune; disabled without it). A failing stage is reported by kind and does not stop the others.
- Test (`tests/integration/worker-main.test.ts`, red first: `composeWorker is not a function`, exit 1): booted in-process against the test database and a per-run object store with the test fakes, the composition delivers one synthetic task through the adapter, sends one E7 reminder through the fake messaging provider, consumes one rendered procedure (by the worker principal), fires one payer follow-up timer and requeues one bridge job whose lease ran out; later ticks only settle events created meanwhile (no event or message settled twice) until one does nothing, and the bridge job is not touched again. Without providers the three sending consumers are disabled with a reason and a synthetic-task event stays `pending` with attempt 0. Under `CUSPATLAS_ENV=development` boot refuses each test-only secret, a missing pepper, an unknown environment and fake providers; a missing principal, a malformed tenant list and a non-synthetic database name are refused. `run()` stops on abort.
- `docs/runbooks/development.md`: the worker section and every variable (`CUSPATLAS_IDEMPOTENCY_DIGEST_KEY`, `CUSPATLAS_MATCH_KEY_PEPPER`, `CUSPATLAS_IMAGING_TOKEN_SECRET`, `CUSPATLAS_BRIDGE_SIGNING_KEY_PEM`, `CUSPATLAS_OBJECT_STORE_DIR`, worker variables, audiences) with placeholders only.
- Open: real adapters and their selection are blocked on E-S1 and the B partner/processor decisions; fakes reach the worker only through `syntheticProviders` under synthetic-test, consistent with the API refusing implicit fakes (section 8.3); the worker's maintenance role is a deployment decision (ADR 0002). Nothing here is deployed.
- Gate: `corepack pnpm run ci` exit 0, 125 files / 2830 tests.

## 9. Round 2 merges (integration 2)

### 9.1 integration-ops (merge 320fbf8)

Only this ledger conflicted; both sides kept (sections 8.4, 8.5). The worker already builds `createBillingService` with a clearinghouse or processor only from `syntheticProviders` (refused outside synthetic-test), so it matches the API's `adapter_not_configured` behaviour. Tests: worker-main, billing-adapter-config, integration-imaging, clinical-export, billing-export (28 passed).

### 9.2 a-api-1 (A4 catalog, A5 change control, A7 forbidden matrix)

No textual conflicts. `catalog:generate` against a-api-1's baseline refused three CL-04 input patterns (`rcm.appeals.draft`, `rcm.claims.attach`, `rcm.claims.packageAttachments`) as "pattern changed": section 8.2 widened `^syn-(img|obj)-…$` to `^(syn-(img|obj)-…|<uuid>)$`. That is a pure widening, so the A5 classifier (`packages/contracts/src/catalog/change-control.ts`, `patternWidens`) now treats a change as additive only when every alternative of the fully anchored old pattern is a top-level alternative of a fully anchored new one (one group spanning the body, `(…)` or `(?:…)`); anything else stays breaking. Test added to `tests/integration/api-change-control.test.ts` (widening additive; dropped alternative, unanchored alternation, non-spanning group and dropped end anchor breaking). Catalog regenerated: 355 operations; client regenerated. Tests: the six api-* suites plus billing-adapter-config, claim attachments, estimate pricing, worker-main (68 passed).

### 9.3 or-engagement (E10 needs-reply queue)

No conflicts. Brings `packages/contracts/src/list-envelope.ts` (OR-01 `ListEnvelope`) and migration `20261127100000_needs_reply_queue.sql`. Catalog regenerated: 357 operations. Tests: needs-reply-queue, engagement-negative-harness, tenant-isolation, api-catalog/mcp-parity/forbidden/scopes/change-control, reply-due (231 passed).

### 9.4 or-scheduling (S18, S20, S21, S22) and one OR-01 envelope

No textual conflicts. Envelope unification:
- TypeScript: the local `ListEnvelope` in `packages/contracts/src/scheduling.ts` is removed; S imports the shared one from `list-envelope.ts` (its `appliedFilters` widened to `Record<string, unknown>` because S filters include lists such as `weekdays`). The S scope kind `explicit_locations` became the shared `location_set` (domain availability/floor/staging and their tests).
- JSON Schema: `LIST_ENVELOPE_SCHEMA_DEFS` in `list-envelope.ts` is the single source of the `ListEnvelope`, `ListScope`, `ListOrdering`, `ListCount` `$defs`; `engagement.schema.json` and `scheduling.schema.json` carry them verbatim (schema files are self-contained, so copied, not cross-file `$ref`). Merged choices: ordering key pattern `^[A-Za-z.]{1,64}$` (S uses dotted keys); `limit` minimum 1 without E10's output maximum 100; `asOf` date-time; `nextCursor` string or null; scope `locationRefs` at most 200 slugs. E10's `ThreadList.data` keeps the flattened envelope shape but its envelope properties equal the shared ones. `tests/integration/list-envelope-conformance.test.ts` fails on any copy that differs, any other schema defining its own, an S list not referring to `ListEnvelope`, or E10 drifting.
- Export: the five new S tables (`scheduling_staging_lists`, `scheduling_staging_entries`, `scheduling_provider_requests`, `scheduling_staff_presence`, `appointment_patient_reassignments`) were appended to `SCHEDULING_EXPORT_TABLES` in FK order, so S17 and the five-way round trip cover them. The E10 tables (`messaging_reply_policies`, `thread_read_receipts`, `thread_reply_escalations`) are not in the E9 export: read receipts are readable only by their own principal under RLS, so an export would be partial; recorded as open.
- Tenant isolation list already had every new table, alphabetical.
- Catalog regenerated: 370 operations. Tests: 17 affected files, 842 passed.

### 9.5 m-migration-1 (M2-M6)

Conflicts: `packages/contracts/src/index.ts` (both exports kept), `tenant-isolation.test.ts` (both table sets, alphabetical: `messaging_reply_policies` before the `migration_*` tables), `negative-harness.test.ts` (S20/S21 fixtures and `seedMigrationHarness` both kept in one fixture object). Catalog wiring the M branch predated: owner workstream `M` (`OwnerWorkstream`, `OWNERS.migration`, docs owner list), schema prefix `migration` -> `migration.schema.json` in `scripts/catalog/schemas.ts`, and the scopes `migration.read`, `migration.write`, `migration.signoff` registered in `docs/SHARED-CONTRACTS.md` (Roles and scopes). The A1 representation gate flagged `sourceId` / `guarantorSourceId` as bare entity ids; they are the source system's own identifiers kept verbatim as provenance, so they join `NON_ENTITY_ID_FIELDS` with that reason (like `providerEventId`). `openapi:migration` rewrote the 14 M operations unchanged. Catalog regenerated: 384 operations. Tests: 16 affected files (M suites, negative harness, tenant isolation, mcp parity, api-* gates, five-way, billing export, reassignment), 871 passed after the exemption.

Five-way export decision: M tables (`migration_source_profiles`, `migration_packages`, `migration_staged_records`, `migration_review_items`, `migration_applied_records`, `migration_opening_items`, `migration_reports`, `migration_signoffs`) are not part of the S, I, C, E, B round trip. They are the migration workspace and its sign-off evidence, owned by M, not a domain fact other workstreams re-import. Consequence recorded as open: `billing_journal_lines.opening_item_id` now references `migration_opening_items`, so a tenant with migrated opening balances has B10 journal lines whose parent is outside the five formats; B's reference check is expected to refuse that import (fail closed) rather than drop the link, but this is not yet tested. Next step: an M export format (or the opening-item chain inside B10) placed before B in the import order, with a round-trip test that includes an opening balance.

### 9.6 Load-independent timing tests (test-only)

- `clinical-review-hardening-c12` "coverage that turned stale after presentation…": staleness is judged by the application clock (`Date.now()` in `estimates.ts`), so the test fakes only `Date` (`vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })`; timers and the database stay real), enters a source one minute short of 30 days old, and moves the clock two minutes forward after presentation instead of sleeping 3 s.
- `rcm-review-hardening-b6b9` "a submission left pending by a crash…": the lookup deadline is the stored `call_deadline` compared with the database clock, so the test places it explicitly (admin session, `session_replication_role = replica` to pass the submission guard, as `billing-fees-procedures` does): one hour ahead for the early poll (now strictly `submission_in_flight`), one second behind for the worklist and lookup. No product change.

### 9.7 Gate (round 2)

`corepack pnpm run ci` exit 0: 145 files, 3070 tests (catalog 384 operations). The first run (1 file, 2 tests failed in `review-hardening-s2` "same-key retry after the start has passed") started booking a five-minute window at about 23:58 America/New_York; the window crossed midnight and the all-day availability ends at the day boundary (`outside_availability`), so it was a midnight edge, not a merge effect; the rerun passed.

Open (round 2): `review-hardening-s2` `soon()` windows can cross local midnight (test-only fix: keep the window inside one local day); M export format / opening-item chain for the five-way round trip (section 9.5); E10 tables not in E9 export (section 9.4); no insurer portion from B5/B9 in C12 estimates. Nothing here is approved, deployed, compliant or clinically validated.

## 10 Hardening H1

### 10.1 Group A (part 1): A-M1, A-M2, A-S3, A-S8

Red then green: `api-change-control-gate` (4 failed, then green), `api-scopes` registry-table and A-S3/A-S8 cases (2 failed each, then green), `comms-telephony` closed CallRead (failed: validator missing, then green). Details and decision A-D4 in `docs/execution/api-progress.md` "Hardening H1". The change-control gate is dormant against today's `origin/main` because the baseline has not landed there yet.

### 10.2 Group A (part 2): A-S4, A-S5, A-S6, A-S7

- A-S4: `tests/integration/support/route-sites.ts` finds every Fastify registration site under `apps/api/src` (typed instances, plugin scopes, aliases, computed verbs, `route(...)`); `api-catalog` pins the reviewed sites and proves the scanner on a bypass fixture.
- A-S5: portal and bridge routes asserted registered in the catalog stack; action aliases may not be weaker than the operation (a command behind a read alias needs a capability check); allow path exercised for human, service and portal. The paired-device allow path stays in `imaging-bridge.test.ts` (open: not in the catalog stack).
- A-S6: representation lint matches `...Ids`, `practiceId`/`organizationId`, union `type` arrays, money by shape (integer beside `currency`) and by name (fee/charge/copay/payment/total; counts excluded, `charges` count reviewed), `...Timestamp` names, and open request maps (`additionalProperties` true/schema, `patternProperties`) unless bounded (`propertyNames` + `maxProperties` + typed values). The generated client types `query` per operation from the documented OpenAPI query parameters (closed; `Record<string, never>` when none).
- A-S7: `summarizeInput`/`inputBreaks` track format, minItems, uniqueItems, multipleOf, exclusive bounds, map values, `not`, `if/then/else`, per-alternative anyOf, and merge allOf by tightest constraint; the baseline (version 2) carries idempotency and refusals; a required idempotency key, a new refusal or a newly admitted non-human principal is breaking.
- Red: A-S6 lint case and A-S7 cases failed first (3 failed), then green; the client query test first failed at parse time (honest note: not a clean assertion red).

### 10.3 Group R: R1-R3 (S22 reassignment)

- R1: reassignment refuses (409, typed reason with refs and remediation) while an active visit context item (`visit_context_active`), a series occurrence/exception (`series_linked`) or a waitlist entry/offer/cancellation recovery (`waitlist_linked`) references the appointment; the reminder intent is superseded in the same transaction by a reminder for the new patient (E6 decides again; delivery key keyed by the reassignment). Linked appointment requests keep their own history (request facts are separate identity facts; not moved).
- R2: reverse race (reassignment committed, then an encounter for the old patient) refused 40001; a runtime-role `UPDATE appointments SET subject_patient_id` without a reassignment row refused 42501 at commit (the relink guard is a deferred constraint trigger).
- R3: migration `20261128000000_reassignment_hardening.sql` adds `appointment_reassignment_blocker`; the reassignment insert guard and the relink-guard S22 branch both call it, so a blocker written after the reassignment record in the same transaction still refuses the move (proved red by removing the branch check, then green). An inactive or merged target is refused at the record.

### 10.4 Group R: R4 (S20 staging)

An S10 cancel or reschedule of a staged appointment resolves its staging entry in the same transaction (`removed`/`appointment_cancelled` or `moved`, audited), so capacity is free at once (`packages/domain/src/scheduling/staging-resolve.ts`). Red (entry stayed `staged`) then green; a concurrent-add race into the last slot gives exactly one 201 and one `staging_capacity_reached` (passed before and after: the list-row lock already serialized it; kept as a regression test).

### 10.5 Group R: R5 and floor nits (S21)

Floor and provider-request reads use configurable caps (`SchedulingDeps.floorCaps`, default 100 each), read `cap + 1` rows and report `truncated` with `count: { atLeast }` when capped (`cappedCount`). A visit with attendance activity in the last day stays on the floor even when its booked window left the ±1 day range. The anonymized projection drops `requestRef` (FloorVisit `providerRequest.requestRef` is now optional), which also removes the redundant ternary. Red (3 failed) then green.

### 10.6 Group R: R7 (E10 escalation)

The episode is keyed on the first portal message after the last staff message; due is measured from it; a follow-up neither de-escalates nor restarts the due time. Only a human who may post staff replies (`messaging.messages.post`) records the escalation fact during a read; read-only readers and service principals get the same list with the overdue item routed to the escalation queue (derived) and `escalatedAt: null` until a staff read records it. The scan uses each queue's policy as its cutoff (no 23-hour constant) and walks batches with a keyset cursor, so no queue starves another. No worker stage was added (open: a worker escalation sweep would remove the dependence on a staff read). Red (2 failed) then green; the two exact-due assertions now allow under one second between the thread activity time and the episode message time.

### 10.7 Group R: R8 (claims attachment source)

`BillingDeps.attachments` is required and `createClaimOperations` has no fake default; the worker now passes `createImagingAttachmentSource()` (I3), as the API and MCP already did; synthetic-test fixtures pass `createFakeAttachmentSource()` explicitly. Red: typecheck failed on the unused `@ts-expect-error` in `review-hardening-h1.test.ts`, then green.

### 10.8 Group R: remaining nits

- Floor: redundant ternary removed with the anonymized `requestRef` drop (10.5).
- Estimate pricing: `20261128010000_estimate_coverage_check_by_name.sql` verifies by name (and by column, not LIKE) that exactly one coverage_status CHECK exists per table and it is `<table>_coverage_status`; the applied `20261125040000` is unchanged.
- Five-way import (when a C document is in the same import; a B-only import keeps its own checks): `assertBillingProcedureRefs` refuses a `clinical_procedure` charge whose `procedure_ref` names no C14 rendered procedure of the tenant (red: the orphan import resolved; then rolled back with the whole import).
- C12: `mergeCoverageStatus`/`coverageNowOf` keep a B5 `unknown` unknown even with an entered assumption (red then green).
- `review-hardening-s2` `soon()` keeps the window inside one America/New_York day (shrinks near midnight; under one minute left it starts after midnight). Test-only.

## 11. Close M batch 2 integration gaps

Four CI failures after the M batch 2 and A20 merge.

- List envelope: only two M batch 2 lists were unregistered, `migration.archive.references` (ordered by archive version, entity, source id, entry id; capped at 10000 with no cursor; tenant scope) and `operations.alerts.list` (fixed obligation order, bounded by the parent set of obligations, exact `data.count`). Both are in `LIST_OPERATIONS`, and their success schemas in `migration.schema.json` carry the top-level `envelope` as the M batch 1 lists do. The M1, M9 readiness and M10 reads are not lists by the A20 rule.
- Vocabularies: only `migration_archive_packages.state` was uncovered; added as `migration_archive_package` (verified, partly readable, failed) and bumped the module to `migration-state-labels.2`.
- E5 acceptance: the product was right and the test was wrong. The test's notice policy used quiet hours 03:00 to 03:01 America/New_York and CI happened to run at 03:00, so E7 correctly deferred the notice (`queued`). It passes at any other minute. The test now places a one-minute quiet window twelve hours away from the run time. No product change; OR-08 behaviour (needs-reply derived from the awaiting-reply item, escalation writes only by humans who may reply or the worker) is unchanged.
- Lint: `useOptionalChain` in `change-control.ts` applied.

## 12. Workstream A batch 2 merge (A8-A13) and A20 conformance

`origin/codex/a-api-2` merged into `codex/backend-integration` (after A20, B11, H1, H2 and M). Synthetic data only; A-S1, A-S2 and A-S3 stay blocked-on-discovery, and nothing here qualifies a transport, a model provider, an evaluation threshold or a prescribing partner.

- Conflicts: `apps/api/src/app.ts` and `apps/mcp/src/server.ts` keep both sides (the A20 envelope hook and list scope, plus A2 agent routes, model adapter and consent/budget tool-call settlement; MCP settles the ticket against the enveloped result). `docs/execution/api-progress.md` keeps both sections. The generated catalog docs took ours and were regenerated.
- H1 meets A2. The H1 scope registry table needed rows for the ten A2 scopes. Human only: `agents.manage`, `actions.approve`, `ai.review`, `prescriptions.draft`, `prescriptions.submit`. The A2 agent-ops route loop was added to the reviewed route-registration sites. The `ActionPrepare.payload` pass-through is now a bounded keyed map (A-S6 open-object rule).
- A-D4 with A10: the four propose-only operations stay human only in the catalog (humans call them directly; a non-agent service is refused `principal_kind_denied`). An agent calling one directly is refused `proposal_required`: `authorize` checks this before the principal kind, and the MCP admit gate checks it before consent, because a consent cannot name a human-only operation. `proposerAllows` lets an agent prepare and stand behind such a proposal at commit. A distinct human still approves and commits. The forbidden matrix and the A-D4 human-only assertions still pass.
- A20 OR-01: all seven A2 lists are registered in `LIST_OPERATIONS` with `placement: 'existing'` and `rows: 'items'`. The agent service builds the envelope at the response root, with no `data` wrapper, and the conformance test now accepts this root-flattened placement. Each list states its ordering and tie-break: `actions.proposals.list` createdAt desc/proposalRef, `agents.audit.list` occurredAt asc/eventRef, `agents.consents.list` grantedAt desc/consentRef, `agents.principals.list` createdAt asc/agentRef, `ai.drafts.list` createdAt desc/draftRef, `ai.evaluations.list` ranAt desc/runRef. These six page by offset cursor (limit 25, max 100, exact count, tenant scope). `ai.useCases.list` (useCase asc) returns the fixed registry whole, with no cursor.
- A20 OR-02: a new `agents` vocabulary module (owner `A`, `agents-state-labels.1`; the `Vocabulary.owner` enum gains `A`). It covers `agent_principal`, `agent_consent`, `operation_proposal` (including `committing`), `ai_draft`, `ai_evaluation_verdict`, `ai_use_case_approval` and `prescription`. Budgets have no state code. The derived use-case `gate` has no vocabulary because its `none` value is a reserved filter sentinel.
- Open: A2 responses have no `data` wrapper, unlike the rest of the API. A2 responses do not yet state vocabulary versions, because their schemas are closed.
- `corepack pnpm run ci`: exit 0, 165 files / 3272 tests passed. Catalog: 435 operations.

## 13. A batch 3 merge (A16-A18, A21, A22, A24) onto the A batch 2 + H3 integration

`origin/codex/a-api-3` (ec12080) merged into `codex/backend-integration` (a5e2542). Synthetic data only; every A3 decision stays recommended-pending-approval, and A-S1, A-S2 and A-S3 stay blocked-on-discovery.

- Conflicts (17 files): `app.ts`, `routes/manifest.ts`, MCP `server.ts`, `execute-once.ts` and `mcp-parity.test.ts` keep both sides (agent routes/tools/replay codecs and the A3 read-op routes/tools, preference and administration codecs). `catalog.ts` and `synthetic-task.schema.json` (owner-workstream enum ordering only) took ours. `docs/execution/api-progress.md` keeps both sections. The `SHARED-CONTRACTS.md` scope registry table is the sorted union (human only: `access.manage`, `audit.read`; `analytics.read` and `display.shared` not human only).
- `authorize.ts`: `authorize` now calls A3's `membershipDenial`, which gained the A10 rule, so the order is membership active, agent `proposal_required` (before principal kind), principal kind, A18 `display.shared` confinement, scope. Navigation filtering, which also uses `membershipDenial`, therefore hides propose-only operations from agents. `membershipAllows` (used by the proposer and approver rechecks and by `proposerAllows`) also applies the display confinement, so a shared-display membership cannot prepare or approve a proposal.
- MCP: the A3 read-op tools pass through the same `callTool` path. That means the A9 consent admit, the H3 budget meter (`chargeToolCall`), settlement with `budgetWarning` on commands, the OR-01 list envelope and the vocabulary-version attachment.
- Generated artifacts (operations, scopes, baseline, list-query keys, client `generated.ts`, `operation-catalog.md`, `scopes.md`) took ours and were regenerated with `catalog:generate`. In OpenAPI, the AGENT_OPS, BILLING_OPS and MIGRATION_OPS blocks were regenerated. A3's READ_OPS block generator lived only in an ignored scratch cache, so it is now `scripts/openapi-read.ts` (`corepack pnpm run openapi:read`), and the block was regenerated from it (18 read operations).
- A5 change gate: `catalog:check` passes against the default base, against `HEAD` (a5e2542) and against `origin/codex/a-api-3`. A3's narrowings (sliding analytics windows refused, saved-view filters restricted, runtime audit SELECT revoked) only affect operations new to this branch or the database layer, so no deprecation entry was needed and the gate was not changed.
- Agent coverage: `agents-negative-harness.test.ts` has a new A3 block. An agent on MCP is refused all 12 administration and preference tools with `forbidden` / `principal_kind_denied`, never `consent_missing`. A consented read surface (`navigation_get`) is logged as `ok` in `agent_tool_calls`, so read-ops are metered. The forbidden matrix covers all 452 authorize operations (2655 cases). The A3 lists (`admin.audit.search`, `analytics.measures.list`, the three preference lists) are in `LIST_OPERATIONS`, and the vocabulary and list-conformance tests pass.
- H3 meets A16: `analytics.read` is a new scope that service principals may hold, so it is now in the generated `AGENT_SCOPE_CEILING`. The first full CI run failed one test, `api-agent-identity` "the database refuses a non-delegable or human-only scope": the database ceiling did not match. Migration `20261203010000_agent_scope_ceiling_analytics.sql` replaces `agent_scope_ceiling()` with the same list plus `analytics.read`. The applied `20261203000000` is unchanged.
- `corepack pnpm run ci`: exit 0, 175 files / 3356 tests passed (after the ceiling migration). Catalog: 453 operations.

## 14. A batch 4 merge, A23 hardening, A19 close-out and the pre-UI hand-off (closing)

Synthetic data only. Configured and tested; not approved, deployed, compliant or clinically validated.

- **A14/A15 merge** (`origin/codex/a-api-4`, e009a49, merged as 2b0620e).
  - Code conflicts kept both sides: `app.ts`, the route manifest, MCP `server.ts`, the execute-once codecs, the scope registry, the SHARED-CONTRACTS scope table, the MCP parity list and the `package.json` scripts.
  - Generated artifacts took ours and were then regenerated: catalog, client and docs, plus the agents, read, billing, migration and automation OpenAPI.
  - `webhooks.read` is admitted to service principals for the read-only webhook lists, so it was added to `agent_scope_ceiling()` (`20261206000000`).
  - The forbidden matrix now asserts that no export operation and no webhook mutation admits a service principal (agent).
  - ci: exit 0, 180 files / 3419 tests.
- **A23 hardening after independent review** (1799577, migration `20261206100000`).
  - The PHI policy flip now purges phi notes, and reads re-check the policy.
  - Memory PHI screening is documented as a best-effort heuristic and has a DB backstop CHECK.
  - One uniform `memory_value_refused`.
  - Reach RLS limited to the sponsor or an `agents.manage` holder.
  - The worker owner/consent recheck stops tasks with `policy_owner_inactive` or `consent_revoked`.
  - New `agents.sponsors.offers.list`.
  - Red 10/10, then green 10/10. The full ci found two catalog-procedure failures; after the fix, both files passed when re-run alone. Details are in the [API ledger](api-progress.md).
- **A19** (90deb7a). The coverage, no-tier and hidden-operation checks are in `scripts/catalog/coverage.ts`, with generated [capability coverage](../api/capability-coverage.md) and [no-tier attestation](../api/no-tier-attestation.md).
  - 25 of 27 rows covered, plus 2 dated P2 gaps.
  - Attestation pass, with the injected check detected.
  - No hidden operations.
  - 455 of 488 operations have MCP.
  - ci: exit 0, 182 files / 3439 tests.
- **Hand-off:** [pre-UI backend handoff](backend-handoff.md) is the starting document for P4. Backend workstreams are complete on synthetic data, up to the stated blocked-on-discovery parts. What remains is the UI phase, which awaits the user's instruction, together with every pending human decision and discovery item listed in the hand-off.
- Not pushed. GitHub CI has not run on these commits.

## Closeout A

Branch `codex/backend-integration`, from 2475167. Synthetic data only; not pushed.

- **A1 cursor key.** Every HMAC list cursor (foundation codec for S patients, C, A agents, A automation and synthetic tasks; scheduling codec for S scheduling and B) now uses one configured key ring: `CUSPATLAS_CURSOR_KEY` (base64, at least 32 bytes), with `CUSPATLAS_CURSOR_KEY_PREVIOUS` accepted for decoding only during a rotation. A test-only key applies under `synthetic-test`; a missing, short or test-only key is refused elsewhere. Offset positions (agent and automation lists) now decode, which the UUID-only check had refused. E thread cursors are unsigned offsets and carry no key, so they already survive a restart. Red 5/5 (exit 1), then green 5/5 (`tests/integration/cursor-key.test.ts`).
- **A2 downtime log** (M8 runbook gap, migration `20261207000000`). Six operations: `operations.downtime.start`, `operations.downtime.end`, `operations.downtime.log`, `operations.downtime.entries.resolve`, `operations.downtime.entries.list` and `operations.downtime.windows.list`, on REST and MCP. They use the existing `migration.write` / `migration.read` scopes, so the agent scope ceiling is unchanged. Resolve is human only; start, end and log also admit a service principal, as the other `operations.*` writes do.
  - Windows cover the tenant or a set of membership locations. The database allows one open window per overlapping scope (guard trigger serialized per tenant, plus a partial unique index). A window only ends, once, at its expected version.
  - Entries are transcribed paper records (kind, structured synthetic payload, summary, paper reference, capture time inside the window, up to 14 days after it ended). They start `pending_review`. They are append-only except one guarded review transition to `applied`, `rejected` (reason code) or `superseded`. The runtime role has column-level UPDATE on the review fields only and no DELETE.
  - The log never applies a payload. `applied` links the owning command the reviewer already ran (operation, resource, correlation). The link must fit the entry kind, apply no other entry and exist in the tenant's audit record after the entry was logged; a definer function checks this for a live human with `migration.write`.
  - New vocabularies `downtime_window` and `downtime_entry_review` (`migration-state-labels.3`). Both lists are in `LIST_OPERATIONS`, capped at 500 rows with no cursor. Both tables are in the M10 migration export, which round-trips in the matrix.
  - Location-restricted members act only on windows inside their locations. The reads are tenant-wide.
  - Red 10/10 (exit 1), then green 10/10 (`tests/integration/downtime-log.test.ts`). The M10 negative matrix gained six rows and passes (45/45).
  - Not enforced: the two-person rule for payments and notes. A window can end with entries still pending; the window list reports how many.
- **A3 backup verification in the worker tick** (M9). `composeWorker` now runs the M9 verification job when `CUSPATLAS_BACKUP_LOCATION` and `CUSPATLAS_RESTORE_ADMIN_DATABASE_URL` are configured, every `CUSPATLAS_BACKUP_VERIFY_INTERVAL_SECONDS` (default 43200, refused above the 86400-second readiness window). Due-ness comes from each served tenant's last recorded verification (a new non-catalog domain read, `lastBackupVerification`, authorized as `operations.backupVerifications.record`), so a second tick or a restart inside the interval records nothing. One `verifyBackup` per tick (digests and an isolated sample restore into a dropped `cuspatlas_synthetic_backup_verify_*` database) is recorded for every due tenant through `operations.backupVerifications.record` as the worker principal (needs `migration.write`; no new scope or operation). A verification that throws is recorded as failed (`verification_unavailable`). Without configuration the job is disabled and logs `backup_verification_disabled` once with reason `backup_location_not_configured` or `restore_target_not_configured` (no path or URL). Red 4/4 (exit 1), then green 4/4 (`tests/integration/worker-backup-verification.test.ts`); `worker-main.test.ts` expectations list the new disabled consumer. Tested against synthetic backups only; no operator backup location is configured or deployed.
