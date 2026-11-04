# Backend integration ledger (foundation F + workstreams S, C, E, I, B)

Branch: `codex/backend-integration` in the isolated worktree `src/cuspatlas-c1` (outside the OneDrive-synced checkout). Base: `0c93aa9` (C final, which contains S final `0c8cfdf` and F). Authorization basis: the user instruction to build every backend workstream on synthetic data until only the UI phase remains. Synthetic data only; no Supabase cloud, no host installs, nothing pushed. Nothing here is approved, deployed, compliant or clinically validated; clinical and legal semantics stay recommended-pending-approval exactly as each workstream ledger records them.

Status values: not started, in progress, blocked with cause, verified (on synthetic data, Windows host, `corepack pnpm run ci` exit 0).

## Status

| Step | Status | Commit | Notes |
|---|---|---|---|
| 1. Merge `codex/e-portal-1` (a2966ef) | verified | merge commit | 16 conflicted files, all resolved keeping both behaviours; combined S+C+E import |
| 2. Integration seams (E4 to C8, E2 `clinical_read`, E attachment port) | not started | | |
| 3. S-table relink guard | not started | | |
| 4. Keyed idempotency payload digest | not started | | |
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

## Open items

- E `AttachmentRefResolver` and C15 `ImageRefResolver` stay ports until I merges (Phase 2).
- B: C12 estimate fees and coverage reads, CL-04 attachment packages (Phase 2).
