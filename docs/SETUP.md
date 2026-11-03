# Foundation status and provisioning handoff

Date: 2026-11-03.

## Current state

- Public GitHub repository: [cyog941/cuspatlas](https://github.com/cyog941/cuspatlas), default branch `main`, AGPL-3.0-or-later.
- [Eight planning issues](https://github.com/cyog941/cuspatlas/issues) cover pilot qualification, cloud capacity, contracts, migration, integrations, acceptance packs, deferred UI and future platform implementation.
- Private vulnerability reporting is enabled. `main` protection disables force-push/deletion and requires conversation resolution; administrator bypass remains available. Required CI checks/reviewers are not configured yet because no implementation CI or reviewer team exists.
- A separate GitHub Projects board was not created: the current GitHub CLI token lacks `read:project` scope. The issue backlog is usable without expanding token access.
- Repository contains planning, policy and setup documentation only.
- No application code, framework dependencies, SQL migrations, patient tables, deployments, API services or UI designs.
- Working name: CuspAtlas; provisional and replaceable.
- Created Supabase development project: `cuspatlas-dev`, US East (Ohio), `us-east-2`.
- Organization selected explicitly by the user: Santi.
- After the user upgraded Santi to Pro and authorized creation, `cuspatlas-dev` was created and independently verified ACTIVE_HEALTHY. Project reference: `pfnuigldoshdldetkaqk`; PostgreSQL 17.11.0.011. No existing project was changed.

## Cloud provisioning completed

Development project: [cuspatlas-dev](https://supabase.com/dashboard/project/pfnuigldoshdldetkaqk). The earlier free-project capacity blocker is resolved. No application schema or patient data was added.

Initial cloud environment must be labeled synthetic-data development. Do not claim PHI readiness from a Pro subscription. Before product work starts, review Data API exposure, auth redirect allowlists, invite/signup policy, storage defaults, network controls and credentials. Since there are no application tables or users yet, do not invent RLS policies or enable an application login surface now.

## Local development path after implementation authorization

Inventory Docker/WSL, supported Node LTS, package manager and Supabase CLI versions, then pin documented versions. Initialize the development stack only after the build is authorized. Local development is a valid fallback for synthetic work independently of managed cloud availability; it is not a production deployment or a workaround for managed limits.

Do not copy production data into local or preview environments. Keep `.env` and connection secrets outside Git. `.env.example` is only a placeholder inventory, not a functional configuration. Production credentials must be distributed using a secrets manager, not public documentation or AI prompts.

## Setup readback checklist

- Verified: GitHub URL, owner, public visibility, AGPL license, default branch and pushed commit.
- Verified: eight planning issues reference acceptance requirements; no claims of shipped functionality.
- Verified: tracked-file review and targeted secret/private-ID scan; raw captures are ignored.
- Verified: new Supabase project identity, selected organization, region and ACTIVE_HEALTHY status after creation.
- Future changes require tests appropriate to their impact; do not scaffold the app to make setup look complete.
