import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTION_POLICIES } from '@cuspatlas/domain';
import { describe, expect, it } from 'vitest';
import {
  type CatalogOperation,
  RELATIONSHIP_SCOPES,
  scopeNameDefect,
} from '../../packages/contracts/src/catalog/catalog';
import { buildCatalog, ROOT, stableJson } from '../../scripts/catalog/build-catalog';
import { renderScopesMd } from '../../scripts/catalog/docs';
import { loadProcedureInputs, procedureGaps } from '../../scripts/catalog/procedure';
import { buildScopeRegistry, humanOnlyScopes, registeredScopes } from '../../scripts/catalog/scopes';

/** A3: the published scope registry and the new-operation procedure as a CI checklist. */
const catalog = buildCatalog();
const registry = buildScopeRegistry(catalog);
const registered = registeredScopes();
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * Registered in SHARED-CONTRACTS but used by no operation yet. Reported, never silently retained: a
 * new orphan (an operation removed while its scope stays) fails until it is reviewed here.
 */
const REVIEWED_ORPHANS = ['claims.read'];

describe('A3 scope registry', () => {
  it('the machine-readable registry and docs/api/scopes.md are current', () => {
    expect(read('packages/contracts/src/catalog/scopes.json')).toBe(stableJson(registry));
    expect(read('docs/api/scopes.md')).toBe(renderScopesMd(registry));
  });

  it('rejects camel-case, wildcard, prefix-wildcard, empty and malformed names', () => {
    expect(scopeNameDefect('receivablesRead')).toBe(
      'camel-case scope receivablesRead; write it as receivables.read',
    );
    expect(scopeNameDefect('*')).toBe('wildcard scope *');
    expect(scopeNameDefect('patients.*')).toBe('wildcard scope patients.*');
    expect(scopeNameDefect('')).toBe('empty scope name');
    expect(scopeNameDefect('Patients.read')).toBe('scope Patients.read is not noun.verb');
    expect(scopeNameDefect('patients.read.all')).toBe('scope patients.read.all is not noun.verb');
    for (const s of registry.scopes) expect(scopeNameDefect(s.name), s.name).toBeNull();
  });

  it('every scope the catalog or the policy table uses is registered in SHARED-CONTRACTS', () => {
    const used = new Set(
      Object.values(ACTION_POLICIES as Record<string, { scope: string | null }>)
        .map((p) => p.scope)
        .filter((x): x is string => x !== null),
    );
    expect([...used].filter((s) => !registered.has(s))).toStrictEqual([]);
    expect(registry.scopes.map((s) => s.name).filter((s) => !registered.has(s))).toStrictEqual([]);
  });

  it('reports registered scopes no operation uses (orphans) instead of retaining them silently', () => {
    const used = new Set(registry.scopes.map((s) => s.name));
    expect([...registered].filter((s) => !used.has(s)).sort()).toStrictEqual(REVIEWED_ORPHANS);
  });

  it('relationship scopes are the five S5 names, separate from every staff scope', () => {
    expect(registry.relationshipScopes).toStrictEqual([...RELATIONSHIP_SCOPES]);
    const doc = read('docs/SHARED-CONTRACTS.md');
    const table = doc.slice(doc.indexOf('### Relationship scopes'), doc.indexOf('## Plan taxonomy'));
    expect([...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1])).toStrictEqual([
      ...RELATIONSHIP_SCOPES,
    ]);
    for (const r of RELATIONSHIP_SCOPES) {
      expect(registered.has(r)).toBe(false);
      expect(catalog.some((o) => o.scope === r)).toBe(false);
    }
  });

  it('human-only scopes include clinical signing, money corrections, merges and approvals', () => {
    const human = new Set(registry.scopes.filter((s) => s.humanOnly).map((s) => s.name));
    for (const s of [
      'clinical.sign',
      'clinical.oversight',
      'billing.correct',
      'patients.merge',
      'patients.mergeReconcile',
      'syntheticTasks.approve',
      'scheduling.override',
      'imaging.associate',
      'imaging.delete',
      'imaging.legalHold',
    ]) {
      expect(human.has(s), s).toBe(true);
    }
    // Device and portal principals never hold a staff scope.
    for (const s of registry.scopes) {
      if (s.principalClasses.includes('portal')) expect.fail(`${s.name} admits a portal principal`);
    }
  });
});

describe('A-M2/A-S8 registry table is the only source', () => {
  it('registeredScopes and humanOnlyScopes read only the registry table rows, never prose', () => {
    const dir = resolve(ROOT, 'node_modules/.cache/h1-scope-fixture/docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'SHARED-CONTRACTS.md'),
      [
        '## Roles and scopes',
        'Prose mentions `prose.only` (human only) and `noun.verb`.',
        '### Scope registry table',
        '| Scope | Human only |',
        '| --- | --- |',
        '| `alpha.read` | no |',
        '| `alpha.sign` | yes |',
        '### Relationship scopes',
      ].join('\n'),
    );
    const root = resolve(dir, '..');
    expect([...registeredScopes(root)].sort()).toStrictEqual(['alpha.read', 'alpha.sign']);
    expect([...humanOnlyScopes(root)]).toStrictEqual(['alpha.sign']);
  });

  it('the published humanOnly flag is the SHARED-CONTRACTS flag, and no human-only scope admits a non-human', () => {
    const declared = humanOnlyScopes();
    for (const sc of registry.scopes) expect(sc.humanOnly, sc.name).toBe(declared.has(sc.name));
    const offenders = catalog.filter(
      (o) => o.scope !== null && declared.has(o.scope) && o.principals.some((p) => p !== 'human'),
    );
    expect(offenders.map((o) => `${o.operation}:${o.principals.join('+')}`)).toStrictEqual([]);
  });
});

describe('A-S3 grey-zone agent operations (A-D4 recommended-pending-approval)', () => {
  it('operations that change access, consent, money responsibility or configuration are human only', () => {
    const humanOnly = [
      'portal.principals.enroll',
      'portal.principals.revoke',
      'communications.consents.record',
      'communications.consents.optOut',
      'patients.relationships.add',
      'patients.relationships.revoke',
      'billing.plans.authorize',
      'billing.plans.autopay',
      'billing.responsibility.transfer',
      'scheduling.locations.changeTimeZone',
      'scheduling.resources.define',
      'imaging.storage.reconcile',
      'imaging.objects.content',
      'imaging.objects.grantRead',
    ];
    const byOp = new Map(catalog.map((o) => [o.operation, o]));
    for (const op of humanOnly) expect(byOp.get(op)?.principals, op).toStrictEqual(['human']);
    // The worker keeps its integrity sweep through a separate, worker-only service command.
    const sweep = byOp.get('imaging.storage.sweep');
    expect(sweep?.principals).toStrictEqual(['service']);
    expect(sweep?.transports).toStrictEqual(['worker']);
  });

  it('A-S8 inferred fields: admin sensitivity, bulk export class and the revoke-grant scope', () => {
    const byOp = new Map(catalog.map((o) => [o.operation, o]));
    for (const o of catalog.filter(
      (x) => x.scope === 'admin.configure' && !/\.export(\.|$)/.test(x.operation),
    )) {
      expect(o.sensitivity, o.operation).toBe('operational');
    }
    expect(byOp.get('imaging.export.blobs')?.sensitivity).toBe('phiBulk');
    expect(byOp.get('imaging.objects.revokeGrant')?.scope).toBe('imaging.write');
  });
});

describe('A3 new-operation procedure', () => {
  const inputs = loadProcedureInputs(catalog, registered, ACTION_POLICIES);

  it('every catalog operation has its catalog, scope, policy, harness and OpenAPI rows', () => {
    const gaps = catalog.flatMap((o) => procedureGaps(o, inputs).map((g) => `${o.operation}:${g}`));
    expect(gaps).toStrictEqual([]);
  });

  it('a new operation that skipped steps fails with each missing step named', () => {
    const fresh: CatalogOperation = {
      operation: 'patients.synthetic.newThing',
      owner: 'S',
      kind: 'command',
      authorization: 'authorize',
      action: 'patients.synthetic.newThing',
      scope: 'patients.newThing',
      principals: ['human'],
      transports: ['rest'],
      rest: { method: 'post', path: '/v1/synthetic-new-thing', successStatus: '201', successSchema: 'x' },
      refusals: ['403'],
      idempotency: 'required',
      sensitivity: 'phi',
      status: 'active',
    };
    expect(procedureGaps(fresh, { ...inputs, catalog: [...catalog, fresh] })).toStrictEqual([
      'scope',
      'policy',
      'harness',
      'openapi',
    ]);
    expect(procedureGaps(fresh, inputs)).toContain('catalog');
  });

  it('the procedure is published', () => {
    const doc = read('docs/api/new-operation.md');
    for (const step of ['catalog', 'scope', 'policy', 'harness', 'openapi'])
      expect(doc).toContain(`\`${step}\``);
  });
});
