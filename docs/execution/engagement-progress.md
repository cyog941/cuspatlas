# Portal and communications execution ledger (workstream E, batch 1)

Branch: `codex/e-portal-1` in an isolated worktree outside the OneDrive-synced checkout. Base SHA: `3b76ad0` (foundation, complete workstream S and main's practice-time docs; 953 tests + 13 todo). Sibling workers build C and B on other branches. Status values: not started, in progress, blocked with cause, verified. Nothing is prechecked.

Authorization basis: user instruction to build every backend workstream on synthetic data until only the UI phase remains. Scope of this batch: E1, E2, E3, E6 and E7 against a fake messaging provider. Synthetic patients and synthetic contacts only (`.invalid` email domains, 555-01xx phone numbers); no Supabase cloud connection, no host installs, no real network egress. E-S1 (messaging qualification), E-S2 (telephony) and E-S3 (portal identity proofing) are **blocked-on-discovery**; consent, suppression, retention and the other legal or compliance choices below are implemented as **recommended-pending-approval** and need reviewers who were not available. Nothing here is approved, deployed, compliant or clinically validated.

## Batch status

| Task | Status | Commit | Notes |
|---|---|---|---|
| E1 portal principals and the grant projection | verified on synthetic data (Windows host); E-S3 blocked-on-discovery | see E1 | proofing level `unverified-synthetic` |

## E1 (portal principals and the grant projection)

Files: `supabase/migrations/20261110000000_portal_principals.sql`, `packages/contracts/src/engagement.schema.json` and `engagement.ts`, `packages/db/src/portal-identity.ts`, `packages/domain/src/engagement/{common,codecs,service,index}.ts`, `packages/domain/src/engagement/portal/{access,principals,session}.ts`, `apps/api/src/routes/{engagement-ops,portal-ops,portal-routes}.ts`, `apps/mcp/src/tools/engagement-ops.ts`, `tests/integration/portal-grants.test.ts`, `tests/integration/engagement-negative-harness.test.ts`, `tests/integration/support/engagement-fixtures.ts`.

Design. A portal principal is a `cuspatlas.principals` row of the new kind `portal` plus a `portal_principals` row binding it to exactly one person record (a patient-identity record of the tenant; S5's counterparty model, so no non-patient person register). It is authenticated by the same EdDSA verifier with a distinct portal audience (`portalIdentity`; the server refuses to boot if it equals the staff audience), and the portal authenticator loads the subject's live enrolment in the token's tenant. The portal context carries principal `portal` and no scopes: no staff action policy admits it, the staff authenticator finds no membership for it, and the database refuses a membership row for a portal principal (trigger, SQLSTATE 42501). The tenant-transaction runner rechecks the live portal enrolment instead of a membership inside every transaction. Enrollment, verification and revocation are staff commands (`portal.principals.enroll` / `verify` / `revoke`, new scope `portal.manage`); invitations of grantees and grant revocation are S5's own `patients.relationships.add` / `revoke` (no second grant command, no grant table, no expiry job). Grants are a projection of S5 relationship rows through `relationshipView` (grantRef = relationshipRef). Acting for another patient calls S5's `evaluatePatientAccess` with the relationship rows share-locked, inside the command's own transaction; acting for the person record itself needs the person to have reached the tenant's age of majority, computed with S5's policy and majority rule (fail closed on a coarse or unknown birth date).

Acceptance cases (`portal-grants.test.ts`, 11 tests, denials under the runtime role):

1. a verified principal is kind `portal`, bound to one person, proofing level `unverified-synthetic`; its session lists the guardian grant with grantRef = relationshipRef, scopes and status, the relationship appears exactly once in the staff S5 list and in the staff `portal.grants.list`; effective access is self plus the child; the marker in names never reaches logs, audit, outbox, attempts or idempotency rows;
2. an unverified principal is pending and its session is 403 with attempt `portal_contact_unverified`;
3. a household phone shared by two patients refuses enrollment (409 `shared_contact_ambiguous`) and creates no principal; a contact that is not on the person's record is 422 `contactNotOnRecord` (contacts are compared as S4 keyed digests, never as plaintext);
4. a request parameter cannot widen a grant (unknown query 400) and two grants for one patient (guardian scheduling + proxy demographics) yield one effective entry with the union of scopes;
5. lowering the tenant age of majority (S5 policy) turns the guardian grant into `expired` / `age_of_majority_reached` and gives the former minor self access; relationship and patient rows are kept;
6. an expired proxy (window ended) and a revoked guardian are listed with S5's status and grant nothing; both rows are kept;
7. revoking a principal denies its existing token at the next request (403 `membership_inactive`), and the principal reads as `revoked`.

Isolation and cross-transport (4 tests): an alpha principal under a beta token is refused exactly like an unknown subject; beta staff get 404 for an alpha principal and an alpha patient's grants; a portal token gets 401 from staff routes and MCP; a staff token gets 401 from the portal; a portal-audience token whose subject is staff is 403 `principal_kind_denied`; a staff-audience token for a portal principal finds no membership (403); the database refuses a staff membership for a portal principal; a portal context handed directly to a staff domain service is 403; one live principal per person (409 `portal_principal_exists`), an unknown person 404, a body carrying `tenantId` 400, and MCP returns the same refusal as REST.

Negative harness (`engagement-negative-harness.test.ts`): 5 staff rows (enroll, verify, revoke, read, grants list), each cross-tenant, revoked and downgraded on REST and MCP with the attempt reason and an unchanged write snapshot; a no-tenant-field check over every body and tool; every portal route against a staff token (401), an MCP token (401), a revoked principal (403), a pending principal (403), another tenant's token (403) and a staff subject on the portal audience (403); every staff E route and tool against a portal token (401). The harness rows were written with E1's implementation in place (they passed on their first run); the E1 suite itself was red first.

- Red: `corepack pnpm test -- tests/integration/portal-grants.test.ts` before implementation: exit 1, 11 failed (11).
- Green: same command exit 0, 11 passed; harness exit 0, 18 passed. `typecheck`, `lint`, `contract:check` exit 0; `corepack pnpm test` exit 0 over the E1 files: 44 files / 982 passed / 13 todo (the full run also contained the not-yet-committed E2 red file).

Shared files touched (minimal, append-only where possible): `packages/contracts/src/context.ts` (`PrincipalKind` adds `portal`; audit schema principal enum; three E1 reason codes), `packages/contracts/src/{index.ts,package.json}`, `packages/db/src/{tenant-transaction.ts,index.ts}` (portal branch of the in-transaction recheck), `packages/domain/src/{index.ts,commands/execute-once.ts,policy/authorize.ts}` (codecs, five staff policies), `packages/domain/src/patients/merge.ts` (one `MERGE_EXCLUDED_REFERENCES` entry, an S file), `apps/api/src/{app.ts,auth.ts,index.ts,contract-drift.ts,routes/manifest.ts}` (`verifyBearer` extracted unchanged from `createAuthenticator`), `apps/mcp/src/{server.ts,index.ts,tools/synthetic-tasks.ts}`, `docs/api/openapi.yaml` (generated E block), `tests/integration/support/appointment-fixtures.ts` (opt-in `portal`), `tests/integration/{tenant-isolation,mcp-parity}.test.ts` (new table, derived E tool names).

Deviations: the plan's `inviteGrantee` / `revokeGrant` are S5's commands themselves rather than delegating wrappers (one grant path); `PortalPrincipal.kind` is reported per accessible patient (`via`: self or the relationship kind) instead of one kind per principal; the plan's `portal_grants` migration is the principal table only (grants are a projection). A merge does not move a portal principal (registered exclusion): the merged identity's principal is denied (`portal_identity_merged`) and staff enroll the survivor.

Unresolved: E-S3 (assurance level, second factor, recovery path); a contact change on the person record does not yet flag the principal for review; patient-level confinement inside the tenant is enforced by the application policy layer (RLS isolates the tenant for portal transactions, not the patient).

## Pending decisions

| Decision | Recommendation implemented (pending approval) | Settles it |
|---|---|---|
| E-S3 / E-D2 portal assurance level | invitation to a contact already on the record, staff-attested verification (`synthetic_attested`), proofing level `unverified-synthetic`; no second factor yet | security owner and practice representative |
| E1 self access of a minor | denied until the tenant's age of majority (S5 policy), fail closed on coarse or unknown birth date | legal review per jurisdiction (with S-D4) |
| E1 merge of an enrolled identity | portal access never follows a merge; re-enroll the survivor | security owner |
