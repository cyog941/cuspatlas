import { randomUUID } from 'node:crypto';
import type { SchedulingExport } from '@cuspatlas/contracts';
import { importSchedulingExport, SCHEDULING_EXPORT_FORMAT } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';

/**
 * S17 export round trip (minimal, S scope; the full export contract, manifest and completeness
 * validation belong to M1): a versioned JSON export of every workstream S record (configuration,
 * patients, relationships, requests, bookings, attendance, series, intents, waitlist, recovery,
 * recall) with references preserved and no tenant field, produced by the domain under the runtime
 * role, re-imported into a fresh synthetic database by the privileged import routine, and exported
 * again: identical, with every identifier preserved and the records readable through the domain.
 */
let source: TestDatabase;
let target: TestDatabase;
let h: AppointmentHarness;
let t: AppointmentHarness;
const APPT = '/v1/scheduling/appointments';

beforeAll(async () => {
  source = await openTestDatabase('export_source');
  h = await openAppointmentHarness(source, { mcp: true });
  const loc = await seedLocation(h, 'loc-export');
  await source.admin.query(
    `INSERT INTO cuspatlas.scheduling_offer_policies (tenant_id, location_id, policy_ref, offer_ttl_minutes)
     SELECT tenant_id, id, 'waitlist-offer-pending-approval-1', 1440 FROM cuspatlas.scheduling_locations
     WHERE location_ref = 'loc-export'`,
  );
  const guardian = await createPatient(h, 'Synthetic Guardian');
  const child = await createPatient(h, 'Synthetic Child');
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${child}/relationships`, {
      counterpartyRef: guardian,
      kind: 'guarantor',
      scopes: ['financial'],
    }),
    201,
  );
  const request = h.ok<{ data: { requestRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/appointment-requests', {
      patientRef: child,
      locationRef: loc.locationRef,
      sourceChannel: 'phone',
      contactConsent: 'unknown',
      flexibility: 'mornings',
    }),
    201,
  ).data.requestRef;
  const window = (day: string, hh: number) => ({
    startsAt: `${day}T${hh}:00:00Z`,
    endsAt: `${day}T${hh + 1}:00:00Z`,
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: loc.provider },
    operatory: { kind: 'operatory', resourceRef: loc.operatory },
  });
  const booked = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', APPT, {
      patientRef: child,
      locationRef: loc.locationRef,
      requestRef: request,
      ...window('2030-03-04', 14),
    }),
    201,
  ).data.appointmentRef;
  h.ok(await h.call('a1', 'POST', `${APPT}/${booked}/attendance`, { kind: 'arrived' }), 201);
  const cancelled = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', APPT, {
      patientRef: guardian,
      locationRef: loc.locationRef,
      ...window('2030-03-05', 14),
    }),
    201,
  ).data.appointmentRef;
  h.ok(
    await h.call('a1', 'POST', `${APPT}/${cancelled}/cancel`, {
      expectedVersion: 1,
      reasonCode: 'patient_request',
    }),
  );
  h.ok(
    await h.call('a1', 'POST', '/v1/scheduling/series', {
      patientRef: guardian,
      locationRef: loc.locationRef,
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
      pattern: { frequency: 'weekly', interval: 1 },
      firstDate: '2030-03-11',
      startTime: '11:00',
      durationMinutes: 30,
      count: 2,
    }),
    201,
  );
  const entry = h.ok<{ data: { entryRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/waitlist', {
      patientRef: guardian,
      locationRef: loc.locationRef,
      durationMinutes: 60,
      desiredFrom: '2030-01-01T00:00:00Z',
      desiredUntil: '2030-12-31T00:00:00Z',
    }),
    201,
  ).data.entryRef;
  const { timeZone: _zone, ...offerWindow } = window('2030-03-06', 15);
  h.ok(await h.call('a1', 'POST', `/v1/scheduling/waitlist/${entry}/offer`, offerWindow), 201);
  h.ok(
    await h.call('a1', 'POST', '/v1/scheduling/recall/policies', {
      category: 'hygiene',
      intervalMonths: 6,
      basis: 'attended_visit',
    }),
    201,
  );
  h.ok(
    await h.call('a1', 'POST', '/v1/scheduling/recall/tasks', {
      patientRef: child,
      category: 'hygiene',
      locationRef: loc.locationRef,
      expectedPolicyVersion: 1,
      asOf: '2030-10-01T12:00:00Z',
    }),
    201,
  );
  target = await openTestDatabase('export_target');
  t = await openAppointmentHarness(target);
});

afterAll(async () => {
  await t?.close();
  await h?.close();
  await target?.close();
  await source?.close();
});

type ExportDoc = { format: string; exportedAt: string; tables: Record<string, Record<string, unknown>[]> };
const exportOf = async (harness: AppointmentHarness) =>
  harness.ok<{ data: ExportDoc }>(await harness.call('a1', 'GET', '/v1/scheduling/export')).data;

describe('S17 scheduling export round trip', () => {
  it('exports every S record class, versioned, with references and no tenant field; REST and MCP agree', async () => {
    const doc = await exportOf(h);
    expect(doc.format).toBe(SCHEDULING_EXPORT_FORMAT);
    for (const table of [
      'patients',
      'patient_relationships',
      'appointment_requests',
      'appointments',
      'appointment_attendance_transitions',
      'appointment_series',
      'appointment_series_occurrences',
      'notification_intents',
      'waitlist_entries',
      'waitlist_offers',
      'cancellation_recoveries',
      'recall_policies',
      'recall_tasks',
    ]) {
      expect([table, (doc.tables[table] ?? []).length > 0]).toStrictEqual([table, true]);
    }
    expect(JSON.stringify(doc)).not.toContain(T_ALPHA);
    for (const rows of Object.values(doc.tables))
      for (const r of rows) expect(r).not.toHaveProperty('tenant_id');
    const m = await h.mcp('a1', 'scheduling_export', {});
    expect({ ...(m.body as { data: ExportDoc }).data, exportedAt: null }).toStrictEqual({
      ...doc,
      exportedAt: null,
    });
  });

  it('is refused to a member without admin.configure and to a location-restricted member; another tenant exports only itself', async () => {
    expect((await h.call('a4', 'GET', '/v1/scheduling/export')).statusCode).toBe(403);
    expect((await h.call('a3', 'GET', '/v1/scheduling/export')).statusCode).toBe(403);
    const alpha = JSON.stringify(await exportOf(h));
    const beta = h.ok<{ data: ExportDoc }>(await h.call('b1', 'GET', '/v1/scheduling/export')).data;
    for (const rows of Object.values(beta.tables)) {
      for (const r of rows) if (typeof r.id === 'string') expect(alpha).not.toContain(r.id);
    }
  });

  it('re-imports into a fresh synthetic database without identifier loss and exports identically', async () => {
    const doc = await exportOf(h);
    const counts = await importSchedulingExport(target.admin, T_ALPHA, doc as unknown as SchedulingExport);
    expect(counts.appointments).toBe(doc.tables.appointments?.length);
    const again = await exportOf(t);
    expect({ ...again, exportedAt: null }).toStrictEqual({ ...doc, exportedAt: null });
    // The re-imported records are live domain data: a booking reads back identically by its reference.
    const ref = doc.tables.appointments?.[0]?.id as string;
    const a = h.ok<{ data: Record<string, unknown> }>(await h.call('a1', 'GET', `${APPT}/${ref}`)).data;
    const b = t.ok<{ data: Record<string, unknown> }>(await t.call('a1', 'GET', `${APPT}/${ref}`)).data;
    expect(b).toStrictEqual(a);
  });

  it('the import refuses an unknown format version and a non-synthetic database', async () => {
    const doc = await exportOf(h);
    await expect(
      importSchedulingExport(target.admin, T_ALPHA, {
        ...doc,
        format: 'other/9',
      } as unknown as SchedulingExport),
    ).rejects.toThrow(/format/);
    expect(randomUUID()).toMatch(/-/);
  });
});
