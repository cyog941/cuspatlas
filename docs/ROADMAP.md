# Delivery roadmap

This is a proposed sequence, not a delivery-date commitment. No product implementation has started.

## Planning sequence

| Stage | Output | Exit condition |
|---|---|---|
| P0: foundation and research | Repository, original scope/design, evidence ledger, backlog, development provisioning record | Documents reviewed; cloud project verified; authenticated REA/Craft attachment remains unresolved |
| P1: workflow and integration qualification | Pilot workflow inventory, device/partner matrix, licensed-data assessment, migration sample contract | Clinical, billing and reception representatives validate the supported workflow and exception inventory |
| P2: domain and security contracts | Schema design, state machines, role matrix, API/MCP schemas, threat model, recovery plan | Cross-tenant and high-impact action cases have explicit expected outcomes |
| P3: synthetic acceptance and operational design | Scenario packs, financial reconciliation oracle, import/restore criteria, operator ownership | Every P1 capability has a measurable acceptance case and an owner |
| P4: UI/UX design — deferred | Workflow navigation, accessibility, interaction design, usability validation | Separate user instruction; no mockups or UI code before then |

UI is the final **planning** stage, not the last coding task after backend lock-in. Usability findings may revise contracts before implementation begins. This prevents premature backend assumptions from forcing unsafe clinical interactions.

## Implementation sequence after explicit authorization

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

Detailed phase-F plan: [platform foundation](superpowers/plans/2026-11-03-platform-foundation.md). Each later workstream must receive its own reviewed technical spec and executable plan after P1/P2 resolve its material unknowns. Inventing payer/clinical contracts today would not make the project more ready.

## Staffing and effort assumptions

This is a clinical/financial product program, not a weekend app. At minimum identify product ownership, clinical and billing reviewers, backend/data engineering, frontend/UX, and security/operations ownership; a person can hold multiple roles, but the responsibilities remain. Do not publish a calendar estimate until pilot scope, integration access, available people and migration samples are known. Workstream acceptance gates determine progress.

## Disruption hypotheses to validate

- A practice can leave with complete, usable records and no export lock-in.
- Staff can complete ordinary care and exception handling with fewer corrections and less re-entry.
- A local integrator can automate supported workflows through documented scopes without purchasing a special API tier.
- Practices can choose hosting and model vendors without losing core capabilities.
- Sustainable maintenance/support can be funded without moving essential security or clinical features behind a license paywall.

Track these against measured baselines. Competitor dissatisfaction or a free license alone does not establish adoption.

