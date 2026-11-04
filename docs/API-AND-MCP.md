# API, MCP and automation design contract

Proposal only. There are no working endpoints or tools in this repository.

## One authority

UI, integration clients, SDKs, MCP and background jobs call the same domain command/query layer. Transport adapters cannot bypass tenant policy, clinical signing rules, financial constraints or audit. Database administration is a separate operator function, never an MCP capability exposed to ordinary agents.

OpenAPI and JSON Schema define versioned REST inputs/results/errors. The MCP schema is generated or mechanically checked against the same contracts. TypeScript types alone do not validate network input. Use resource-specific commands rather than generic unrestricted CRUD.

## Identity and scopes

- Human sessions: MFA for staff, short-lived tokens, server-side session validation for sensitive actions, explicit tenant membership and role checks.
- Patient portal: patient/guardian/proxy grants, not staff roles. Never infer access solely from family phone/email.
- Integration principals: tenant-bound service accounts with named owner, purpose, scopes, expiration, rotation and immediate revocation. Background jobs reauthorize at execution, not only enqueue time.
- Remote MCP: OAuth with resource/audience validation, minimal scopes and consent per deployment. Validate the then-current MCP authorization specification during implementation. Local stdio tooling uses a constrained credential, not database administrator secrets.
- Permission examples: patients.read, appointments.read/write, notes.draft, notes.sign, ledger.read, payments.execute, claims.submit, messages.send, exports.create, access.manage. Scope alone is insufficient: resource/location/relationship/purpose policy also applies.

## Examples of intended parity

| Business operation | REST concept | MCP concept | Policy |
|---|---|---|---|
| Search patients | GET /v1/patients with bounded filters | patients_search | Minimum fields; prevent enumeration; audit sensitive access |
| Find valid opening | POST /v1/availability/search | availability_search | Read only; resource/type/duration/timezone explicit |
| Book appointment | POST /v1/appointments | appointments_create | Idempotency and conflict recheck; notification choice explicit |
| Reschedule | POST /v1/appointments/{id}/reschedule | appointments_reschedule | Version check, history link, message policy |
| Draft clinical note | POST /v1/encounters/{id}/note-drafts | notes_draft | AI output is draft; source references retained |
| Sign/amend note | POST /v1/notes/{id}/sign or /amendments | notes_sign / notes_amend | Authorized clinician, current version, signing confirmation |
| Post/refund money | POST /v1/payments or /refunds | payments_create / payments_refund | Finance scope, policy approval, external idempotency, receipt |
| Submit claim | POST /v1/claims/{id}/submit | claims_submit | Validated claim version and partner authorization |
| Send outreach | POST /v1/messages | messages_send | Recipient/content/channel preview, consent, budgets, approved scope |
| Export practice data | POST /v1/exports | exports_create | Elevated scope, job audit, private short-lived delivery |

Names are proposals, not implemented endpoints. All other matrix operations require a corresponding contract before feature acceptance. No hidden UI-only business functionality.

## Execution guarantees

Every mutation receives an idempotency key and request correlation ID; store actor, tenant, operation, payload digest, result and bounded retry retention. Reusing a key with different content fails. Use expected record version/ETag; conflict returns a structured 409 with safe reconciliation guidance. Client-supplied tenant values never establish authority.

High-impact tools support prepare/commit: a server-created proposal binds operation, payload digest, actor, affected records and versions, expiry, policy version and approval identity. Commit rechecks permissions and versions. A stale proposal fails. Read-only discovery must not enqueue actions. Bulk operations expose count, scope, per-item outcome and bounded batches; a partial failure is not atomic success.

Responses include stable error code, retryability, correlation ID and safe field detail. Use cursor pagination, explicit projection and rate limits. Do not leak record existence across tenants through status codes, counts or timing where practical. Webhooks are versioned, signed, timestamped, replay-resistant and delivered at least once; consumers must deduplicate. Credentials and full PHI do not appear in webhook metadata by default.

## AI boundaries

The [AI PMS architecture contract](AI-PMS-ARCHITECTURE.md) defines capability dependencies and release evidence. Every AI capability consumes these same domain contracts; no separate privileged agent implementation is allowed. Protected proposals retain source versions and final disposition. Changes to approved payloads invalidate approval; automation cannot approve its own elevated actions. Deterministic services supply balances, availability and other authoritative calculations.

No arbitrary SQL, shell, general file reader, unrestricted HTTP proxy or impersonation tool. Allowlist external connector hosts and block private-network/metadata SSRF destinations. Treat imported records, images, OCR and retrieved text as data, never instructions. Enforce authorization outside the model. Tenant-specific retrieval and embeddings must obey retention and deletion rules.

Default AI workload is draft-only. Practices choose providers and policies; PHI is sent only to approved services with appropriate contractual and technical controls. Disable training/retention where the selected service contract supports it and verify the actual configuration. Track model/prompt version, sources, actor, review and final disposition without copying PHI into operational logs.

The Supabase development MCP connector used by maintainers is distinct from the future CuspAtlas clinical MCP service. Never distribute the former as the latter.

## Contract acceptance suite

Cross-tenant references; revoked membership during job execution; role downgrade with unexpired token; expired proposal; forged approval; repeated webhook; conflicting request key; concurrent reschedule; message opt-out between prepare and send; incomplete external payment response; PHI in errors/logs; malicious note attempting prompt injection; patient-portal privilege escalation; unauthorized export download.
