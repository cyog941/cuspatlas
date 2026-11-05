import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { CatalogOperation } from '../../packages/contracts/src/catalog/catalog';
import { ROOT } from './build-catalog';

/**
 * A19 close-out: capability coverage over the matrix in docs/CAPABILITIES.md (A owns API/MCP parity,
 * AI assistance, prescribing, analytics, administration and the daily huddle; every other workstream's
 * rows are read only), the no-tier attestation, and the hidden-operation check. Gaps are reported as
 * gaps with the date they were recorded; a row whose owning workstream has no readable descriptors is
 * reported as unknown, never as covered.
 */

export interface MatrixRow {
  readonly domain: string;
  readonly release: string;
}

export interface CapabilityMapping {
  readonly domain: string;
  /** Owning workstreams (catalog `owner` letters). */
  readonly owners: readonly string[];
  /** Operation-name patterns; empty for a row with no operation (a gap). */
  readonly patterns: readonly RegExp[];
  /** Plan-defined row that is not a line of the capability matrix (A19 names it). */
  readonly planOnly?: boolean;
  readonly gap?: { readonly since: string; readonly reason: string };
  /** Parts of a covered row that are blocked on discovery or deferred, stated rather than implied. */
  readonly notes?: string;
}

const op = (...names: string[]) => names.map((n) => new RegExp(`^${n.replace(/\./g, '\\.')}(\\.|$)`));

export const CAPABILITY_ROWS: readonly CapabilityMapping[] = [
  {
    domain: 'Practice setup',
    owners: ['S', 'B'],
    patterns: op(
      'scheduling.locations',
      'scheduling.resources',
      'scheduling.timeBlocks',
      'billing.feeSchedules',
      'billing.fees',
    ),
    notes:
      'Organization profile, holiday calendars and procedure catalog administration are not separate operations yet.',
  },
  { domain: 'Patient identity', owners: ['S'], patterns: op('patients') },
  {
    domain: 'Family and consent',
    owners: ['S', 'E', 'C'],
    patterns: op(
      'patients.relationships',
      'communications.consents',
      'portal.grants',
      'portal.consents',
      'clinical.consents',
    ),
  },
  {
    domain: 'Scheduling',
    owners: ['S', 'A'],
    patterns: op(
      'scheduling.appointments',
      'scheduling.holds',
      'scheduling.series',
      'scheduling.availability',
      'scheduling.waitlist',
      'scheduling.timeBlocks',
      'scheduling.staging',
      'schedule.view',
    ),
  },
  {
    domain: 'Intake and portal',
    owners: ['E', 'S'],
    patterns: op('intake', 'portal', 'scheduling.requests'),
  },
  {
    domain: 'Daily workflow',
    owners: ['S', 'A'],
    patterns: op(
      'huddle.read',
      'appointments.detail',
      'scheduling.attendance',
      'scheduling.floor',
      'scheduling.presence',
      'scheduling.visitContext',
      'scheduling.worklist',
      'scheduling.notifications',
    ),
  },
  { domain: 'Clinical chart', owners: ['C'], patterns: op('clinical.chart') },
  {
    domain: 'Periodontal',
    owners: ['C'],
    patterns: op('clinical.perio'),
    notes: 'Clinician validation against a synthetic paper chart is pending (domain validation gate).',
  },
  {
    domain: 'Clinical documentation',
    owners: ['C'],
    patterns: op('clinical.notes', 'clinical.noteTemplates', 'clinical.history', 'clinical.authors'),
  },
  {
    domain: 'Treatment planning',
    owners: ['C'],
    patterns: op('clinical.treatmentPlans', 'clinical.estimates', 'clinical.consentTemplates'),
  },
  {
    domain: 'Procedures/encounters',
    owners: ['C'],
    patterns: op('clinical.procedures', 'clinical.encounters'),
  },
  {
    domain: 'Imaging/documents',
    owners: ['I'],
    patterns: op('imaging', 'clinical.imageLinks'),
    notes:
      'Vendor bridges and DICOM acquisition are blocked on device/vendor discovery; the bridge contract is synthetic.',
  },
  { domain: 'Insurance', owners: ['B'], patterns: op('rcm.coverages', 'rcm.eligibility') },
  {
    domain: 'Claims/RCM',
    owners: ['B'],
    patterns: op(
      'rcm.claims',
      'rcm.remittances',
      'rcm.appeals',
      'rcm.workflows',
      'rcm.submissionPolicies',
      'rcm.workflowPolicies',
      'rcm.visits',
    ),
    notes:
      'Clearinghouse submission, acknowledgements and ERA intake run against a synthetic adapter; a validated partner is blocked on discovery.',
  },
  {
    domain: 'Financial ledger',
    owners: ['B'],
    patterns: op(
      'billing.ledger',
      'billing.entries',
      'billing.charges',
      'billing.payments',
      'billing.adjustments',
      'billing.funds',
      'billing.balances',
      'billing.procedures',
      'billing.responsibility',
    ),
  },
  {
    domain: 'Patient billing',
    owners: ['B'],
    patterns: op('billing.statements', 'billing.plans', 'billing.worklist'),
    notes: 'Card tokenization and payment links need a payment provider (blocked on discovery).',
  },
  {
    domain: 'Prescribing',
    owners: ['A'],
    patterns: op('prescriptions'),
    notes:
      'Envelope only; the e-prescribing partner, prescriber identity proofing and controlled-substance workflow are blocked on discovery.',
  },
  {
    domain: 'Communications',
    owners: ['E'],
    patterns: op(
      'communications.channelPolicies',
      'communications.consents',
      'communications.contacts',
      'communications.decisions',
      'communications.deliver',
      'communications.deliveries',
      'communications.receipts',
      'communications.suppression',
      'communications.templates',
      'messaging',
      'telephony',
    ),
    notes:
      'SMS, email and telephony carriers are synthetic adapters; carrier selection is blocked on discovery.',
  },
  {
    domain: 'Recall and follow-up',
    owners: ['S', 'E'],
    patterns: op('scheduling.recall', 'scheduling.followUp', 'scheduling.recovery', 'communications.recall'),
  },
  { domain: 'Lab/referrals', owners: ['C'], patterns: op('clinical.labCases', 'clinical.referrals') },
  { domain: 'Analytics', owners: ['A', 'B'], patterns: op('analytics', 'billing.reports') },
  {
    domain: 'Administration',
    owners: ['A'],
    patterns: op('admin', 'exports', 'imaging.legalHolds', 'messaging.retention'),
  },
  {
    domain: 'Integrations',
    owners: ['A', 'F'],
    patterns: op('webhooks', 'agents', 'vocabularies', 'session.read', 'navigation.read'),
    notes: 'Remote MCP transport is not claimed until A-S1 closes; vendor adapters are blocked on discovery.',
  },
  {
    domain: 'Specialty breadth',
    owners: ['C'],
    patterns: [],
    gap: {
      since: '2026-11-05',
      reason:
        'P2: no specialty operations are built; separate clinical and workflow validation per specialty.',
    },
  },
  {
    domain: 'International',
    owners: ['F'],
    patterns: [],
    gap: {
      since: '2026-11-05',
      reason:
        'P2: no country packs are built; extensibility requirements only (IANA time zones, explicit currency, numbering conversion).',
    },
  },
  {
    domain: 'AI assistance',
    owners: ['A'],
    planOnly: true,
    patterns: op('ai', 'actions.proposals'),
    notes:
      'Model-provider arrangement and evaluation thresholds are unverified; drafts are synthetic and always human-reviewed.',
  },
  { domain: 'Daily huddle', owners: ['A'], planOnly: true, patterns: op('huddle.read', 'scheduling.floor') },
];

/** The table rows of the capability matrix (first table in docs/CAPABILITIES.md). */
export function parseCapabilityMatrix(md: string): MatrixRow[] {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('| Domain |'));
  if (start < 0) throw new Error('capability matrix table not found');
  const rows: MatrixRow[] = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith('|')) break;
    const cells = l.split('|').map((c) => c.trim());
    rows.push({ domain: cells[1] ?? '', release: cells[4] ?? '' });
  }
  return rows;
}

export interface CoverageRow {
  readonly domain: string;
  readonly owners: readonly string[];
  readonly release: string;
  readonly status: 'covered' | 'gap' | 'unknown';
  readonly operations: readonly string[];
  readonly negativeCases: readonly string[];
  readonly gapSince?: string;
  readonly note?: string;
}

export interface CoverageReport {
  readonly rows: readonly CoverageRow[];
  readonly unmapped: readonly string[];
  readonly scopeDefects: readonly string[];
  readonly mcp: {
    readonly with: number;
    readonly without: number;
    readonly withoutOperations: readonly string[];
  };
}

const NEGATIVE_FILE = /negative|forbidden|refus|harness|matrix|isolation|tenant|revok|rls|security|parity/i;
const NEGATIVE_BODY = /toBe\(40[134]\)|'forbidden'|'not_found'|statusCode\)\.toBe\(4|rejects\.toThrow/;
const GENERIC_MATRIX = 'api-forbidden-matrix.test.ts (A7 matrix, every catalog operation)';

function testSources(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.ts')) out.set(e.name, readFileSync(p, 'utf8'));
    }
  };
  walk(resolve(root, 'tests'));
  return out;
}

/** Each operation's named negative test files (a refusal-asserting test that names it or its tool). */
function negativeIndex(catalog: readonly CatalogOperation[], root: string): Map<string, string[]> {
  const tests = [...testSources(root)].filter(([n, src]) => NEGATIVE_FILE.test(n) || NEGATIVE_BODY.test(src));
  const index = new Map<string, string[]>();
  for (const o of catalog) {
    const needles = [`'${o.operation}'`, `"${o.operation}"`, ...(o.mcpTool ? [`'${o.mcpTool}'`] : [])];
    index.set(
      o.operation,
      tests
        .filter(([, src]) => needles.some((n) => src.includes(n)))
        .map(([n]) => n)
        .sort(),
    );
  }
  return index;
}

export function describeCoverage(input: {
  readonly catalog: readonly CatalogOperation[];
  readonly matrix: readonly MatrixRow[];
  readonly scopes: ReadonlySet<string>;
  readonly root?: string;
}): CoverageReport {
  const { catalog, matrix, scopes } = input;
  const negatives = negativeIndex(catalog, input.root ?? ROOT);
  const owners = new Set<string>(catalog.map((o) => o.owner));
  const mapped = new Map(CAPABILITY_ROWS.map((m) => [m.domain, m]));
  const unmapped = matrix.filter((r) => !mapped.has(r.domain)).map((r) => r.domain);
  const describe = (m: CapabilityMapping | undefined, domain: string, release: string): CoverageRow => {
    if (!m || m.owners.some((w) => !owners.has(w))) {
      return {
        domain,
        owners: m?.owners ?? [],
        release,
        status: 'unknown',
        operations: [],
        negativeCases: [],
      };
    }
    const ops = catalog
      .filter((o) => m.patterns.some((p) => p.test(o.operation)))
      .map((o) => o.operation)
      .sort();
    if (ops.length === 0) {
      return {
        domain,
        owners: m.owners,
        release,
        status: 'gap',
        operations: [],
        negativeCases: [],
        gapSince: m.gap?.since ?? 'unrecorded',
        note: m.gap?.reason ?? 'no operation matches this row',
      };
    }
    const named = [...new Set(ops.flatMap((o) => negatives.get(o) ?? []))].sort();
    return {
      domain,
      owners: m.owners,
      release,
      status: 'covered',
      operations: ops,
      negativeCases: named.length > 0 ? named : [GENERIC_MATRIX],
      ...(m.notes ? { note: m.notes } : {}),
    };
  };
  const rows = [
    ...matrix.map((r) => describe(mapped.get(r.domain), r.domain, r.release)),
    ...CAPABILITY_ROWS.filter((m) => m.planOnly).map((m) => describe(m, m.domain, 'plan A19')),
  ];
  const scopeDefects = catalog
    .filter((o) => o.scope !== null && !scopes.has(o.scope))
    .map((o) => `${o.operation}: scope ${o.scope} is not in the published registry`);
  const withoutOperations = catalog
    .filter((o) => !o.mcpTool)
    .map((o) => o.operation)
    .sort();
  return {
    rows,
    unmapped,
    scopeDefects,
    mcp: {
      with: catalog.length - withoutOperations.length,
      without: withoutOperations.length,
      withoutOperations,
    },
  };
}

// ---- No-tier attestation ----

/** Entitlement, plan, licence or feature-key evaluation vocabulary (code identifiers, not prose). */
export const ENTITLEMENT_PATTERN =
  /\b(entitlements?|isEntitled|featureKeys?|feature_keys?|featureGates?|feature_gates?|licen[cs]eKeys?|licen[cs]e_keys?|licen[cs]eTier|planTier|plan_tier|subscriptionTier|subscription_tier|pricingTier|paidTier|requiresPlan|hasFeature|isFeatureEnabled|tierAllows)\b/;

const SCAN_DIRS = ['apps', 'packages', 'supabase/migrations', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage']);
const SELF = resolve(ROOT, 'scripts/catalog/coverage.ts');

function stripComments(src: string, sql: boolean): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock
    .split('\n')
    .map((l) => (sql ? l.replace(/--.*$/, '') : l.replace(/(^|[^:'"`])\/\/.*$/, '$1')))
    .join('\n');
}

export interface AttestationResult {
  readonly findings: readonly string[];
  readonly filesScanned: number;
  readonly descriptorsScanned: number;
}

/**
 * Scans every catalog descriptor and every source file (apps, packages, migrations, scripts; tests
 * excluded because they assert the absence) for entitlement evaluation. Throws when the scan cannot
 * complete, so absence of findings is never mistaken for a pass.
 */
export function assertNoEntitlementGate(input: {
  readonly catalog: readonly CatalogOperation[];
  readonly roots?: readonly string[];
}): AttestationResult {
  const findings: string[] = [];
  for (const o of input.catalog) {
    const json = JSON.stringify(o);
    const m = ENTITLEMENT_PATTERN.exec(json);
    if (m) findings.push(`descriptor ${o.operation}: ${m[0]}`);
  }
  let filesScanned = 0;
  const roots = input.roots ?? [ROOT];
  for (const root of roots) {
    const dirs = input.roots ? [root] : SCAN_DIRS.map((d) => resolve(root, d));
    for (const dir of dirs) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error(`attestation incomplete: ${relative(ROOT, dir)} cannot be read`);
      }
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = resolve(d, e.name);
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(p);
            continue;
          }
          if (!/\.(ts|tsx|mjs|js|sql)$/.test(e.name) || e.name.endsWith('.test.ts') || p === SELF) continue;
          filesScanned += 1;
          const lines = stripComments(readFileSync(p, 'utf8'), e.name.endsWith('.sql')).split('\n');
          lines.forEach((l, i) => {
            const m = ENTITLEMENT_PATTERN.exec(l);
            if (m) findings.push(`${relative(root, p).replace(/\\/g, '/')}:${i + 1}: ${m[0]}`);
          });
        }
      };
      walk(dir);
    }
  }
  if (filesScanned === 0) throw new Error('attestation incomplete: no source files were scanned');
  return { findings, filesScanned, descriptorsScanned: input.catalog.length };
}

// ---- Hidden operations ----

export function describeHiddenOperations(input: {
  readonly catalog: readonly CatalogOperation[];
  readonly rest: readonly { readonly method: string; readonly url: string }[];
  readonly mcpTools: readonly string[];
  readonly workerActions: readonly string[];
}): {
  readonly hidden: readonly string[];
  readonly counts: { rest: number; portal: number; bridge: number; mcp: number; worker: number };
} {
  const fastify = (p: string) => p.replace(/\{(\w+)\}/g, ':$1');
  const byRoute = new Map(
    input.catalog
      .filter((o) => o.rest)
      .map((o) => [`${o.rest?.method.toUpperCase()} ${fastify(o.rest?.path ?? '')}`, o]),
  );
  const tools = new Set(input.catalog.filter((o) => o.mcpTool).map((o) => o.mcpTool));
  const workers = new Set(
    input.catalog.filter((o) => o.transports.includes('worker')).map((o) => o.operation),
  );
  const hidden: string[] = [];
  const counts = { rest: 0, portal: 0, bridge: 0, mcp: 0, worker: 0 };
  for (const r of input.rest) {
    const o = byRoute.get(`${r.method.toUpperCase()} ${r.url}`);
    if (!o) hidden.push(`rest ${r.method.toUpperCase()} ${r.url}`);
    else if (o.transports.includes('portal')) counts.portal += 1;
    else if (o.transports.includes('bridge')) counts.bridge += 1;
    else counts.rest += 1;
  }
  for (const t of input.mcpTools) {
    if (tools.has(t)) counts.mcp += 1;
    else hidden.push(`mcp ${t}`);
  }
  for (const w of input.workerActions) {
    if (workers.has(w)) counts.worker += 1;
    else hidden.push(`worker ${w}`);
  }
  return { hidden: hidden.sort(), counts };
}

// ---- Published documents ----

const list = (xs: readonly string[], n: number) =>
  xs.length <= n
    ? xs.map((x) => `\`${x}\``).join(', ')
    : `${xs
        .slice(0, n)
        .map((x) => `\`${x}\``)
        .join(', ')} and ${xs.length - n} more`;

export function renderCoverageMd(r: CoverageReport): string {
  const covered = r.rows.filter((x) => x.status === 'covered').length;
  const gaps = r.rows.filter((x) => x.status === 'gap');
  const unknown = r.rows.filter((x) => x.status === 'unknown');
  const out = [
    '# Capability coverage (A19)',
    '',
    '<!-- Generated by `corepack pnpm catalog:generate` from docs/CAPABILITIES.md, the operation catalog and tests/; `contract:check` fails on drift. -->',
    '',
    'Evidence category: **tested on synthetic data**. Coverage means a row resolves to named catalog operations and at least one negative (refusal) test; it is not approval, deployment, compliance or clinical validation.',
    '',
    `Rows: ${r.rows.length} (matrix rows plus plan-defined A rows). Covered: ${covered}. Gaps: ${gaps.length}. Unknown: ${unknown.length}. Unmapped matrix rows: ${r.unmapped.length}. Scope defects: ${r.scopeDefects.length}.`,
    '',
    `MCP surface: ${r.mcp.with} operations have an MCP tool; ${r.mcp.without} do not.`,
    '',
    '| Capability row | Owners | Release | Status | Operations | Negative cases | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.rows.map(
      (x) =>
        `| ${x.domain} | ${x.owners.join(', ')} | ${x.release} | ${x.status}${x.gapSince ? ` (since ${x.gapSince})` : ''} | ${x.operations.length}: ${list(x.operations, 4)} | ${list(x.negativeCases, 3)} | ${x.note ?? ''} |`,
    ),
    '',
    '## Gap register',
    '',
    'Gaps are appended with the date they were recorded and are never edited away; closing a gap adds operations to its row.',
    '',
    ...(gaps.length === 0
      ? ['None.']
      : gaps.map((g) => `- ${g.gapSince}: **${g.domain}** — ${g.note ?? ''}`)),
    '',
    '## Operations without an MCP surface',
    '',
    'These are portal, device, pairing, bridge, worker or public operations; the forbidden matrix proves an MCP caller is staff only.',
    '',
    ...r.mcp.withoutOperations.map((o) => `- \`${o}\``),
    '',
  ];
  return out.join('\n');
}

export function renderNoTierMd(a: AttestationResult, descriptors: number): string {
  return [
    '# No-tier attestation (A19)',
    '',
    '<!-- Generated by `corepack pnpm catalog:generate`; `contract:check` fails on drift. -->',
    '',
    `Result: **${a.findings.length === 0 ? 'pass' : 'FAIL'}** — ${a.findings.length} findings.`,
    '',
    `Scanned every operation descriptor (${descriptors}) and every source file under ${SCAN_DIRS.map((d) => `\`${d}/\``).join(', ')} (comments stripped; test files excluded because they assert the absence) for entitlement, plan, licence or feature-key evaluation:`,
    '',
    '```',
    ENTITLEMENT_PATTERN.source,
    '```',
    '',
    'Core PMS functionality, the documented API, MCP, export and self-hosting require no proprietary feature key (AGENTS.md product commitment). The attestation is proven to fail: `tests/integration/api-coverage.test.ts` injects an entitlement check in a fixture source file and in a descriptor and asserts both are found, and a scan that cannot read its inputs throws instead of passing.',
    '',
    ...(a.findings.length === 0 ? [] : ['## Findings', '', ...a.findings.map((f) => `- ${f}`), '']),
  ].join('\n');
}
