import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { type AppointmentHarness, openAppointmentHarness, type Who } from './appointment-fixtures';
import type { TestDatabase } from './db';
import { FakeAttachmentRefs } from './fake-attachments';
import { SVC_A1, SVC_B1, T_ALPHA, T_BETA, USER_A1, USER_A2, USER_A3, USER_A4, USER_B1 } from './fixtures';
import { patientBody } from './patient-fixtures';

/**
 * Workstream E (portal and communications) fixtures, layered on the S appointment harness.
 * Synthetic identities and contacts only: `.invalid` email domains and 555-01xx phone numbers.
 */
export const PORTAL_AUDIENCE = 'urn:cuspatlas:portal:synthetic';
export const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';

/** Alpha messaging worker (service, communications.deliver only). */
export const SVC_W1 = '30000000-0000-4000-8000-0000000000e1';
/** Alpha receipt-ingestion integration (service, communications.receipts only). */
export const SVC_R1 = '30000000-0000-4000-8000-0000000000e2';
/** Alpha telephony integration (service, telephony.events only; fake adapter). */
export const SVC_T1 = '30000000-0000-4000-8000-0000000000e4';
/** Beta messaging worker. */
export const SVC_WB = '30000000-0000-4000-8000-0000000000e3';

export const E_ALL = [
  'portal.manage',
  'communications.read',
  'communications.write',
  'messaging.read',
  'messaging.write',
];

export async function seedEngagementScopes(admin: pg.Pool): Promise<void> {
  const add: [string, string[]][] = [
    [USER_A1, E_ALL],
    [USER_A2, E_ALL], // revoked membership
    [USER_A3, E_ALL], // loc-north only
    [USER_A4, ['communications.read']],
    [SVC_A1, ['communications.read', 'communications.write']],
    [USER_B1, E_ALL],
    [SVC_B1, E_ALL],
  ];
  for (const [principal, scopes] of add) {
    await admin.query(
      'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
      [principal, scopes],
    );
  }
  for (const [id, tenant, handle, scopes] of [
    [SVC_W1, T_ALPHA, 'svc-w1', ['communications.deliver']],
    [SVC_R1, T_ALPHA, 'svc-r1', ['communications.receipts']],
    [SVC_T1, T_ALPHA, 'svc-t1', ['telephony.events']],
    [SVC_WB, T_BETA, 'svc-wb', ['communications.deliver']],
  ] as const) {
    await admin.query(
      `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', $2) ON CONFLICT DO NOTHING`,
      [id, handle],
    );
    await admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [tenant, id, scopes],
    );
  }
}

export const email = (local: string, preference = 'preferred') => ({
  channel: 'email',
  use: 'home',
  value: `${local}@example.invalid`,
  preference,
});
export const synthPhone = (suffix: string, preference = 'preferred') => ({
  channel: 'phone',
  use: 'mobile',
  value: `+1-202-555-01${suffix}`,
  preference,
});

export interface EngagementHarness extends AppointmentHarness {
  /** Test double of I's attachment reference read (the AttachmentRefResolver port). */
  readonly attachments: FakeAttachmentRefs;
  /** Calls a portal route with a portal-audience token for `principalRef` (or a raw token). */
  portal(
    principalOrToken: string,
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    key?: string | null,
    tenantId?: string,
  ): Promise<LightMyRequestResponse>;
  portalToken(principalRef: string, tenantId?: string): Promise<string>;
  /** Creates a synthetic patient with the given contact points through the staff command. */
  person(given: string, points: unknown[], overrides?: Record<string, unknown>, who?: Who): Promise<string>;
  /** Enrolls and verifies a portal principal for `personRef` through the staff commands. */
  enroll(personRef: string, contact: { channel: string; value: string }, verify?: boolean): Promise<string>;
}

export async function openEngagementHarness(
  db: TestDatabase,
  opts: { pool?: number; mcp?: boolean } = {},
): Promise<EngagementHarness> {
  const attachments = new FakeAttachmentRefs();
  const h = await openAppointmentHarness(db, { ...opts, portal: true, attachmentRefs: attachments });
  await seedEngagementScopes(db.admin);
  const portalTokens = new Map<string, string>();
  const portalToken = async (principalRef: string, tenantId = T_ALPHA) => {
    const k = `${principalRef}:${tenantId}`;
    const existing = portalTokens.get(k);
    if (existing) return existing;
    const t = await h.issuer.issue({ sub: principalRef, tid: tenantId, audience: PORTAL_AUDIENCE });
    portalTokens.set(k, t);
    return t;
  };
  const portal: EngagementHarness['portal'] = async (who, method, url, body, key = randomUUID(), tid) => {
    const token = who.includes('.') ? who : await portalToken(who, tid);
    return h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(method === 'POST' && key !== null ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  };
  const person: EngagementHarness['person'] = async (given, points, overrides = {}, who = 'a1') => {
    const r = h.ok<{ data: { patientRef: string } }>(
      await h.call(
        who,
        'POST',
        '/v1/patients',
        patientBody(given, {
          contact: points.length === 0 ? { known: false, reason: 'not_provided' } : { known: true, points },
          ...overrides,
        }),
      ),
      201,
    );
    return r.data.patientRef;
  };
  const enroll: EngagementHarness['enroll'] = async (personRef, contact, verify = true) => {
    const r = h.ok<{ data: { principalRef: string } }>(
      await h.call('a1', 'POST', '/v1/portal/principals', { personRef, contact }),
      201,
    );
    if (verify) {
      h.ok(
        await h.call('a1', 'POST', `/v1/portal/principals/${r.data.principalRef}/verify`, {
          expectedVersion: 1,
          method: 'synthetic_attested',
        }),
      );
    }
    return r.data.principalRef;
  };
  return { ...h, attachments, portal, portalToken, person, enroll };
}
