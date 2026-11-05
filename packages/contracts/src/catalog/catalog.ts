/**
 * A4 operation catalog: one row per business operation across every transport (REST, MCP, portal,
 * device bridge, worker). The committed `operations.json` is GENERATED from the code tables
 * (ACTION_POLICIES, the route manifests, the MCP tool table and the worker's authorize calls) by
 * `scripts/catalog/build-catalog.ts`; CI fails when the two disagree. Nothing here grants authority:
 * the policy layer (`authorize`, the portal relationship policy and the device allowlist) does.
 */

export type Transport = 'rest' | 'mcp' | 'portal' | 'bridge' | 'worker';
export type CatalogPrincipal = 'human' | 'service' | 'portal' | 'device';
export type OwnerWorkstream = 'F' | 'S' | 'C' | 'B' | 'E' | 'I' | 'M' | 'A';

/**
 * How the operation is authorized. `authorize`: the one staff policy table (ACTION_POLICIES) through
 * `createAuthorize`. `portal`: a portal principal's live S5 relationship scope (policy/patient-access).
 * `device`: the live device row and its allowlist inside the transaction. `pairing`: the one-time
 * pairing code (the only anonymous bridge call). `public`: no tenant data (health).
 * `capability`: not callable on its own; an additional authorize check inside another operation.
 */
export type AuthorizationPath = 'authorize' | 'portal' | 'device' | 'pairing' | 'public' | 'capability';

/** PHI class of what the operation reads or changes (declared by the scope family; see scopes.md). */
export type Sensitivity = 'none' | 'operational' | 'phi' | 'phiBulk';

export interface CatalogOperation {
  readonly operation: string;
  readonly owner: OwnerWorkstream;
  readonly kind: 'query' | 'command' | 'capability';
  readonly authorization: AuthorizationPath;
  /** The ACTION_POLICIES key `authorize` is called with (null when another path authorizes). */
  readonly action: string | null;
  /** Staff scope required (null: any active member, or a non-staff path). */
  readonly scope: string | null;
  readonly principals: readonly CatalogPrincipal[];
  readonly transports: readonly Transport[];
  readonly rest?: {
    readonly method: 'get' | 'post';
    readonly path: string;
    readonly requestSchema?: string;
    /** Non-JSON request body (binary upload); default application/json. */
    readonly requestMedia?: 'application/octet-stream';
    readonly successStatus: '200' | '201';
    readonly successSchema: string;
    /** Non-JSON success body (object bytes); default application/json. */
    readonly successMedia?: 'application/octet-stream';
  };
  readonly mcpTool?: string;
  /** Documented refusal statuses; every one uses the shared Refusal body. */
  readonly refusals: readonly string[];
  readonly idempotency: 'none' | 'required';
  readonly sensitivity: Sensitivity;
  readonly status: 'active' | 'deprecated';
  /**
   * A10 / A-D4: `proposal` = an agent may only prepare this operation through actions.proposals.*;
   * a human distinct from the proposer and its sponsor approves and commits. Absent = direct.
   */
  readonly approval?: 'proposal';
}

export interface DeprecationEntry {
  readonly operation: string;
  /** ISO date the deprecation was announced. */
  readonly announced: string;
  /** ISO date after which the operation may be removed (window length: A-D1, human decision). */
  readonly sunset: string;
  /** Replacement operation, or null with an explicit statement that none exists. */
  readonly replacedBy: string | null;
  readonly note: string;
}

/**
 * Scope names are `noun.verb`: exactly one dot, each segment starting lower case (a camel-case
 * noun such as `paymentDistribution` is registered usage). A dotless camel-case name
 * (`receivablesRead`), a wildcard, an upper-case start or an empty name is a defect.
 */
const SCOPE_NAME = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/;

export function scopeNameDefect(name: string): string | null {
  if (name.length === 0) return 'empty scope name';
  if (name.includes('*')) return `wildcard scope ${name}`;
  if (SCOPE_NAME.test(name)) return null;
  const camel = /^([a-z]+)([A-Z][a-zA-Z]*)$/.exec(name);
  if (camel) {
    const [, noun, verb] = camel as unknown as [string, string, string];
    return `camel-case scope ${name}; write it as ${noun}.${verb.charAt(0).toLowerCase()}${verb.slice(1)}`;
  }
  return `scope ${name} is not noun.verb`;
}

/** The complete S5 relationship scope vocabulary (SHARED-CONTRACTS). Never staff scopes. */
export const RELATIONSHIP_SCOPES = [
  'demographics',
  'scheduling',
  'clinical_read',
  'financial',
  'consent',
] as const;

const FORBIDDEN_TOOL =
  /(^|_)(sql|raw|shell|exec|eval|file|files|filesystem|fs|http|proxy|fetch|impersonate)(_|$)/;

/**
 * Structural validation of a catalog against a scope registry. Returns every defect (empty: valid).
 * A registry or catalog that fails must stop the build/startup rather than run with a partial set.
 */
export function validateCatalog(
  ops: readonly CatalogOperation[],
  registeredScopes: ReadonlySet<string>,
): string[] {
  const defects: string[] = [];
  const seen = new Map<string, string>();
  const once = (key: string, op: string) => {
    const prior = seen.get(key);
    if (prior !== undefined) defects.push(`${op}: duplicate ${key} (also ${prior})`);
    else seen.set(key, op);
  };
  for (const o of ops) {
    once(`operation ${o.operation}`, o.operation);
    if (o.rest) once(`rest ${o.rest.method.toUpperCase()} ${o.rest.path}`, o.operation);
    if (o.mcpTool !== undefined) {
      once(`tool ${o.mcpTool}`, o.operation);
      if (FORBIDDEN_TOOL.test(o.mcpTool)) defects.push(`${o.operation}: forbidden tool kind ${o.mcpTool}`);
      if (!o.transports.includes('mcp')) defects.push(`${o.operation}: tool without mcp transport`);
    }
    if (o.scope !== null) {
      const d = scopeNameDefect(o.scope);
      if (d) defects.push(`${o.operation}: ${d}`);
      else if (!registeredScopes.has(o.scope)) defects.push(`${o.operation}: unregistered scope ${o.scope}`);
    }
    if (o.kind === 'query' && o.idempotency === 'required') {
      defects.push(`${o.operation}: query declared idempotency required`);
    }
    if (o.authorization === 'authorize' && o.action === null)
      defects.push(`${o.operation}: authorize without action`);
    if (o.transports.includes('mcp') && o.authorization !== 'authorize') {
      defects.push(`${o.operation}: MCP is a staff transport; ${o.authorization} operations never are tools`);
    }
    if (o.kind === 'capability' && o.transports.length > 0)
      defects.push(`${o.operation}: capability with a transport`);
    if (o.kind !== 'capability' && o.transports.length === 0) defects.push(`${o.operation}: no transport`);
    if (o.principals.length === 0) defects.push(`${o.operation}: no principal kind`);
  }
  return defects;
}
