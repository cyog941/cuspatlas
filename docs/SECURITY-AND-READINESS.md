# Security, clinical readiness and operations

This is a security design and release gate, not a compliance certification. No PHI is authorized in this development foundation.

## Deployment obligations

HHS describes administrative, physical and technical safeguards and risk analysis obligations. Cloud providers handling ePHI generally require an appropriate BAA even when they cannot decrypt the data. Supabase specifically requires a signed BAA and its HIPAA add-on for projects handling PHI. A free developer project, RLS alone, or encryption alone does not meet the overall obligation. Verify the contract's covered services, subprocessors and region before a production decision. [HHS Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html), [HHS cloud guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html), [Supabase HIPAA](https://supabase.com/docs/guides/platform/hipaa-projects).

Self-hosting transfers operations responsibility to the operator. Supabase's local CLI development stack is not its hardened production deployment. Validate secrets, network exposure, backups, TLS, upgrade procedures and monitoring separately. [Self-hosting guidance](https://supabase.com/docs/guides/self-hosting).

## Threats and required controls

| Threat | Required control | Release evidence |
|---|---|---|
| Cross-practice or cross-patient access | Server-derived context, scoped membership, RLS, private storage and constrained portal grants | Negative tests for DB/API/MCP/jobs/export/realtime |
| Stolen staff session | MFA, inactivity policy, revocation, step-up for sensitive actions | Revoked and expired token tests across all surfaces |
| Privileged service compromise | Least-privilege runtime role, private domain schemas, isolated deployment, secret rotation | No BYPASSRLS in ordinary paths; credential rotation drill |
| Clinical history corruption | Signed versions, append-only amendments, explicit correction reasons | Concurrent signature/amendment tests and clinician review |
| Double billing or money loss | Transactional journal, decimal money, idempotency, external reconciliation | Ledger invariant/property tests and controlled retry failures |
| Data leakage through files | Private buckets, scoped signed URLs, malware quarantine, MIME/size checks | Cross-tenant object URL, revoked URL and malicious upload tests |
| AI data exfiltration | External policy, narrow tools, approved destinations, minimum context | Prompt-injection/red-team evaluation and egress review |
| Device compromise | Pairing, signed updates, allowed jobs/paths, restricted capabilities | Device revocation, update integrity and path traversal tests |
| Ransomware or operator mistake | Encrypted independent backups, integrity checks, restore runbook | Timed restore into isolated environment and reconciliation |
| Insider abuse | Read/export/admin audit, least privilege, access review, break-glass review | Alert exercises and periodic review records |
| Supply-chain change | Lockfiles, provenance/SBOM, dependency/license scanning, reviewed releases | Signed release artifacts and reproducible build evidence |

## Audit and logging

Audit clinical reads/exports and all mutations/permission changes with actor, principal type, tenant, operation, target references, timestamp, correlation ID, outcome and purpose where needed. Sensitive audit content is itself protected. Ordinary logs contain no patient names, notes, tokens, query bodies or URLs with identifiers. Audit storage is append-only to application roles; production tamper resistance needs independent restricted/WORM or equivalent retention, tested access separation and monitoring. A hash chain alone does not protect against an attacker who controls both data and keys.

## Supabase-specific future checks

All exposed tables need grants AND explicit RLS. Private schemas also use RLS as defense in depth. Never authorize using user-editable metadata. Views must respect caller security where exposed. Keep privileged functions private, minimize SECURITY DEFINER, fix search paths and revoke default execution. Use publishable keys only in public clients. Recheck session/membership freshness for sensitive actions. Test pooling and transaction-local context. Storage/realtime need independent policies. Run security advisors and resolve findings before staging or production deployment.

## Clinical and legal boundaries

Dentists validate chart semantics, note/signature rules, alert handling and treatment state. AI drafts never silently become signed notes or diagnoses. Prescribing and controlled-substance support require a qualified partner and applicable requirements; no claim of certification is made. Payer transaction guides and CDT terminology rights must be reviewed before implementing/distributing those adapters or datasets. Retention is configurable by jurisdiction, patient age, record type and legal hold; do not apply one universal deletion period. Professional/legal review is a release dependency.

## Production gate: all must be evidenced

1. Named accountable operator, clinician reviewer and security owner; staff training and access review.
2. Risk assessment, incident/breach procedures, contracts and service-level obligations reviewed.
3. Independent penetration test and tenant/portal/agent isolation tests; critical issues resolved.
4. Backup/restore, downtime and disaster exercises meet agreed recovery targets.
5. Device/integration sandbox certification for the actual pilot environment.
6. Synthetic end-to-end scenarios pass, then a supervised practice validation plan is approved.
7. Migration totals, balances, images, history and unresolved exceptions reconciled; rollback/cutover plan approved.
8. Privacy-aware observability and actionable on-call support; no model or vendor outage silently drops work.
9. Verified patient export and exit path, including attachments and history.
10. Explicit PHI deployment and cutover authorization. Passing local tests is not this authorization.
