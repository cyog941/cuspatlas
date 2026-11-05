# Forbidden-operation matrix

Status: tested on synthetic data under the runtime role (A7), one Windows host. Evidence:
`tests/integration/api-forbidden-matrix.test.ts`; the run writes every case with its fingerprints to
`node_modules/.cache/a1-forbidden-matrix.json` (not committed).

The matrix is derived from the operation catalog, never hand-listed, so a new operation gets its rows
automatically and a catalog operation without rows fails the coverage check. Expected outcomes come
from the catalog's policy row; the REST and MCP refusals of one case must agree on outcome, refusal
code and internal reason. A surface that answers 5xx or cannot be reached is recorded as `unverified`
and fails, never counted as a correct denial. An injected divergence is reported with the surface and
field that differ.

| Operation class | Cases (each on the real transport) |
|---|---|
| staff (`authorize`) REST and MCP | human and service: a kind the policy excludes (full scopes) is `principal_kind_denied`; an admitted kind without the scope is `scope_missing`; REST and MCP identical. Human revoked membership (token issued earlier); a token naming another tenant than the membership. A portal principal's token and a device identity on the staff transport. |
| portal | a staff token; staff, service and device identities on the portal audience; the enrolled portal principal against a foreign patient where the route names one |
| bridge and pairing | staff human and service tokens and a portal token |
| worker and capability actions | the shared `authorize` the worker uses: human, service and portal kinds with all, no and revoked scopes; a resource in another tenant is `tenant_mismatch` |

AI boundaries asserted from the catalog and proven by the rows above: no MCP tool of a SQL, raw, shell,
exec, eval, file, filesystem, HTTP, proxy, fetch or impersonation kind; no service (agent) principal is
admitted to clinical writing, signing, amendment or oversight, money corrections (`billing.correct`),
merges, scheduling overrides, imaging association, deletion or legal holds, any `*.approve` operation
or any `*.export`; MCP carries staff operations only. Self-approval of an agent's own proposal and
approval by an agent are refused in `tests/integration/proposal-policy.test.ts`.

Reviewed reason exception: `syntheticTasks.proposals.approve` for a service principal is denied as
not-found (`resource_hidden_or_missing`) rather than `principal_kind_denied`, because the approval
loads the proposal first (self-approval is evaluated before scope, ADR 0010) and the matrix uses an
unknown proposal reference. It is still denied, identically on REST and MCP.

Not covered here (stays in the workstream harnesses): record-level cross-tenant reads and writes on
existing records, location limits, relationship expiry, membership revoked while a job was queued
(worker dispatch tests), and the UI path, which does not exist yet (the UI is deferred; when it
exists it must call the same command layer and join this matrix).
