import { randomUUID } from 'node:crypto';
import type { ActorContext } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  type ClinicalDeps,
  createAppointmentService,
  createAuthorize,
  createBillingEstimatePricing,
  createClinicalService,
  executeOnce,
  type SchedulingDeps,
} from '@cuspatlas/domain';
import type { TestDatabase } from './db';

/**
 * Direct construction of the appointment service under the runtime role, for container tests that
 * need a port the transports do not expose (a synthetic producer or suppression stub). The service is
 * the same domain code REST and MCP call; only the injected port differs.
 */
export function domainAppointments(db: TestDatabase, extra: Partial<SchedulingDeps> = {}) {
  return createAppointmentService({
    authorize: createAuthorize(createMembershipSource(db.app)),
    withTenantTransaction: createTenantTransactionRunner(db.app),
    recording: { sink: createSecurityAttemptSink(db.sink), alert: () => undefined },
    execute: executeOnce,
    ...extra,
  });
}

/** The clinical service built the same way, for a port the transports wire differently (C15 resolver). */
export function domainClinical(db: TestDatabase, extra: Partial<ClinicalDeps> = {}) {
  return createClinicalService({
    authorize: createAuthorize(createMembershipSource(db.app)),
    withTenantTransaction: createTenantTransactionRunner(db.app),
    recording: { sink: createSecurityAttemptSink(db.sink), alert: () => undefined },
    execute: executeOnce,
    estimatePricing: createBillingEstimatePricing(),
    ...extra,
  });
}

/** Server-built actor for a seeded synthetic principal, scopes read from its live membership row. */
export async function actorFor(
  db: TestDatabase,
  principalId: string,
  tenantId: string,
): Promise<ActorContext> {
  const { rows } = await db.admin.query(
    `SELECT m.scopes, p.kind FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
     WHERE m.principal_id = $1 AND m.tenant_id = $2`,
    [principalId, tenantId],
  );
  const row = rows[0];
  if (!row) throw new Error('no membership for synthetic principal');
  return {
    tenantId,
    actorId: principalId,
    principal: row.kind,
    sessionId: randomUUID(),
    scopes: row.scopes,
    correlationId: randomUUID(),
  };
}

export const envelope = (operation: string, payload: unknown, key: string = randomUUID()) => ({
  operation,
  idempotencyKey: key,
  payload,
});
