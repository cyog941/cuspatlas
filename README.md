# CuspAtlas

An open-source dental practice platform being planned for US general dentistry.

**Status: planning only. No application, clinical database, API, or UI has been built. Do not use this repository for patient care or upload patient information.**

CuspAtlas is a working name: a tooth's cusp + an atlas of practice operations. The name is provisional; an initial exact-name web/GitHub search found no competing project, but does not establish trademark or domain availability.

## Purpose

Give dental practices ownership of their data and software, complete practice workflows, and secure programmatic access without a software-license paywall. Self-hosting is a first-class objective. Hosting, hardware, support, communications, payer connections, prescribing, and model inference still have real costs.

## Read first

- [Product and architecture design](docs/superpowers/specs/2026-11-03-dental-pms-design.md)
- [End-to-end capability and acceptance matrix](docs/CAPABILITIES.md)
- [API, MCP, and automation contract](docs/API-AND-MCP.md)
- [AI PMS architecture, capability contracts and delivery gates](docs/AI-PMS-ARCHITECTURE.md)
- [Security and clinical-readiness gates](docs/SECURITY-AND-READINESS.md)
- [Research evidence and its limits](docs/RESEARCH.md)
- [Authenticated Tab32 surface map](docs/TAB32-AUTHENTICATED-MAP.md)
- [Tab32 HTTP surface and conventions](docs/TAB32-API-SURFACE.md)
- [Tab32 domain model observations](docs/TAB32-DOMAIN-MODEL.md)
- [Foundation status and Supabase provisioning](docs/SETUP.md)
- [Delivery sequence](docs/ROADMAP.md)

## Proposed technical direction

Web-first TypeScript application and API, PostgreSQL transactional core, Supabase services with a self-hosting path, and an optional native device companion. Rust is a candidate for the companion; actual vendor SDK requirements determine adapters. This is an engineering recommendation, not a benchmark result or an implemented architecture.

UI design is intentionally deferred to the final planning stage. Application implementation requires a later explicit start instruction.

## License

Copyright (c) 2026 CuspAtlas contributors. Licensed under **AGPL-3.0-or-later**; see [LICENSE](LICENSE). The core license is an initial maintainer choice intended to preserve open access to network-service modifications. Third-party services and terminology datasets retain their own terms. CuspAtlas is independent of and not endorsed by Tab32.
