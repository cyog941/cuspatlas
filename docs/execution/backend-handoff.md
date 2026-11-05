# Pre-UI backend handoff

This is the starting document for the UI phase (P4). It records what the backend foundation contains, how to run it, the evidence behind it, and everything still waiting on a human decision or on discovery.

**Completion language (AGENTS.md):** the backend foundation is **configured and tested on synthetic data**. It is **not approved, not deployed, not compliant, not clinically validated and not production-ready**. No real patient data has been used, and none may be used. A green CI run is not authorization to hold PHI or to deploy. UI design (P4) is the next phase, and it starts only when the user instructs it.

Branch `codex/backend-integration` (worktree `src/cuspatlas-c1`); see [integration progress](integration-progress.md) for the merge history.

## What exists per workstream

The operation counts come from `packages/contracts/src/catalog/operations.json` (catalog owner letter), 507 operations in total after Closeout C. Every routed operation is reachable over REST, and over MCP where it has a tool (469 of 507; see [capability coverage](../api/capability-coverage.md)), through one policy layer.

| Workstream | Tasks built (ledger) | Operations | Key read models for the UI |
| --- | --- | --- | --- |
| F Foundation | Tasks 1–8 including 7a ([foundation](foundation-progress.md), [decisions](foundation-contract-decisions.md)) | 14 | `session.read` (`GET /v1/session`), `vocabularies.list` / `vocabularies.read` (`GET /v1/vocabularies[/{name}]`, state labels for every state machine), health, outbox delivery |
| S Scheduling and patients | S-S1, S-S3, S4–S17, OR S18–S22 ([scheduling](scheduling-progress.md)) | 92 | `scheduling.floor.read` (`GET /v1/scheduling/floor`), `scheduling.floor.providerRequests`, `scheduling.staging.list`, `scheduling.worklist.daily`, `scheduling.followUp.worklist`, `scheduling.notifications.worklist`, availability search, patient search/read |
| C Clinical record | C-S1, C-S2 (decision records), C5–C18 ([clinical](clinical-progress.md)) | 88 | chart, perio, notes, treatment plans and estimates, `clinical.labCases.worklist`, `clinical.referrals.worklist` |
| B Billing and RCM | B1–B10, CL-01..CL-12, OR B11 ([billing](billing-progress.md)) | 66 | claims queues `rcm.claims.queues` (`GET /v1/rcm/claims/queues`), `rcm.claims.worklist`, `rcm.claims.measures`, `billing.worklist.list`, `billing.plans.worklist`, ledger and balances |
| E Portal and communications | E1–E9, S15 portal seam, OR E10 ([engagement](engagement-progress.md)) | 60 | needs-reply `messaging.threads.worklist` (`GET /v1/messaging/threads/worklist`), threads, `intake.reviews.worklist`, `communications.deliveries.worklist`, portal views |
| I Imaging and devices | I1–I9; I5/I6/I7 partly blocked on I-S1/I-S2/I-S3 ([imaging](imaging-progress.md)) | 55 | `imaging.bridge.worklist`, objects, mounts, associations, annotations |
| M Migration and operations | M1–M10 ([migration](migration-progress.md)) | 29 | migration reports, review items, readiness, practice export |
| A API, MCP and AI | A1, A3–A24 (A9 local transport only; A13 envelope only; A19 close-out) ([api](api-progress.md)) | 84 | schedule view `schedule.view` (`GET /v1/schedule/view`), appointment detail `appointments.detail` (`GET /v1/appointments/{appointmentRef}/detail`), `huddle.read` (`GET /v1/huddle`), `navigation.read` (`GET /v1/navigation`), saved views/favourites/recent patients, analytics measures, admin audit/access review, webhooks, exports, agents |
| OR Operational read models | A20–A24, S18–S22, B11, E10 ([spec](../superpowers/specs/2026-11-04-operational-read-models.md), [plan](../superpowers/plans/2026-11-04-operational-read-models.md)) | (counted above) | **List envelope** (OR-01): every registered list in `packages/contracts/src/list-operations.ts` returns `items`, cursor, `limit`, applied filters and sort; **vocabularies** (OR-02) with versioned labels; floor, staging, claims queues, needs-reply, navigation, huddle |

The UI should consume these contracts: `docs/api/openapi.yaml` (REST), `docs/api/operation-catalog.md` (every operation with its scope, principals, transports and refusals), `docs/api/scopes.md`, `packages/client/src/generated.ts` (typed client), `docs/SHARED-CONTRACTS.md`. The domain, state machines and refusal codes are fixed by the backend. The UI must not invent a business operation: every UI action maps to a catalog operation, and `describeHiddenOperations()` fails any transport route that is not in the catalog.

## How to run

- [Development runbook](../runbooks/development.md): prerequisites, clean checkout on Windows/Linux, embedded PostgreSQL, running one suite, migrator, environment variables, worker, privacy scan, SBOM, CI, known limitations. Other runbooks: [restore](../runbooks/restore.md), [downtime](../runbooks/downtime.md), [downtime scheduling](../runbooks/downtime-scheduling.md), [escalation](../runbooks/escalation.md), [imaging deletion](../runbooks/imaging-deletion.md), [imaging recovery](../runbooks/imaging-recovery.md).
- Commands (always `corepack pnpm ...`, never `npx`):
  - `corepack pnpm install --frozen-lockfile`
  - `corepack pnpm run ci`: the full gate (tsc, biome, contract drift, catalog check, vitest, privacy scan, SBOM, evidence).
  - `corepack pnpm start`: the API and local MCP.
  - `corepack pnpm start:worker`: outbox, webhook dispatch, agent tasks, purges.
  - `corepack pnpm catalog:generate`: regenerates the catalog, client, docs, coverage and attestation.
  - `corepack pnpm openapi:<agents|read|billing|migration|automation>`
- Environment variables (documented in the runbook table):
  - `CUSPATLAS_ENV` (`synthetic-test` / `development` / `production`; fakes only under `synthetic-test`)
  - `CUSPATLAS_DATABASE_URL`, `CUSPATLAS_ATTEMPT_DATABASE_URL`, `CUSPATLAS_MIGRATION_DATABASE_URL`, `CUSPATLAS_MAINTENANCE_DATABASE_URL`
  - `CUSPATLAS_HOST`, `CUSPATLAS_PORT`
  - `CUSPATLAS_JWT_ISSUER`, `CUSPATLAS_JWT_AUDIENCE`, `CUSPATLAS_JWT_PUBLIC_KEY_PEM`, `CUSPATLAS_MCP_AUDIENCE`
  - `CUSPATLAS_IDEMPOTENCY_DIGEST_KEY`, `CUSPATLAS_MATCH_KEY_PEPPER`, `CUSPATLAS_CURSOR_KEY`, `CUSPATLAS_IMAGING_TOKEN_SECRET`, `CUSPATLAS_BRIDGE_SIGNING_KEY_PEM`
  - `CUSPATLAS_OBJECT_STORE_DIR`
  - `CUSPATLAS_WORKER_PRINCIPAL_ID`, `CUSPATLAS_WORKER_TENANT_IDS`, `CUSPATLAS_WORKER_INTERVAL_MS`
  - Tooling only: `CUSPATLAS_RESTORE_ADMIN_DATABASE_URL`, `CUSPATLAS_BACKUP_DATABASE_URL`, `CUSPATLAS_CATALOG_BASE_REF`, `CUSPATLAS_DEPRECATION_WINDOW_DAYS`
  - `.env.example` holds placeholders only. No Supabase cloud project holds application data.

## Evidence

- Local `corepack pnpm run ci` at the A19 commit: exit 0, 182 test files, 3439 tests passed (the A14/A15 merge ran 180 files / 3419 tests; the A23 hardening commit was gated on targeted reruns, recorded in the API ledger).
- Catalog: 488 operations. [Capability coverage](../api/capability-coverage.md): 27 rows (25 matrix rows + 2 plan-defined A rows); 25 covered with named operations and negative tests, 2 dated gaps (Specialty breadth, International, both P2), 0 unknown. [No-tier attestation](../api/no-tier-attestation.md): pass (0 findings), shown to fail on an injected entitlement check.
- GitHub CI (`gh run list --repo cyog941/cuspatlas --branch codex/backend-integration --limit 5`, before this hand-off was pushed):

| Run | Conclusion | Commit | Created |
| --- | --- | --- | --- |
| 42032428551 | success | A23 and 3c: record verification in the ledger | 2026-11-05T13:03:49Z |
| 42024688924 | success | Merge A batch 3 read surfaces (A16-A18, A21, A22, A24) into backend i… | 2026-11-05T12:08:58Z |
| 42019315242 | success | Use a function for the agent scope ceiling; record H3 in the ledger a… | 2026-11-05T11:29:04Z |
| 42007364199 | success | Conform workstream A batch 2 to A20 list envelope and vocabularies | 2026-11-05T10:02:31Z |
| 41993837735 | success | Close M batch 2 integration gaps for the list envelope and vocabularies | 2026-11-05T08:21:32Z |

The A14/A15 merge (2b0620e), the A23 hardening (1799577), A19 (90deb7a) and this hand-off are local commits that have not been pushed. GitHub CI has not yet run on them, and the next push is the clean Linux gate.

## Pending human decisions

Status is `pending` unless recorded otherwise. Only OR-D1..OR-D6 are accepted by the user (2026-11-04, "go with your recommended options"), and that acceptance covers the product choice only; clinical, billing, privacy and legal reviewer sign-offs remain pending. Paths are relative to this document.

| ID | Decision | Owner role | Recommended option | Status | Defined in |
| --- | --- | --- | --- | --- | --- |
| A-D1 | API version identity and deprecation window | maintainer + integrator | `/v1` path major, additive-only, release-counted support window | pending | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A-D2 | Scope granularity and human-only set | clinician + security review | Per-domain read/write plus draft/commit/sign/execute; sign human-only | pending | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A-D3 | MCP write tools per deployment | operator | Read + draft by default; commit/sign/execute per named operator | pending | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A-D4 | Approval model for high-impact operations | safety + financial review | Prepare/commit, distinct human approver, no self-approval, expiry | pending | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A-D5 | AI patient-data egress boundary | security/privacy (after A-S2) | Only providers with a written PHI arrangement; else local/no AI | pending | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A-D6 | AI capabilities in first release | clinical reviewer | Admin explanation, source-linked summary, drafts; no diagnosis | pending | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A-D7 | Webhook endpoint registration and egress | security review | Operator-approved allowlist per endpoint, pinned secret | pending | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A-D8 | Meaning of a "complete" export | A-S4 + migration review | Entities, attachments with checksums, history, provenance; receiver-verifiable | pending | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A-D9 | Agent principal lifecycle | security review + operator | One principal per agent, named sponsor, expiry, revocation, scope ceiling | pending | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| S-D1 | Recurrence cap | practice/clinical reviewer | 26 per request, ceiling 52, explicit "continue series" | pending | ../superpowers/plans/2026-11-04-scheduling-and-patients.md; ../adr/0009 |
| S-D2 | Merge reversibility | identity owner | Reversible until a new fact; then elevated role + review | pending | ../superpowers/plans/2026-11-04-scheduling-and-patients.md; ../adr/0003 |
| S-D3 | Duplicate candidate presentation | identity owner | Scored candidates for staff review, never auto-merge | pending | ../superpowers/plans/2026-11-04-scheduling-and-patients.md |
| S-D4 | Guardian and proxy terms | legal (jurisdiction) | Per-tenant config; guardian to majority; proxies time-boxed | pending | ../superpowers/plans/2026-11-04-scheduling-and-patients.md |
| S-D5 | First-release messaging channels | product (after S-S2) | Intent recording only until a provider is qualified | blocked-on-discovery | ../superpowers/plans/2026-11-04-scheduling-and-patients.md |
| S-D6 | Waitlist offer semantics | practice owner | Short-lived hold with expiry; explicit acceptance to book | pending | ../superpowers/plans/2026-11-04-scheduling-and-patients.md; ../adr/0009 |
| S-D7 | Recall basis | clinical lead / practice | Per-practice/category interval; booked care excluded by default | pending | ../superpowers/plans/2026-11-04-scheduling-and-patients.md; ../adr/0009 |
| S-D8 | Patient scope within a tenant | practice owner | Tenant-wide identity, location-level access policy | pending | ../superpowers/plans/2026-11-04-scheduling-and-patients.md |
| C-D1 | Tooth identity and display | clinical lead / dentist | Canonical ID; Universal default; FDI supported; refuse lossy conversion | pending | ../superpowers/plans/2026-11-04-clinical-record.md; ../adr/0005 |
| C-D2 | Vocabulary and terminology rights | clinical lead + terminology-rights reviewer | Provisional `SYN-` vocabulary; licensed set after rights review | pending (licensed distribution blocking) | ../superpowers/plans/2026-11-04-clinical-record.md |
| C-D3 | Perio derived values | clinical lead / dentist | Raw measurements; versioned clinician-approved formulas | pending (every formula blocking) | ../superpowers/plans/2026-11-04-clinical-record.md; ../adr/0005 |
| C-D4 | Template enforcement point | clinical lead | Blocks signing, not drafting; deficit list in the refusal | pending | ../superpowers/plans/2026-11-04-clinical-record.md; ../adr/0006 |
| C-D5 | Amendment authority | clinical lead / compliance | Amending another author's note needs the oversight scope | pending | ../superpowers/plans/2026-11-04-clinical-record.md; ../adr/0006 |
| C-D6 | Consent evidence per method | records owner + clinical lead | Structured attestation plus artifact ref/digest; witness per method | pending | ../superpowers/plans/2026-11-04-clinical-record.md |
| C-D7 | Estimates with unknown coverage | practice manager + billing lead | Ranges or labelled unknown; eligibility from B5 | pending | ../superpowers/plans/2026-11-04-clinical-record.md |
| C-D8 | Imaging store boundary | clinical + imaging owner | I owns bytes; C stores the encounter-to-`imageRef` link | pending | ../superpowers/plans/2026-11-04-clinical-record.md |
| C-D9 | Lab states and ordering channel | clinical lead | Configurable states; print/export until a partner is verified | pending (C16-P1 blocking) | ../superpowers/plans/2026-11-04-clinical-record.md |
| C-D10 | Referral sharing | clinical lead / legal | Record-keeping plus print/export; explicit share record | pending | ../superpowers/plans/2026-11-04-clinical-record.md |
| B-D1 | Card data handling | billing reviewer + security owner | Provider tokens only, no card data | blocked-on-discovery (B-S1) | ../superpowers/plans/2026-11-04-billing-and-rcm.md |
| B-D2 | Draft vs posted adjustments | billing reviewer | Auto-post insurer contractual; review patient-facing | pending | ../superpowers/plans/2026-11-04-billing-and-rcm.md |
| B-D3 | Residual minor-unit rounding | billing reviewer | Largest remainder, lower-index tie-break | pending | ../superpowers/plans/2026-11-04-billing-and-rcm.md; ../adr/0008 |
| B-D4 | Undistributed funds policy | practice financial policy owner | Hold with age basis; escalation worklist at 7 days | pending | ../superpowers/plans/2026-11-04-billing-and-rcm.md |
| B-D5 | Statement delivery | operator | Portal plus recorded manual print; no mail vendor | pending | ../superpowers/plans/2026-11-04-billing-and-rcm.md |
| B-D6 | Historical financial detail | migration/financial sign-off | Opening balances plus integrity-checked read-only archive | pending | ../superpowers/plans/2026-11-04-billing-and-rcm.md |
| B-D7 | Claim correction model | billing (after B-S2) | Replace with a linked new version; never edit | pending | ../superpowers/plans/2026-11-04-billing-and-rcm.md |
| B-D8 | Report discrepancy tolerance | billing reviewer | Zero tolerance with an explicit discrepancy state | pending | ../superpowers/plans/2026-11-04-billing-and-rcm.md |
| E-D1 | Pilot channels | practice (after E-S1) | Portal plus email; SMS after registration/consent verified | pending | ../superpowers/plans/2026-11-04-portal-and-communications.md |
| E-D2 | Portal assurance level | security owner + practice | Invitation plus second factor, explicit recovery | pending (E-S3) | ../superpowers/plans/2026-11-04-portal-and-communications.md |
| E-D3 | Guardian expiry rule | legal review | Per-patient configured event, review task | pending | ../superpowers/plans/2026-11-04-portal-and-communications.md |
| E-D4 | Portal balance visibility | billing reviewer + practice | Summary plus audited statements; no payment page | pending | ../superpowers/plans/2026-11-04-portal-and-communications.md |
| E-D5 | Message retention | legal review | Per record class with legal hold | pending | ../superpowers/plans/2026-11-04-portal-and-communications.md |
| E-D6 | Template approval | practice policy | Practice manager for admin templates; clinical review for clinical | pending | ../superpowers/plans/2026-11-04-portal-and-communications.md |
| E-D7 | Reminder timing defaults | pilot practice | Per-practice config, quiet hours, no default window | pending | ../superpowers/plans/2026-11-04-portal-and-communications.md |
| E-D8 | Notification content | security review | Notice only; content read in the portal | pending | ../superpowers/plans/2026-11-04-portal-and-communications.md |
| I-D1 | Imaging storage backend | operator (BAA, cost) | One S3-compatible abstraction, managed at pilot | pending | ../superpowers/plans/2026-11-04-imaging-and-devices.md |
| I-D2 | Acquisition path at pilot | operator (after I-S1/I-S3) | Bridge export from capture software; manual import fallback | pending | ../superpowers/plans/2026-11-04-imaging-and-devices.md |
| I-D3 | DICOM scope | imaging (after I-S2) | Opaque plus bounded metadata summary; no network DICOM | pending | ../superpowers/plans/2026-11-04-imaging-and-devices.md |
| I-D4 | Annotation storage | clinical reviewer | Stored separately; exports marked derived | pending | ../superpowers/plans/2026-11-04-imaging-and-devices.md |
| I-D5 | Imaging retention defaults | legal + clinical review | Per record class and jurisdiction; no universal default | pending | ../superpowers/plans/2026-11-04-imaging-and-devices.md |
| I-D6 | Image deletion authority | practice policy + legal | Dual approval; single actor only if never associated | pending | ../superpowers/plans/2026-11-04-imaging-and-devices.md |
| I-D7 | Bridge distribution | operator (after I-S1) | Signed installer and updates with revocation | pending | ../superpowers/plans/2026-11-04-imaging-and-devices.md |
| I-D8 | Unmatched image age bound | operator | Escalate after a configured age (48 h); never auto-discard | pending | ../superpowers/plans/2026-11-04-imaging-and-devices.md |
| M-D1 | Cutover data scope | financial sign-off | Active records, open items, opening balances, archive refs | pending | ../superpowers/plans/2026-11-04-migration-and-operations.md |
| M-D2 | Historical financial detail | financial reviewer | Opening balances plus archive | pending | ../superpowers/plans/2026-11-04-migration-and-operations.md |
| M-D3 | Archive access model | retention review (M-S2) | In-product read-only module (built) | pending | ../superpowers/plans/2026-11-04-migration-and-operations.md |
| M-D4 | Write freeze duration | practice + operator | Per-practice agreement, rollback path, reconciliation | pending | ../superpowers/plans/2026-11-04-migration-and-operations.md |
| M-D5 | Recovery objectives | operator (timed drill, M-S3) | RPO 15 min, RTO 4 h engineering targets | pending | ../superpowers/plans/2026-11-04-migration-and-operations.md |
| M-D6 | Hosting model at pilot | operator | Contracted hosting with a named operator | pending | ../superpowers/plans/2026-11-04-migration-and-operations.md |
| M-D7 | Support tiers | maintainer | Security-fix commitment plus optional paid support | pending | ../superpowers/plans/2026-11-04-migration-and-operations.md |
| M-D8 | Rollback after new work | practice + operator + maintainer | Reconcile into the restored incumbent; never dual-write | pending | ../superpowers/plans/2026-11-04-migration-and-operations.md |
| R-D1 | Scope of "supported" | operator + maintainer + practice | One named practice/operator/config; otherwise a limited trial | pending | ../superpowers/plans/2026-11-04-supported-release.md |
| R-D2 | Go/no-go authority | governance | Concurrence of operator, clinician reviewer, security owner | pending | ../superpowers/plans/2026-11-04-supported-release.md |
| R-D3 | Baseline claim discipline | practice | Claim only paired same-instrument measurements | pending | ../superpowers/plans/2026-11-04-supported-release.md |
| R-D4 | Pen-test severity threshold | security owner + maintainer | No open critical/high; mediums owned with expiry | pending | ../superpowers/plans/2026-11-04-supported-release.md |
| R-D5 | Clinical intended-use boundary | clinician reviewer | Record-keeping/workflow only; no diagnosis or triage | pending | ../superpowers/plans/2026-11-04-supported-release.md |
| R-D6 | Patient-data deployment authorization | practice + operator signature | Signed instrument naming scope, region, instant | pending | ../superpowers/plans/2026-11-04-supported-release.md |
| R-D7 | Checkpoint offsets and fallback triggers | practice + operator | Offsets from cutover, named reviewers, intake-suspend triggers | pending | ../superpowers/plans/2026-11-04-supported-release.md |
| R-D8 | Published support commitment | maintainer | Security-fix commitment plus pilot support hours | pending | ../superpowers/plans/2026-11-04-supported-release.md |
| OR-D1 | Floor view in first release | product + clinical | Build the read model now; release with clinical reviewer | accepted-by-user | ../superpowers/specs/2026-11-04-operational-read-models.md |
| OR-D2 | Staging capacity and slot retention | engineering + reception | 10 per location, configurable; slot kept | accepted-by-user | ../superpowers/specs/2026-11-04-operational-read-models.md |
| OR-D3 | Claims priority configurability | billing reviewer | One documented global order | accepted-by-user | ../superpowers/specs/2026-11-04-operational-read-models.md |
| OR-D4 | Default reply-due time | product + E | 1 business day, configurable per queue | accepted-by-user | ../superpowers/specs/2026-11-04-operational-read-models.md |
| OR-D5 | Recent-patients retention | privacy | 7 days, user-clearable, references only | accepted-by-user | ../superpowers/specs/2026-11-04-operational-read-models.md |
| OR-D6 | Maximum availability search window | reception | 60 days, configurable | accepted-by-user | ../superpowers/specs/2026-11-04-operational-read-models.md |

Sub-decisions held in the ledgers (all pending): billing M-1..M-12, P-1..P-7, ST-1..ST-4, CV-1..CV-3 (`execution/billing-progress.md`); clinical C-S1-Q1/Q2/Q5 and C-S2-Q1/Q2/Q4/Q5 (blocking) plus C5-P..C17-P (`execution/clinical-progress.md`); imaging I-T1..I-T13 (`execution/imaging-progress.md`); engagement E1..E9 policy rows (`execution/engagement-progress.md`); A23 agent-workspace retention, idle timeout and limits (`execution/api-progress.md`).

## Blocked on discovery

| ID | Item | Category | Defined in |
| --- | --- | --- | --- |
| A-S1 | MCP authorization revision and remote transport qualification | vendor/standard | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A-S2 | Model provider and data-processing arrangement | vendor/legal | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A-S3 | AI evaluation acceptance criteria and reviewer authority | clinical/regulatory | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A-S4 | External consumer and portability requirements | partner | ../superpowers/plans/2026-11-04-api-mcp-and-ai.md |
| A13 | E-prescribing partner (operations refuse `prescribing_not_available`) | partner | api-progress.md |
| B-S1 | Payment processor qualification (PCI) | vendor | ../superpowers/plans/2026-11-04-billing-and-rcm.md |
| B-S2 | Claims clearinghouse partner and real COB rules | partner | ../superpowers/plans/2026-11-04-billing-and-rcm.md |
| B-S3 | Eligibility source qualification | partner | ../superpowers/plans/2026-11-04-billing-and-rcm.md |
| B-S4 | Fee schedule and terminology rights | legal/licensing | ../superpowers/plans/2026-11-04-billing-and-rcm.md |
| C-S3 | Imaging reference boundary and device qualification | device | ../superpowers/plans/2026-11-04-clinical-record.md |
| C-S4 | Lab partner and referral exchange channel | partner | ../superpowers/plans/2026-11-04-clinical-record.md |
| C-D2 | Licensed terminology distribution | legal/licensing | ../adr/0005 |
| I-S1 | Pilot hardware, driver and acquisition-software matrix | device/vendor | ../superpowers/plans/2026-11-04-imaging-and-devices.md |
| I-S2 | DICOM conformance and library licensing | device/licensing | ../superpowers/plans/2026-11-04-imaging-and-devices.md |
| I-S3 | Where acquisition runs | device | ../superpowers/plans/2026-11-04-imaging-and-devices.md |
| E-S1 | SMS/email provider qualification | vendor | ../superpowers/plans/2026-11-04-portal-and-communications.md |
| E-S2 | Telephony provider qualification | vendor | ../superpowers/plans/2026-11-04-portal-and-communications.md |
| E-S3 | Portal identity proofing level | legal/security | ../superpowers/plans/2026-11-04-portal-and-communications.md |
| S-S2 | Notification channel and reminder qualification | vendor | ../superpowers/plans/2026-11-04-scheduling-and-patients.md |
| M-S1 | Authorised incumbent export availability and rights | vendor/legal | ../superpowers/plans/2026-11-04-migration-and-operations.md |
| M-S2 | Lawful archive for non-exportable history | legal | ../superpowers/plans/2026-11-04-migration-and-operations.md |
| M-S3 | Recovery objectives and named operator model | operator | ../superpowers/plans/2026-11-04-migration-and-operations.md |
| R-S1 | Staff validation instrument and observation protocol | practice | ../superpowers/plans/2026-11-04-supported-release.md |
| R-S2 | Pen-test engagement scope and independence | vendor/security | ../superpowers/plans/2026-11-04-supported-release.md |
| R-S3 | Regulatory, legal and claims review intake | regulatory/legal | ../superpowers/plans/2026-11-04-supported-release.md |
| R-S4 | Incident response, breach notification, on-call capacity | legal/operator | ../superpowers/plans/2026-11-04-supported-release.md |

## Known limitations

- Everything runs on synthetic data on a Windows development host; nothing is approved, deployed, compliant or clinically validated.
- Hosted-Windows embedded PostgreSQL: `postgres.exe` refuses to start under the runner's administrator account, and embedded-postgres launches it directly. The integration global setup therefore starts the server through the bundled `pg_ctl` on win32 (restricted token; also fine for non-admin hosts). In GitHub run 42087689761 the Windows job started PostgreSQL and passed 169 of 173 integration files (3200 tests, about 16 minutes). Four files fail only on the hosted runner and are excluded from the blocking Windows step, running in a separate non-blocking step instead: `engagement-export`, `billing-statements` (B4 cases 4 and 5), `clinical-consents` (C13 case 3) and `restore-smoke` (case e). Their cause is not yet analysed (the date-cutoff and as-of cases look timing sensitive). Until then the Windows job is evidence for the other 169 files, and the full suite remains evidenced on Linux CI and a non-admin Windows developer host.
- Billing uses a synthetic payment processor and a fake clearinghouse; a missing adapter refuses with 503 `adapter_not_configured`, and fakes are allowed only under `synthetic-test`.
- Messaging and telephony are fake providers; email is exercised, SMS is modelled but not exercised, call recording is refused.
- AI uses a deterministic fake model adapter: no egress, output is always a draft, prescribing operations always refuse.
- Imaging uses a local filesystem object store (refused in production); no managed adapter, no real DICOM parsing, no bridge client.
- Migration uses the fabricated source format `cuspatlas-synthetic-legacy/1`; no real incumbent export has been received.
- Drill RPO/RTO timings describe only the embedded test cluster.
- Every clinical semantic is recommended-pending-clinical-approval; no dentist has reviewed any of them.
- Webhooks have no real network transport; a narrow window between the revoke recheck and the send remains.
- The privacy scan and SBOM are partial controls; a green CI is not authorization to deploy or hold PHI.
- Open integration items: A batch 2 responses have no `data` wrapper. (The C12 insurer portion and E2 portal documents were built in Closeout B; B4 statements reach the portal since Closeout C.)
- Closeout A limits (tested on synthetic data only):
  - Ending a downtime window does not require its entries to be resolved, and the log does not enforce a two-person rule for payments or notes.
  - Reply escalation has no per-queue enable flag; only each queue's reply-due threshold applies. The escalation target queue still needs practice confirmation.
  - Backup verification in the worker runs only when an operator configures `CUSPATLAS_BACKUP_LOCATION` and `CUSPATLAS_RESTORE_ADMIN_DATABASE_URL`. No operator location exists.
  - The orphan-bytes sweep is a human operation, not a scheduled job, and handles at most 200 candidates per run. Known residual risks:
    - A removal followed by a transaction rollback leaves no record.
    - An ingest retried after the grace period finds its bytes gone.
  - Export downloads: REST ranges (without `If-Range`) and MCP chunks read only their range; the local store reuses a digest verification of the unchanged file for at most 60 s and re-verifies on any change. A whole download, and a range with `If-Range`, still reads and verifies the whole package. A managed object store backend (I-D1) must implement the same ranged read or falls back to whole reads.
- Closeout C limits (tested on synthetic data only):
  - Statement portal releases: a statement goes only to its guarantor's portal (or a relationship holding `financial`) and shows every covered account's lines, including those of dependents. Whether that is acceptable for adult dependents is a billing and privacy decision that is still open. Superseding a released statement does not revoke the release; the portal marks it `superseded`. Nothing notifies the patient (E7 delivery is not built). The portal reads the JSON snapshot; no printable document is rendered.
  - The MCP truncation descriptor is advertised in each read-only tool's `_meta` under `cuspatlas/truncation`. That key is a project extension, and no tool declares an `outputSchema`.
  - MCP export chunks are base64 inside JSON, at most 1 MiB of package bytes per call.
  - Export builds run only in the worker, under its own service-only scope `exports.build` (never in the agent ceiling), and only with `CUSPATLAS_OBJECT_STORE_DIR` and an imaging token secret. Without a running worker, a request stays `building` until a worker leases it; there is no queue-age cap, so a request can wait indefinitely while no worker runs. A leased build renews its lease (default 300 s) while it runs; a build whose lease expired and was not renewed or taken over for the 900-second deadline fails as `build_interrupted`. A practice build racing an earlier attempt's in-flight idempotency reservation is deferred and retried, not failed. The worker builds as the requester's live membership and records each attempt as itself. This delegated execution still needs security review. A direct `practice.export.create` (M1) still builds inline.
  - The MCP `resumeCursor` input is advertised to agent callers only; a non-agent caller that sends one is refused as an unknown argument.
  - The downtime and reviewer cursors are keyset positions. A row inserted before the current position during a walk is not returned in that walk.
- No retention period ships for messages or images, so nothing in those classes is deletable.
- Agent memory PHI screening is a best-effort heuristic, not enforced default-deny (A23 hardening).

## What the UI phase must respect

- Every screen action maps to a catalog operation. Do not add a UI-only business path.
- Show the refusal codes from the catalog. Do not hide them.
- Use the vocabularies and the list envelope as published. Do not re-derive labels or paginate client-side.
- Patient identity, appointment request, booking, attendance, procedure completion, note signing, claim status and payment allocation are separate facts. Screens must not merge them.
- Signed clinical history and posted financial history are amended or reversed, never overwritten.
- Treat domain/workflow validation as still open. UI and workflow review may revise contracts through the A5 change gate, and clinical interactions are not frozen.
- Synthetic data only. Do not use screenshots of real charts, real exports or incumbent screen designs.

## Completion statement

The backend foundation is **configured and tested on synthetic data**. It is **not approved, not deployed, not compliant, not clinically validated and not production-ready**.

Every decision above marked `pending` still needs its owner role. Every blocked-on-discovery item still needs its vendor, partner, device or legal input. The release gates in the [supported release plan](../superpowers/plans/2026-11-04-supported-release.md) stay unevidenced until then. UI design (P4) awaits the user's instruction.
