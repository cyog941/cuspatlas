import { randomUUID } from 'node:crypto';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  type BillingDeps,
  createAuthorize,
  createBillingService,
  createFakeAttachmentSource,
  createFakeClearinghouse,
  createSyntheticPaymentProvider,
} from '@cuspatlas/domain';
import { seedLocation, T_ALPHA } from './appointment-fixtures';
import { type BillingHarness, openBillingHarness, usd } from './billing-fixtures';
import { seedClinicalScopes } from './clinical-fixtures';
import type { TestDatabase } from './db';

/**
 * Shared setup for B6/B7/B9 (synthetic data only): the billing harness plus clinical scopes, one
 * location with a provider, a billing worker service principal, rendered procedures from C14 and a
 * direct billing service for tests that inject ports.
 */
export const SVC_BILLING_WORKER = '30000000-0000-4000-8000-0000000000b9';
export const RCM_LOC = 'loc-rcm';

export interface RcmHarness {
  readonly h: BillingHarness;
  readonly provider: string;
  service(over?: Partial<BillingDeps>): ReturnType<typeof createBillingService>;
  encounter(patientRef: string): Promise<string>;
  render(encounterRef: string, codeRef: string, sequence?: number, dateOfService?: string): Promise<string>;
  consume(procedureRef: string): ReturnType<BillingHarness['call']>;
  publishFee(
    scheduleRef: string,
    items: [string, number][],
    extra?: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * Today in the synthetic location's own time zone (America/New_York): a clinical date of service is
 * refused when it is after the location's today, so a UTC date fails between 00:00 and 05:00 UTC.
 */
export const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

export async function openRcmHarness(db: TestDatabase, opts: { mcp?: boolean } = {}): Promise<RcmHarness> {
  const h = await openBillingHarness(db, { pool: 10, ...opts });
  await seedClinicalScopes(db.admin);
  const loc = await seedLocation(h, RCM_LOC);
  await db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-billing-worker')
     ON CONFLICT DO NOTHING`,
    [SVC_BILLING_WORKER],
  );
  await db.admin.query(
    `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [T_ALPHA, SVC_BILLING_WORKER, ['outbox.deliver', 'billing.write', 'ledger.read']],
  );
  const service = (over: Partial<BillingDeps> = {}) =>
    createBillingService({
      authorize: createAuthorize(createMembershipSource(db.app)),
      withTenantTransaction: createTenantTransactionRunner(db.app),
      recording: { sink: createSecurityAttemptSink(db.sink), alert: () => {} },
      // No implicit fakes in the domain: tests pass the synthetic adapters explicitly.
      payments: createSyntheticPaymentProvider(),
      claims: createFakeClearinghouse(),
      // Synthetic-test fixture only: the in-process attachment fake (R8: never a domain default).
      attachments: createFakeAttachmentSource(),
      ...over,
    });
  return {
    h,
    provider: loc.provider,
    service,
    async encounter(patientRef) {
      const e = h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
        await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef, locationRef: RCM_LOC }),
        201,
      ).data.encounter;
      h.ok(
        await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/assignments`, {
          expectedVersion: e.version,
          role: 'treating_provider',
          assignee: { kind: 'provider', resourceRef: loc.provider },
        }),
        201,
      );
      return e.encounterRef;
    },
    async render(encounterRef, codeRef, sequence = 1, dateOfService = today()) {
      return h.ok<{ data: { procedureRef: string } }>(
        await h.call(
          'a1',
          'POST',
          `/v1/clinical/encounters/${encounterRef}/procedures`,
          { sequence, dateOfService, renderingProviderRef: loc.provider, codeRef },
          randomUUID(),
        ),
        201,
      ).data.procedureRef;
    },
    consume: (procedureRef) =>
      h.call('svcA1', 'POST', `/v1/billing/procedure-events/${procedureRef}/consume`, {}),
    async publishFee(scheduleRef, items, extra = {}) {
      return h.ok(
        await h.call('a1', 'POST', '/v1/billing/fee-schedules/versions', {
          scheduleRef,
          purpose: 'practice',
          effectiveFrom: '2026-01-01',
          items: items.map(([codeRef, minor]) => ({ codeRef, fee: usd(minor) })),
          ...extra,
        }),
        201,
      );
    },
  };
}
