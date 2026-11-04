# DeepSeek harness handoff

Objective: finish evidence-backed product discovery and the build-ready specification package for CuspAtlas. Do not implement the product or design UI during this research phase. UI is the last planning stage and needs a separate instruction.

## Current assets and boundaries

- Repository: https://github.com/cyog941/cuspatlas . Start from current main, read AGENTS.md, README.md and docs/SETUP.md.
- Existing product spec: docs/superpowers/specs/2026-11-03-dental-pms-design.md.
- Existing implementation plan: docs/superpowers/plans/2026-11-03-platform-foundation.md. This is the platform foundation plan, not a complete executable plan for every PMS module.
- Coverage and evidence: docs/TAB32-ANALYSIS-COVERAGE.md and docs/RESEARCH.md.
- Requirements: docs/CAPABILITIES.md, docs/API-AND-MCP.md, docs/SECURITY-AND-READINESS.md and docs/ROADMAP.md.
- Supabase development project exists under Santi: cuspatlas-dev, reference pfnuigldoshdldetkaqk, region us-east-2. Reverify live status before using it. Do not use another client project, add production data or apply schemas in this phase.
- REA 6.8.0 and Craft Anything 0.3.0 were installed locally and public-page captures succeeded. Installed versions and paths must be reverified on the new host. Their MCP registration does not transfer automatically between harnesses.
- Authenticated inspection used browser controls. Direct authenticated REA/Craft capture has NOT succeeded. An isolated browser launch was policy-rejected even after explicit user approval. Do not disguise/reissue the rejected operation through another tool. Resolve supported access through the host's documented configuration and administrative process.
- Existing local Craft investigation: .research-local/tab32-study.cany. This ignored directory is not available from a Git clone. It contains public capture evidence; do not assume a new MCP session automatically loads it.

## Ordered work

1. **Prepare the harness.** Identify its actual product/version, supported MCP transports, browser integration and file/terminal permissions. Configure version-pinned REA and Craft using their documented installation and registration paths. Read their skills. Verify tools/list and benign session-status calls. Do not guess a DeepSeek-specific config format: a model name does not identify the host runtime.
2. **Resolve analysis access.** Use a supported, approved browser connection. Sign in normally; never transfer cookies or credentials. Verify both tools identify the same intended Tab32 target before claiming attachment. Keep capture local, bounded and data-minimized. Do not send patient records to a new model provider merely because it powers the harness. Use a vendor demo/sandbox or synthetic environment for data-bearing captures unless the actual data-processing arrangements have been approved.
3. **Create a coverage plan.** Use TAB32-ANALYSIS-COVERAGE.md as the starting backlog. For each domain define the question, entry screen, role, happy path, exception, evidence method and stop condition. An unavailable feature is an explicit unknown, not proof it does not exist.
4. **Inspect the complete supported workflow.** Cover intake/identity/guardians, appointment requests and scheduling, huddle, medical history, odontogram/perio, treatment alternatives and estimates, consent, notes/signing/amendments, imaging/labs/referrals, eligibility/claims/appeals/ERA, ledger/allocations/refunds/payment plans, statements, recall/communications, reports, roles/audit and configuration. Use read-only production observation; transaction tests belong in a sandbox. The user permits a new clearly synthetic demo patient if needed, but never relabel a real patient. Check automatic messaging/enrollment before creating anything; leave reachable contact details absent. Do not sign clinical notes or post payments/claims to test production.
5. **Record evidence and gaps.** Preserve local evidence IDs and coverage limits. Publish only original, de-identified workflow summaries. Separate observed UI, observed behavior, vendor claims, historical references and proposed design. Do not publish vendor source, private URLs, patient details or captures. A menu label does not prove validation, authorization or persistence.
6. **Qualify integrations and migration.** Build a matrix for clearinghouse, eligibility, prescribing, payments, messaging, imaging hardware and exports. Record access requirements, supported interface, sandbox, cost model, contractual/data-processing requirements, owner, fallback and pilot necessity. Validate an authorized synthetic export/import sample; define reconciliation and archive expectations. Unavailable commercial access remains a release gate.
7. **Revise domain and security design.** Specify entities, state transitions, actor/role/location permissions, invariants, API/MCP operation parity, idempotency, audit, clinical amendments, financial reversals, retention, downtime and restore requirements. Keep web-first TypeScript/PostgreSQL and optional native bridge as the current recommendation; revise only with evidence and an explicit decision record.
8. **Complete the build plan.** Preserve the detailed foundation plan and add reviewed plans for patients/scheduling, clinical, billing/RCM, imaging, portal/communications and migration/operations. Each task needs dependencies, proposed file/module boundaries, contracts, synthetic acceptance cases, failure/recovery cases and an observable completion condition. Separate discovery spikes from implementation tasks. Do not invent vendor contracts to make a plan appear complete.
9. **Review readiness.** Have clinical, reception, billing and operations reviewers validate their workflows. Run a document consistency, link, provenance and sensitive-data audit. Reconcile repository issues with actual completed provisioning and remaining gates. Present unresolved decisions with a recommended option and the evidence needed to settle them.
10. **UI last, then build.** Deliver the research/spec/plan package for review. Only after the user separately authorizes UI design, design and validate the end-to-end interactions using synthetic scenarios; feed usability corrections back into contracts. Start application implementation only on an explicit build instruction.

## Required final package

- Updated research ledger and domain-by-domain coverage matrix with evidence references.
- Complete workflow/state/role matrix and original capability requirements.
- Integration/device/migration qualification matrix with accountable owners and unresolved gates.
- Revised product architecture, domain/security and API/MCP specifications.
- Synthetic acceptance scenario pack, including an ordinary practice day and exceptions.
- Dependency-ordered implementation plans for all release workstreams, not just the platform core.
- Decision log, risk/unknown register and concise readiness review.
- Updated GitHub issues and README links; no product code or clinical schemas.

## Completion standard

Research complete does not mean production ready, clinically validated or fully reverse engineered. For the requested REA/Craft deliverable, both tools must have their own successful authenticated evidence, or that requirement remains explicitly blocked. For planning readiness, every first-release capability must map to a specification, permission/state rules, acceptance scenario and implementation task. Unknown vendor behavior must have an owner and a resolution gate; it must not silently become an assumed fact. Real-practice cutover requires additional clinical, financial, integration, migration, security and operational validation after implementation.

## Starter instruction for the new agent

Read AGENTS.md and docs/DEEPSEEK-HANDOFF.md, then inspect the current repository and connected tools. Continue the existing CuspAtlas research and planning work without starting over. First verify your actual MCP/browser capabilities and establish approved access for REA and Craft; do not bypass prior execution restrictions. Keep production observation read-only and use synthetic/demo data for captures and tests. Complete the coverage matrix, revise the spec, and produce executable plans for every first-release workstream. Do not design UI or build application features yet. Report evidence, limitations and the next required user action accurately; never describe browser-only inspection as authenticated REA/Craft analysis.
