# CuspAtlas

An open-source dental practice platform being planned for US general dentistry.

**Status: planning only. No application, clinical database, API, or UI has been built. Do not use this repository for patient care or upload patient information.**

CuspAtlas is a working name: a tooth's cusp + an atlas of practice operations. The name is provisional; an initial exact-name web/GitHub search found no competing project, but does not establish trademark or domain availability.

## Purpose

Give dental practices ownership of their data and software, complete practice workflows, and secure programmatic access without a software-license paywall. Self-hosting is a first-class objective. Hosting, hardware, support, communications, payer connections, prescribing, and model inference still have real costs.

## Read first

Start here, in this order:

1. [Readiness review](docs/READINESS-REVIEW.md) — what is and is not established, the decision log, and the risk and unknown registers.
2. [Product and architecture design](docs/superpowers/specs/2026-11-03-dental-pms-design.md)
3. [End-to-end capability and acceptance matrix](docs/CAPABILITIES.md)
4. [API, MCP, and automation contract](docs/API-AND-MCP.md)
5. [Security and clinical-readiness gates](docs/SECURITY-AND-READINESS.md)

## The planning package

- [90% practice-suitability target and compatibility research](docs/PRACTICE-COVERAGE-STRATEGY.md)

- **Contracts and matrices**: [shared contracts across plans](docs/SHARED-CONTRACTS.md) · [workflow, state and role matrix](docs/WORKFLOW-ROLE-MATRIX.md) · [integration and device qualification](docs/INTEGRATION-QUALIFICATION-MATRIX.md) · [synthetic acceptance scenarios](docs/ACCEPTANCE-SCENARIOS.md)
- **Architecture contracts**: [AI PMS architecture and delivery gates](docs/AI-PMS-ARCHITECTURE.md) · [hardware and claims qualification](docs/HARDWARE-AND-CLAIMS-QUALIFICATION.md)
- **Delivery**: [roadmap](docs/ROADMAP.md) · [foundation status and Supabase provisioning](docs/SETUP.md)
- **Evidence**: [research ledger and its limits](docs/RESEARCH.md) · [Tab32 coverage and remaining gaps](docs/TAB32-ANALYSIS-COVERAGE.md)

### What was observed of the incumbent

Read-only observation of Tab32 through an authenticated session. Structure and vocabulary only; no patient data is published.

- [Authenticated surface map](docs/TAB32-AUTHENTICATED-MAP.md) — routes, overlay screens, menus, field inventories
- [HTTP surface and conventions](docs/TAB32-API-SURFACE.md) — endpoint inventory and the conventions we will not copy
- [Domain model observations](docs/TAB32-DOMAIN-MODEL.md) — auditable entity taxonomy, payment plans, scheduler
- [State vocabularies and access control](docs/TAB32-STATUS-VOCABULARIES.md) — appointment statuses, form fields, permission matrix

### Implementation plans

One per roadmap workstream, all conforming to [shared contracts](docs/SHARED-CONTRACTS.md):

| Workstream | Plan |
|---|---|
| F: platform core | [platform foundation](docs/superpowers/plans/2026-11-03-platform-foundation.md) |
| S: patients and scheduling | [scheduling and patients](docs/superpowers/plans/2026-11-04-scheduling-and-patients.md) |
| C: clinical record | [clinical record](docs/superpowers/plans/2026-11-04-clinical-record.md) |
| B: billing and RCM | [billing and RCM](docs/superpowers/plans/2026-11-04-billing-and-rcm.md) |
| I: imaging and devices | [imaging and devices](docs/superpowers/plans/2026-11-04-imaging-and-devices.md) |
| E: engagement and portal | [portal and communications](docs/superpowers/plans/2026-11-04-portal-and-communications.md) |
| A: API, MCP and AI | [API, MCP and AI](docs/superpowers/plans/2026-11-04-api-mcp-and-ai.md) |
| M: migration and operations | [migration and operations](docs/superpowers/plans/2026-11-04-migration-and-operations.md) |
| R: supported release | [supported release](docs/superpowers/plans/2026-11-04-supported-release.md) |

A plan existing is not a plan approved. Every plan carries open decisions and blocked-on-discovery items, and the readiness review records that none of the release gates is evidenced.

- [Assurance targets: ISO 27001, ISO 42001 and open-source controls](docs/ASSURANCE-AND-CERTIFICATION.md)

## Proposed technical direction

Web-first TypeScript application and API, PostgreSQL transactional core, Supabase services with a self-hosting path, and an optional native device companion. Rust is a candidate for the companion; actual vendor SDK requirements determine adapters. This is an engineering recommendation, not a benchmark result or an implemented architecture.

Broad incumbent research is closed. UI design remains deferred until separately requested and does not block synthetic backend foundation work. Application implementation requires a separate explicit start instruction; module qualification and clinical validation remain required.

## License

Copyright (c) 2026 CuspAtlas contributors. Licensed under **AGPL-3.0-or-later**; see [LICENSE](LICENSE). The core license is an initial maintainer choice intended to preserve open access to network-service modifications. Third-party services and terminology datasets retain their own terms. CuspAtlas is independent of and not endorsed by Tab32.
