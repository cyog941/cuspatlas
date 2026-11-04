# AI PMS architecture and delivery requirements

Status: proposed product requirements incorporated at the user's direction, 2026-11-03. No features are implemented or clinically validated. These requirements extend the existing architecture; they are not claims about Tab32 internals. DSH's observed evidence remains separately attributed in the research documents.

## Product contract

The platform must support a complete US general-dentistry practice day before claiming to replace a PMS. The [capability matrix](CAPABILITIES.md) and [first-replacement contract](superpowers/specs/2026-11-03-dental-pms-design.md) remain authoritative for scope. AI does not relax those requirements.

| Required foundation | End-to-end coverage |
|---|---|
| Patient identity | Patients, families, guarantors, guardians/proxies, duplicates, medical history, allergies, medications, forms and consent |
| Scheduling and daily operations | Requests versus bookings, providers/operatories/resources, recurrence, holds, conflicts, waitlists, recall, cancellation recovery, arrival/in-care/checkout and staff handoffs |
| Clinical care | Odontogram/surfaces, longitudinal perio, treatment alternatives/phases/estimates, signed notes/addenda, imaging/documents, labs and referrals |
| Revenue cycle | Coverage and eligibility provenance, preauthorization, primary/secondary claims, attachments, acknowledgements, denials/appeals and remittance reconciliation |
| Financial record | Balanced journal, allocation, adjustments/reversals, refunds, unapplied credit, payment plans, statements and reconciliation |
| Patient engagement | Scoped portal, intake, consent-aware messaging/reminders, payments, recall and treatment follow-up |
| Practice operations | Reports, AR, acceptance, roles, audit, multiple locations, vendor status and accountable work queues |
| Ownership and continuity | Reconciled migration, accessible history, complete export, supported self-hosting, backups, restore, downtime and upgrade procedures |

## Shared architecture

Keep the web-first TypeScript modular service and PostgreSQL transactional core. An optional Rust companion handles qualified local-device integration. AI providers sit behind a replaceable adapter; model availability is not a dependency for ordinary clinical or financial operations.

All UI, REST, MCP, workers and connectors use the same authorized domain commands. Every supported business operation has a documented programmatic contract, including permissions and error states. API parity does not grant an agent clinician identity or unrestricted execution rights. No agent SQL, service-role credentials or generic privileged proxy.

Add logical boundaries for AI orchestration, tenant-scoped retrieval, protected proposal records, provider egress policy and evaluation. These are modules in the existing service/worker design, not a requirement for separate microservices or a new database vendor. Retrieval permissions are checked at access time, including source revocation; embeddings and caches inherit tenant, retention and deletion policies.

Keep clinical/financial source records authoritative. Analytics and AI use explicitly dated projections and permission-filtered references. Money, balances, availability, coverage calculations and state transitions come from deterministic domain services. A model may explain those results but cannot substitute invented calculations or missing facts.

## AI capability contracts

| Capability | Intended result and required dependencies | Acceptance boundary |
|---|---|---|
| Daily huddle assistant | Summarize missing forms, eligibility, balances, lab dependencies and scheduling issues; requires S, clinical/lab context, B and consent as applicable | Each finding links to an authorized source and its freshness; unavailable data is marked unknown; no fabricated readiness |
| Clinical documentation assistant | Dictation and authorized chart context produce structured note drafts; requires C and qualified transcription adapter | Preserve attribution, uncertainty and source links; no invented findings; clinician reviews and signs through the ordinary signing workflow |
| Scheduling assistant | Rank valid openings and waitlist matches; requires S and E for outreach | Respect provider, operatory, duration, timezone and consent; recheck conflicts transactionally at booking; never infer booking from an invitation |
| Revenue-cycle assistant | Identify missing claim information, prioritize denial work and draft narratives/appeals; requires B and qualified payer adapter | Distinguish sourced facts from suggested text; no invented procedures or coverage guarantees; submission is a separate approved action |
| Treatment follow-up assistant | Worklists and draft messages for incomplete care; requires C, E and contact preferences | Respect opt-out and current treatment status; explain selection; approval and delivery evidence separate from draft creation |
| Financial assistant | Explain balances, unmatched payments, overdue accounts and reconciliation differences; requires B | Use ledger calculations and source transactions; no model-generated postings; refunds/write-offs retain finance authorization |
| Analytics assistant | Answer practice questions with dated filters, definitions, calculations and evidence; requires validated reporting projections | Reproduce totals through deterministic queries; disclose freshness and missing data; preserve location/role visibility |
| Workflow automation | Coordinate approved sequences across modules; requires their contracts, durable jobs and approval controls | Bounded scope, preview, retry/reconciliation, cancellation and per-step outcomes; partial success is explicit |

Workstream letters refer to [ROADMAP](ROADMAP.md). A capability can launch with a clearly stated subset of sources; it must not imply unavailable modules were checked.

## Proposal and execution lifecycle

Default progression is **read → recommend → draft → approve → execute**. Read-only responses need no execution approval; the sequence applies when a recommendation would cause a change. Initial AI release is read/draft only. Later automation requires a separately reviewed operation-specific policy; conversational agreement alone cannot override that policy.

Before execution, a server-created proposal binds tenant, requesting principal, exact operation/payload digest, affected record versions, source references, expiry and policy version. Approval binds the authorized approver to that proposal. Editing the payload invalidates approval. Execution rechecks current access, consent, record versions and applicable business rules. An agent cannot approve its own elevated action or impersonate the clinician who signs a note.

Clinical signing, prescribing, financial posting/refunds, access administration, exports and outbound communications retain their respective roles and approval rules outside the model. Batch proposals expose recipients/counts and individual outcomes. Opt-out or revocation between approval and execution blocks the affected action.

Protect proposal contents and source references as sensitive application data. Record model/provider/prompt version, source versions, actor, approval, execution receipt and final disposition in access-controlled records. Ordinary logs contain correlation identifiers and safe metadata, not prompts, transcripts or patient text. This is accountable provenance, not collection of private model reasoning.

Long-running sequences use durable per-step state and stable idempotency keys. An external timeout means unknown outcome until reconciled. Do not blindly replay money or messages. Where possible, stop or compensate explicitly; signed notes and posted finances require amendments/reversals rather than pretending a workflow rollback erases them.

## Provider and connector controls

- Practices choose approved model providers and allowed data categories. Credentials remain server-side; routing, retention, contractual requirements and data egress are deployment policy. Local models are optional, not assumed safe by default.
- Connectors have a named owner, tenant-bound identity, minimal scopes, allowlisted destinations, expiry/revocation, health status, delivery receipts and recovery queues. Version contracts and test failure as well as success.
- Imported text, documents, OCR and tool outputs are untrusted data. They cannot authorize tools, change destinations or widen retrieval scope. Enforce limits outside the model.
- Apply per-practice usage budgets, concurrency/time limits and emergency disable controls. Provider outages and budget exhaustion leave manual care workflows available.
- Core clinical, financial, security, API/MCP, export and self-hosting features remain open without proprietary feature keys. Hosting, support, messaging, clearinghouses and inference still have operating costs. API/MCP presence alone is not a unique market claim.

## Evaluation and release evidence

Build a versioned synthetic scenario pack for each capability before enabling it. Include normal cases, absent/stale/conflicting sources, cross-tenant references, revoked roles, prompt injection, malicious documents, provider outage, duplicate execution, concurrent edits, changed consent and uncertain external outcomes. Use clinical and billing reviewers for domain correctness.

Measure factual support and source-link correctness, critical omissions, unsupported statements, clinician corrections, staff task time, inappropriate tool attempts, policy denials, duplicate side effects, latency and cost per completed task. Establish baseline and numerical acceptance thresholds with reviewers before evaluation; this document makes no unmeasured performance claims. Unauthorized disclosure, unauthorized signing/posting and duplicate financial effects are release-blocking failures.

Model/provider/prompt/retrieval changes rerun relevant evaluations. Record dataset version, configuration, reviewer, results and approval; regressions block promotion. Pilot monitoring needs an accountable reviewer and disable/rollback procedure. Model confidence scores alone do not establish factual or clinical correctness.

## Delivery gates

1. **Planning now:** map requirements to modules, domain contracts, integration owners and synthetic acceptance scenarios. Complete evidence review and staff validation. UI design remains the final planning stage and is deferred.
2. **F after build authorization:** implement common identity, policy, audit, idempotency, jobs and API/MCP parity. Add synthetic proposal/approval tests as specified in the foundation plan; no live model or clinical schema is required.
3. **S/C/B/I/E:** implement dependable underlying workflows and qualified integrations. Every operation receives API/MCP parity and domain tests as it lands. These are prerequisites, not work an agent can bypass.
4. **A1:** source-linked summaries, huddle preparation, note drafts and claim-readiness assistance, enabled only for modules with validated data and reviewers. Remain read/draft only.
5. **A2:** consider cancellation recovery, recall, denial follow-up and multi-step actions after A1 evidence and explicit operation-level approval policies. Release each automation independently.
6. **Replacement release:** pass the full capability, migration, security, financial, clinical, integration, recovery and support gates. AI availability does not establish replacement readiness.

Each follow-on plan must name its owner, dependencies, contracts, evaluation fixtures, failure/recovery tests, review roles and measurable exit conditions. The foundation plan is not a complete implementation plan for all these modules.
