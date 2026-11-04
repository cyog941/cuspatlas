# Clinical record execution ledger (workstream C)

Branch: `codex/c-clinical-1` in an isolated worktree outside the OneDrive-synced checkout. Base SHA: `b757ead` (workstream S S4-S11 plus the practice-time documents from main). A sibling worktree builds S12-S17 on `codex/scheduling-patients`; the orchestrator merges both. Status values: not started, in progress, blocked with cause, verified. Nothing is prechecked.

Authorization basis: user instruction to build every backend workstream on synthetic data until only the UI phase remains. Scope of this branch (batch 1): C-S1, C-S2, C5 and C8. No real patient data, no cloud connection, no host installs, no licensed terminology dataset.

## Clinical-safety framing

Clinical semantics need dentist validation, which was not available. Per AGENTS.md, domain and workflow validation gates the clinical modules for release. Everything in this batch is a **synthetic engineering implementation** of the plan's **recommended** options, each recorded as **recommended-pending-clinical-approval**, never as decided or clinically validated. There is no clinical decision support: no interaction checking, no relevance classification, no recommendation. Codes are a clearly provisional internal synthetic vocabulary (`SYN-...` placeholders); CDT, SNOMED CT, ICD or any other licensed set is not committed. Nothing here is approved, deployed, compliant or clinically validated.

## Batch status

| Task | Status | Head SHA | Notes |
|---|---|---|---|
| C-S1 chart semantics decision record | recommended-pending-clinical-approval (no reviewer) | e4bcc6e | ADR 0005 |
| C-S2 note signing decision record | recommended-pending-clinical-approval (no reviewer) | e4bcc6e | ADR 0006 |
| C5 encounter and clinical authorship | verified on synthetic data (Windows host); semantics pending clinical approval | (this commit) | see C5 |
| C8 medical history, allergies, medications | not started | | |

## Pending decisions (none decided)

| Id | Question | Recommendation used (source) | Status | Deciding role (pending) | Affects |
|---|---|---|---|---|---|
| C-D1 | Tooth identity and display | plan C-D1 (ADR 0005) | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C6 |
| C-D2 | Vocabulary and terminology rights | plan C-D2: provisional synthetic `SYN-` codes, no licensed set | recommended-pending-clinical-approval; licensed distribution blocking | clinical lead; terminology-rights reviewer | C6, C8 codes, C9, C11 |
| C-D3 | Perio derived values | plan C-D3 (ADR 0005); every formula blocking | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C7 |
| C-D4 | Template enforcement point | plan C-D4: blocks signing, not drafting (ADR 0006) | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C9, C10 |
| C-D5 | Amendment authority | plan C-D5: addenda and amendments, oversight scope for another clinician's note (ADR 0006) | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C10 |
| C-S1-Q1/Q2/Q5 | Conversion refusal list, surface scope, perio sites and grades | no value in the plan | blocking | clinical lead / dentist reviewer | C6, C7 |
| C-S2-Q1/Q2/Q4/Q5 | Required sections, code satisfaction, attestation wording, co-signature | no recommendation in the plan | blocking | clinical lead; compliance/records owner | C9, C10 |
| C5-P1 | Who is a clinical author; are clinical writes human-only | engineering proposal from the plan's ClinicalAuthor shape and C10's "the model is never the author": human principals with a configured profile; service principals refused | recommended-pending-clinical-approval | clinical lead; practice manager | every clinical mutation |
| C5-P2 | Clinical role vocabulary | the plan's `ClinicalAuthor.role` enum (dentist, hygienist, assistant, other_clinical) | recommended-pending-clinical-approval | clinical lead | authorship records |
| C5-P3 | Encounter disposition vocabulary | per-tenant configuration (synthetic codes in tests only); no value decided | blocking for release (no vocabulary) | clinical lead; practice manager | encounter close |
| C5-P4 | Provider identity for assignments | a scheduling provider/staff resource (S7) at the encounter location; credential detail stays in the staff module | recommended-pending-clinical-approval | practice manager; clinical lead | C14 rendering provider |
| C5-P5 | One encounter per appointment, ever | plan C5 case 1 and the completion condition ("exactly one encounter") | recommended-pending-clinical-approval | clinical lead | open after close is 409 |

## Command log

### C-S1 and C-S2

- Wrote `docs/adr/0005-chart-semantics.md` (C-D1, C-D2, C-D3 and the C-S1 questions) and `docs/adr/0006-note-signing.md` (C-D4, C-D5 and the C-S2 questions): question list, the plan's recommended option, consequences of the alternatives, terminology status, deciding role named as pending. Questions without a recommendation in the plan are marked `blocking` instead of answered.
- Deviation: the plan's walkthroughs with clinician reviewers (synthetic paper chart, enforcement outcomes) did not happen; the walkthrough agendas are in the records. The reviewer register is empty.
- Commit e4bcc6e (documentation only; no test run needed beyond the unchanged suite).

### C5 (encounter and clinical authorship)

Acceptance cases (tests/integration/clinical-encounters.test.ts, every denial under the runtime role `cuspatlas_app`):

1. two opens for one appointment with different keys: one encounter, the second `outcome: existing` with nothing applied, one `clinical.encounters.open` audit row; the same key replays (`replayed: true`); the response validates against `EncounterOpenResult`;
2. treating, secondary, supervising, staff and completing assignments recorded independently; changing treating and unassigning secondary leave the other roles unchanged; the append-only history keeps all seven rows with their author; kind/role mismatch is 422 and a stale version 409;
3. close with an unconfigured disposition is 422 `notConfigured`; with a configured one the encounter is closed by a hygienist (opening author a dentist, both recorded) with one close audit row; a second close is 409 `encounter_closed`;
4. a closed encounter refuses a new assignment (409 `encounter_closed` with `blockingRefs`); the runtime role with direct SQL cannot reopen, rewrite authorship, update assignments or delete (42501, trigger or privilege);
5. another tenant opening against an alpha patient or appointment gets a 404 identical to a missing reference with a `resource_hidden_or_missing` attempt; no beta encounter is written; a cross-tenant read is 404;
6. an encounter for a cancelled appointment is permitted with `statusAtOpen: cancelled` and the flag `appointment_cancelled_at_open`.

Failure cases: (1) revoking the outbox INSERT grant makes close a 500 and leaves state, disposition, version, audit and outbox unchanged; (2) two concurrent opens return one encounter, one `opened` and one `existing`, one audit row; (3) a rescheduled appointment keeps the original reference, reports `currentStatus: rescheduled` with the new appointment and the flag `appointment_changed_since_open`, without a version change; (4) a merge relinks the encounter (`patient_merge_moves` row with equal digests, a `patients.merge` audit row for `clinicalEncounter`), the full row minus the reference and bookkeeping and every assignment row are byte-identical, the closure is unchanged; a merged-away identity gets 409 `patient_merged` naming the survivor; a clinical fact on the survivor after the merge makes unmerge require the reconciliation review (S-D2 probe), and the reviewed unmerge moves the encounter back with its closure intact.

Structural merge assertion: for every `MERGE_RECORD_CLASSES` entry with `factKind: clinical`, the runtime role's UPDATE column grants equal exactly the digest exclusions (the reference, write-once closure columns and bookkeeping), so no application path can write a column the merge digest covers; the closure columns are write-once by trigger.

Also: a member without a profile is 403 `clinical_author_missing` with a `clinical_author_unresolved` attempt, and its author context is the explicit `no_profile`; a service principal with `clinical.write` is 403 and its context is `service_principal`; an admin defines, refuses to duplicate and deactivates a profile (an inactive author is 403 `clinical_author_inactive`); a non-member actor is 404; attendance `arrived` opens no encounter and closing the encounter changes neither attendance nor booking; a location-restricted member gets 404 and an empty list for another location's encounter; an empty patient list is `{data: [], nextCursor: null}`; reads write sensitive-read rows with references only; the marker in a credential reference and a patient name never reaches logs, audit, outbox, attempts, idempotency or sensitive-read rows; an MCP open replays a REST key and refusals match across surfaces.

Negative harness: 7 rows appended (`clinical.authors.define|context`, `clinical.encounters.open|read|assign|close|list`), each cross-tenant, revoked and downgraded on REST and MCP, with the clinical tables in the unchanged-state snapshot.

- Red: implementation stashed (`git stash push -u` of contracts, domain, api, mcp, migrations and OpenAPI), `corepack pnpm test -- clinical-encounters` → exit 1, the file failed to load (19 skipped). Honest note: the C5 tests were written after the first implementation draft, then shown red against the pre-implementation tree; they were not authored first.
- Green: `corepack pnpm test -- clinical-encounters` → exit 0, 19 passed; `negative-harness tenant-isolation mcp-parity` → exit 0, 269 passed.
- Pre-commit: `corepack pnpm typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0, 34 files, 703 tests (655 at start + 19 encounters + 21 harness rows + 8 clinical tool drift). `node scripts/privacy-scan.mjs` exit 0.

Shared files touched (minimal, append-only): `packages/contracts/src/context.ts` (`alternative`, reason code), `synthetic-task.schema.json` (Refusal `alternative`), contracts `index.ts`/`package.json`, domain `index.ts`, `commands/execute-once.ts` (codecs), `policy/authorize.ts` (rows), `patients/merge.ts` (one record class and the table union; owned by S, flagged for the integrator), `apps/api/src/app.ts`, `routes/manifest.ts`, `contract-drift.ts`, `apps/mcp/src/server.ts`, `tools/synthetic-tasks.ts` (ToolDeps, known properties), `docs/api/openapi.yaml`, `docs/SHARED-CONTRACTS.md` (scopes), `docs/execution/foundation-contract-decisions.md`, tests `negative-harness`, `tenant-isolation`, `mcp-parity`. One S test changed: `tests/integration/attendance.test.ts` asserted that no table named `clinical|note` exists; it now asserts that no such table contains the marker (same intent; flagged for the S owner and the integrator).

Deviations: one contract file `clinical.schema.json` (C8 extends it) instead of per-aggregate files; integration tests live at `tests/integration/clinical-*.test.ts` because the integration project includes only `tests/integration/*.test.ts`; `getAuthorContext` is the caller's own context (no read of other members' profiles); `openEncounter` returns 201 for both `opened` and `existing` (one success status per route). Case 4's "amendment against a closed encounter names the alternative path" is implemented as the `requireOpenEncounter` seam with an `alternative` operation; no amendment command exists until C10, and C8 exercises the seam with a real command.

Seams: `requireOpenEncounter` (C6-C15, C8); `loadClinicalPatient`/`assertNotMerged`; `ClinicalAuthor` snapshots on every row for C10 signing and C14 rendering; `assignments` with `treating_provider`/`supervising_provider` for C14's rendering-provider rule and a future co-signature rule (C-S2-Q5); S11 visit status still shows `clinicalCompletion: {ref: null, owner: 'C5'}` (S-owned code; the integrator may point it at the encounter by appointment).
