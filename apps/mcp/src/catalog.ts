import type { CatalogOperation } from '@cuspatlas/contracts';
import operations from '@cuspatlas/contracts/catalog/operations.json' with { type: 'json' };

interface ToolLike {
  readonly name: string;
  readonly operationId: string;
  readonly readOnly: boolean;
}

/**
 * A6: the registered MCP tools must equal the operation catalog's MCP operations (generated from the
 * same tables). Returns every disagreement; startup refuses when the list is not empty, so a tool
 * added by hand, naming an operation the catalog does not have, or remapped, never serves.
 */
export function toolCatalogDrift(
  tools: readonly ToolLike[],
  catalog: readonly CatalogOperation[] = operations as readonly CatalogOperation[],
): string[] {
  const byTool = new Map(catalog.filter((o) => o.mcpTool).map((o) => [o.mcpTool as string, o]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) out.push(`tool ${t.name} is registered twice`);
    seen.add(t.name);
    const o = byTool.get(t.name);
    if (!o) {
      out.push(`tool ${t.name} is not in the operation catalog`);
      continue;
    }
    if (o.operation !== t.operationId) {
      out.push(`tool ${t.name} maps to ${t.operationId}; the catalog says ${o.operation}`);
    }
    if ((o.kind === 'query') !== t.readOnly)
      out.push(`tool ${t.name} read-only hint disagrees with the catalog kind`);
    if (o.authorization !== 'authorize') out.push(`tool ${t.name} is not a staff (authorize) operation`);
  }
  for (const name of byTool.keys()) if (!seen.has(name)) out.push(`catalog tool ${name} is not registered`);
  return out;
}
