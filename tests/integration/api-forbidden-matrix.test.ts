import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REFUSAL_HTTP_STATUS, type RefusalCode } from '@cuspatlas/contracts';
import { ACTION_POLICIES, type ActionName, createAuthorize } from '@cuspatlas/domain';
import { TOOLS } from '@cuspatlas/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogOperation } from '../../packages/contracts/src/catalog/catalog';
import { buildCatalog, ROOT } from '../../scripts/catalog/build-catalog';
import { buildScopeRegistry } from '../../scripts/catalog/scopes';
import {
  type CatalogStack,
  enrollPortalPrincipal,
  M_HUMAN_ALL,
  M_HUMAN_NONE,
  M_HUMAN_REVOKED,
  M_SERVICE_ALL,
  M_SERVICE_NONE,
  PORTAL_AUDIENCE,
  registerDevice,
  type Subject,
  startCatalogStack,
} from './support/catalog-stack';
import { T_ALPHA, T_BETA } from './support/fixtures';
import { createMembershipSource } from './support/scenario-deps';

/**
 * A7 forbidden-operation matrix, derived from the catalog (never hand-listed): every operation x
 * principal kind (human staff, service/agent, portal, device) x transport, on the real app and MCP
 * server under the runtime role. Expected outcomes come from the catalog's policy row; the REST and
 * MCP refusals of the same case must be identical. Resource-level cases (cross-tenant records,
 * locations, relationships) stay in the workstream harnesses; this matrix proves the operation set.
 */
const catalog = buildCatalog();
const allScopes = buildScopeRegistry(catalog).scopes.map((s) => s.name);

type Kind = 'human' | 'service' | 'portal' | 'device';
type Surface = 'rest' | 'mcp' | 'portal' | 'bridge' | 'worker';
interface Fingerprint {
  readonly surface: Surface;
  readonly outcome: 'allowed' | 'denied' | 'unverified';
  readonly code: string | null;
  readonly reason: string | null;
}
interface Row {
  readonly operation: string;
  readonly kind: Kind;
  readonly caseRef: string;
  readonly fingerprints: Fingerprint[];
}

/** Names the diverging surface and field when two fingerprints of one case disagree. */
function divergence(row: Row): string | null {
  const [first, ...rest] = row.fingerprints;
  if (!first) return `${row.caseRef}: no surface reached`;
  for (const f of row.fingerprints) {
    if (f.outcome !== 'denied') return `${row.caseRef}: ${f.surface} ${f.outcome}`;
  }
  for (const f of rest) {
    for (const k of ['code', 'reason'] as const) {
      if (f[k] !== null && first[k] !== null && f[k] !== first[k]) {
        return `${row.caseRef}: ${f.surface}.${k}=${f[k]} differs from ${first.surface}.${k}=${first[k]}`;
      }
    }
  }
  return null;
}

/** The case each principal kind exercises for a staff (authorize) operation, from its policy row. */
function staffCase(o: CatalogOperation, kind: 'human' | 'service'): { who: Subject; reason: string } | null {
  if (!o.principals.includes(kind)) {
    return { who: kind === 'human' ? 'humanAll' : 'serviceAll', reason: 'principal_kind_denied' };
  }
  if (o.scope === null) return null;
  return { who: kind === 'human' ? 'humanNone' : 'serviceNone', reason: 'scope_missing' };
}

/** A-M2: the human-only flag is published in the scope registry from SHARED-CONTRACTS, never hand-listed. */
const HUMAN_ONLY = new Set(
  buildScopeRegistry(catalog)
    .scopes.filter((x) => x.humanOnly)
    .map((x) => x.name),
);

let s: CatalogStack;
let portalToken = '';
let devicePortalToken = '';
let deviceStaffToken = '';
const rows: Row[] = [];
const reasonMismatch: string[] = [];

/**
 * Denied, but with a different internal reason than the policy row predicts. Reviewed: proposal
 * approval loads the proposal before the policy check (self-approval is evaluated first, ADR 0010),
 * so for an unknown proposal a service approver gets the same not-found refusal as anyone; a service
 * approving an existing proposal is refused in proposal-policy.test.ts (agent self-approval and agent
 * approves a human proposal). REST and MCP still agree.
 */
const REVIEWED_REASON_EXCEPTIONS = [
  'syntheticTasks.proposals.approve:service:rest resource_hidden_or_missing (expected principal_kind_denied)',
  'syntheticTasks.proposals.approve:service:mcp resource_hidden_or_missing (expected principal_kind_denied)',
];

beforeAll(async () => {
  s = await startCatalogStack('api_forbidden_matrix', allScopes);
  const { principalRef } = await enrollPortalPrincipal(s);
  portalToken = await s.token(principalRef, PORTAL_AUDIENCE, T_ALPHA);
  const deviceRef = await registerDevice(s);
  deviceStaffToken = await s.token(deviceRef, undefined, T_ALPHA);
  devicePortalToken = await s.token(deviceRef, PORTAL_AUDIENCE, T_ALPHA);
}, 300_000);

afterAll(async () => {
  writeFileSync(
    resolve(ROOT, 'node_modules/.cache/a1-forbidden-matrix.json'),
    `${JSON.stringify(rows, null, 2)}\n`,
  );
  await s?.close();
});

const urlOf = (o: CatalogOperation) => (o.rest?.path ?? '').replace(/\{(\w+)\}/g, () => crypto.randomUUID());
const methodOf = (o: CatalogOperation) => (o.rest?.method === 'get' ? 'GET' : 'POST');

async function restFingerprint(o: CatalogOperation, token: string, surface: Surface): Promise<Fingerprint> {
  const seen = s.attempts.length;
  const res = await s.rest(token, methodOf(o), urlOf(o), {});
  const attempt = s.attempts.slice(seen).find((a) => a.operation === o.operation || a.operation === o.action);
  const body = res.json() as { code?: string };
  return {
    surface,
    outcome: res.statusCode < 300 ? 'allowed' : res.statusCode >= 500 ? 'unverified' : 'denied',
    code: body.code ?? null,
    reason: attempt?.reasonCode ?? null,
  };
}

async function mcpFingerprint(o: CatalogOperation, who: Subject): Promise<Fingerprint> {
  const seen = s.attempts.length;
  const r = await s.mcp(who, o.mcpTool as string, {});
  const attempt = s.attempts.slice(seen).find((a) => a.operation === o.operation || a.operation === o.action);
  const status = r.code ? REFUSAL_HTTP_STATUS[r.code as RefusalCode] : 200;
  return {
    surface: 'mcp',
    outcome: !r.isError ? 'allowed' : status >= 500 ? 'unverified' : 'denied',
    code: r.code,
    reason: attempt?.reasonCode ?? null,
  };
}

describe('A7 forbidden-operation matrix', () => {
  it('the AI boundary holds in the catalog: no SQL, shell, file or HTTP tool; elevated scopes are human only', () => {
    const forbidden =
      /(^|_)(sql|raw|shell|exec|eval|file|files|filesystem|fs|http|proxy|fetch|impersonate)(_|$)/;
    expect(TOOLS.filter((t) => forbidden.test(t.name)).map((t) => t.name)).toStrictEqual([]);
    // Every catalog row with a human-only scope admits no service, portal or device principal.
    const nonHuman = catalog.filter(
      (o) => o.scope !== null && HUMAN_ONLY.has(o.scope) && o.principals.some((p) => p !== 'human'),
    );
    expect(nonHuman.map((o) => `${o.operation}:${o.principals.join('+')}`)).toStrictEqual([]);
    expect(HUMAN_ONLY.size).toBeGreaterThan(10);
    const agentAdmitted = catalog.filter(
      (o) =>
        o.principals.includes('service') &&
        (o.operation.endsWith('.export') ||
          /\.approve$/.test(o.operation) ||
          /^clinical\.notes\.(sign|amend|cosign)/.test(o.operation)),
    );
    expect(agentAdmitted.map((o) => o.operation)).toStrictEqual([]);
    // An MCP caller can only be staff: no portal, device or pairing operation is a tool.
    expect(catalog.filter((o) => o.mcpTool && o.authorization !== 'authorize')).toStrictEqual([]);
  });

  it('staff operations: every operation is refused for each principal kind on REST and MCP alike', async () => {
    const staff = catalog.filter((o) => o.authorization === 'authorize' && o.rest);
    for (const o of staff) {
      for (const kind of ['human', 'service'] as const) {
        const c = staffCase(o, kind);
        if (!c) continue;
        const fps = [await restFingerprint(o, await s.token(c.who), 'rest')];
        if (o.mcpTool) fps.push(await mcpFingerprint(o, c.who));
        rows.push({
          operation: o.operation,
          kind,
          caseRef: `${o.operation}:${kind}:${c.reason}`,
          fingerprints: fps,
        });
        // Independent check of the expected refusal itself, not only surface equality.
        for (const f of fps) {
          if (f.outcome === 'denied' && f.reason !== c.reason) {
            reasonMismatch.push(`${o.operation}:${kind}:${f.surface} ${f.reason} (expected ${c.reason})`);
          }
        }
      }
      // Revoked membership (credential issued before revocation) and a token naming another tenant.
      if (o.principals.includes('human')) {
        const revoked = [await restFingerprint(o, await s.token('humanRevoked'), 'rest')];
        if (o.mcpTool) revoked.push(await mcpFingerprint(o, 'humanRevoked'));
        rows.push({
          operation: o.operation,
          kind: 'human',
          caseRef: `${o.operation}:human:revoked`,
          fingerprints: revoked,
        });
        const foreign = await restFingerprint(o, await s.token('humanAll', undefined, T_BETA), 'rest');
        rows.push({
          operation: o.operation,
          kind: 'human',
          caseRef: `${o.operation}:human:tenantMismatch`,
          fingerprints: [foreign],
        });
      }
      // A portal principal and a device identity presented on the staff transport.
      rows.push({
        operation: o.operation,
        kind: 'portal',
        caseRef: `${o.operation}:portal:staffTransport`,
        fingerprints: [await restFingerprint(o, portalToken, 'rest')],
      });
      rows.push({
        operation: o.operation,
        kind: 'device',
        caseRef: `${o.operation}:device:staffTransport`,
        fingerprints: [await restFingerprint(o, deviceStaffToken, 'rest')],
      });
    }
    const bad = rows.map(divergence).filter((d): d is string => d !== null);
    expect(reasonMismatch).toStrictEqual(REVIEWED_REASON_EXCEPTIONS);
    expect(bad).toStrictEqual([]);
    expect(new Set(rows.map((r) => r.operation)).size).toBe(staff.length);
  }, 900_000);

  it('portal operations: refused for staff, service and device identities and for a foreign patient', async () => {
    const portal = catalog.filter((o) => o.authorization === 'portal');
    for (const o of portal) {
      const cases: [Kind, string, string][] = [
        ['human', 'staffToken', await s.token('humanAll')],
        ['human', 'staffOnPortalAudience', await s.token('humanAll', PORTAL_AUDIENCE)],
        ['service', 'serviceOnPortalAudience', await s.token('serviceAll', PORTAL_AUDIENCE)],
        ['device', 'deviceOnPortalAudience', devicePortalToken],
      ];
      if (o.rest?.path.includes('{patientRef}')) cases.push(['portal', 'foreignPatient', portalToken]);
      for (const [kind, label, token] of cases) {
        const f = await restFingerprint(o, token, 'portal');
        rows.push({
          operation: o.operation,
          kind,
          caseRef: `${o.operation}:${kind}:${label}`,
          fingerprints: [f],
        });
      }
    }
    const bad = rows.filter((r) => portal.some((o) => o.operation === r.operation)).map(divergence);
    expect(bad.filter((d) => d !== null)).toStrictEqual([]);
  }, 300_000);

  it('bridge operations: refused for staff, service and portal credentials', async () => {
    const bridge = catalog.filter((o) => o.authorization === 'device' || o.authorization === 'pairing');
    expect(bridge.length).toBeGreaterThan(0);
    for (const o of bridge) {
      for (const [kind, token] of [
        ['human', await s.token('humanAll')],
        ['service', await s.token('serviceAll')],
        ['portal', portalToken],
      ] as const) {
        const f = await restFingerprint(o, token, 'bridge');
        rows.push({
          operation: o.operation,
          kind,
          caseRef: `${o.operation}:${kind}:bridge`,
          fingerprints: [f],
        });
        expect([o.operation, f.outcome]).toStrictEqual([o.operation, 'denied']);
      }
    }
  });

  it('worker and capability operations: the shared authorize refuses every other principal kind', async () => {
    const authorize = createAuthorize(createMembershipSource(s.db.app));
    const ops = catalog.filter((o) => o.transports.includes('worker') || o.kind === 'capability');
    const subjects: [Kind, string, 'human' | 'service' | 'portal', string][] = [
      ['human', M_HUMAN_ALL, 'human', 'all'],
      ['human', M_HUMAN_NONE, 'human', 'none'],
      ['human', M_HUMAN_REVOKED, 'human', 'revoked'],
      ['service', M_SERVICE_ALL, 'service', 'all'],
      ['service', M_SERVICE_NONE, 'service', 'none'],
      ['portal', M_HUMAN_ALL, 'portal', 'portalKind'],
    ];
    for (const o of ops) {
      for (const [kind, actorId, principal, label] of subjects) {
        const policy = (ACTION_POLICIES as unknown as Record<string, { principals: readonly string[] }>)[
          o.operation
        ];
        const mayPass = label === 'all' && policy?.principals.includes(principal);
        let reason: string | null = null;
        try {
          await authorize(
            {
              tenantId: T_ALPHA,
              actorId,
              principal,
              scopes: label === 'all' ? allScopes : [],
              correlationId: crypto.randomUUID(),
              locationRefs: null,
            } as never,
            o.operation as ActionName,
            { tenantId: T_ALPHA, id: 'matrix' },
          );
        } catch (err) {
          reason = (err as { reasonCode?: string }).reasonCode ?? 'refused';
        }
        rows.push({
          operation: o.operation,
          kind,
          caseRef: `${o.operation}:${kind}:${label}`,
          fingerprints: [{ surface: 'worker', outcome: reason ? 'denied' : 'allowed', code: null, reason }],
        });
        if (mayPass) expect([o.operation, label, reason]).toStrictEqual([o.operation, label, null]);
        else expect([o.operation, label, reason === null]).toStrictEqual([o.operation, label, false]);
      }
    }
    // Cross-tenant: the resource tenant is never the caller's.
    const cross = await authorize(
      {
        tenantId: T_ALPHA,
        actorId: M_SERVICE_ALL,
        principal: 'service',
        scopes: allScopes,
        correlationId: 'x',
        locationRefs: null,
      } as never,
      'outbox.deliver',
      { tenantId: T_BETA, id: 'outbox' },
    ).then(
      () => null,
      (e: { reasonCode?: string }) => e.reasonCode,
    );
    expect(cross).toBe('tenant_mismatch');
  });

  it('every catalog operation has matrix rows for every principal kind it can be refused for', () => {
    const byOp = new Map<string, Set<Kind>>();
    for (const r of rows) byOp.set(r.operation, (byOp.get(r.operation) ?? new Set()).add(r.kind));
    const missing = catalog
      .filter((o) => o.authorization !== 'public')
      .flatMap((o) => {
        const want: Kind[] =
          o.authorization === 'authorize' && o.rest
            ? [
                'portal',
                'device',
                ...(o.scope !== null || !o.principals.includes('human') ? (['human'] as const) : []),
                ...(o.scope !== null || !o.principals.includes('service') ? (['service'] as const) : []),
              ]
            : o.authorization === 'portal'
              ? ['human', 'service', 'device']
              : o.authorization === 'device' || o.authorization === 'pairing'
                ? ['human', 'service', 'portal']
                : ['human', 'service', 'portal'];
        return want.filter((k) => !byOp.get(o.operation)?.has(k)).map((k) => `${o.operation}:${k}`);
      });
    expect(missing).toStrictEqual([]);
    process.stdout.write(`\nA7 MATRIX: ${rows.length} cases over ${byOp.size} operations\n`);
  });

  it('an injected divergence is detected and attributed to its surface and field', () => {
    const ok: Row = {
      operation: 'x',
      kind: 'service',
      caseRef: 'x:service:scope_missing',
      fingerprints: [
        { surface: 'rest', outcome: 'denied', code: 'forbidden', reason: 'scope_missing' },
        { surface: 'mcp', outcome: 'denied', code: 'forbidden', reason: 'scope_missing' },
      ],
    };
    expect(divergence(ok)).toBeNull();
    const worker = {
      ...ok,
      fingerprints: [
        ...ok.fingerprints,
        { surface: 'worker' as const, outcome: 'denied' as const, code: null, reason: 'membership_inactive' },
      ],
    };
    expect(divergence(worker)).toBe(
      'x:service:scope_missing: worker.reason=membership_inactive differs from rest.reason=scope_missing',
    );
    const leak = {
      ...ok,
      fingerprints: [
        ok.fingerprints[0] as Fingerprint,
        { surface: 'mcp' as const, outcome: 'denied' as const, code: 'not_found', reason: 'scope_missing' },
      ],
    };
    expect(divergence(leak)).toBe(
      'x:service:scope_missing: mcp.code=not_found differs from rest.code=forbidden',
    );
    const timeout = {
      ...ok,
      fingerprints: [
        {
          surface: 'rest' as const,
          outcome: 'unverified' as const,
          code: 'service_unavailable',
          reason: null,
        },
      ],
    };
    expect(divergence(timeout)).toBe('x:service:scope_missing: rest unverified');
  });
});
