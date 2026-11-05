# MCP surface

Status: tested on the local synthetic transport (A6). Remote transport qualification (A-S1) is
blocked-on-discovery; which tools a deployment may disable is an open human decision (A-D3).

The MCP tool set is exactly the operation catalog's staff operations that carry the `mcp` transport
(`docs/api/operation-catalog.md`, column "MCP tool"): 326 tools at this head. `buildMcpServer` refuses
to start when the registered tools disagree with `packages/contracts/src/catalog/operations.json`
(a tool added by hand, a tool naming an operation the catalog lacks, a remapped tool, a read-only hint
that contradicts the catalog kind, a missing catalog tool, or a tool on a non-staff authorization
path). Tool names are checked against forbidden kinds (no SQL, raw, shell, exec, eval, file,
filesystem, HTTP, proxy, fetch or impersonation tool), and the server exposes no resources or prompts.

Only staff principals reach MCP: portal, bridge and pairing operations are never tools. Every tool
authorizes through the same `authorize` and domain handlers as its REST twin, so a refusal is
identical on both surfaces (proven per operation by `tests/integration/api-forbidden-matrix.test.ts`).
Staff REST operations that are deliberately not tools: `imaging.objects.content`,
`imaging.ingress.upload` and `imaging.export.blobs` (byte transports) and `session.read`.

Deprecated tools still answer; their description and every result (`_meta.deprecation`) carry the
notice from `deprecations.json`.

Candidate tools a deployment might disable (A-D3, not decided): exports (`*_export`), deletions and
legal holds (`imaging_deletions_*`, `imaging_legal_holds_*`) and standing-policy administration. Nothing is
disabled by default and no per-deployment switch exists yet.
