# Foundation status and provisioning handoff

Date: 2026-11-03.

## Current state

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

- GitHub URL, owner, visibility, license, default branch and commit verified.
- Planning issues link to acceptance requirements; no claims of shipped functionality.
- Repository documentation excludes PHI, private URLs, raw captures and credentials.
- Supabase blocker accurately recorded until a real project exists.
- Future changes require tests appropriate to their impact; do not scaffold the app to make setup look complete.
