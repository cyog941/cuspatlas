# Clinical record execution ledger, batch 2b: note templates and notes (workstream C)

Branch: `codex/c-notes` in an isolated worktree outside the OneDrive-synced checkout. Base SHA: `58bb6b5` (C-S1, C-S2, C5, C8; 743 tests). Sibling worktrees build C6/C7/C11 (`codex/c-chart`) and S12-S17; the integrator merges this file into `docs/execution/clinical-progress.md`. Status values: not started, in progress, blocked with cause, verified. Nothing is prechecked.

Authorization basis: user instruction to build every backend workstream on synthetic data until only the UI phase remains. Scope of this branch: C9 and C10. No real patient data, no cloud connection, no host installs, no licensed terminology dataset.

## Clinical-safety framing

Clinical semantics need dentist validation, which was not available. Everything here is a **synthetic engineering implementation** of the recommended options in [ADR 0006](../adr/0006-note-signing.md), each **recommended-pending-clinical-approval**, never decided or clinically validated:

- **C-D4**: enforcement blocks **signing, not drafting**, until the named required sections and associated procedure codes are addressed; the refusal names the missing sections and codes.
- **C-D5**: both addenda and amendments exist; amending **another clinician's** signed note needs an explicit clinical-oversight scope; an addendum is preferred for clarifying text. Both are append-only and audited.

AI drafting is **not built** (A11 later): a draft may carry `source: 'human' | 'ai_draft'` provenance (with model and prompt version references) for future use, but nothing generates text, and only a named human clinician signs. Templates use synthetic content; codes are provisional `SYN-...` placeholders; no CDT or other licensed set. Nothing here is approved, deployed, compliant or clinically validated.

## Batch status

| Task | Status | Head SHA | Notes |
|---|---|---|---|
| C9 note templates, enforcement, code association | verified on synthetic data (Windows host); semantics pending clinical approval | see commit log | 782 tests |
| C10 note drafting, signing, amendment, addendum, co-signature | not started | | |

## Pending decisions (none decided)

| Id | Question | Recommendation used (source) | Status | Deciding role (pending) | Affects |
|---|---|---|---|---|---|
| C-D4 | What enforcement prevents, and where | ADR 0006: blocks signing (and amendment), not drafting | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C9, C10 |
| C-S2-Q1 | Required-section list per template type | none in the plan; synthetic sections only, configured per template | blocking for release | clinical lead / dentist reviewer | C9 templates |
| C-S2-Q2 | How a code association is satisfied | none in the plan; engineering placeholder: a structured code entry on the note, never a text mention (the stricter reading) | blocking for release | clinical lead / dentist reviewer | `checkAgainstTemplate` |
| C9-P1 | Who configures templates | practice configuration under `admin.configure`, human only | recommended-pending-clinical-approval | practice manager; clinical lead | define/revise/retire |
| C9-P2 | Where applicability codes come from | caller-supplied SYN- codes until C11/C14 record encounter procedures | engineering seam | C11/C14 owners | applicable |
| C9-P3 | Template retirement reasons | pattern-checked reason codes, no vocabulary | blocking for release | practice manager | retire |

## Command log

### C9 (progress-note templates with per-template enforcement and code association)

Acceptance cases (`tests/integration/clinical-note-templates.test.ts`, every denial under the runtime role `cuspatlas_app`; enforcement outcomes in `packages/domain/src/clinical/notes/template-check.test.ts`):

1. an enforced template with an unaddressed required section (and a code mentioned only in text) yields a deficit list `{missingSections, missingCodeRefs, unresolvedSections}` with `blocksSigning: true` (unit); the blocked command is the C10 sign, exercised in the C10 tests;
2. the same draft under a non-enforced template gives the same deficits with `blocksSigning: false`, recorded as a warning (unit);
3. with `procedureCodeRefs=SYN-PROC-APPL-A` the associated template is offered with its matched code, a template with another code is not offered, a template with no code association appears only in `general`; without codes nothing is associated;
4. a revision creates version 2; version 1 reads byte-identical before and after (including the code association removed in version 2; failure case 4); a stale `expectedVersion` is 409 with `currentVersion`; signed-note resolution of the old version is a C10 case;
5. another tenant reading a template, a version or the applicability list of an alpha encounter, revising or retiring gets 404; the same type and label in beta is a separate template; codes are global synthetic placeholders, so "another tenant's code set" has no representation until a per-tenant procedure-code configuration exists (deviation, seam for C11/B);
6. a retired template disappears from applicability, still reads (template and version), refuses revision and a second retirement (409 `template_retired`), and frees its type and label for a new active template.

Failure cases: (1) a template retired while drafts pin it: C10 case; (2) unresolved sections are listed explicitly (unit: an empty draft lists every required section and code; a section the template does not define is `unresolvedSections`); (3) a second active template with the same type and case-insensitive label is 409 `template_exists` with `blockingRefs`, a different note type is allowed, and the partial unique index backs it under concurrency; (4) see case 4.

Also: duplicate section keys are 422 `duplicateSection`; a body with `tenantId`, a non-`SYN-` code and duplicate codes are 400; a service principal (`principal_kind_denied`) and a read-only member (`scope_missing`) cannot define, each with an attempt row; the runtime role cannot update a version, delete a version or template, relabel or unretire a template (42501 by privilege or trigger), and the owner path (superuser pool) cannot rewrite a template version (append-only trigger); one audit row per define with resource type `clinicalNoteTemplate`; the marker in a section label and a template label never reaches logs, audit, outbox, attempts or idempotency rows; an MCP define replays a REST key, an MCP read equals the REST read, a cross-tenant MCP version read is 404, a malformed REST reference is 404.

Negative harness: 6 rows appended (`clinical.noteTemplates.define|revise|retire|read|readVersion|applicable`), each cross-tenant, revoked and downgraded on REST and MCP, with the template tables in the unchanged-state snapshot. `define` is `own_tenant_only` (another tenant's admin defines in its own tenant).

- Red: tests written first (integration file, unit file, harness rows, MCP tool list, tenant-isolation inventory) with no implementation; `corepack pnpm test -- clinical-note-templates template-check negative-harness mcp-parity tenant-isolation` → exit 1: 5 files failed (the unit file and the harness failed to load), 14 tests failed, 113 passed.
- Green: the same command plus `clinical-tool-drift` → exit 0, 6 files, 340 passed.
- Pre-commit: `corepack pnpm typecheck`, `npx biome check .`, `corepack pnpm run contract:check` exit 0; `corepack pnpm test` exit 0, 37 files, 782 tests (743 + 4 unit + 11 templates + 18 harness rows + 6 clinical tool drift).
- One pre-existing C8 test was order-dependent: `clinical-history` case 2 destructured the changes of one version, which `versionDetail` orders by change id (random UUID), so it failed about half the time. The test now selects each change by its text; the C8 code is unchanged (flag for the integrator: a version's change order is not the submission order).

Shared files touched (minimal, append-only): `packages/contracts/src/clinical.schema.json` (C9 definitions, title), `packages/contracts/src/index.ts` (one export line; new module `clinical-notes.ts`), `packages/domain/src/clinical/{codecs,service,index}.ts`, `packages/domain/src/policy/authorize.ts` (6 rows), `apps/api/src/routes/{clinical-manifest,clinical}.ts`, `apps/api/src/contract-drift.ts` (closed bodies), `apps/mcp/src/server.ts` and `tools/synthetic-tasks.ts` (path references), `apps/mcp/src/tools/clinical.ts`, `apps/mcp/src/clinical-tool-drift.test.ts`, `docs/api/openapi.yaml`, `docs/SHARED-CONTRACTS.md` (no new scope), `docs/execution/foundation-contract-decisions.md`, tests `negative-harness`, `tenant-isolation`, `mcp-parity`, `clinical-history` (order fix). New: `packages/domain/src/clinical/notes/{template-check,templates}.ts`, `tests/integration/support/note-fixtures.ts`.

Deviations: one contract file (`clinical.schema.json`) instead of `note-template.schema.json`; tests at `tests/integration/clinical-note-templates.test.ts` (the integration project includes only `tests/integration/*.test.ts`); `validateAgainstTemplates` is the pure `checkAgainstTemplate` plus its use in C10 rather than a separate operation; `listApplicableTemplates` takes caller-supplied codes; template reads are not sensitive reads.
