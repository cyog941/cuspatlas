import { randomUUID } from 'node:crypto';
import { validateCallRead } from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { dbNow } from './support/db-clock';
import {
  type EngagementHarness,
  openEngagementHarness,
  SVC_T1,
  synthPhone,
} from './support/engagement-fixtures';
import { FakeTelephony } from './support/fake-telephony';
import { T_ALPHA } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * E8 telephony configuration and call references (E-S2 blocked-on-discovery; FAKE adapter only, no
 * network, no recording). Configuration is versioned and validated before publication; recording is
 * refused; a call event is metadata only and resolves to the rule in force when it happened; a call
 * is linked to a patient only by a person's confirmation, a caller-number match yields candidates.
 */
let db: TestDatabase;
let h: EngagementHarness;
const fake = new FakeTelephony();
const MAIN = '+1-202-555-0100';
const CONFIG = {
  numbers: [MAIN],
  timeZone: 'America/New_York',
  hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '08:00', end: '17:00' })),
  routing: { open: { action: 'ring_queue', queue: 'front_desk' }, closed: { action: 'voicemail' } },
  recording: 'off',
};
let household1: string;
let household2: string;
let single: string;

beforeAll(async () => {
  db = await openTestDatabase('comms_telephony');
  h = await openEngagementHarness(db, { mcp: true });
  // A shared household phone and a phone of one patient (fictional 555-01xx numbers only).
  household1 = await h.person(`Synthetic Caller One ${MARKER}`, [synthPhone('42')]);
  household2 = await h.person('Synthetic Caller Two', [synthPhone('42')]);
  single = await h.person('Synthetic Caller Single', [synthPhone('43')]);
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

const integration = async () => h.issuer.issue({ sub: SVC_T1, tid: T_ALPHA });
async function deliverFakeEvents(): Promise<
  { statusCode: number; json: () => { data: { callRef: string } } }[]
> {
  const token = await integration();
  const out = [];
  for (const e of await fake.pull())
    out.push(await h.call(token, 'POST', '/v1/telephony/calls', e, e.providerCallRef));
  return out;
}

describe('E8 configuration', () => {
  it('not configured is explicit; a configuration is versioned, recording stays off, invalid routing is refused', async () => {
    const empty = h.ok<{
      data: { coverage: { status: string; reason: string }; provider: { status: string } };
    }>(await h.call('a1', 'GET', '/v1/telephony/config')).data;
    expect(empty.coverage).toStrictEqual({
      status: 'unavailable',
      reason: 'not_configured',
      owner: 'practice',
    });
    expect(empty.provider.status).toBe('blocked_on_discovery');
    const recording = await h.call('a1', 'POST', '/v1/telephony/config', { ...CONFIG, recording: 'on' });
    expect([recording.statusCode, recording.json().detail.violations[0].rule]).toStrictEqual([
      422,
      'recording_without_consent',
    ]);
    const overlap = await h.call('a1', 'POST', '/v1/telephony/config', {
      ...CONFIG,
      hours: [
        { weekday: 1, start: '08:00', end: '12:00' },
        { weekday: 1, start: '11:00', end: '17:00' },
      ],
    });
    expect([overlap.statusCode, overlap.json().detail.violations[0].rule]).toStrictEqual([
      422,
      'routing_invalid',
    ]);
    const badZone = await h.call('a1', 'POST', '/v1/telephony/config', {
      ...CONFIG,
      timeZone: 'Mars/Olympus',
    });
    expect(badZone.statusCode).toBe(422);
    const realLooking = await h.call('a1', 'POST', '/v1/telephony/config', {
      ...CONFIG,
      numbers: ['+1-202-555-1234'],
    });
    expect(realLooking.statusCode).toBe(400);
    expect((await h.call('svcA1', 'POST', '/v1/telephony/config', CONFIG)).statusCode).toBe(403);
    expect((await h.call('a4', 'POST', '/v1/telephony/config', CONFIG)).statusCode).toBe(403);
    expect(await countRows('telephony_configs')).toBe(0);
    const v1 = h.ok<{ data: { version: number; recordingState: string } }>(
      await h.call('a1', 'POST', '/v1/telephony/config', CONFIG),
      201,
    ).data;
    expect(v1).toMatchObject({ version: 1, recordingState: 'off' });
    const read = h.ok<{ data: { config: { version: number; numbers: string[]; recordingState: string } } }>(
      await h.call('a1', 'GET', '/v1/telephony/config'),
    ).data;
    expect(read.config).toMatchObject({ version: 1, numbers: [MAIN], recordingState: 'off' });
    await expect(
      db.admin.query(`UPDATE cuspatlas.telephony_configs SET recording_state = 'on'`),
    ).rejects.toBeDefined();
  });
});

describe('E8 call references', () => {
  it('a fake-adapter call is metadata only, deduplicated, never auto-linked; a historical call keeps its rule version', async () => {
    const at = new Date().toISOString();
    fake.ring({
      direction: 'inbound',
      callerNumber: '+1-202-555-0142',
      dialedNumber: MAIN,
      occurredAt: at,
      outcome: 'missed',
    });
    const [first] = await deliverFakeEvents();
    expect(first?.statusCode).toBe(201);
    const callRef = first?.json().data.callRef as string;
    // The same provider event again is the same call.
    const token = await integration();
    const replay = h.ok<{ data: { callRef: string; deduplicated: boolean } }>(
      await h.call(
        token,
        'POST',
        '/v1/telephony/calls',
        {
          providerCallRef: (
            await db.admin.query('SELECT provider_call_ref FROM cuspatlas.call_events WHERE id = $1', [
              callRef,
            ])
          ).rows[0].provider_call_ref,
          direction: 'inbound',
          callerNumber: '+1-202-555-0142',
          dialedNumber: MAIN,
          occurredAt: at,
          outcome: 'missed',
        },
        randomUUID(),
      ),
      201,
    ).data;
    expect(replay).toStrictEqual({ callRef, deduplicated: true });
    expect(await countRows('call_events')).toBe(1);
    const call = h.ok<{
      data: {
        callerLast4: string;
        recording: null;
        link: null;
        candidates: string[];
        candidateState: string;
        handling: { state: string; rule: { action: string }; sourceVersion: number };
      };
    }>(await h.call('a1', 'GET', `/v1/telephony/calls/${callRef}`)).data;
    expect(call.callerLast4).toBe('0142');
    // A-S3: the read matches the closed CallRead shape: no recording, transcript or body field.
    const raw = (await h.call('a1', 'GET', `/v1/telephony/calls/${callRef}`)).json();
    expect(validateCallRead(raw), JSON.stringify(validateCallRead.errors)).toBe(true);
    expect(JSON.stringify(raw)).not.toMatch(/transcript|"body"/);
    expect(call.recording).toBeNull();
    // A shared household number: two candidates, ambiguous, and no automatic link.
    expect(call.link).toBeNull();
    expect([...call.candidates].sort()).toStrictEqual([household1, household2].sort());
    expect(call.candidateState).toBe('ambiguous');
    expect(call.handling.sourceVersion).toBe(1);
    // A later configuration does not change what the historical call resolved to.
    h.ok(
      await h.call('a1', 'POST', '/v1/telephony/config', {
        ...CONFIG,
        numbers: [MAIN, '+1-202-555-0101'],
        routing: {
          open: { action: 'ring_queue', queue: 'billing' },
          closed: { action: 'external_reference' },
        },
      }),
      201,
    );
    const again = h.ok<{ data: { handling: { sourceVersion: number; rule: { action: string } } } }>(
      await h.call('a1', 'GET', `/v1/telephony/calls/${callRef}`),
    ).data;
    expect(again.handling).toStrictEqual(call.handling);
    const then = h.ok<{ data: { sourceVersion: number } }>(
      await h.call('a1', 'GET', `/v1/telephony/handling?at=${encodeURIComponent(at)}`),
    ).data;
    const now = h.ok<{ data: { sourceVersion: number } }>(
      await h.call('a1', 'GET', `/v1/telephony/handling?at=${encodeURIComponent(await dbNow(db.admin))}`),
    ).data;
    expect([then.sourceVersion, now.sourceVersion]).toStrictEqual([1, 2]);
    // Metadata only: the full caller number is stored nowhere and nothing is a recording.
    const leak = await db.admin.query(
      `SELECT (SELECT count(*) FROM cuspatlas.call_events e WHERE e::text LIKE '%555-0142%' OR e::text LIKE '%5550142%')
            + (SELECT count(*) FROM cuspatlas.audit_events a WHERE a::text LIKE '%5550142%' OR a::text LIKE '%555-0142%')
            + (SELECT count(*) FROM cuspatlas.command_idempotency c WHERE c::text LIKE '%555-0142%') AS n`,
    );
    expect(Number(leak.rows[0].n)).toBe(0);
    const cols = await db.admin.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'cuspatlas'
       AND column_name ~ '(recording|audio)' ORDER BY 1, 2`,
    );
    expect(cols.rows).toStrictEqual([{ table_name: 'telephony_configs', column_name: 'recording_state' }]);
    expect(h.logLines.join('\n')).not.toContain('555-0142');
  });

  it('a person links the call; a beta patient is 404; unlinking keeps the history; only staff with scopes act', async () => {
    fake.ring({
      direction: 'inbound',
      callerNumber: '+1-202-555-0143',
      dialedNumber: MAIN,
      occurredAt: new Date().toISOString(),
      outcome: 'answered',
    });
    const [res] = await deliverFakeEvents();
    const callRef = res?.json().data.callRef as string;
    const call = h.ok<{ data: { candidates: string[]; candidateState: string; link: null } }>(
      await h.call('a1', 'GET', `/v1/telephony/calls/${callRef}`),
    ).data;
    // Even a single exact candidate is not linked until a person confirms.
    expect([call.candidates, call.candidateState, call.link]).toStrictEqual([[single], 'single', null]);
    const beta = h.ok<{ data: { patientRef: string } }>(
      await h.call('b1', 'POST', '/v1/patients', {
        legalName: { known: true, given: 'Synthetic', family: 'Beta Caller' },
        birthDate: { known: true, value: '1990-01-01', precision: 'day' },
      }),
      201,
    ).data.patientRef;
    const foreign = await h.call('a1', 'POST', `/v1/telephony/calls/${callRef}/link`, {
      patientRef: beta,
      reasonCode: 'caller_confirmed_identity',
    });
    expect(foreign.statusCode).toBe(404);
    expect((await h.call('b1', 'GET', `/v1/telephony/calls/${callRef}`)).statusCode).toBe(404);
    expect(
      (
        await h.call('svcA1', 'POST', `/v1/telephony/calls/${callRef}/link`, {
          patientRef: single,
          reasonCode: 'caller_confirmed_identity',
        })
      ).statusCode,
    ).toBe(403);
    expect((await h.call('a5', 'GET', `/v1/telephony/calls/${callRef}`)).statusCode).toBe(403);
    h.ok(
      await h.call('a1', 'POST', `/v1/telephony/calls/${callRef}/link`, {
        patientRef: single,
        reasonCode: 'caller_confirmed_identity',
      }),
      201,
    );
    let read = h.ok<{ data: { link: { patientRef: string } | null } }>(
      await h.call('a1', 'GET', `/v1/telephony/calls/${callRef}`),
    ).data;
    expect(read.link?.patientRef).toBe(single);
    h.ok(
      await h.call('a1', 'POST', `/v1/telephony/calls/${callRef}/link`, {
        patientRef: null,
        reasonCode: 'wrong_patient',
      }),
      201,
    );
    read = h.ok<{ data: { link: null } }>(await h.call('a1', 'GET', `/v1/telephony/calls/${callRef}`)).data;
    expect(read.link).toBeNull();
    expect(await countRows('call_links', 'call_id = $1', [callRef])).toBe(2);
    const mcp = await h.mcp('a1', 'telephony_calls_get', { callRef });
    expect((mcp.body as { data: unknown }).data).toStrictEqual(read);
  });

  it('only the integration principal records calls; an unconfigured number and an unconfigured tenant are refused', async () => {
    const event = {
      providerCallRef: `fake-call-${randomUUID()}`,
      direction: 'inbound',
      callerNumber: '+1-202-555-0144',
      dialedNumber: '+1-202-555-0199',
      occurredAt: new Date().toISOString(),
      outcome: 'missed',
    };
    expect((await h.call('a1', 'POST', '/v1/telephony/calls', event)).statusCode).toBe(403);
    const token = await integration();
    const unconfigured = await h.call(token, 'POST', '/v1/telephony/calls', event);
    expect([unconfigured.statusCode, unconfigured.json().detail.violations[0].rule]).toStrictEqual([
      422,
      'numberNotConfigured',
    ]);
    const betaHandling = await h.call(
      'b1',
      'GET',
      `/v1/telephony/handling?at=${encodeURIComponent(new Date().toISOString())}`,
    );
    expect([betaHandling.statusCode, betaHandling.json().detail.reason]).toStrictEqual([
      409,
      'telephony_not_configured',
    ]);
    // A provider outage leaves nothing to record: the adapter is unavailable, no call is fabricated.
    fake.unavailable = true;
    await expect(fake.pull()).rejects.toThrow(/unavailable/);
    fake.unavailable = false;
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });

  it('a configuration is in force from its own millisecond: an instant in that millisecond resolves to it', async () => {
    const v = h.ok<{ data: { version: number; configRef: string } }>(
      await h.call('a1', 'POST', '/v1/telephony/config', CONFIG),
      201,
    ).data;
    // Instants on the API carry milliseconds; created_at carries microseconds. Pin a sub-millisecond
    // remainder (deterministic on any OS; triggers are bypassed only in this superuser transaction).
    const c = await db.admin.connect();
    let created: Date;
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      const { rows } = await c.query<{ at: Date }>(
        `UPDATE cuspatlas.telephony_configs
         SET created_at = date_trunc('milliseconds', created_at) + interval '456 microseconds'
         WHERE id = $1 RETURNING date_trunc('milliseconds', created_at) AS at`,
        [v.configRef],
      );
      await c.query('COMMIT');
      created = rows[0]?.at as Date;
    } finally {
      c.release();
    }
    const handlingAt = async (at: Date) =>
      h.ok<{ data: { sourceVersion: number } }>(
        await h.call('a1', 'GET', `/v1/telephony/handling?at=${encodeURIComponent(at.toISOString())}`),
      ).data.sourceVersion;
    expect(await handlingAt(created)).toBe(v.version);
    expect(await handlingAt(new Date(created.getTime() - 1))).toBe(v.version - 1);
  });
});

async function countRows(table: string, where = 'true', args: unknown[] = []): Promise<number> {
  return (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${table} WHERE ${where}`, args))
    .rows[0].n as number;
}
