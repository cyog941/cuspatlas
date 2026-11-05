import { ROUTES } from '@cuspatlas/api';
import { type CatalogOperation, NAVIGATION } from '@cuspatlas/contracts';
import catalog from '@cuspatlas/contracts/catalog/operations.json' with { type: 'json' };
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, openAppointmentHarness } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { USER_A4 } from './support/fixtures';

/**
 * A24 (OR-14): navigable capabilities come from the catalog. Every capability resolves to registered
 * operations with a REST route, financial destinations group under one area, and GET /v1/navigation
 * filters by the caller's live permissions (a scope removed now disappears now). Synthetic data only.
 */
const OPS = new Map((catalog as unknown as CatalogOperation[]).map((o) => [o.operation, o]));
let db: TestDatabase;
let h: AppointmentHarness;
type Json = Record<string, any>;

beforeAll(async () => {
  db = await openTestDatabase('navigation');
  h = await openAppointmentHarness(db, { mcp: true });
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('A24 navigation from the catalog', () => {
  it('every capability resolves to registered catalog operations with a route', () => {
    const routed = new Set(ROUTES.map((r) => r.operationId));
    const keys = new Set<string>();
    for (const g of NAVIGATION) {
      for (const c of g.capabilities) {
        expect(keys.has(c.key), c.key).toBe(false);
        keys.add(c.key);
        expect(c.operations[0]).toBe(c.entry);
        for (const op of c.operations) {
          expect(OPS.get(op), `${c.key}: ${op} is not a catalog operation`).toBeDefined();
          expect(routed.has(op), `${c.key}: ${op} has no route`).toBe(true);
          expect(OPS.get(op)?.status).toBe('active');
        }
      }
    }
    expect(NAVIGATION.map((g) => g.area)).toEqual([
      'scheduling',
      'clinical',
      'financial',
      'communications',
      'imaging',
      'administration',
      'migration',
    ]);
  });

  it('groups every money destination under the one financial area', () => {
    for (const g of NAVIGATION) {
      const money = g.capabilities.flatMap((c) => c.operations).filter((o) => /^(billing|rcm)\./.test(o));
      if (g.area !== 'financial') expect(money, g.area).toEqual([]);
    }
    const financial = NAVIGATION.find((g) => g.area === 'financial');
    expect(financial?.capabilities.map((c) => c.key)).toEqual(
      expect.arrayContaining(['ledger', 'claims', 'coverage', 'plansAndStatements', 'receivables']),
    );
  });

  it('filters by the live permissions of the caller', async () => {
    await db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2::text[] WHERE principal_id = $1', [
      USER_A4,
      ['scheduling.read', 'patients.read'],
    ]);
    const nav = h.ok<{ data: Json }>(await h.call('a4', 'GET', '/v1/navigation')).data;
    const areas = nav.areas.map((a: Json) => a.area);
    expect(areas).toEqual(expect.arrayContaining(['scheduling', 'administration']));
    for (const hidden of ['clinical', 'financial', 'imaging', 'migration']) expect(areas).not.toContain(hidden);
    const schedule = nav.areas[0].capabilities.find((c: Json) => c.key === 'schedule');
    expect(schedule.entry).toEqual({
      operation: 'schedule.view',
      kind: 'query',
      method: 'get',
      path: '/v1/schedule/view',
      mcpTool: 'schedule_view',
    });
    // Booking needs scheduling.write: the capability is shown, the operation is not.
    expect(schedule.operations.map((o: Json) => o.operation)).not.toContain('scheduling.appointments.book');
    expect(JSON.stringify(nav)).not.toContain('billing.');

    await db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2::text[] WHERE principal_id = $1', [
      USER_A4,
      ['patients.read'],
    ]);
    const after = h.ok<{ data: Json }>(await h.call('a4', 'GET', '/v1/navigation')).data;
    const caps = after.areas.flatMap((a: Json) => a.capabilities.map((c: Json) => c.key));
    expect(caps).not.toContain('schedule');
    expect(caps).toContain('patients');
  });

  it('REST equals MCP; revoked and cross-tenant callers are refused', async () => {
    const rest = h.ok<Json>(await h.call('a1', 'GET', '/v1/navigation'));
    const mcp = await h.mcp('a1', 'navigation_get', {});
    expect(mcp.body).toEqual(rest);
    expect((await h.call('a2', 'GET', '/v1/navigation')).statusCode).toBe(403);
    const beta = h.ok<{ data: Json }>(await h.call('b1', 'GET', '/v1/navigation')).data;
    expect(beta.version).toBe('navigation.1');
  });
});
