# Backend integration ledger (foundation F + workstreams S, C, E, I, B)

Branch: `codex/backend-integration` in the isolated worktree `src/cuspatlas-c1` (outside the OneDrive-synced checkout). Base: `0c93aa9` (C final, which contains S final `0c8cfdf` and F). Authorization basis: the user instruction to build every backend workstream on synthetic data until only the UI phase remains. Synthetic data only; no Supabase cloud, no host installs, nothing pushed. Nothing here is approved, deployed, compliant or clinically validated; clinical and legal semantics stay recommended-pending-approval exactly as each workstream ledger records them.

Status values: not started, in progress, blocked with cause, verified (on synthetic data, Windows host, `corepack pnpm run ci` exit 0).

## Status

| Step | Status | Commit | Notes |
|---|---|---|---|
| 1. Merge `codex/e-portal-1` (a2966ef) | verified | merge commit | 16 conflicted files, all resolved keeping both behaviours; combined S+C+E import |
| 2. Integration seams (E4 to C8, E2 `clinical_read`, E attachment port, E6 over C14) | verified (E4 to C8, E6 over C14); E2 documents and E attachments recorded as ports | step 2 commit | migration `20261120000000` |
| 3. S-table relink guard | verified | step 3 commit | migration `20261120010000` |
| 4. Keyed idempotency payload digest | verified | step 4 commit | migration `20261120020000` |
| Phase 2: merge I and B, resolver and fee/coverage seams | not started (waiting for the I and B branches) | | |

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

- E4 medical-history hand-off to C8 (wired). C8 exposes no proposal queue: history enters the record only as a clinician's own `clinical.history.recordChange` (structured items; free text cannot be mapped automatically without clinical judgment). The seam is therefore "record, then close": the clinician records the change with provenance `patient_reported` and `sourceRef` `intake-submission:<submission>`; `intake.reviews.resolve` with `apply` on a hand-off then names that version (`historyVersionRef` in the result, `applied_history_version_id` on the item, resolution `recorded_in_clinical_history`). Without such a version: 409 `clinical_history_not_recorded` with alternative `clinical.history.recordChange` (replaces E's `c8_not_deployed`); without `clinical.history.read`: 403. Nothing is copied from the submission; the proposal stays `{}`. Migration `20261120000000_integration_intake_history_handoff.sql`: column with composite FK to the C8 version, the E4 CHECK "a hand-off is never applied" relaxed to "applied only with a C8 version", and the review-item guard checks the version is a patient-reported version of the item's own patient recorded from the item's own submission. Worklist suggestion `record_in_clinical_history` (was `hold_for_c8`). Recommended-pending-clinical-approval. Tests: `portal-intake.test.ts` (refusal, wrong-source version, 403, apply, DB binding under the runtime role: 42501 for another submission's version, 23514 without a version; reject still available).
- E6 recall enrollment over S16's completed-procedure basis (wired in the merge, tested here): `integration-seams.test.ts` (procedure-due patient enrolled, listed with the procedure as last event, other code `no_baseline`, 403 without `clinical.read` for enroll and list).
- E2 portal `clinical_read` view (`documents`): kept `unavailable` (owner C15). C exposes no patient-facing projection: every C read is a staff sensitive read, and C15 stores opaque `imageRef`s whose documents live in I. Revisit in Phase 2 when I3 reference reads exist and a patient-facing document projection is specified.
- E `AttachmentRefResolver`: kept as a port (fail closed) until I merges (Phase 2).
- Test-only fix carried with this step: `clinical-procedures.test.ts` and `clinical-review-hardening-c12.test.ts` computed TODAY as the UTC date while the server checks the date of service in the location zone (America/New_York), so 21 C14 tests failed between 00:00 and 05:00 UTC; TODAY is now the New York date.

## 3. S-table relink guard

Gap reported by C: the S record classes of the merge registry had no database relink guard. Migration `20261120010000_integration_s_relink_guard.sql` adds `merge_reference_relink_guard(column)`, the column-parameterised form of C's `clinical_subject_relink_guard` (as hardened by `20261109100000`: forward relink only with an unreversed merge of that pair recorded and observed in the same transaction that lists the record and column; reversal relink only with the reversal recorded and observed in the same transaction, a listed move, and no later merge of the record), as deferred constraint triggers on every S class of `MERGE_RECORD_CLASSES`: `patient_relationships.subject_patient_id` and `.counterparty_patient_id`, `appointment_requests`, `appointments`, `appointment_series`, `waitlist_entries` (`subject_patient_id`). Bound to the runtime role `cuspatlas_app` (the C guard scope assumption); privileged roles can disable triggers in any case. The excluded S reference `recall_tasks.subject_patient_id` never moves under the runtime role. The existing S6 observation triggers (`20261109050000`) and the moves-cover guard already applied to these tables.

Tests (`s-relink-guard.test.ts`, runtime role, committed so deferred checks run): per class, a bare relink to the survivor or a stranger is refused (42501), the real merge and unmerge relink, a bare move back after a merge is refused, and after merge/unmerge/merge a bare relink cannot borrow the old reversal; the trigger set equals the S classes; a recall task's patient cannot be moved and a real merge leaves it in place. Without the migration all 8 tests fail (checked).

## 4. Keyed idempotency payload digest

Platform finding held earlier: `command_idempotency.payload_digest` was an unkeyed SHA-256 over canonical JSON that can contain low-entropy PHI (allergen names, contact values), so it could be confirmed by guessing. Now (scheme 2) it is HMAC-SHA-256 under a dedicated server secret `CUSPATLAS_IDEMPOTENCY_DIGEST_KEY` (base64, at least 32 bytes; read by `apps/api/src/server.ts`, `AppDeps`/`McpServerDeps.idempotencyDigestKey`) over a purpose label, the tenant id and the canonical JSON (`idempotencyPayloadDigest`). A dedicated key rather than the match-key pepper, so the two secrets rotate independently. `resolveIdempotencyDigestKey`: the test-only key `SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY` is used when none is configured under synthetic-test and is refused elsewhere; outside synthetic-test a key is required. The API and MCP builders resolve the key for their environment and run `createDurableExecutor(key)` for every service (the key is required outside synthetic-test even when a test injects its own executor; MCP refusal tests in `mcp-parity.test.ts`). The fallback `executeOnce` of a domain service built without an executor uses the process key (`configureIdempotencyDigestKey`; a second, different key in one process is refused) and fails closed without one. Integration tests set the test key in a vitest setup file (`tests/integration/support/idempotency-key-setup.ts`) because some build domain services directly.

Comparison semantics are unchanged (equal canonical payload within a tenant and key, equal digest). Migration `20261120020000_integration_idempotency_digest_key.sql` adds `payload_digest_scheme` (existing rows 1, new rows 2): legacy scheme 1 rows (synthetic only) are still compared by their own unkeyed scheme until they expire (7 days, purged by maintenance); a takeover rewrites them as scheme 2. Action proposals keep the unkeyed digest: the payload is stored beside it and the client submits it for approval.

Tests: `idempotency.test.ts` (stored digest differs from a plain SHA-256 of the payload and equals the tenant-bound HMAC; tenant binding; replay and conflict unchanged; a legacy scheme 1 row conflicts on another body and is taken over as scheme 2 with the same body; existing raw-row tests use the keyed digest), `digest.test.ts` (HMAC properties, key resolution and refusals, fail-closed without a key, no second key).

## Open items

- E `AttachmentRefResolver` and C15 `ImageRefResolver` stay ports until I merges (Phase 2).
- B: C12 estimate fees and coverage reads, CL-04 attachment packages (Phase 2).
