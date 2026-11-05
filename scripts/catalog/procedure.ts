import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CatalogOperation } from '../../packages/contracts/src/catalog/catalog';
import { ROOT } from './build-catalog';

/**
 * A3 new-operation procedure as a CI checklist (docs/api/new-operation.md). For each catalog
 * operation it returns the missing steps; a new operation that skipped one fails CI.
 */
export interface ProcedureInputs {
  readonly catalog: readonly CatalogOperation[];
  readonly registered: ReadonlySet<string>;
  readonly policies: Readonly<Record<string, unknown>>;
  readonly openapi: string;
  /** Concatenated source of the integration and scenario test files. */
  readonly tests: string;
}

export function loadProcedureInputs(
  catalog: readonly CatalogOperation[],
  registered: ReadonlySet<string>,
  policies: Readonly<Record<string, unknown>>,
  root = ROOT,
): ProcedureInputs {
  // Workstream harnesses, scenarios and their fixtures; the derived api-* suites do not count.
  const tests = ['tests/integration', 'tests/integration/support', 'tests/scenarios']
    .flatMap((d) =>
      readdirSync(resolve(root, d))
        .filter((f) => f.endsWith('.ts') && !f.startsWith('api-') && f !== 'catalog-stack.ts')
        .map((f) => readFileSync(resolve(root, d, f), 'utf8')),
    )
    .join('\n');
  return {
    catalog,
    registered,
    policies,
    openapi: readFileSync(resolve(root, 'docs/api/openapi.yaml'), 'utf8'),
    tests,
  };
}

export function procedureGaps(op: CatalogOperation, inp: ProcedureInputs): string[] {
  const gaps: string[] = [];
  // Step 1: named in the catalog (the operation is passed in, so it exists; check uniqueness).
  if (inp.catalog.filter((o) => o.operation === op.operation).length !== 1) gaps.push('catalog');
  // Step 2: a registered scope (or an explicit non-staff authorization path).
  if (op.scope !== null && !inp.registered.has(op.scope)) gaps.push('scope');
  if (op.scope === null && op.authorization === 'authorize' && op.operation !== 'session.read') {
    gaps.push('scope');
  }
  // Step 3: the resource policy binding (an ACTION_POLICIES row for the policy path).
  if (op.action !== null && !Object.hasOwn(inp.policies, op.action)) gaps.push('policy');
  // Step 4: negative cases registered in a workstream harness (by id, tool name or REST path), on
  // top of the derived A7 forbidden-operation matrix that runs every catalog operation.
  const named = [`'${op.operation}'`, op.mcpTool ? `'${op.mcpTool}'` : null, op.rest?.path.split('{')[0]];
  const capabilityScope =
    op.kind === 'capability' && op.scope !== null && inp.tests.includes(`'${op.scope}'`);
  if (!capabilityScope && !named.some((n) => n && inp.tests.includes(n))) gaps.push('harness');
  // Step 5: regenerated contracts (the OpenAPI operation exists for every REST surface).
  if (op.rest && !inp.openapi.includes(`operationId: ${op.operation}\n`)) gaps.push('openapi');
  return gaps;
}
