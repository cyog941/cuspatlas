import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  openAppointmentHarness,
  seedLocation,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';

/**
 * A20 / OR-01 behaviour of the transport-attached envelope (REST and MCP, one table): an empty list,
 * a truncated list, a location-restricted caller (a3 is restricted to loc-north) and an explicit
 * location filter. Synthetic data only.
 */
let db: TestDatabase;
let h: AppointmentHarness;
type Env = {
  asOf: string;
  appliedFilters: Record<string, unknown>;
  scope: { kind: string; locationRefs?: string[] };
  limit: number;
  truncated: boolean;
  nextCursor: string | null;
  ordering: { key: string; direction: string; tieBreak: string };
  count: { exact?: number; atLeast?: number };
};
const env = async (who: string, url: string) =>
  h.ok<{ data: unknown[]; envelope: Env }>(await h.call(who, 'GET', url));

beforeAll(async () => {
  db = await openTestDatabase('list_envelope');
  h = await openAppointmentHarness(db, { mcp: true, pool: 6 });
  await seedLocation(h, 'loc-north');
  await seedLocation(h, 'loc-south');
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('A20 / OR-01 list envelope on every list', () => {
  it('an empty list states count.exact = 0 with the same envelope', async () => {
    const r = await env('a1', '/v1/scheduling/waitlist?locationRef=loc-south');
    expect(r.data).toEqual([]);
    expect(r.envelope).toMatchObject({
      truncated: false,
      nextCursor: null,
      count: { exact: 0 },
      scope: { kind: 'location_set', locationRefs: ['loc-south'] },
      ordering: { key: 'priority', direction: 'asc', tieBreak: 'entryRef' },
      limit: 100,
      appliedFilters: { limit: 100, locationRef: 'loc-south' },
    });
    expect(Number.isNaN(Date.parse(r.envelope.asOf))).toBe(false);
  });

  it('a truncated page carries the cursor, truncated and a lower-bound count; the last page is exact', async () => {
    const first = await env('a1', '/v1/scheduling/resources?limit=1');
    expect(first.data).toHaveLength(1);
    expect(first.envelope).toMatchObject({ limit: 1, truncated: true, count: { atLeast: 1 } });
    expect(first.envelope.nextCursor).toEqual(expect.any(String));
    const all = await env('a1', '/v1/scheduling/resources?limit=100');
    expect(all.envelope).toMatchObject({
      truncated: false,
      nextCursor: null,
      count: { exact: all.data.length },
    });
    expect(all.envelope.scope).toStrictEqual({ kind: 'tenant_wide' });
  });

  it('a location-restricted caller sees the restriction policy applied, not what it asked for', async () => {
    const r = await env('a3', '/v1/scheduling/resources?limit=100');
    expect(r.envelope.scope).toStrictEqual({ kind: 'assigned_locations', locationRefs: ['loc-north'] });
    // A tenant-wide list (not location-filtered) states tenant_wide even for a restricted caller.
    const p = h.ok<{ envelope: Env }>(await h.call('a3', 'POST', '/v1/patients/search', { limit: 5 }));
    expect(p.envelope.scope).toStrictEqual({ kind: 'tenant_wide' });
  });

  it('MCP answers the same envelope from the same table', async () => {
    const m = await h.mcp('a3', 'scheduling_resources_list', { limit: '100' });
    const rest = await env('a3', '/v1/scheduling/resources?limit=100');
    const { asOf: _a, ...mcpEnv } = (m.body as { envelope: Env }).envelope;
    const { asOf: _b, ...restEnv } = rest.envelope;
    expect(mcpEnv).toStrictEqual(restEnv);
  });
});
