# Open platform, deployment and service onboarding

Status: user-directed requirements, 2026-11-04. Planned, not implemented or production-qualified. UI design remains deferred. This defines behavior and acceptance criteria, not screen designs or authorization to change active builds or provision services.

## Non-negotiable commercial boundary

All CuspAtlas software features remain free and open source, including clinical, financial, claims, AI/automation, connectors, API/MCP, security, administration, migration, deployment tooling, backup/recovery and export. No proprietary feature keys, seat-based feature gates, paid-only connectors, security tiers or vendor-account requirement to run supported self-hosted software. Legitimate authorization, safety controls and provider quotas are not license gates.

Paid offerings are setup (including migration/onboarding assistance), hosting/managed operation, and support (including training and troubleshooting). They buy service and accountability, not additional software capabilities. Essential security fixes and supported release artifacts remain publicly available. Do not introduce a paid-only control plane that is necessary to operate or update the open product.

Third-party infrastructure, clearinghouses, payment processors, prescribing, messages, hardware/SDK licenses and model inference can carry costs and restrictions. Publish those separately and clearly; free software is not unlimited free service usage. Do not redistribute third-party binaries, standards or terminology without rights. A qualified externally licensed service may be needed to perform an operation, but our adapter and capability must not require a CuspAtlas paid tier.

## Three deployment options, one product

| Mode | Ownership and operation | Paid service |
|---|---|---|
| Self-managed | Practice or its chosen IT operator controls deployment, database and provider accounts | None required; optional setup/support |
| Managed in practice-owned infrastructure | Practice owns infrastructure/accounts; delegated operator access is limited and auditable | Setup, managed operation and support |
| Hosted by us | We operate a clearly scoped service with contracts, recovery and tenant isolation | Hosting, setup and support |

Publish the same versioned application and adapter contracts for all modes. Differences in hosting capacity, operational responsibility and purchased vendor services must be visible, not disguised as software feature tiers. Self-hosters do not inherit our certifications, agreements or operational assurances.

## Bring your own database safely

BY-01: support a published PostgreSQL version/extension matrix and qualified Supabase configurations. "Bring your own DB" means a dedicated compatible target with our schema, not arbitrary MySQL/SQL Server support or reading an incumbent's live database. A database is only one dependency: API service, workers, authentication, private object storage, secrets, backups and monitoring also need configuration.

BY-02: a guided preflight checks TLS/identity, database version, required extensions, permissions, connectivity, region/operator choices and existing contents without modifying them. Show an understandable result with exact corrective steps. Reject unknown/non-dedicated targets; never overwrite unrelated tables or assume the current browser project is ours. No production migration occurs from an unauthenticated connection test.

BY-03: propose a versioned setup/change plan, obtain authorized operator confirmation for consequential changes, then apply resumable migrations with integrity checks and an auditable receipt. Use separate short-lived bootstrap/migration privileges and a restricted runtime role. Do not retain owner/superuser credentials for normal operation. Verify grants/RLS with negative tests before reporting ready.

BY-04: provide validated deployment templates, environment checks and secure configuration generation. Credentials stay server-side in a secret-store adapter; no plaintext secret exports, client bundle secrets, MCP results or logs. Separate demo/test/live and verify environment identity on reset, restore and migration. Runtime grants must never include migration authority by convenience.

BY-05: verify backup destinations, encryption/key custody, restore into a separate target, schema/version compatibility, upgrade health and rollback limitations. Protect object storage as well as PostgreSQL; a database-only backup is not a complete practice backup. Name the qualified operator and show last successful backup/restore evidence. Never label a local development stack production-ready.

## Connections center requirements

CN-01: define a versioned connector capability registry: service category, supported operations, configuration schema, auth method, scopes, environment, data categories, owner, provider prerequisites, enrollment, rate limits, fees, health probes, webhook validation, rotation/revocation and qualified versions. Prefer scoped OAuth where supported; API keys are accepted only through protected server-side configuration. Not every provider supports OAuth or the same services.

CN-02: expose plain-language onboarding states: not configured, needs authorization, needs verification/enrollment, test ready, live qualified, degraded, expired/revoked and disabled. A successful API ping is not live qualification. Return a safe reason and next action; distinguish unavailable capability from empty data.

| Connection | Guided setup and qualification |
|---|---|
| Email | Sender/domain verification, applicable authentication records, test delivery, bounce/complaint handling and safe content policy |
| SMS/voice | Numbers, applicable registration, consent/opt-out, sender identity, delivery callbacks and channel costs |
| AI | Provider/model, approved data/egress/retention policy, budget, use-case evaluation and manual fallback |
| Claims/eligibility | Clearinghouse credentials, provider/location/payer enrollment, per-service coverage, attachments, test transactions, status and remittance |
| Payments | Processor authorization, tokenization boundaries, verified callbacks, settlement and reconciliation; never accept raw card data into general configuration |
| Prescribing | Qualified partner, prescriber enrollment/identity and permitted operations; an API key alone is insufficient |
| Imaging | Companion pairing, exact software/device qualification and patient-context/image-return validation |
| Storage/backups | Private access, object integrity, retention/key custody and verified recovery |

CN-03: a connection test is read-only by default. Any test that sends a message, creates a charge or submits a transaction requires an explicitly identified sandbox/test recipient and preview of the effect. No live patient outreach or fees as a surprise during setup. Reject caller-selected arbitrary destinations that could probe internal networks; use qualified endpoint configuration and SSRF protections, including redirect handling.

CN-04: show usage, quotas, budget/limit alerts, last successful operation, failures and recovery instructions. Rotate credentials without losing in-flight receipts; revocation cancels unauthorized queued work and preserves reconciliation history. Connector outage does not disable unrelated clinical workflows. Credentials cannot be exposed through exported configuration; reauthorization is part of migration between operators.

CN-05: maintain one connection authority across UI, REST, MCP and jobs. Routine health/status discovery is scoped; credential onboarding and rotation require privileged human/operator authorization or a narrowly delegated administrative principal. Models never receive raw secrets. Test cross-tenant connection references, revoked administrators, replayed callbacks and masked-secret updates.

## Easy setup, clear accountability

ON-01: provide a resumable checklist with safe defaults, saved non-secret progress, readiness explanations and advanced options only when needed. Reuse existing configuration; do not ask a dentist to understand connection strings or reconcile infrastructure logs. Offer an operator handoff bundle with redacted diagnostics, desired configuration and unresolved steps. UI layout is designed later.

ON-02: separate connected, tested, qualified and production-authorized states. Required operator, contracts/BAAs, security review, recovery and practice cutover authorization remain gates. No automated checklist can certify legal compliance. Explain vendor-enrollment delays and expected external costs before migration commitment.

ON-03: support access is explicit, least-privilege, time-limited and audited, with reason, approving party, expiry and revocation. No permanent universal vendor backdoor. Support staff see only what the approved session requires; production data never enters public issues or uncontrolled diagnostics.

ON-04: ending paid support must not disable software, security controls, APIs or exports. Hosted termination follows disclosed retention/access and handover terms; it does not promise indefinite free hosting. Provide versioned data/configuration manifests, object files/checksums, documented migration and credential reauthorization. Practice-owned infrastructure remains operable after our delegated access is revoked. No external license-validation service is required to keep self-hosted software running.

## Execution ownership and acceptance

| Plan | Required additions before affected implementation |
|---|---|
| F | Environment identity, runtime/bootstrap separation, secret interface and synthetic safe-configuration tests; no cloud provisioning by default |
| A | Connector registry and versioned setup/health/rotate/revoke contracts; shared policy and audit; no-tier parity for all operations |
| M | BY-01–05 deployment preflight, resumable migrations, complete backup/upgrade/recovery and ON-04 handover |
| B/E/I | Category-specific enrollment, safe tests, webhook receipts, outage/revocation behavior and truthful capability status |
| R | Equivalent feature availability, supported self-hosted installation, support revocation, evidence of restore/handover and later onboarding usability measurements |

Required synthetic tests: invalid/unsupported database, existing unrelated data, interrupted migration, insufficient runtime privilege, spoofed target, missing object backup, expired key, key rotation during delivery, malicious endpoint/redirect, unauthorized connection change, duplicate callback, failed enrollment, fake provider quota, cancellation of support, export/reimport and removal of operator access. Assert no license key unlocks software and no call to a commercial control plane is required for supported self-hosted operation. Preserve legitimate provider billing and security limits.

Before shipping, document supported deployment combinations and reproduce installation/upgrade/restore on them. Measure setup completion, operator/practice time, failed steps and support interventions; set thresholds before usability evaluation. "Plug and play" and "all features" are product commitments to implement, not claims that every third-party service works without qualification.
