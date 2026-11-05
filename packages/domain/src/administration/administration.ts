import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  foundationDef,
  RefusalError,
  SYNTHETIC_TASK_PROPERTIES,
  validateIdempotencyKey,
} from '@cuspatlas/contracts';
import type { ReplayCodec, StoredResult } from '../commands/execute-once';
import type { CommandExecutor } from '../commands/executor';
import type { ComposerBase } from '../composers/framework';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';

/**
 * A17 administration surface (human only). Audit search reads the committed-change audit, the security
 * attempts and the sensitive-read log of the CURRENT tenant through `cuspatlas.admin_audit_search`
 * (bounded, filtered, newest first) and records itself as a sensitive read; it never changes a source
 * row. Agent activity is the `principal = service` filter of the same sources. Access review lists
 * memberships (scopes, locations, grant/revocation, last activity), portal principals and imaging
 * devices; each entry names the existing domain command that revokes it. Membership revocation (human
 * or service principal) is the one new command; portal principals and devices are revoked through
 * their own operations (`portal.principals.revoke`, `imaging.devices.revoke`), never redefined here.
 */
export const AUDIT_SEARCH_MAX = 200;
export const AUDIT_SOURCES = ['committed_change', 'security_attempt', 'sensitive_read'] as const;

interface AuditQuery {
  readonly source?: string;
  readonly actorRef?: string;
  readonly principal?: 'human' | 'service';
  readonly operation?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: string | number;
}
const validateAuditQuery = foundationDef('AuditSearchQuery');

/**
 * Strict RFC 3339 instant with a real calendar date and an explicit offset (what Postgres timestamptz
 * accepts unambiguously): `Date.parse` alone accepts `1` or `March 7, 2030`, which Postgres rejects (500).
 */
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
export function isInstant(v: string): boolean {
  const m = INSTANT.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}
const validateRevoke = foundationDef('AccessRevoke');
const failedAt = (pointer: string, rule: string) =>
  new RefusalError({ code: 'validation_failed', detail: { violations: [{ pointer, rule }] } });

export function createAdministrationOperations(base: ComposerBase, deps: { execute: CommandExecutor }) {
  const tx = base.deps.withTenantTransaction;
  return {
    searchAudit(ctx: ActorContext, query: unknown) {
      const op = 'admin.audit.search';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid<AuditQuery>(validateAuditQuery, query, SYNTHETIC_TASK_PROPERTIES);
        const limit = query.limit === undefined ? 100 : Number(query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_SEARCH_MAX)
          throw failedAt('/limit', 'range');
        const sources = query.source === undefined ? [...AUDIT_SOURCES] : query.source.split(',');
        if (!sources.every((s) => (AUDIT_SOURCES as readonly string[]).includes(s)))
          throw failedAt('/source', 'enum');
        for (const k of ['from', 'to'] as const)
          if (query[k] !== undefined && !isInstant(query[k] as string)) throw failedAt(`/${k}`, 'instant');
        return tx(ctx, async (t) => {
          const { rows } = await t.query<{
            source: string;
            event_ref: string;
            occurred_at: Date;
            actor_id: string | null;
            principal: string | null;
            operation: string;
            resource_type: string | null;
            resource_ref: string | null;
            reason_code: string | null;
            result_count: number | null;
          }>('SELECT * FROM cuspatlas.admin_audit_search($1::text[], $2, $3, $4, $5, $6, $7)', [
            sources,
            query.actorRef ?? null,
            query.principal ?? null,
            query.operation ?? null,
            query.from ?? null,
            query.to ?? null,
            limit + 1,
          ]);
          const page = rows.slice(0, limit);
          const data = page.map((r) => ({
            source: r.source,
            eventRef: r.event_ref,
            occurredAt: r.occurred_at.toISOString(),
            actorRef: r.actor_id,
            principal: r.principal,
            operation: r.operation,
            resourceType: r.resource_type,
            resourceRef: r.resource_ref,
            reasonCode: r.reason_code,
            resultCount: r.result_count,
          }));
          // The search is itself audited (who searched, which filters by name, which rows came back).
          await recordSensitiveRead(t, {
            operation: op,
            resourceType: 'auditRecord',
            resourceRefs: data.slice(0, 100).map((d) => d.eventRef),
            ...(data.length > 100 ? { totalCount: data.length } : {}),
            queryFields: Object.keys(query).filter((k) => /^[a-z][A-Za-z]{0,63}$/.test(k)),
          });
          const truncated = rows.length > limit;
          return {
            data,
            envelope: {
              asOf: new Date().toISOString(),
              appliedFilters: { ...query, source: sources.join(','), limit },
              scope: { kind: 'tenant_wide' as const },
              limit,
              truncated,
              nextCursor: null,
              ordering: { key: 'occurredAt', direction: 'desc' as const, tieBreak: 'eventRef' },
              count: truncated ? { atLeast: data.length } : { exact: data.length },
            },
          };
        });
      });
    },

    reviewAccess(ctx: ActorContext) {
      const op = 'admin.access.review';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return tx(ctx, async (t) => {
          const { rows: members } = await t.query<{
            principal_id: string;
            kind: string;
            handle: string;
            scopes: string[];
            location_refs: string[] | null;
            granted_at: Date;
            revoked_at: Date | null;
            last_activity_at: Date | null;
          }>('SELECT * FROM cuspatlas.admin_access_review()');
          const { rows: portal } = await t.query<{
            principal_id: string;
            state: string;
            revoked_at: Date | null;
          }>(
            'SELECT principal_id, state, revoked_at FROM cuspatlas.portal_principals ORDER BY principal_id LIMIT 1000',
          );
          const { rows: devices } = await t.query<{ id: string; state: string; revoked_at: Date | null }>(
            'SELECT id, state, revoked_at FROM cuspatlas.imaging_devices ORDER BY id LIMIT 1000',
          );
          // The review discloses who holds which access: it is itself a logged sensitive read.
          const refs = members.map((m) => m.principal_id);
          await recordSensitiveRead(t, {
            operation: op,
            resourceType: 'membership',
            resourceRefs: refs.slice(0, 100),
            ...(refs.length > 100 ? { totalCount: refs.length } : {}),
            queryFields: [],
          });
          const iso = (d: Date | null) => (d ? d.toISOString() : null);
          return {
            data: {
              asOf: new Date().toISOString(),
              memberships: members.map((m) => ({
                principalRef: m.principal_id,
                kind: m.kind,
                handle: m.handle,
                scopes: m.scopes,
                locationRefs: m.location_refs,
                grantedAt: m.granted_at.toISOString(),
                revokedAt: iso(m.revoked_at),
                active: m.revoked_at === null,
                lastActivityAt: iso(m.last_activity_at),
                // Agent principals and their sponsors are not modelled in this build (A8 pending).
                sponsor: m.kind === 'service' ? { status: 'unavailable', owner: 'A8' } : null,
                revokeOperation: 'admin.access.revoke',
              })),
              portalPrincipals: portal.map((p) => ({
                principalRef: p.principal_id,
                state: p.state,
                revokedAt: iso(p.revoked_at),
                revokeOperation: 'portal.principals.revoke',
              })),
              devices: devices.map((d) => ({
                deviceRef: d.id,
                state: d.state,
                revokedAt: iso(d.revoked_at),
                revokeOperation: 'imaging.devices.revoke',
              })),
            },
          };
        });
      });
    },

    revokeAccess(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<RevokeResult>> {
      const op = 'admin.access.revoke';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        if (envelope.operation !== op) throw new RefusalError({ code: 'invalid_request' });
        assertValid(validateIdempotencyKey, envelope.idempotencyKey, SYNTHETIC_TASK_PROPERTIES);
        const p = envelope.payload as { principalRef: string; reasonCode: string };
        assertValid(validateRevoke, p, SYNTHETIC_TASK_PROPERTIES);
        return tx(ctx, (t) =>
          deps.execute<RevokeResult>(ctx, envelope, t, async () => {
            const { rows } = await t.query<{ outcome: string }>(
              'SELECT cuspatlas.admin_revoke_membership($1) AS outcome',
              [p.principalRef],
            );
            const outcome = (rows[0] as { outcome: string }).outcome;
            if (outcome === 'not_found')
              throw new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
            if (outcome !== 'revoked')
              throw new RefusalError({ code: 'conflict', detail: { reason: `membership_${outcome}` } });
            await recordCommand(
              t,
              { operation: op, resourceType: 'membership', resourceRef: p.principalRef, resourceVersion: 1 },
              { changedFields: ['revokedAt'] },
            );
            // Per class: tokens are stateless and every request, tool call and queued job reloads the
            // membership, so the revocation is effective on the next call of any surface.
            return {
              data: {
                principalRef: p.principalRef,
                membership: 'revoked',
                sessions: 'refused_on_next_request',
                queuedWork: 'refused_on_next_authorization',
                reasonCode: p.reasonCode,
              },
              version: 1,
            };
          }),
        );
      });
    },
  };
}

export interface RevokeResult {
  readonly principalRef: string;
  readonly membership: 'revoked';
  readonly sessions: 'refused_on_next_request';
  readonly queuedWork: 'refused_on_next_authorization';
  readonly reasonCode: string;
}

const revokeCodec: ReplayCodec<RevokeResult> = {
  persist: (d): StoredResult => ({ kind: 'success', principalRef: d.principalRef }),
  restore(s, payload) {
    if (s.kind !== 'success' || typeof s.principalRef !== 'string')
      throw new Error('Stored result is malformed');
    return {
      principalRef: s.principalRef,
      membership: 'revoked',
      sessions: 'refused_on_next_request',
      queuedWork: 'refused_on_next_authorization',
      reasonCode: String((payload as { reasonCode?: unknown } | null)?.reasonCode ?? ''),
    };
  },
};
// biome-ignore lint/suspicious/noExplicitAny: codecs are heterogeneous per operation.
export const ADMINISTRATION_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<any>>> = {
  'admin.access.revoke': revokeCodec,
};
