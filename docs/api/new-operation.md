# Adding an operation

Status: tested procedure for the synthetic build (A3). The scope granularity and default role grants
remain an open human decision (A-D2).

Every business operation exists once, in the operation catalog
(`packages/contracts/src/catalog/operations.json`, rendered in [operation-catalog.md](operation-catalog.md)),
whatever transport carries it. The catalog is generated; you change the code tables and regenerate.
`tests/integration/api-scopes.test.ts` runs this checklist over every catalog operation and names the
missing step, so a new operation that skips one fails CI.

1. `catalog`: add the route to its workstream manifest (REST and, for staff operations an agent may
   call, the MCP tool in the same ops table), or add a literal `authorize(ctx, '<action>', ...)` call
   for a worker operation. Then run `pnpm catalog:generate`. An operation id is `<noun>.<...>.<verb>`
   and unique; a REST path and an MCP tool name are unique across the catalog.
2. `scope`: pick a registered scope from [scopes.md](scopes.md). If none fits, register one in the
   "Roles and scopes" section of [SHARED-CONTRACTS](../SHARED-CONTRACTS.md) in the same change, with
   its sensitivity, the principal kinds that may hold it, whether it is human only, and why. Names are
   `noun.verb`; a dotless camel-case name, a wildcard or an empty name is rejected.
3. `policy`: add the `ACTION_POLICIES` row (scope and principal kinds) in
   `packages/domain/src/policy/authorize.ts`, and bind the resource policy in the domain command: a
   scope alone never authorizes (tenant from the authenticated context, live membership, location,
   resource and, for a portal principal, the S5 relationship).
4. `harness`: add the cross-tenant, missing-scope and revoked-access cases to the workstream's
   negative harness. The derived forbidden-operation matrix (`tests/integration/api-forbidden-matrix.test.ts`)
   runs the new operation for every principal kind automatically; it does not replace the
   workstream's resource-level cases.
5. `openapi`: document the operation in `docs/api/openapi.yaml` against its JSON Schema (the contract
   drift check compares the two), then run `pnpm catalog:generate` again so the generated client
   (`packages/client`), the scope registry and these documents follow.

A change that removes or renames an operation, or makes its input stricter, also needs a deprecation
entry with a sunset date; see [deprecation.md](deprecation.md).
