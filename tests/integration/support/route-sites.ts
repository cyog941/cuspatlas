import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ROOT } from '../../../scripts/catalog/build-catalog';

const VERBS = 'get|post|put|patch|delete|head|options|all|route';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = resolve(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

/**
 * A-S4: every place under apps/api/src that can register an HTTP route, keyed `file: receiver.verb`.
 * A receiver is any Fastify instance the file can reach: a `FastifyInstance`-typed binding, a plugin
 * scope from `register(async (x) => ...)`, a `Fastify(...)` result, or an alias of one of those
 * (`const r = app`). Verb calls include computed ones (`app[method](...)`) and `addRoute`-style
 * `route(...)`; a new site fails the structural check until it is reviewed.
 */
export function routeRegistrationSites(root = ROOT): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of sourceFiles(resolve(root, 'apps/api/src'))) {
    const src = readFileSync(file, 'utf8');
    const names = new Set<string>();
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\??\s*:\s*FastifyInstance\b/g))
      names.add(m[1] as string);
    for (const m of src.matchAll(/\bregister\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/g))
      names.add(m[1] as string);
    for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?Fastify\(/g))
      names.add(m[1] as string);
    // Aliases, repeated until stable (`const a = app; const b = a;`).
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of src.matchAll(
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*[;,\n]/g,
      )) {
        if (names.has(m[2] as string) && !names.has(m[1] as string)) {
          names.add(m[1] as string);
          grew = true;
        }
      }
    }
    const rel = relative(root, file).replaceAll('\\', '/');
    for (const n of names) {
      const esc = n.replace(/\$/g, '\\$');
      const re = new RegExp(`\\b${esc}\\s*(?:\\.\\s*(${VERBS})|\\[\\s*([^\\]]+)\\])\\s*(?:<[^>]*>)?\\(`, 'g');
      for (const m of src.matchAll(re)) {
        const key = `${rel}: ${n}.${m[1] ?? `[${m[2]}]`}`;
        out[key] = (out[key] ?? 0) + 1;
      }
    }
  }
  return out;
}
