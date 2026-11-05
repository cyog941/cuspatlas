import {
  type ActorContext,
  type CatalogOperation,
  type MembershipSource,
  NAVIGATION,
  NAVIGATION_VERSION,
} from '@cuspatlas/contracts';
import catalog from '@cuspatlas/contracts/catalog/operations.json' with { type: 'json' };
import type { ComposerBase } from '../composers/framework';
import { membershipDenial } from '../policy/authorize';

const BY_ID = new Map((catalog as unknown as CatalogOperation[]).map((o) => [o.operation, o]));

/**
 * A24 (OR-14): `GET /v1/navigation`, the catalog's navigable capabilities filtered by the caller's
 * LIVE permissions (one membership load, the same policy decision `authorize` takes per action). A
 * capability appears only when its entry operation is allowed; it lists only the allowed operations.
 * Resource and location checks still apply when an operation is called: navigation grants nothing.
 */
export function createNavigationReads(base: ComposerBase, memberships: MembershipSource | undefined) {
  return {
    async readNavigation(ctx: ActorContext) {
      const op = 'navigation.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        const m = memberships ? await memberships.load(ctx.actorId, ctx.tenantId) : null;
        const allowed = (id: string) => {
          const o = BY_ID.get(id);
          return o !== undefined && o.action !== null && membershipDenial(m, ctx, o.action) === null;
        };
        const describe = (id: string) => {
          const o = BY_ID.get(id) as CatalogOperation;
          return {
            operation: o.operation,
            kind: o.kind,
            method: o.rest?.method ?? null,
            path: o.rest?.path ?? null,
            mcpTool: o.mcpTool ?? null,
          };
        };
        const areas = NAVIGATION.map((g) => ({
          area: g.area,
          label: g.label,
          capabilities: g.capabilities
            .filter((c) => allowed(c.entry))
            .map((c) => ({
              key: c.key,
              label: c.label,
              entry: describe(c.entry),
              operations: c.operations.filter(allowed).map(describe),
            })),
        })).filter((g) => g.capabilities.length > 0);
        return { data: { version: NAVIGATION_VERSION, areas } };
      });
    },
  };
}
