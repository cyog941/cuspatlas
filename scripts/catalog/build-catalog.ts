import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IMAGING_OPS } from '../../apps/api/src/routes/imaging-ops';
import { ROUTES } from '../../apps/api/src/routes/manifest';
import { PORTAL_OPS } from '../../apps/api/src/routes/portal-ops';
import { TOOLS } from '../../apps/mcp/src/server';
import type {
  CatalogOperation,
  CatalogPrincipal,
  DeprecationEntry,
  OwnerWorkstream,
  Sensitivity,
  Transport,
} from '../../packages/contracts/src/catalog/catalog';
import deprecations from '../../packages/contracts/src/catalog/deprecations.json' with { type: 'json' };
import { ACTION_POLICIES } from '../../packages/domain/src/policy/authorize';

export const ROOT = resolve(import.meta.dirname, '../..');

interface Policy {
  readonly scope: string | null;
  readonly principals: readonly CatalogPrincipal[];
}
const POLICIES = ACTION_POLICIES as unknown as Record<string, Policy>;

const OWNERS: Record<string, OwnerWorkstream> = {
  health: 'F',
  session: 'F',
  syntheticTasks: 'F',
  outbox: 'F',
  patients: 'S',
  scheduling: 'S',
  billing: 'B',
  rcm: 'B',
  clinical: 'C',
  portal: 'E',
  communications: 'E',
  intake: 'E',
  messaging: 'E',
  telephony: 'E',
  imaging: 'I',
  migration: 'M',
  practice: 'M',
  operations: 'M',
};

/**
 * REST operations that authorize with a different ACTION_POLICIES key than their own id: the list is
 * a read of the task table, and a proposal commit first authorizes the proposal read, then the
 * proposal executor authorizes the proposal's own operation again.
 */
export const ACTION_ALIASES: Record<string, string> = {
  'syntheticTasks.list': 'syntheticTasks.read',
  'syntheticTasks.proposals.commit': 'syntheticTasks.proposals.read',
};

/** Actions only ever checked as an additional capability inside another operation. */
export const CAPABILITY_OF: Record<string, string> = {
  'syntheticTasks.approve': 'syntheticTasks.proposals.commit',
  'patients.unmerge.reconcile': 'patients.unmerge',
  'scheduling.appointments.override': 'scheduling.appointments.book',
  'clinical.notes.amendOthers': 'clinical.notes.amend',
  'imaging.grants.revokeAny': 'imaging.objects.revokeGrant',
};

/** Scope families whose operations never touch patient data. */
const OPERATIONAL_SCOPES = new Set([
  'syntheticTasks.read',
  'syntheticTasks.write',
  'syntheticTasks.approve',
  'outbox.deliver',
]);

/** Worker operations: actions the worker passes to `authorize` as literals (its own principal). */
export function workerActions(root = ROOT): string[] {
  const dir = resolve(root, 'apps/worker/src');
  const found = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
    const src = readFileSync(resolve(dir, f), 'utf8');
    for (const m of src.matchAll(/authorize\(ctx, '([a-zA-Z.]+)'/g)) found.add(m[1] as string);
    if (/authorize\(ctx, OPERATION\b/.test(src)) {
      const c = /const OPERATION = '([a-zA-Z.]+)'/.exec(src);
      if (c) found.add(c[1] as string);
    }
  }
  return [...found].sort();
}

const ownerOf = (op: string): OwnerWorkstream => {
  const owner = OWNERS[op.split('.')[0] as string];
  if (!owner) throw new Error(`catalog: no owner workstream for ${op}; add its prefix to OWNERS`);
  return owner;
};

function sensitivityOf(op: string, scope: string | null, auth: string): Sensitivity {
  if (auth === 'public') return 'none';
  if (op.endsWith('.export') || op.startsWith('practice.export.')) return 'phiBulk';
  if (op === 'session.read' || (scope !== null && OPERATIONAL_SCOPES.has(scope))) return 'operational';
  return 'phi';
}

const READ_NAME = /\.(search|describe|read|list|get|find|resolve)$/;

/** Builds the catalog from the code tables. Throws when a table entry cannot be classified. */
export function buildCatalog(root = ROOT): CatalogOperation[] {
  const deprecated = new Set((deprecations as readonly DeprecationEntry[]).map((d) => d.operation));
  const toolByOp = new Map(TOOLS.map((t) => [t.operationId, t]));
  const portal = new Set(PORTAL_OPS.map((o) => o.operationId));
  const imaging = new Map(IMAGING_OPS.map((o) => [o.operationId as string, o]));
  const ops: CatalogOperation[] = [];
  const status = (op: string) => (deprecated.has(op) ? ('deprecated' as const) : ('active' as const));

  for (const r of ROUTES) {
    const op = r.operationId;
    const tool = toolByOp.get(op);
    const img = imaging.get(op);
    let authorization: CatalogOperation['authorization'];
    let action: string | null = null;
    let principals: CatalogPrincipal[];
    let scope: string | null = null;
    const transports: Transport[] = [];
    if (!r.protected && op === 'health.read') {
      authorization = 'public';
      principals = ['human', 'service', 'portal', 'device'];
    } else if (portal.has(op)) {
      authorization = 'portal';
      principals = ['portal'];
      transports.push('portal');
    } else if (img?.transport === 'device' || img?.transport === 'pairing') {
      // The policy table names the device kind for these (authorize itself never admits a device:
      // the live device row and its allowlist authorize inside the transaction).
      authorization = img.transport;
      action = POLICIES[op] ? op : null;
      principals = ['device'];
      transports.push('bridge');
    } else {
      authorization = 'authorize';
      action = ACTION_ALIASES[op] ?? op;
      const p = POLICIES[action];
      if (!p) throw new Error(`catalog: route ${op} has no ACTION_POLICIES entry`);
      principals = [...p.principals];
      scope = p.scope;
    }
    if (authorization === 'authorize' || authorization === 'public') transports.unshift('rest');
    if (tool) transports.push('mcp');
    let kind: CatalogOperation['kind'] = 'command';
    if (r.method === 'get') kind = 'query';
    else if (tool) kind = tool.readOnly ? 'query' : 'command';
    else if (READ_NAME.test(op)) kind = 'query';
    ops.push({
      operation: op,
      owner: ownerOf(op),
      kind,
      authorization,
      action,
      scope,
      principals,
      transports,
      rest: {
        method: r.method,
        path: r.path,
        ...(r.requestBody ? { requestSchema: r.requestBody } : {}),
        ...(r.requestMedia ? { requestMedia: r.requestMedia } : {}),
        successStatus: r.success.status,
        successSchema: r.success.schema,
        ...(r.success.media ? { successMedia: r.success.media } : {}),
      },
      ...(tool ? { mcpTool: tool.name } : {}),
      refusals: [...r.refusals],
      idempotency: kind === 'command' && !img?.unkeyed ? 'required' : 'none',
      sensitivity: sensitivityOf(op, scope, authorization),
      status: status(op),
    });
  }

  const workers = workerActions(root);
  for (const w of workers) {
    if (!POLICIES[w]) throw new Error(`catalog: worker authorizes unknown action ${w}`);
  }
  const routedActions = new Set(ops.map((o) => o.action));
  for (const [action, p] of Object.entries(POLICIES)) {
    if (routedActions.has(action)) {
      if (workers.includes(action))
        throw new Error(`catalog: ${action} is both a route and a worker operation`);
      continue;
    }
    const capability = CAPABILITY_OF[action];
    if (!capability && !workers.includes(action)) {
      throw new Error(`catalog: action ${action} has no route, worker call or capability owner`);
    }
    ops.push({
      operation: action,
      owner: ownerOf(action),
      kind: capability ? 'capability' : 'command',
      authorization: capability ? 'capability' : 'authorize',
      action,
      scope: p.scope,
      principals: [...p.principals],
      transports: capability ? [] : ['worker'],
      refusals: [],
      idempotency: 'none',
      sensitivity: sensitivityOf(action, p.scope, 'authorize'),
      status: status(action),
    });
  }
  return ops.sort((a, b) => (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0));
}

export const stableJson = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
