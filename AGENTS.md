# CuspAtlas working rules

## Current boundary

This repository is in planning/foundation mode. The user authorized research, a GitHub repository, Supabase setup, specifications, and a build plan. Do not write product code, install application dependencies, create clinical schemas/migrations, deploy, or design UI until separately requested. Broad incumbent research is closed by user direction. UI design remains deferred until separately requested; it is not a prerequisite for separately authorized synthetic backend foundation work. Domain/workflow validation still gates affected clinical modules and user-facing release.

## Product commitments

- US general dentistry first; internationalization and specialties are extensibility requirements, not launch promises.
- Core PMS functionality, documented API, MCP, export, and self-hosting must not require proprietary feature keys.
- No real patient records, production exports, cookies, tokens, private account URLs, screenshots of patient charts, or licensed terminology datasets in Git, issues, logs, demos, or fixtures.
- Use synthetic data for development; free development hosting is not authorization for PHI.
- Copy workflow requirements, not a vendor's code, branding, imagery, or screen design.
- Mark evidence as live-observed, historical-reference, vendor-claimed, inferred, or proposed. Never promote one category silently.

## Future implementation invariants

- One application policy layer for UI, REST, MCP, workers, and integrations. RLS and constraints provide independent enforcement.
- No direct agent SQL or production Supabase service-role access. API parity means controlled business operations, not unrestricted database writes.
- Derive tenant and actor from authenticated context; recheck membership and resource access server-side. Never trust client tenant IDs or user-editable auth metadata.
- Patient identity, appointment request, booking, attendance, procedure completion, note signing, claim status, and payment allocation are separate facts.
- Preserve signed clinical history and posted financial history with amendments/reversals. No silent overwrites.
- Use decimal/integer-minor-unit money, explicit currency, IANA timezones, idempotency, optimistic versions, and database-backed resource conflict checks.
- Every permission-sensitive path needs negative cross-tenant, role, and revoked-access tests, including jobs, exports, storage and realtime.
- Pin dependency versions and lockfiles when implementation is authorized. Maintain provenance, licenses and security advisories.

## Completion language

Distinguish planned, configured, tested, approved, deployed, compliant, and clinically validated. Do not call this a production-ready PMS until every release gate has evidence.
