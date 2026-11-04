import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  type EngagementHarness,
  email,
  openEngagementHarness,
  SVC_T1,
  synthPhone,
} from './support/engagement-fixtures';
import { T_ALPHA, USER_A4 } from './support/fixtures';

/**
 * Independent review of E4-E9, second pass (synthetic data only). Each describe block is one review
 * item; the first assertion of every block failed before its fix.
 */
let db: TestDatabase;
let h: EngagementHarness;
let LOC: string;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const MAIN = '+1-202-555-0100';
const CONFIG = {
  numbers: [MAIN],
  timeZone: 'America/New_York',
  hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '08:00', end: '17:00' })),
  routing: { open: { action: 'ring_queue', queue: 'front_desk' }, closed: { action: 'voicemail' } },
  recording: 'off',
};

beforeAll(async () => {
  db = await openTestDatabase('engagement_review_2');
  h = await openEngagementHarness(db, { mcp: true });
  LOC = (await seedLocation(h, 'loc-e-rv2')).locationRef;
  h.ok(await h.call('a1', 'POST', '/v1/telephony/config', CONFIG), 201);
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

async function ring(callerNumber: string): Promise<string> {
  const token = await h.issuer.issue({ sub: SVC_T1, tid: T_ALPHA });
  const r = await h.call(
    token,
    'POST',
    '/v1/telephony/calls',
    {
      providerCallRef: `rv2-${randomUUID()}`,
      direction: 'inbound',
      callerNumber,
      dialedNumber: MAIN,
      occurredAt: new Date().toISOString(),
      outcome: 'missed',
    },
    randomUUID(),
  );
  return h.ok<{ data: { callRef: string } }>(r, 201).data.callRef;
}

describe('item 1: keyed digests', () => {
  it('caller digest is an HMAC, never a plain sha256 of the number; +1 and bare 10-digit numbers match', async () => {
    const withPlus = await h.person('Synthetic Keyed One', [synthPhone('51')]);
    const bare = await h.person('Synthetic Keyed Two', [
      { channel: 'phone', use: 'mobile', value: '2025550151', preference: 'preferred' },
    ]);
    const callRef = await ring('+1-202-555-0151');
    const stored = await db.admin.query('SELECT caller_digest FROM cuspatlas.call_events WHERE id = $1', [
      callRef,
    ]);
    const digest = stored.rows[0].caller_digest as string;
    for (const plain of ['12025550151', '2025550151', '+12025550151', '+1-202-555-0151']) {
      expect(digest).not.toBe(sha(plain));
    }
    const call = h.ok<{ data: { candidates: string[] } }>(
      await h.call('a1', 'GET', `/v1/telephony/calls/${callRef}`),
    ).data;
    expect([...call.candidates].sort()).toStrictEqual([withPlus, bare].sort());
    // The same number again yields the same keyed digest (deterministic within the tenant).
    const second = await ring('+1-202-555-0151');
    const again = await db.admin.query('SELECT caller_digest FROM cuspatlas.call_events WHERE id = $1', [
      second,
    ]);
    expect(again.rows[0].caller_digest).toBe(digest);
  });

  it('a contact verification digest is keyed and verifies across phone formats; email stays case-insensitive', async () => {
    const p = await h.person('Synthetic Keyed Three', [synthPhone('52'), email('Keyed.Three')]);
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${p}/contact-verifications`, {
        channel: 'phone',
        value: '2025550152',
        method: 'synthetic_attested',
      }),
      201,
    );
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${p}/contact-verifications`, {
        channel: 'email',
        value: 'keyed.three@EXAMPLE.invalid',
        method: 'synthetic_attested',
      }),
      201,
    );
    const { rows } = await db.admin.query(
      'SELECT contact_digest FROM cuspatlas.contact_verifications WHERE patient_id = $1',
      [p],
    );
    expect(rows).toHaveLength(2);
    const plains = [
      '12025550152',
      '2025550152',
      'keyed.three@example.invalid',
      'Keyed.Three@example.invalid',
    ].map(sha);
    for (const r of rows) expect(plains).not.toContain(r.contact_digest);
  });
});

describe('item 4: call candidates need patients.read and honor the location restriction', () => {
  it('candidate refs are withheld without patients.read, limited to own locations when restricted, and stored as keys', async () => {
    const north = await h.person('Synthetic Cand North', [synthPhone('53')], {
      homeLocationRef: 'loc-north',
    });
    const south = await h.person('Synthetic Cand South', [synthPhone('53')], {
      homeLocationRef: 'loc-south',
    });
    const callRef = await ring('+1-202-555-0153');
    const keys = await db.admin.query('SELECT caller_match_keys FROM cuspatlas.call_events WHERE id = $1', [
      callRef,
    ]);
    expect(keys.rows[0].caller_match_keys).toHaveLength(2);
    const read = async (who: string) =>
      h.ok<{ data: { candidates: string[]; candidateState: string } }>(
        await h.call(who, 'GET', `/v1/telephony/calls/${callRef}`),
      ).data;
    expect([...(await read('a1')).candidates].sort()).toStrictEqual([north, south].sort());
    // Restricted to loc-north: only the north patient is a candidate.
    expect((await read('a3')).candidates).toStrictEqual([north]);
    // Without patients.read the call is readable but names no patient.
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = array_remove(scopes, 'patients.read') WHERE principal_id = $1`,
      [USER_A4],
    );
    try {
      const noPatients = await read('a4');
      expect([noPatients.candidates, noPatients.candidateState]).toStrictEqual([[], 'none']);
    } finally {
      await db.admin.query(
        `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['patients.read'] WHERE principal_id = $1`,
        [USER_A4],
      );
    }
    // Showing candidates is a sensitive read of those patients.
    const logged = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.sensitive_read_events
       WHERE operation = 'telephony.calls.read' AND $1::uuid = ANY (resource_refs)`,
      [north],
    );
    expect(logged.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

describe('item 2: export needs the read scopes of everything it reads', () => {
  it('a member holding admin.configure alone (or without messaging.read) is refused; the allowed export logs counts and refs per table', async () => {
    const A5 = '20000000-0000-4000-8000-0000000000a5';
    const grant = (id: string, scopes: string[]) =>
      db.admin.query(
        'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
        [id, scopes],
      );
    const strip = (id: string, scopes: string[]) =>
      db.admin.query(
        `UPDATE cuspatlas.memberships SET scopes = ARRAY(SELECT s FROM unnest(scopes) s WHERE s <> ALL ($2::text[]))
         WHERE principal_id = $1`,
        [id, scopes],
      );
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = ARRAY['admin.configure'] WHERE principal_id = $1`,
      [A5],
    );
    await grant(USER_A4, ['admin.configure']);
    try {
      const only = await h.call('a5', 'GET', '/v1/communications/export');
      expect(only.statusCode).toBe(403);
      // a4 reads patients and communications but holds no messaging.read.
      const noMessaging = await h.call('a4', 'GET', '/v1/communications/export');
      expect(noMessaging.statusCode).toBe(403);
      expect((await h.mcp('a4', 'communications_export', {})).status).toBe(403);
    } finally {
      await strip(USER_A4, ['admin.configure']);
    }
    await h.person('Synthetic Export Scope', [synthPhone('54')]);
    const doc = h.ok<{ data: { tables: Record<string, unknown[]> } }>(
      await h.call('a1', 'GET', '/v1/communications/export'),
    ).data;
    const logged = await db.admin.query(
      `SELECT query_fields, total_count, resource_refs FROM cuspatlas.sensitive_read_events
       WHERE operation = 'communications.export' ORDER BY occurred_at DESC, query_fields`,
    );
    const byTable = new Map<string, { total_count: number; resource_refs: string[] }>(
      logged.rows.map((r) => [r.query_fields[0], r]),
    );
    const camel = (t: string) => t.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    for (const [table, rows] of Object.entries(doc.tables)) {
      expect(byTable.get(camel(table))?.total_count, table).toBe(rows.length);
    }
    expect(byTable.get('callEvents')?.resource_refs.length).toBeLessThanOrEqual(100);
  });
});

describe('item 3: thread bodies are not readable by service principals by default', () => {
  it('a service principal holding messaging.read is refused on REST and MCP; a human reads', async () => {
    const SVC_A1 = '30000000-0000-4000-8000-0000000000a1';
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['messaging.read'] WHERE principal_id = $1`,
      [SVC_A1],
    );
    const p = await h.person('Synthetic Thread Body', [email('thread.body')]);
    const t = h.ok<{ data: { threadRef: string } }>(
      await h.call('a1', 'POST', `/v1/patients/${p}/message-threads`, {
        topic: 'general',
        locationRef: LOC,
        body: 'Synthetic staff opener',
      }),
      201,
    ).data;
    expect((await h.call('a1', 'GET', `/v1/messaging/threads/${t.threadRef}`)).statusCode).toBe(200);
    const rest = await h.call('svcA1', 'GET', `/v1/messaging/threads/${t.threadRef}`);
    expect([rest.statusCode, rest.json().code]).toStrictEqual([403, 'forbidden']);
    const mcp = await h.mcp('svcA1', 'messaging_threads_get', { threadRef: t.threadRef });
    expect(mcp.status).toBe(403);
  });
});

describe('nits: typed conflicts and consent vocabulary', () => {
  it('concurrent deliveries of one provider call event never produce a 500; treatment is not a communications consent purpose', async () => {
    const token = await h.issuer.issue({ sub: SVC_T1, tid: T_ALPHA });
    const event = {
      providerCallRef: `rv2-dup-${randomUUID()}`,
      direction: 'inbound',
      callerNumber: '+1-202-555-0155',
      dialedNumber: MAIN,
      occurredAt: new Date().toISOString(),
      outcome: 'missed',
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => h.call(token, 'POST', '/v1/telephony/calls', event, randomUUID())),
    );
    for (const r of results) expect([201, 409]).toContain(r.statusCode);
    const n = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.call_events WHERE provider_call_ref = $1',
      [event.providerCallRef],
    );
    expect(n.rows[0].n).toBe(1);

    const p = await h.person('Synthetic Treatment Consent', [email('rv2.treatment')]);
    const viaApi = await h.call('a1', 'POST', `/v1/patients/${p}/consents`, {
      channel: 'email',
      purpose: 'treatment',
      state: 'granted',
      source: 'written_form',
      consentVersion: 'v1',
    });
    expect(viaApi.statusCode).toBe(400);
    await expect(
      db.admin.query(
        `INSERT INTO cuspatlas.communication_consents (tenant_id, patient_id, channel, purpose, state, source, consent_version, recorded_by)
         VALUES ($1, $2, 'email', 'treatment', 'granted', 'written_form', 'v1', $3)`,
        [T_ALPHA, p, '20000000-0000-4000-8000-0000000000a1'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
