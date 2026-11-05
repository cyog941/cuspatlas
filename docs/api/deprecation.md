# Deprecation and change control

Status: tested on synthetic data (A5). The deprecation window length is an open human decision (A-D1);
nothing here sets a default.

The published contract is `packages/contracts/src/catalog/baseline.json`, generated from the operation
catalog and the JSON Schemas. `pnpm catalog:generate` compares the current contract with it and moves
it forward only when every breaking change is covered; `pnpm catalog:check` (in CI) fails when the
committed baseline is stale.

| Class | Examples |
|---|---|
| additive | a new operation; a new optional request property; a wider enum; a larger maximum |
| breaking | removing or renaming an operation; dropping a transport, a principal kind or the MCP tool; changing the scope or REST path; a new required property; removing a property of a closed request object; narrowing an enum; a smaller maximum length, value or item count; a larger minimum; a changed pattern; making a nullable field non-null |

To change an operation in a breaking way:

1. Add an entry to `packages/contracts/src/catalog/deprecations.json`:
   `{ "operation", "announced", "sunset", "replacedBy" (or null), "note" }`. Dates are ISO dates; the
   sunset follows the announcement by the A-D1 window once decided.
2. Run `pnpm catalog:generate`. The catalog marks the operation `deprecated`, the sunset register
   (`docs/api/sunset-register.md`) lists it, REST responses carry `Deprecation`, `Sunset` and
   `Link: </docs/api/sunset-register.md>; rel="deprecation"`, and MCP results carry
   `_meta.deprecation` with the same notice in the tool description. The operation still answers and
   still writes its audit and security-attempt rows.
3. Make the breaking change only after the sunset date. Before it, `catalog:generate` refuses and
   writes nothing, naming the operation, the field path and the reason.

A deprecated operation never silently disappears from the documentation: it stays in the catalog,
the OpenAPI document and the register until it is removed after its sunset.
