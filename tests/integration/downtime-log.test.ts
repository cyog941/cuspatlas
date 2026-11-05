import { randomUUID } from 'node:crypto';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ctxFor, T_ALPHA, USER_A1 } from './support/fixtures';
import { type ImagingStack, startImagingStack, type Who } from './support/imaging-fixtures';
import { patientBody } from './support/patient-fixtures';
import { seedPracticeScopes } from './support/practice-fixtures';

/**
 * Closeout A2 (M8 runbook gap): downtime windows and the paper records transcribed after them.
 * Synthetic only. A logged entry is never applied by the log: a reviewer applies it through the owning
 * command (S, C, B) and then links that committed command (operation, resource, correlation) to the
 * entry, or rejects or supersedes it. Entries are append-only except their review fields.
 */
let s: ImagingStack;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
const reason = (r: { json: Record<string, unknown> }) => (r.json.detail as { reason?: string })?.reason;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const start = (who: Who, body: Record<string, unknown>, key?: string) =>
  s.command(who, '/v1/operations/downtime/windows', body, key);
const end = (who: Who, body: Record<string, unknown>) =>
  s.command(who, '/v1/operations/downtime/windows/end', body);
const log = (who: Who, body: Record<string, unknown>, key?: string) =>
  s.command(who, '/v1/operations/downtime/entries', body, key);
const resolveEntry = (who: Who, body: Record<string, unknown>) =>
  s.command(who, '/v1/operations/downtime/entries/resolve', body);
const entries = (who: Who, query = '') => s.inject(who, 'GET', `/v1/operations/downtime/entries${query}`);
const windows = (who: Who, query = '') => s.inject(who, 'GET', `/v1/operations/downtime/windows${query}`);
const entryBody = (windowRef: string, over: Record<string, unknown> = {}) => ({
  windowRef,
  entryKind: 'patient_registration',
  summary: 'Synthetic paper registration sheet transcribed after the outage',
  payload: [
    { name: 'givenName', value: 'Synthetic' },
    { name: 'familyName', value: 'Downtime' },
    { name: 'sheet', value: 'front-desk' },
  ],
  paperRef: 'SHEET-0001',
  capturedAt: ago(60),
  ...over,
});

const f = { window: '', registration: '', booking: '', copy: '', late: '', north: '' };

beforeAll(async () => {
  s = await startImagingStack('downtime_log');
  await seedPracticeScopes(s);
}, 180_000);

afterAll(async () => {
  await s?.close();
});

describe('A2 downtime windows', () => {
  it('opens one tenant window; a second open window over the same or an overlapping scope is refused', async () => {
    const r = await start('owner', { scope: 'tenant', reasonCode: 'network_outage', startedAt: ago(120) });
    expect(r.status).toBe(201);
    const w = data<{ windowRef: string; state: string }>(r);
    expect(w.state).toBe('open');
    expect(r.json.version).toBe(1);
    f.window = w.windowRef;
    const twice = await start('owner', { scope: 'tenant', reasonCode: 'network_outage' });
    expect([twice.status, reason(twice)]).toStrictEqual([409, 'downtime_already_open']);
    const overlap = await start('owner', {
      scope: 'locations',
      locationRefs: ['loc-north'],
      reasonCode: 'power_outage',
    });
    expect([overlap.status, reason(overlap)]).toStrictEqual([409, 'downtime_already_open']);
    const future = await start('crossTenant', {
      scope: 'tenant',
      reasonCode: 'network_outage',
      startedAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect([future.status, reason(future)]).toStrictEqual([422, 'started_in_future']);
    const listed = await windows('owner', '?state=open');
    expect(listed.status).toBe(200);
    expect(data<{ windowRef: string }[]>(listed).map((x) => x.windowRef)).toStrictEqual([f.window]);
    expect(listed.json.envelope).toMatchObject({ truncated: false, count: { exact: 1 } });
  });

  it('the database refuses a second open window even when the domain check is bypassed', async () => {
    const tx = createTenantTransactionRunner(s.db.app);
    await expect(
      tx(ctxFor(T_ALPHA, USER_A1, 'human'), (t) =>
        t.query(
          `INSERT INTO cuspatlas.ops_downtime_windows (tenant_id, scope_kind, reason_code, started_at, started_by)
           VALUES (cuspatlas.current_tenant_id(), 'tenant', 'network_outage', now(), cuspatlas.current_actor_id())`,
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('A2 downtime entries', () => {
  it('logs entries captured during the open window as pending review; a replay returns the same entry', async () => {
    const key = randomUUID();
    const body = entryBody(f.window);
    const a = await log('owner', body, key);
    expect(a.status).toBe(201);
    expect(data<{ reviewState: string }>(a).reviewState).toBe('pending_review');
    f.registration = data<{ entryRef: string }>(a).entryRef;
    const again = await log('owner', body, key);
    expect([again.status, data<{ entryRef: string }>(again).entryRef, again.json.replayed]).toStrictEqual([
      201,
      f.registration,
      true,
    ]);
    const b = await log(
      'service',
      entryBody(f.window, { entryKind: 'appointment_booking', paperRef: 'BOOK-7', capturedAt: ago(50) }),
    );
    expect(b.status).toBe(201);
    f.booking = data<{ entryRef: string }>(b).entryRef;
    const c = await log('owner', entryBody(f.window, { entryKind: 'other', paperRef: 'SHEET-0001-COPY' }));
    f.copy = data<{ entryRef: string }>(c).entryRef;
    const outside = await log('owner', entryBody(f.window, { capturedAt: ago(500) }));
    expect([outside.status, reason(outside)]).toStrictEqual([422, 'captured_outside_window']);
    const noWindow = await log('owner', entryBody(randomUUID()));
    expect(noWindow.status).toBe(404);
  });

  it('the reconciliation worklist lists the pending entries (shared list envelope)', async () => {
    const r = await entries('owner', `?windowRef=${f.window}&reviewState=pending_review`);
    expect(r.status).toBe(200);
    const rows = data<{ entryRef: string; reviewState: string; payload: unknown }[]>(r);
    expect(rows.map((x) => x.entryRef).sort()).toStrictEqual([f.registration, f.booking, f.copy].sort());
    expect(rows.every((x) => x.reviewState === 'pending_review')).toBe(true);
    expect(r.json.envelope).toMatchObject({
      count: { exact: 3 },
      appliedFilters: { reviewState: 'pending_review', windowRef: f.window },
    });
    const w = data<{ windowRef: string; pendingEntries: number }[]>(await windows('owner'));
    expect(w.find((x) => x.windowRef === f.window)?.pendingEntries).toBe(3);
  });

  it('ends the window with its version; a stale version or a second end is refused', async () => {
    const stale = await end('owner', { windowRef: f.window, expectedVersion: 7 });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('stale_version');
    const ok = await end('owner', { windowRef: f.window, expectedVersion: 1, endedAt: ago(30) });
    expect([ok.status, data<{ state: string }>(ok).state, ok.json.version]).toStrictEqual([200, 'ended', 2]);
    const again = await end('owner', { windowRef: f.window, expectedVersion: 2 });
    expect([again.status, reason(again)]).toStrictEqual([409, 'window_not_open']);
    // Paper records are transcribed after the window: still loggable, but only inside its bounds.
    const late = await log('owner', entryBody(f.window, { paperRef: 'SHEET-0002', capturedAt: ago(40) }));
    expect(late.status).toBe(201);
    f.late = data<{ entryRef: string }>(late).entryRef;
    const after = await log('owner', entryBody(f.window, { paperRef: 'SHEET-0003', capturedAt: ago(10) }));
    expect([after.status, reason(after)]).toStrictEqual([422, 'captured_outside_window']);
  });

  it('a reviewer links the owning command that applied an entry; it resolves once', async () => {
    const created = await s.command('owner', '/v1/patients', patientBody('Downtime Registration'));
    expect(created.status).toBe(201);
    const patientRef = data<{ patientRef: string }>(created).patientRef;
    const applied = {
      operation: 'patients.create',
      resourceRef: patientRef,
      correlationId: created.json.correlationId as string,
    };
    const svc = await resolveEntry('service', {
      entryRef: f.registration,
      expectedVersion: 1,
      decision: 'applied',
      appliedCommand: applied,
    });
    expect(svc.status).toBe(403);
    const fake = await resolveEntry('owner', {
      entryRef: f.registration,
      expectedVersion: 1,
      decision: 'applied',
      appliedCommand: { ...applied, correlationId: randomUUID() },
    });
    expect([fake.status, reason(fake)]).toStrictEqual([422, 'applied_command_not_found']);
    const wrongKind = await resolveEntry('owner', {
      entryRef: f.booking,
      expectedVersion: 1,
      decision: 'applied',
      appliedCommand: applied,
    });
    expect([wrongKind.status, reason(wrongKind)]).toStrictEqual([422, 'applied_operation_mismatch']);
    const ok = await resolveEntry('owner', {
      entryRef: f.registration,
      expectedVersion: 1,
      decision: 'applied',
      appliedCommand: applied,
    });
    expect([ok.status, data<{ reviewState: string }>(ok).reviewState, ok.json.version]).toStrictEqual([
      200,
      'applied',
      2,
    ]);
    const twice = await resolveEntry('owner', {
      entryRef: f.registration,
      expectedVersion: 2,
      decision: 'rejected',
      rejectionReason: 'duplicate',
    });
    expect([twice.status, reason(twice)]).toStrictEqual([409, 'already_resolved']);
    const relink = await resolveEntry('owner', {
      entryRef: f.late,
      expectedVersion: 1,
      decision: 'applied',
      appliedCommand: applied,
    });
    expect([relink.status, reason(relink)]).toStrictEqual([409, 'applied_command_already_linked']);
    const mismatch = await resolveEntry('owner', {
      entryRef: f.booking,
      expectedVersion: 1,
      decision: 'rejected',
    });
    expect([mismatch.status, reason(mismatch)]).toStrictEqual([422, 'decision_fields_mismatch']);
    const rejected = await resolveEntry('owner', {
      entryRef: f.booking,
      expectedVersion: 1,
      decision: 'rejected',
      rejectionReason: 'illegible',
    });
    expect(data<{ reviewState: string }>(rejected).reviewState).toBe('rejected');
    const superseded = await resolveEntry('owner', {
      entryRef: f.copy,
      expectedVersion: 1,
      decision: 'superseded',
      supersededByRef: f.registration,
    });
    expect(data<{ reviewState: string }>(superseded).reviewState).toBe('superseded');
    const pending = data<{ entryRef: string }[]>(await entries('owner', '?reviewState=pending_review'));
    expect(pending.map((x) => x.entryRef)).toStrictEqual([f.late]);
    const one = data<{ entryRef: string; review: Record<string, unknown> }[]>(
      await entries('owner', '?reviewState=applied'),
    );
    expect(one[0]?.review).toMatchObject({ appliedCommand: applied, reviewedBy: USER_A1 });
  });

  it('the database keeps entries append-only except their one review transition', async () => {
    const tx = createTenantTransactionRunner(s.db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    for (const sql of [
      `UPDATE cuspatlas.ops_downtime_entries SET payload = '{"edited":true}' WHERE id = '${f.late}'`,
      `UPDATE cuspatlas.ops_downtime_entries SET summary = 'edited' WHERE id = '${f.late}'`,
      `UPDATE cuspatlas.ops_downtime_entries SET captured_at = now() WHERE id = '${f.late}'`,
      `DELETE FROM cuspatlas.ops_downtime_entries WHERE id = '${f.late}'`,
      `UPDATE cuspatlas.ops_downtime_entries SET review_state = 'rejected', rejection_reason = 'duplicate',
         reviewed_by = cuspatlas.current_actor_id(), reviewed_at = now(), applied_operation = NULL,
         applied_resource_ref = NULL, applied_correlation_id = NULL, version = version + 1
       WHERE id = '${f.registration}'`,
      `UPDATE cuspatlas.ops_downtime_windows SET started_at = now() WHERE id = '${f.window}'`,
      `DELETE FROM cuspatlas.ops_downtime_windows WHERE id = '${f.window}'`,
      `INSERT INTO cuspatlas.ops_downtime_entries (tenant_id, window_id, entry_kind, summary, payload, paper_ref,
         captured_at, logged_by, review_state)
       SELECT cuspatlas.current_tenant_id(), '${f.window}', 'other', 'x', '{}', 'P-1', started_at,
         cuspatlas.current_actor_id(), 'applied' FROM cuspatlas.ops_downtime_windows WHERE id = '${f.window}'`,
    ]) {
      await expect(
        tx(ctx, (t) => t.query(sql)),
        sql,
      ).rejects.toMatchObject({ code: expect.any(String) });
    }
    await expect(
      tx(ctx, (t) =>
        t.query(`UPDATE cuspatlas.ops_downtime_entries SET payload = '{"edited":true}' WHERE id = $1`, [
          f.late,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Even the owner path cannot rewrite what was transcribed.
    await expect(
      s.db.admin.query(`UPDATE cuspatlas.ops_downtime_entries SET payload = '{}' WHERE id = $1`, [f.late]),
    ).rejects.toMatchObject({ code: '42501' });
    const { rows } = await s.db.admin.query(
      'SELECT review_state, payload FROM cuspatlas.ops_downtime_entries WHERE id = $1',
      [f.registration],
    );
    expect(rows[0]).toMatchObject({ review_state: 'applied', payload: { familyName: 'Downtime' } });
  });
});

describe('A2 downtime negatives', () => {
  it('cross-tenant callers cannot see or act on alpha windows and entries', async () => {
    const e = await end('crossTenant', { windowRef: f.window, expectedVersion: 2 });
    const l = await log('crossTenant', entryBody(f.window, { capturedAt: ago(45) }));
    const r = await resolveEntry('crossTenant', {
      entryRef: f.late,
      expectedVersion: 1,
      decision: 'rejected',
      rejectionReason: 'duplicate',
    });
    expect([e.status, l.status, r.status]).toStrictEqual([404, 404, 404]);
    for (const res of [await entries('crossTenant'), await windows('crossTenant')]) {
      expect(res.status).toBe(200);
      for (const ref of Object.values(f).filter(Boolean)) expect(res.body).not.toContain(ref);
    }
  });

  it('missing scope, revoked membership, location restriction and service principal on review are refused', async () => {
    const noScope = await start('noImagingScopes', { scope: 'tenant', reasonCode: 'network_outage' });
    const readOnlyLog = await log('imagingReadOnly', entryBody(f.window, { capturedAt: ago(45) }));
    const readOnlyResolve = await resolveEntry('imagingReadOnly', {
      entryRef: f.late,
      expectedVersion: 1,
      decision: 'rejected',
      rejectionReason: 'duplicate',
    });
    const noScopeList = await entries('noImagingScopes');
    expect([noScope.status, readOnlyLog.status, readOnlyResolve.status, noScopeList.status]).toStrictEqual([
      403, 403, 403, 403,
    ]);
    expect((await entries('imagingReadOnly')).status).toBe(200);
    const revoked = [
      await start('revoked', { scope: 'tenant', reasonCode: 'network_outage' }),
      await log('revoked', entryBody(f.window, { capturedAt: ago(45) })),
      await entries('revoked'),
      await windows('revoked'),
    ];
    expect(revoked.map((x) => x.status)).toStrictEqual([403, 403, 403, 403]);
    // a3 is restricted to loc-north: no tenant-wide window, no other location, its own location only.
    const tenantWide = await start('writer', { scope: 'tenant', reasonCode: 'network_outage' });
    const south = await start('writer', {
      scope: 'locations',
      locationRefs: ['loc-south'],
      reasonCode: 'power_outage',
    });
    expect([tenantWide.status, south.status]).toStrictEqual([403, 403]);
    const north = await start('writer', {
      scope: 'locations',
      locationRefs: ['loc-north'],
      reasonCode: 'power_outage',
      startedAt: ago(20),
    });
    expect(north.status).toBe(201);
    f.north = data<{ windowRef: string }>(north).windowRef;
    const writerOnTenantWindow = await log('writer', entryBody(f.window, { capturedAt: ago(45) }));
    expect(writerOnTenantWindow.status).toBe(403);
    // The service principal may log (transcription jobs) but never resolve (human review).
    const svcLog = await log('service', entryBody(f.north, { capturedAt: ago(5), paperRef: 'NORTH-1' }));
    expect(svcLog.status).toBe(201);
    const svcResolve = await resolveEntry('service', {
      entryRef: data<{ entryRef: string }>(svcLog).entryRef,
      expectedVersion: 1,
      decision: 'rejected',
      rejectionReason: 'duplicate',
    });
    expect(svcResolve.status).toBe(403);
    const { rows } = await s.db.admin.query(
      "SELECT count(*)::int AS n FROM cuspatlas.ops_downtime_entries WHERE review_state <> 'pending_review' AND reviewed_by <> $1",
      [USER_A1],
    );
    expect(rows[0].n).toBe(0);
  });

  it('MCP carries the same operations: list parity, log, and a refused service review', async () => {
    const names = await s.mcpToolNames('owner');
    for (const t of [
      'operations_downtime_start',
      'operations_downtime_end',
      'operations_downtime_log',
      'operations_downtime_entries_resolve',
      'operations_downtime_entries_list',
      'operations_downtime_windows_list',
    ])
      expect(names).toContain(t);
    const rest = await entries('owner', '?reviewState=pending_review');
    const viaMcp = await s.mcp('owner', 'operations_downtime_entries_list', {
      reviewState: 'pending_review',
    });
    expect(viaMcp.isError).toBe(false);
    expect((viaMcp.body.data as { entryRef: string }[]).map((x) => x.entryRef).sort()).toStrictEqual(
      data<{ entryRef: string }[]>(rest)
        .map((x) => x.entryRef)
        .sort(),
    );
    expect((viaMcp.body.envelope as { count: unknown }).count).toStrictEqual(
      (rest.json.envelope as { count: unknown }).count,
    );
    const logged = await s.mcp('owner', 'operations_downtime_log', {
      ...entryBody(f.north, { capturedAt: ago(4), paperRef: 'NORTH-2' }),
      idempotencyKey: randomUUID(),
    });
    expect(logged.isError).toBe(false);
    const refused = await s.mcp('service', 'operations_downtime_entries_resolve', {
      entryRef: (logged.body.data as { entryRef: string }).entryRef,
      expectedVersion: 1,
      decision: 'rejected',
      rejectionReason: 'duplicate',
      idempotencyKey: randomUUID(),
    });
    expect(refused.isError).toBe(true);
    const ended = await s.mcp('writer', 'operations_downtime_end', {
      windowRef: f.north,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    expect(ended.isError).toBe(false);
    expect((ended.body.data as { state: string }).state).toBe('ended');
  });
});

describe('A2 applied-command link at the database clock (clock audit)', () => {
  // Audit occurred_at was stamped with the application clock and compared with the entry's
  // database-stamped logged_at: with the host clock behind, a command applied right after the entry
  // was logged looked older than the entry and the link was refused as not found.
  it('links a command applied right after logging, with the app clock behind or ahead by 5 s', async () => {
    const w = await start('owner', { scope: 'tenant', reasonCode: 'network_outage', startedAt: ago(10) });
    expect(w.status).toBe(201);
    const windowRef = data<{ windowRef: string }>(w).windowRef;
    for (const skewMs of [-5_000, 5_000]) {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skewMs });
      try {
        const logged = await log('owner', entryBody(windowRef, { capturedAt: ago(5), paperRef: `SKEW-${skewMs}` }));
        expect(logged.status).toBe(201);
        const created = await s.command('owner', '/v1/patients', patientBody(`Downtime Skew ${skewMs}`));
        expect(created.status).toBe(201);
        const ok = await resolveEntry('owner', {
          entryRef: data<{ entryRef: string }>(logged).entryRef,
          expectedVersion: 1,
          decision: 'applied',
          appliedCommand: {
            operation: 'patients.create',
            resourceRef: data<{ patientRef: string }>(created).patientRef,
            correlationId: created.json.correlationId as string,
          },
        });
        expect([ok.status, reason(ok)]).toStrictEqual([200, undefined]);
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
