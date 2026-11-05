import { randomUUID } from 'node:crypto';
import { READ_OPS } from '@cuspatlas/api';
import { DISPLAY_ACTIONS } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, openAppointmentHarness } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { T_ALPHA } from './support/fixtures';

/**
 * A batch 3 negative harness over every READ_OPS operation (beside the derived A7 forbidden matrix,
 * which already runs each one for every principal kind): a revoked member, a member without the scope,
 * a shared-display principal (only the anonymized display projections), and on MCP an agent principal
 * for the human-only administration and preference operations. Each refusal is a 403 before any
 * validation, so a dummy body is enough. Synthetic data only.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let display: string;
const url = (path: string) =>
  path
    .replace('{measureKey}', 'scheduling.utilization')
    .replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000001');
const call = (who: string, op: (typeof READ_OPS)[number]) =>
  h.call(who, op.method === 'get' ? 'GET' : 'POST', url(op.path), op.method === 'get' ? undefined : {});

beforeAll(async () => {
  db = await openTestDatabase('read_surfaces_negative');
  h = await openAppointmentHarness(db, { mcp: true });
  const ref = randomUUID();
  await db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'display-negative')`,
    [ref],
  );
  await db.admin.query(
    'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3::text[])',
    [
      T_ALPHA,
      ref,
      [
        'display.shared',
        'scheduling.read',
        'patients.read',
        'analytics.read',
        'audit.read',
        'access.manage',
        'clinical.read',
      ],
    ],
  );
  display = await h.issuer.issue({ sub: ref, tid: T_ALPHA });
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('A batch 3 negative harness', () => {
  it('a revoked member is refused on every operation', async () => {
    for (const op of READ_OPS) expect((await call('a2', op)).statusCode, op.operationId).toBe(403);
  });

  it('a member without the scope is refused on every scoped operation', async () => {
    // a5 holds only syntheticTasks.read: null-scope operations (navigation, preferences) admit it.
    const open = new Set(['navigation.read']);
    for (const op of READ_OPS) {
      if (open.has(op.operationId) || op.operationId.startsWith('preferences.')) continue;
      expect((await call('a5', op)).statusCode, op.operationId).toBe(403);
    }
  });

  it('a shared-display principal reaches only the display projections', async () => {
    for (const op of READ_OPS) {
      const r = await call(display, op);
      if (DISPLAY_ACTIONS.has(op.operationId)) expect(r.statusCode, op.operationId).not.toBe(403);
      else expect(r.statusCode, op.operationId).toBe(403);
    }
  });

  it('an agent (service principal) cannot read audit, review access, revoke or keep preferences on MCP', async () => {
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['audit.read', 'access.manage'] WHERE principal_id = '30000000-0000-4000-8000-0000000000a1'`,
    );
    const human = READ_OPS.filter(
      (o) => o.operationId.startsWith('admin.') || o.operationId.startsWith('preferences.'),
    );
    expect(human.length).toBe(12);
    for (const op of human) {
      const args: Record<string, unknown> =
        op.method === 'post' ? { idempotencyKey: `synthetic-${randomUUID()}` } : {};
      for (const p of op.path.match(/\{([^}]+)\}/g) ?? [])
        args[p.slice(1, -1)] = '00000000-0000-4000-8000-000000000001';
      const r = await h.mcp('svcA1', op.tool as string, args);
      expect([r.status, r.code], op.operationId).toEqual([403, 'forbidden']);
    }
  });
});
