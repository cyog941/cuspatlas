import { randomUUID } from 'node:crypto';
import { MARKER } from './marker';
import { intakeBody, legacyPackage, legacyTables, PRACTICE, SOURCE_SYSTEM } from './migration-fixtures';

/**
 * Workstream M rows of the shared negative harness (tests/integration/negative-harness.test.ts):
 * every M command attempted cross-tenant, revoked, downgraded and through MCP. Structurally typed like
 * the harness's HarnessCommand so the harness file only appends them.
 */
type F = { readonly [name: string]: string };
type Rest = { method: 'GET' | 'POST'; url: string; body?: unknown; keyed: boolean; status: number };
interface Row {
  readonly operation: string;
  readonly tool: string;
  readonly crossTenant: 'not_found' | 'own_tenant_only';
  readonly downgradedTo: 'readOnly' | 'noPatientScopes';
  rest(f: F): Rest;
  mcpArgs(f: F): Record<string, unknown>;
}

const pkg = () => legacyPackage(legacyTables({ nameSuffix: MARKER, unknownField: true }));
const get = (url: string): Rest => ({ method: 'GET', url, keyed: false, status: 200 });
const post = (url: string, body: unknown, status = 200): Rest => ({
  method: 'POST',
  url,
  body,
  keyed: true,
  status,
});
const keyed = (body: Record<string, unknown>) => ({ ...body, idempotencyKey: randomUUID() });
const pq = (f: F) => `packageRef=${f.alphaMigrationPackage}`;

const profileBody = {
  sourceSystem: 'syn-harness-pms',
  format: 'cuspatlas-synthetic-legacy/1',
  practiceRef: PRACTICE,
};
const resolveBody = (f: F) => ({
  packageRef: f.alphaMigrationPackage,
  itemRef: f.alphaMigrationItem,
  decision: 'exclude',
  reasonCode: 'reviewed',
});

export const MIGRATION_HARNESS_ROWS: Row[] = [
  {
    operation: 'migration.sourceProfiles.register',
    tool: 'migration_source_profiles_register',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => post('/v1/migration/source-profiles', profileBody, 201),
    mcpArgs: () => keyed(profileBody),
  },
  {
    operation: 'migration.packages.intake',
    tool: 'migration_packages_intake',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => post('/v1/migration/packages', intakeBody(f.alphaMigrationProfile as string, pkg()), 201),
    mcpArgs: (f) => keyed(intakeBody(f.alphaMigrationProfile as string, pkg())),
  },
  {
    operation: 'migration.packages.read',
    tool: 'migration_packages_read',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => get(`/v1/migration/packages/state?${pq(f)}`),
    mcpArgs: (f) => ({ packageRef: f.alphaMigrationPackage }),
  },
  {
    operation: 'migration.reviewItems.list',
    tool: 'migration_review_items_list',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => get(`/v1/migration/review-items?${pq(f)}`),
    mcpArgs: (f) => ({ packageRef: f.alphaMigrationPackage }),
  },
  {
    operation: 'migration.reviewItems.resolve',
    tool: 'migration_review_items_resolve',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => post('/v1/migration/review-items/resolve', resolveBody(f)),
    mcpArgs: (f) => keyed(resolveBody(f)),
  },
];

type Owner = (
  url: string,
  body: unknown,
) => Promise<{ statusCode: number; json(): { data: Record<string, string> } }>;
type Get = (
  url: string,
) => Promise<{ statusCode: number; json(): { data: { itemRef: string; category: string }[] } }>;

/** Alpha fixtures for the M rows, created through the M commands as the owner. */
export async function seedMigrationHarness(owner: Owner, ownerGet: Get): Promise<Record<string, string>> {
  const profile = await owner('/v1/migration/source-profiles', {
    sourceSystem: SOURCE_SYSTEM,
    format: 'cuspatlas-synthetic-legacy/1',
    practiceRef: PRACTICE,
  });
  if (profile.statusCode !== 201) throw new Error('harness migration profile');
  const alphaMigrationProfile = profile.json().data.profileRef as string;
  const intake = await owner(
    '/v1/migration/packages',
    intakeBody(alphaMigrationProfile, legacyPackage(legacyTables({ unknownField: true, exportSeq: 0 }))),
  );
  if (intake.statusCode !== 201) throw new Error('harness migration package');
  const alphaMigrationPackage = intake.json().data.packageRef as string;
  const items = await ownerGet(`/v1/migration/review-items?packageRef=${alphaMigrationPackage}`);
  const field = items.json().data.find((i) => i.category === 'unknown_field');
  if (!field) throw new Error('harness migration review item');
  return { alphaMigrationProfile, alphaMigrationPackage, alphaMigrationItem: field.itemRef };
}

/** Migration tables in the harness state digest (a refusal must leave every one unchanged). */
export const MIGRATION_STATE_SQL: readonly string[] = [
  'SELECT count(*)::int AS n FROM cuspatlas.migration_source_profiles',
  'SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.migration_packages',
  'SELECT count(*)::int AS n FROM cuspatlas.migration_staged_records',
  'SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.migration_review_items',
];
