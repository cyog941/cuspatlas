import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../scripts/catalog/build-catalog';
import { buildScopeRegistry } from '../../scripts/catalog/scopes';
import { type CatalogStack, startCatalogStack } from './support/catalog-stack';

/**
 * Closeout D6: the MCP `outputSchema` of each read-only list tool describes what the tool answers. A
 * caller with every scope lists the tools (so the SDK client validates each later structured result
 * against its declared outputSchema, and refuses one that does not match), then calls every list tool
 * that needs no argument. Synthetic tenant, mostly empty lists.
 */
let s: CatalogStack;
const catalog = buildCatalog();

beforeAll(async () => {
  s = await startCatalogStack(
    'mcp_output_schema',
    buildScopeRegistry(catalog).scopes.map((x) => x.name),
  );
});
afterAll(async () => {
  await s?.close();
});

describe('Closeout D6: MCP list answers conform to their declared outputSchema', () => {
  it('lists an outputSchema on the list tools, and every argument-free list answer validates', async () => {
    const tools = (await s.mcpList('humanAll')) as unknown as {
      name: string;
      inputSchema: { required?: string[] };
      outputSchema?: unknown;
    }[];
    const declared = tools.filter((t) => t.outputSchema);
    expect(declared.length).toBeGreaterThan(50);
    let validated = 0;
    const mismatches: string[] = [];
    for (const t of declared) {
      if ((t.inputSchema.required ?? []).length > 0) continue;
      try {
        const r = await s.mcpCall('humanAll', t.name, {});
        if (r.isError) continue;
        expect(r.body.data, t.name).toBeDefined();
        validated += 1;
      } catch (err) {
        // The SDK client throws when structured content does not match the declared outputSchema.
        mismatches.push(`${t.name}: ${(err as Error).message.slice(0, 300)}`);
      }
    }
    expect(mismatches).toStrictEqual([]);
    expect(validated).toBeGreaterThan(10);
  });
});
