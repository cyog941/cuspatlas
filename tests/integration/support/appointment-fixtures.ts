import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { TestDatabase } from './db';
import { SVC_A1, seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_A3, USER_A4, USER_B1 } from './fixtures';
import { patientBody, seedPatientScopes } from './patient-fixtures';
import { seedSchedulingScopes } from './scheduling-fixtures';
import { createTestTokenIssuer, type TestTokenIssuer } from './test-token-issuer';

/**
 * Shared setup for the S8, S10 and S11 integration files: tenancy, patient and scheduling scopes,
 * the REST app under the runtime role, and helpers that build synthetic fixtures through the domain
 * commands only (never by direct writes).
 */
export type Who = 'a1' | 'a3' | 'a4' | 'svcA1' | 'b1';

export interface AppointmentHarness {
  readonly app: FastifyInstance;
  readonly issuer: TestTokenIssuer;
  readonly logLines: string[];
  readonly tokens: Record<string, string>;
  call(
    who: Who | string,
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    key?: string | null,
  ): Promise<LightMyRequestResponse>;
  ok<T = Record<string, unknown>>(res: LightMyRequestResponse, status?: number): T;
}

export async function openAppointmentHarness(db: TestDatabase): Promise<AppointmentHarness> {
  await seedTenancy(db.admin);
  await seedPatientScopes(db.admin);
  await seedSchedulingScopes(db.admin);
  const issuer = await createTestTokenIssuer();
  const logLines: string[] = [];
  const app = await buildApp({
    env: 'synthetic-test',
    logger: { level: 'info', stream: { write: (l: string) => logLines.push(l) } },
    identity: issuer.verifierConfig,
    membership: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(db.sink),
    tenantTransactions: createTenantTransactionRunner(db.app),
  });
  const tokens: Record<string, string> = {
    a1: await issuer.issue({ sub: USER_A1, tid: T_ALPHA }),
    a3: await issuer.issue({ sub: USER_A3, tid: T_ALPHA }),
    a4: await issuer.issue({ sub: USER_A4, tid: T_ALPHA }),
    svcA1: await issuer.issue({ sub: SVC_A1, tid: T_ALPHA }),
    b1: await issuer.issue({ sub: USER_B1, tid: T_BETA }),
  };
  const call: AppointmentHarness['call'] = (who, method, url, body, key = randomUUID()) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${tokens[who] ?? who}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(method === 'POST' && key !== null ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const ok = <T>(res: LightMyRequestResponse, status = 200): T => {
    expect([res.statusCode, res.body]).toStrictEqual([status, res.body]);
    return res.json() as T;
  };
  return { app, issuer, logLines, tokens, call, ok };
}

/** Creates a synthetic location with one provider and one operatory, each with weekly hours. */
export async function seedLocation(
  h: AppointmentHarness,
  locationRef: string,
  opts: { who?: Who; timeZone?: string; weekly?: { weekday: number; start: string; end: string }[] } = {},
): Promise<{ locationRef: string; provider: string; operatory: string }> {
  const who = opts.who ?? 'a1';
  h.ok(
    await h.call(who, 'POST', '/v1/scheduling/locations', {
      locationRef,
      displayLabel: `Synthetic ${locationRef}`,
      timeZone: opts.timeZone ?? 'America/New_York',
    }),
    201,
  );
  const weekly = opts.weekly ?? [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '08:00', end: '17:00' }));
  const define = async (kind: string, label: string) => {
    const r = h.ok<{ data: { resourceRef: string } }>(
      await h.call(who, 'POST', '/v1/scheduling/resources', { kind, locationRef, displayLabel: label }),
      201,
    );
    h.ok(
      await h.call(who, 'POST', `/v1/scheduling/resources/${r.data.resourceRef}/availability`, {
        effectiveFrom: '2030-01-01',
        weekly,
      }),
      201,
    );
    return r.data.resourceRef;
  };
  return {
    locationRef,
    provider: await define('provider', 'Synthetic Provider'),
    operatory: await define('operatory', 'Operatory 1'),
  };
}

export async function createPatient(h: AppointmentHarness, given: string, who: Who = 'a1'): Promise<string> {
  const r = h.ok<{ data: { patientRef: string } }>(
    await h.call(who, 'POST', '/v1/patients', patientBody(given)),
    201,
  );
  return r.data.patientRef;
}

export const count = async (db: TestDatabase, table: string): Promise<number> =>
  (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${table}`)).rows[0].n as number;

/** Every table text a caller-controlled value could leak into (marker scans). */
export async function leakTables(db: TestDatabase): Promise<string> {
  const parts: string[] = [];
  for (const t of ['audit_events', 'outbox_events', 'security_attempt_events', 'command_idempotency']) {
    const { rows } = await db.admin.query(
      `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.${t} t`,
    );
    parts.push(rows[0].j);
  }
  return parts.join('\n');
}

export { T_ALPHA, T_BETA, USER_A1, USER_A4, USER_B1 };

export async function setPatientStatus(
  h: AppointmentHarness,
  patientRef: string,
  status: 'inactive' | 'deceased',
  expectedVersion = 1,
): Promise<void> {
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${patientRef}/status`, {
      expectedVersion,
      status,
      effectiveAt: '2026-10-01T00:00:00Z',
      reasonCode: status === 'deceased' ? 'deceased_reported' : 'moved_away',
    }),
  );
}

/** Merges `merged` into `survivor` through candidate review (both must be true duplicates). */
export async function mergePatients(
  h: AppointmentHarness,
  survivor: string,
  merged: string,
): Promise<string> {
  const review = h.ok<{ data: { candidateRef: string; confirmationToken: string }[] }>(
    await h.call('a1', 'GET', `/v1/patients/${survivor}/duplicate-candidates`),
  );
  const token = review.data.find((c) => c.candidateRef === merged)?.confirmationToken;
  expect(token).toBeDefined();
  const res = h.ok<{ data: { mergeRef: string } }>(
    await h.call('a1', 'POST', '/v1/patients/merges', {
      survivorRef: survivor,
      mergedRef: merged,
      confirmationToken: token,
      reasonCode: 'duplicate_registration',
    }),
    201,
  );
  return res.data.mergeRef;
}
