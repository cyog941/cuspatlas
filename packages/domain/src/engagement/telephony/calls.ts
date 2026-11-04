import { createHash } from 'node:crypto';
import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  ENGAGEMENT_PROPERTIES,
  type TenantTransaction,
  validateCallEventInput,
  validateCallLink,
  validateEmptyQuery,
  validateHandlingQuery,
  validateTelephonyConfigDefine,
} from '@cuspatlas/contracts';
import { executeOnce } from '../../commands/execute-once';
import { recordCommand } from '../../events/record-command';
import { formatLocal, minutesOf } from '../../scheduling/zoned-time';
import { assertRef, checkEnvelope, conflict, type EngagementBase, failedAt, notFound } from '../common';
import { CONTACT_DIGEST_SQL } from '../communications/suppression';

/**
 * E8 telephony (E-S2 blocked-on-discovery: no provider, no network). What is built is the practice's
 * configuration and call references:
 *
 * - configuration versions (fictional 555-01xx numbers, weekly hours in an IANA zone, routing for open
 *   and closed hours), append-only, validated before publication; recording is off and a request to
 *   turn it on is refused (`recording_without_consent`: no recording storage and no approved recording
 *   consent exist);
 * - call events recorded by the telephony integration principal from a (fake) adapter: metadata only,
 *   the caller number kept as a digest plus its last four digits, bound to the configuration version in
 *   force at the call so a historical call resolves to its rule after later changes;
 * - links from a call to a patient by a person's confirmation only. A caller-number match yields a
 *   candidate list (possibly several patients of one household); nothing is linked automatically.
 */
export const TELEPHONY_POLICY_VERSION = 'telephony.pending-approval.1';
export const TELEPHONY_PROVIDER_STATUS = { status: 'blocked_on_discovery', spike: 'E-S2' } as const;

/** The adapter port. The only implementation is the synthetic fake under tests/ (no SDK, no egress). */
export interface CallEventInput {
  readonly providerCallRef: string;
  readonly direction: 'inbound' | 'outbound';
  readonly callerNumber: string;
  readonly dialedNumber: string;
  readonly occurredAt: string;
  readonly outcome: 'answered' | 'missed' | 'voicemail';
}
export interface TelephonyAdapter {
  readonly provider: 'synthetic-fake';
  /** Normalized events since the last pull; never a recording, never audio. */
  pull(): Promise<readonly CallEventInput[]>;
}

interface Window {
  weekday: number;
  start: string;
  end: string;
}
interface Routing {
  open: { action: 'ring_queue'; queue: 'front_desk' | 'billing' };
  closed: { action: 'voicemail' | 'external_reference' };
}
interface ConfigRow extends Record<string, unknown> {
  id: string;
  version: number;
  numbers: string[];
  time_zone: string;
  hours: Window[];
  routing: Routing;
  recording_state: string;
  created_at: Date;
}

const digits = (n: string) => n.replace(/[^0-9]/g, '');
const digestOf = (n: string) => createHash('sha256').update(digits(n)).digest('hex');

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Open or closed at an instant, by the configuration's weekly hours in its own zone. */
export function handlingAt(config: { hours: Window[]; time_zone: string }, at: Date): 'open' | 'closed' {
  const local = formatLocal(at.getTime(), config.time_zone);
  const weekday = new Date(`${local.slice(0, 10)}T00:00:00Z`).getUTCDay();
  const m = minutesOf(local.slice(11, 16));
  return config.hours.some((w) => w.weekday === weekday && m >= minutesOf(w.start) && m < minutesOf(w.end))
    ? 'open'
    : 'closed';
}

async function configAt(tx: TenantTransaction, at: Date | null): Promise<ConfigRow | null> {
  const { rows } = await tx.query<ConfigRow>(
    `SELECT id, version, numbers, time_zone, hours, routing, recording_state, created_at FROM cuspatlas.telephony_configs
     WHERE ($1::timestamptz IS NULL OR created_at <= $1) ORDER BY version DESC LIMIT 1`,
    [at],
  );
  return rows[0] ?? null;
}

const configOut = (c: ConfigRow) => ({
  version: c.version,
  configRef: c.id,
  numbers: c.numbers,
  timeZone: c.time_zone,
  hours: c.hours,
  routing: c.routing,
  recordingState: c.recording_state,
  effectiveFrom: c.created_at.toISOString(),
});

export function createTelephonyOperations(base: EngagementBase) {
  const { deps } = base;
  const execute = deps.execute ?? executeOnce;
  return {
    defineTelephonyConfig(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'telephony.config.define';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateTelephonyConfigDefine, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as {
          numbers: string[];
          timeZone: string;
          hours: Window[];
          routing: Routing;
          recording: 'off' | 'on';
        };
        // Recording needs storage, a retention class and an approved recording consent: none exist.
        if (p.recording === 'on') throw failedAt('/recording', 'recording_without_consent');
        if (!validZone(p.timeZone)) throw failedAt('/timeZone', 'routing_invalid');
        // A misconfigured rule is detected before publication: empty or overlapping windows.
        p.hours.forEach((w, i) => {
          if (minutesOf(w.start) >= minutesOf(w.end)) throw failedAt(`/hours/${i}`, 'routing_invalid');
          for (const o of p.hours.slice(0, i)) {
            if (
              o.weekday === w.weekday &&
              minutesOf(w.start) < minutesOf(o.end) &&
              minutesOf(o.start) < minutesOf(w.end)
            )
              throw failedAt(`/hours/${i}`, 'routing_invalid');
          }
        });
        return deps.withTenantTransaction(ctx, async (tx) =>
          execute(ctx, envelope, tx, async () => {
            const latest = await configAt(tx, null);
            const version = (latest?.version ?? 0) + 1;
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.telephony_configs (tenant_id, version, numbers, time_zone, hours, routing, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2::text[], $3, $4::jsonb, $5::jsonb, cuspatlas.current_actor_id())
               RETURNING id`,
              [version, p.numbers, p.timeZone, JSON.stringify(p.hours), JSON.stringify(p.routing)],
            );
            const id = rows[0]?.id as string;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'telephonyConfig', resourceRef: id, resourceVersion: 1 },
              { changedFields: ['numbers', 'hours', 'routing'] },
            );
            return { data: { configRef: id, version, recordingState: 'off' }, version };
          }),
        );
      });
    },

    describeTelephonyConfig(ctx: ActorContext, query: unknown) {
      const op = 'telephony.config.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const c = await configAt(tx, null);
          // Not configured is an explicit state, never an empty configuration.
          return c === null
            ? {
                coverage: { status: 'unavailable', reason: 'not_configured', owner: 'practice' },
                config: null,
                provider: TELEPHONY_PROVIDER_STATUS,
              }
            : {
                coverage: { status: 'available' },
                config: configOut(c),
                provider: TELEPHONY_PROVIDER_STATUS,
              };
        });
      });
    },

    /** The rule in force at an instant, with the configuration version it came from. */
    resolveCallHandling(ctx: ActorContext, query: unknown) {
      const op = 'telephony.handling.resolve';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid(validateHandlingQuery, query, ENGAGEMENT_PROPERTIES);
        const at = new Date((query as { at: string }).at);
        if (Number.isNaN(at.getTime())) throw failedAt('/at', 'format');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const c = await configAt(tx, at);
          if (c === null) throw conflict('telephony_not_configured');
          const state = handlingAt(c, at);
          return { at: at.toISOString(), state, rule: c.routing[state], sourceVersion: c.version };
        });
      });
    },

    recordCallEvent(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'telephony.calls.record';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateCallEventInput, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as CallEventInput;
        const at = new Date(p.occurredAt);
        if (Number.isNaN(at.getTime())) throw failedAt('/occurredAt', 'format');
        return deps.withTenantTransaction(ctx, async (tx) =>
          execute(ctx, envelope, tx, async () => {
            const dup = await tx.query<{ id: string }>(
              'SELECT id FROM cuspatlas.call_events WHERE provider_call_ref = $1',
              [p.providerCallRef],
            );
            if (dup.rows[0]) return { data: { callRef: dup.rows[0].id, deduplicated: true }, version: 1 };
            const c = await configAt(tx, at);
            if (c === null) throw conflict('telephony_not_configured');
            if (!c.numbers.includes(p.dialedNumber)) throw failedAt('/dialedNumber', 'numberNotConfigured');
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.call_events (tenant_id, provider_call_ref, direction, caller_digest, caller_last4,
                 dialed_number, occurred_at, outcome, config_id, handling, recorded_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, cuspatlas.current_actor_id())
               RETURNING id`,
              [
                p.providerCallRef,
                p.direction,
                digestOf(p.callerNumber),
                digits(p.callerNumber).slice(-4),
                p.dialedNumber,
                at,
                p.outcome,
                c.id,
                handlingAt(c, at),
              ],
            );
            const id = rows[0]?.id as string;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'callEvent', resourceRef: id, resourceVersion: 1 },
              { changedFields: ['call'] },
            );
            return { data: { callRef: id, deduplicated: false }, version: 1 };
          }),
        );
      });
    },

    readCall(ctx: ActorContext, callRef: string) {
      const op = 'telephony.calls.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(callRef);
          const { rows } = await tx.query<{
            id: string;
            direction: string;
            caller_digest: string;
            caller_last4: string;
            dialed_number: string;
            occurred_at: Date;
            outcome: string;
            handling: 'open' | 'closed';
            version: number;
            routing: Routing;
          }>(
            `SELECT e.id, e.direction, e.caller_digest, e.caller_last4, e.dialed_number, e.occurred_at, e.outcome, e.handling,
               c.version, c.routing
             FROM cuspatlas.call_events e JOIN cuspatlas.telephony_configs c ON c.id = e.config_id AND c.tenant_id = e.tenant_id
             WHERE e.id = $1`,
            [callRef],
          );
          const e = rows[0];
          if (!e) throw notFound();
          const link = await tx.query<{ patient_id: string | null; reason_code: string; created_at: Date }>(
            'SELECT patient_id, reason_code, created_at FROM cuspatlas.call_links WHERE call_id = $1 ORDER BY seq DESC LIMIT 1',
            [e.id],
          );
          // Candidates: patients with a phone contact point whose digest matches. Never a link.
          const candidates = await tx.query<{ id: string }>(
            `SELECT DISTINCT p.id FROM cuspatlas.patients p, jsonb_array_elements(
               CASE WHEN (p.contact ->> 'known')::boolean THEN p.contact -> 'points' ELSE '[]'::jsonb END) AS cp
             WHERE p.merged_into IS NULL AND cp ->> 'channel' = 'phone'
               AND ${CONTACT_DIGEST_SQL("cp ->> 'value'", "'phone'")} = $1
             ORDER BY p.id LIMIT 10`,
            [e.caller_digest],
          );
          const current = link.rows[0];
          return {
            callRef: e.id,
            direction: e.direction,
            callerLast4: e.caller_last4,
            dialedNumber: e.dialed_number,
            occurredAt: e.occurred_at.toISOString(),
            outcome: e.outcome,
            handling: { state: e.handling, rule: e.routing[e.handling], sourceVersion: e.version },
            recording: null,
            link:
              current && current.patient_id !== null
                ? {
                    patientRef: current.patient_id,
                    reasonCode: current.reason_code,
                    linkedAt: current.created_at.toISOString(),
                  }
                : null,
            candidates: candidates.rows.map((r) => r.id),
            candidateState:
              candidates.rows.length === 0 ? 'none' : candidates.rows.length === 1 ? 'single' : 'ambiguous',
          };
        });
      });
    },

    listCalls(ctx: ActorContext, query: unknown) {
      const op = 'telephony.calls.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            occurred_at: Date;
            outcome: string;
            caller_last4: string;
            linked: string | null;
          }>(
            `SELECT e.id, e.occurred_at, e.outcome, e.caller_last4,
               (SELECT l.patient_id FROM cuspatlas.call_links l WHERE l.call_id = e.id ORDER BY l.seq DESC LIMIT 1) AS linked
             FROM cuspatlas.call_events e ORDER BY e.occurred_at DESC, e.id LIMIT 100`,
          );
          return rows.map((r) => ({
            callRef: r.id,
            occurredAt: r.occurred_at.toISOString(),
            outcome: r.outcome,
            callerLast4: r.caller_last4,
            linkedPatientRef: r.linked,
          }));
        });
      });
    },

    /** A person confirms (or removes) the patient of a call. Never derived from caller ID alone. */
    linkCall(ctx: ActorContext, callRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'telephony.calls.link';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateCallLink, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as { patientRef: string | null; reasonCode: string };
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(callRef);
          const call = await tx.query('SELECT 1 FROM cuspatlas.call_events WHERE id = $1', [callRef]);
          if (call.rowCount === 0) throw notFound();
          if (p.patientRef !== null) {
            assertRef(p.patientRef);
            const pt = await tx.query<{ merged_into: string | null }>(
              'SELECT merged_into FROM cuspatlas.patients WHERE id = $1 FOR SHARE',
              [p.patientRef],
            );
            if (!pt.rows[0]) throw notFound();
            if (pt.rows[0].merged_into !== null) throw conflict('patient_merged');
          }
          return execute(ctx, { ...envelope, payload: { callRef, ...p } }, tx, async () => {
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.call_links (tenant_id, call_id, patient_id, reason_code, linked_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id()) RETURNING id`,
              [callRef, p.patientRef, p.reasonCode],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: 'callLink',
                resourceRef: rows[0]?.id as string,
                resourceVersion: 1,
              },
              { changedFields: ['patient'] },
            );
            return { data: { callRef, patientRef: p.patientRef }, version: 1 };
          });
        });
      });
    },
  };
}
