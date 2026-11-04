# Delivery roadmap

This is a proposed sequence, not a delivery-date commitment. No product implementation has started.

## Planning sequence

The [practice coverage strategy](PRACTICE-COVERAGE-STRATEGY.md) adds a user-directed target of 90% suitability for US general-dentistry practice locations. P1 must research broad imaging ecosystems and payer/service coverage, not only one pilot. This is an unverified target; national claims require representative evidence and joint suitability across hardware, insurance and the other release requirements. First pilots still require qualification of all their essential workflows.

| Stage | Output | Exit condition |
|---|---|---|
| P0: foundation and research | Repository, original scope/design, evidence ledger, backlog, development provisioning record | Documents reviewed; cloud project verified; authenticated REA/Craft attachment remains unresolved |
| P1: workflow and integration qualification | Pilot workflow inventory, device/partner matrix, licensed-data assessment, migration sample contract | Clinical, billing and reception representatives validate the supported workflow and exception inventory |
| P2: domain and security contracts | Schema design, state machines, role matrix, API/MCP schemas, threat model, recovery plan | Cross-tenant and high-impact action cases have explicit expected outcomes |
| P3: synthetic acceptance and operational design | Scenario packs, financial reconciliation oracle, import/restore criteria, operator ownership | Every P1 capability has a measurable acceptance case and an owner |
| P4: UI/UX design — deferred | Workflow navigation, accessibility, interaction design, usability validation | Separate user instruction; no mockups or UI code before then |

UI is the final **planning** stage, not the last coding task after backend lock-in. Usability findings may revise contracts before implementation begins. This prevents premature backend assumptions from forcing unsafe clinical interactions.

## Implementation sequence after explicit authorization

Integration qualification runs during P1/P2 using the [hardware and claims backlog](HARDWARE-AND-CLAIMS-QUALIFICATION.md): H1/H2 establish pilot configurations and vendor interface rights; C1/C2 establish clearinghouse access, payer coverage, costs and enrollment; R1 establishes regulatory responsibilities. H3/C3 supply reviewed contracts. H4/C4 require real device and partner qualification during implementation. Synthetic foundation work can proceed after authorization, but workstreams I/B and release R cannot claim production support from mocked adapters. Vendor outreach drafts are prepared, not sent.

| Workstream | Depends on | Independently verifiable result |
|---|---|---|
| F: platform core | Approved design/contracts | Tenant isolation, identity, audit, contracts, job/idempotency framework; detailed plan below |
| S: patients and scheduling | F | Identity/guardian permissions, transactional booking, huddle, safe notifications |
| C: clinical record and care | F + patient identity | Structured odontogram/perio/history, plans, signed notes and amendments |
| B: billing and RCM | F + patients; procedures contract from C | Reconciled journal, payment/claim adapters, ERA/secondary workflows |
| I: files and device bridge | F + patients | Private image/doc import, provenance and qualified device bridge |
| E: engagement and portal | F + S + consent | Intake, scoped portal, secure messaging, reminders/recall |
| A: API/MCP and AI | Every module as it lands | Contract parity is continuous; optional draft AI with evaluated controls |
| M: migration and practice operations | S + C + B + I | Reconciled import/archive/export, downtime and restore exercises |
| R: supported release | All applicable P1 capabilities | Staff validation, security review, vendor/device readiness, operator/support sign-off |

Executable plans now exist for every workstream. Shared types, identifiers, money, scopes and task-id conventions are fixed in [shared contracts](SHARED-CONTRACTS.md), which every plan must conform to:

| Workstream | Plan |
|---|---|
| F: platform core | [platform foundation](superpowers/plans/2026-11-03-platform-foundation.md) |
| S: patients and scheduling | [scheduling and patients](superpowers/plans/2026-11-04-scheduling-and-patients.md) |
| C: clinical record | [clinical record](superpowers/plans/2026-11-04-clinical-record.md) |
| B: billing and RCM | [billing and RCM](superpowers/plans/2026-11-04-billing-and-rcm.md) |
| I: imaging and devices | [imaging and devices](superpowers/plans/2026-11-04-imaging-and-devices.md) |
| E: engagement and portal | [portal and communications](superpowers/plans/2026-11-04-portal-and-communications.md) |
| A: API, MCP and AI | [API, MCP and AI](superpowers/plans/2026-11-04-api-mcp-and-ai.md) |
| M: migration and operations | [migration and operations](superpowers/plans/2026-11-04-migration-and-operations.md) |
| R: supported release | [supported release](superpowers/plans/2026-11-04-supported-release.md) |

A plan existing is not a plan being approved, funded or sequenced. Each carries open decisions and blocked-on-discovery items that must be settled before implementation, and inventing payer or clinical contracts today would not make the project more ready.

## AI delivery within the existing workstreams

The [AI PMS architecture contract](AI-PMS-ARCHITECTURE.md) is part of the roadmap. F establishes authorization, provenance and synthetic proposal/approval guarantees. S/C/B/I/E provide the authoritative data and business operations. A delivers API/MCP parity continuously; its AI releases follow their actual module dependencies rather than preceding them.

- A1: sourced summaries, huddle preparation, clinical note drafts and claim-readiness assistance. Require source freshness, reviewed synthetic evaluations and the relevant clinical/billing modules; read/draft only.
- A2: scheduling recovery, recall, denial follow-up and multi-step automation. Require separately reviewed execution policies, current consent/access checks, durable step history, idempotency and external-outcome reconciliation.
- Every capability plan names its owner, prerequisite contracts, synthetic scenarios, domain reviewers, quantitative acceptance thresholds and disable/recovery procedure. A model or prompt change triggers relevant regression evaluation.

This adds architecture and future implementation requirements only. It neither authorizes coding nor moves UI design ahead of the remaining planning gates. Release R still requires the full replacement contract even if individual AI capabilities are ready earlier.

This is a clinical/financial product program, not a weekend app. At minimum identify product ownership, clinical and billing reviewers, backend/data engineering, frontend/UX, and security/operations ownership; a person can hold multiple roles, but the responsibilities remain. Do not publish a calendar estimate until pilot scope, integration access, available people and migration samples are known. Workstream acceptance gates determine progress.

## Disruption hypotheses to validate

- A practice can leave with complete, usable records and no export lock-in.
- Staff can complete ordinary care and exception handling with fewer corrections and less re-entry.
- A local integrator can automate supported workflows through documented scopes without purchasing a special API tier.
- Practices can choose hosting and model vendors without losing core capabilities.
- Sustainable maintenance/support can be funded without moving essential security or clinical features behind a license paywall.

Track these against measured baselines. Competitor dissatisfaction or a free license alone does not establish adoption.

