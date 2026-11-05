import { type DeprecationEntry, deprecationHeaders, deprecationIndex } from '@cuspatlas/contracts';
import type { FastifyInstance } from 'fastify';
import { ROUTES } from './routes/manifest';

/**
 * A5: a deprecated operation still answers and still audits; every response it produces (success or
 * refusal) carries `Deprecation`, `Sunset` and a `Link` to the sunset register. Register before routes.
 */
export function registerDeprecationHeaders(app: FastifyInstance, entries: readonly DeprecationEntry[]): void {
  const index = deprecationIndex(entries);
  const byRoute = new Map<string, Record<string, string>>();
  for (const r of ROUTES) {
    const e = index.get(r.operationId);
    if (e)
      byRoute.set(`${r.method.toUpperCase()} ${r.path.replace(/\{(\w+)\}/g, ':$1')}`, deprecationHeaders(e));
  }
  if (byRoute.size === 0) return;
  app.addHook('onSend', async (request, reply, payload) => {
    const headers = byRoute.get(`${request.method} ${request.routeOptions.url ?? ''}`);
    if (headers) reply.headers(headers);
    return payload;
  });
}
