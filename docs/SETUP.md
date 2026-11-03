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
- Proposed new Supabase development project: `cuspatlas-dev`, US East (Ohio), `us-east-2`.
- Organization selected explicitly by the user: Santi.
- Supabase quoted $0/month but rejected creation due to the owner's **two active free-project limit**. No new project ID or URL exists. No existing project was paused, deleted or modified.

## Resolve the cloud blocker

Choose an authorized capacity/billing change or defer cloud creation. Never repurpose an existing client database or evade the account limit. For any nonzero cost, obtain the current quote and explicit approval before spending. After capacity is available, create the new named project in the selected organization and verify its identity/region/readiness. Record only non-secret project identifiers in this file.

Initial cloud environment must be labeled synthetic-data development. Do not claim PHI readiness from the free plan. Before product work starts, review Data API exposure, auth redirect allowlists, invite/signup policy, storage defaults, network controls and credentials. Since there are no application tables or users yet, do not invent RLS policies or enable an application login surface now.

## Local development path after implementation authorization

Inventory Docker/WSL, supported Node LTS, package manager and Supabase CLI versions, then pin documented versions. Initialize the development stack only after the build is authorized. Local development is a valid fallback for synthetic work while cloud capacity is pending; it is not a production deployment or a workaround for managed limits.

Do not copy production data into local or preview environments. Keep `.env` and connection secrets outside Git. `.env.example` is only a placeholder inventory, not a functional configuration. Production credentials must be distributed using a secrets manager, not public documentation or AI prompts.

## Setup readback checklist

- Verified: GitHub URL, owner, public visibility, AGPL license, default branch and pushed commit.
- Verified: eight planning issues reference acceptance requirements; no claims of shipped functionality.
- Verified: tracked-file review and targeted secret/private-ID scan; raw captures are ignored.
- Verified: Supabase creation failed and a subsequent project listing showed only the existing projects.
- Future changes require tests appropriate to their impact; do not scaffold the app to make setup look complete.
